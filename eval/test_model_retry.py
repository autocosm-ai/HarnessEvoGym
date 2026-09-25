"""真实本地 HTTP 服务复现断流和上游状态码，确认重试的是同一轮请求。"""

import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import model


class ModelRetryTests(unittest.TestCase):
    def request(self, failure):
        requests = []
        payload = json.dumps({"choices": [{"message": {"content": "complete"}, "finish_reason": "stop"}]}).encode()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                status, body, content_type, extra_length = (
                    failure if len(requests) == 1 else (200, payload, "application/json", 0)
                )
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body) + extra_length))
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            messages = [{"role": "user", "content": "same round"}]
            with patch.object(model.time, "sleep"), patch.object(model, "_UPSTREAM_RETRY_MAX", 1):
                result = model.query(f"http://127.0.0.1:{server.server_port}/v1",
                                     "fixture", "fixture-model", messages, 128)
            self.assertEqual(result, "complete")
            self.assertEqual(requests, [requests[0], requests[0]])
            self.assertEqual(requests[0]["messages"], messages)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_http_errors_and_three_forms_of_truncation_retry_same_request(self):
        partial_sse = b'data: {"choices":[{"delta":{"content":"half"}}]}\n'
        for failure in (
            (502, b"unavailable", "text/plain", 0),
            (429, b"rate limited", "text/plain", 0),
            (200, partial_sse, "text/event-stream", 0),
            (200, partial_sse, "text/event-stream", 20),
            (200, b'data: {"choices":', "text/event-stream", 0),
        ):
            with self.subTest(failure=failure):
                self.request(failure)

    def test_failed_request_always_closes_connection_and_stops_at_retry_limit(self):
        with patch.object(model.http.client, "HTTPConnection") as connection, patch.object(model.time, "sleep"), patch.object(model, "_UPSTREAM_RETRY_MAX", 1):
            connection.return_value.request.side_effect = OSError("connection reset")
            with self.assertRaisesRegex(RuntimeError, "connection failed"):
                model.query("http://127.0.0.1/v1", "fixture", "fixture-model", [], 128)
            self.assertEqual(connection.return_value.close.call_count, 2)

    def test_auth_failure_is_not_retried(self):
        with patch.object(model.http.client, "HTTPConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 401
            response.read.return_value = b"invalid key"
            with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                model.query("http://127.0.0.1/v1", "fixture", "fixture-model", [], 128)
            self.assertEqual(connection.return_value.request.call_count, 1)
            self.assertEqual(connection.return_value.close.call_count, 1)


if __name__ == "__main__":
    unittest.main()
