"""通过 Controller 的 Unix socket 调用 Responses API。

候选进程只看到本地 Unix socket 和虚拟 key；真实 Provider 凭据仍由
Controller 的 Model Gateway 持有。本文件只负责单次请求的协议解析和重试：

- 必须收到 ``response.completed``（或等价的 ``[DONE]``）才接受正文；
- 半截 SSE、网关错误帧、429/5xx、连接中断和空正文会原地重试；
- 重试发生在当前模型轮次，不会让整个 Office 题目从第一步重新开始。
"""

from __future__ import annotations

import http.client
import json
import socket
import time
from typing import Any


MAXIMUM_UPSTREAM_RETRIES = 8
UPSTREAM_RETRY_BASE_DELAY = 5.0
UPSTREAM_RETRY_MAX_DELAY = 60.0
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504, 524})


class RetryableModelError(RuntimeError):
    """可以安全重发当前模型请求的上游故障。"""


class IncompleteStreamError(RetryableModelError):
    """SSE 在终止事件前断开，不能把半截正文交给 Agent。"""


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: int = 1200):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def _output_text(response: dict[str, Any]) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    parts: list[str] = []
    for item in response.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                parts.append(content["text"])
    return "".join(parts)


def _read_sse(raw: str) -> str:
    """解析 Responses SSE，并强制要求完整终止事件。"""
    deltas: list[str] = []
    completed: dict[str, Any] | None = None
    saw_done_marker = False
    saw_event = False

    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data:
            continue
        if data == "[DONE]":
            saw_done_marker = True
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError as exc:
            raise IncompleteStreamError("model gateway returned malformed SSE JSON") from exc
        if not isinstance(event, dict):
            continue
        saw_event = True
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str):
                deltas.append(delta)
        elif event_type == "response.output_text.done" and not deltas:
            text = event.get("text")
            if isinstance(text, str):
                deltas.append(text)
        elif event_type == "response.completed":
            response = event.get("response")
            if isinstance(response, dict):
                completed = response
        elif event_type in {"error", "response.failed", "response.incomplete"}:
            raise RetryableModelError("model gateway returned an upstream stream error")

    # 单独收到 delta/done 不能算成功，否则会把半截模型回答当成正常答案。
    if completed is None and not saw_done_marker:
        detail = "no events" if not saw_event else "terminal event missing"
        raise IncompleteStreamError(f"model gateway stream incomplete: {detail}")

    text = "".join(deltas)
    if not text and completed is not None:
        text = _output_text(completed)
    if not text.strip():
        raise RetryableModelError("model gateway returned no final text")
    return text


def _retryable_http_error(status: int) -> RetryableModelError:
    return RetryableModelError(f"model gateway HTTP {status}")


def _query_once(socket_path: str, api_key: str, body: bytes) -> str:
    connection = UnixHTTPConnection(socket_path)
    try:
        connection.request(
            "POST",
            "/v1/responses",
            body=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            },
        )
        response = connection.getresponse()
        raw = response.read().decode("utf-8", errors="replace")
        if response.status != 200:
            if response.status in RETRYABLE_HTTP_STATUSES:
                raise _retryable_http_error(response.status)
            raise RuntimeError(f"model gateway HTTP {response.status}")
        return _read_sse(raw).strip()
    except (ConnectionError, OSError, TimeoutError) as exc:
        raise RetryableModelError(f"model gateway connection failed: {type(exc).__name__}") from exc
    finally:
        connection.close()


def query(socket_path: str, api_key: str, messages: list[dict], max_output_tokens: int) -> str:
    body = json.dumps({
        "model": "controller-selected",
        "input": messages,
        "max_output_tokens": max_output_tokens,
        "stream": True,
    }).encode()

    last_error: Exception | None = None
    for attempt in range(MAXIMUM_UPSTREAM_RETRIES + 1):
        try:
            return _query_once(socket_path, api_key, body)
        except RetryableModelError as exc:
            last_error = exc
            if attempt >= MAXIMUM_UPSTREAM_RETRIES:
                break
            delay = min(UPSTREAM_RETRY_MAX_DELAY, UPSTREAM_RETRY_BASE_DELAY * (2 ** attempt))
            # 不打印请求正文或凭据，只记录第几次重试和错误类型。
            print(
                f"[model] retry {attempt + 1}/{MAXIMUM_UPSTREAM_RETRIES} "
                f"after {type(exc).__name__}; waiting {delay:.0f}s",
                flush=True,
            )
            time.sleep(delay)
    raise RuntimeError(
        f"model gateway request failed after {MAXIMUM_UPSTREAM_RETRIES + 1} attempts: "
        f"{last_error}"
    ) from last_error
