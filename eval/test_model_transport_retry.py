"""请求级断流重试：保留消息、关闭连接、拒绝半截输出。"""

import http.client
import json
import unittest
from unittest.mock import Mock, patch

import model


def response(body="ok", status=200):
    result = Mock(status=status, headers={"content-type": "text/event-stream"})
    result.read.return_value = (
        'data: ' + json.dumps({"choices": [{"delta": {"content": body}, "finish_reason": "stop"}]})
        + '\n\ndata: [DONE]\n\n'
    ).encode()
    return result


class TransportRetryTests(unittest.TestCase):
    def query_with(self, first):
        connections = [Mock(), Mock()]
        connections[0].getresponse.side_effect = first if isinstance(first, Exception) else None
        connections[0].getresponse.return_value = first
        connections[1].getresponse.return_value = response()
        messages = [{"role": "user", "content": "保留前面完整对话"}]
        with patch.object(model.http.client, "HTTPConnection", side_effect=connections), \
             patch.object(model.time, "sleep") as sleep:
            actual = model.query("http://localhost/v1", "dummy", "test", messages, 8192)
        self.assertEqual(actual, "ok")
        self.assertEqual(connections[0].request.call_args, connections[1].request.call_args)
        for connection in connections:
            connection.close.assert_called_once()
        sleep.assert_called_once_with(5.0)

    def test_incomplete_chunked_read_retries_same_request(self):
        partial = response()
        partial.read.side_effect = http.client.IncompleteRead(b"partial", 100)
        self.query_with(partial)

    def test_response_headers_disconnected(self):
        self.query_with(http.client.RemoteDisconnected("remote end closed connection"))

    def test_504_retries(self):
        self.query_with(response("gateway timeout", status=504))

    def test_half_sse_never_returned(self):
        partial = response()
        partial.read.return_value = b'data: {"choices":[{"delta":{"content":"half"}}]}\n\n'
        self.query_with(partial)

    def test_exhaustion_stays_failure(self):
        connection = Mock()
        connection.getresponse.side_effect = http.client.IncompleteRead(b"", 1)
        with patch.object(model.http.client, "HTTPConnection", return_value=connection), \
             patch.object(model.time, "sleep"), patch.object(model, "_UPSTREAM_RETRY_MAX", 2):
            with self.assertRaisesRegex(RuntimeError, "connection failed"):
                model.query("http://localhost/v1", "dummy", "test", [], 8192)
        self.assertEqual(connection.close.call_count, 3)

    def test_auth_failure_is_not_retried(self):
        connection = Mock()
        connection.getresponse.return_value = response("unauthorized", status=401)
        with patch.object(model.http.client, "HTTPConnection", return_value=connection), \
             patch.object(model.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                model.query("http://localhost/v1", "dummy", "test", [], 8192)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
