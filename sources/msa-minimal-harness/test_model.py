"""MSA model.py 的本地协议与重试测试，不访问真实 Provider。"""

from __future__ import annotations

import importlib.util
import pathlib
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).with_name("model.py")
SPEC = importlib.util.spec_from_file_location("msa_model", MODULE_PATH)
assert SPEC and SPEC.loader
model = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(model)


def sse(*events: str) -> str:
    return "".join(f"data: {event}\n\n" for event in events)


class FakeResponse:
    def __init__(self, status: int, body: str):
        self.status = status
        self._body = body.encode()

    def read(self) -> bytes:
        return self._body


class FakeConnection:
    responses = []
    calls = 0

    def __init__(self, *_args, **_kwargs):
        pass

    def request(self, *_args, **_kwargs):
        type(self).calls += 1

    def getresponse(self):
        return type(self).responses.pop(0)

    def close(self):
        pass


class ModelRetryTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.responses = []
        FakeConnection.calls = 0

    def test_truncated_sse_is_rejected(self):
        with self.assertRaises(model.IncompleteStreamError):
            model._read_sse(sse('{"type":"response.output_text.delta","delta":"半截"}'))

    def test_completed_sse_returns_text(self):
        result = model._read_sse(sse(
            '{"type":"response.output_text.delta","delta":"完成"}',
            '{"type":"response.completed","response":{}}',
        ))
        self.assertEqual(result, "完成")

    def test_request_retries_truncated_stream_then_succeeds(self):
        FakeConnection.responses = [
            FakeResponse(200, sse('{"type":"response.output_text.delta","delta":"半截"}')),
            FakeResponse(200, sse(
                '{"type":"response.output_text.delta","delta":"完整"}',
                '{"type":"response.completed","response":{}}',
            )),
        ]
        with patch.object(model, "UnixHTTPConnection", FakeConnection), patch.object(model.time, "sleep"):
            result = model.query("/tmp/fake.sock", "dummy", [], 100)
        self.assertEqual(result, "完整")
        self.assertEqual(FakeConnection.calls, 2)

    def test_request_retries_retryable_http_status(self):
        FakeConnection.responses = [
            FakeResponse(502, "upstream unavailable"),
            FakeResponse(200, sse(
                '{"type":"response.output_text.delta","delta":"恢复"}',
                '{"type":"response.completed","response":{}}',
            )),
        ]
        with patch.object(model, "UnixHTTPConnection", FakeConnection), patch.object(model.time, "sleep"):
            result = model.query("/tmp/fake.sock", "dummy", [], 100)
        self.assertEqual(result, "恢复")
        self.assertEqual(FakeConnection.calls, 2)


if __name__ == "__main__":
    unittest.main()
