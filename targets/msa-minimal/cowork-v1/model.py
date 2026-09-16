"""通过 Controller 隔离网关调用 OpenAI Chat Completions。

这里是 Cowork CandidateSeed 中实际覆盖到候选 workspace 的模型客户端。
上游返回半截 SSE、空正文、错误帧、429/5xx 或连接中断时，只重试当前
模型请求，不把半截正文交给 Agent，也不让整道 Office 题从头重跑。
"""

from __future__ import annotations

import http.client
import json
import ssl
import time
from urllib.parse import urlsplit

MAXIMUM_UPSTREAM_RETRIES = 8
UPSTREAM_RETRY_BASE_DELAY = 5.0
UPSTREAM_RETRY_MAX_DELAY = 60.0
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504, 524})


class RetryableModelError(RuntimeError):
    pass


def _content(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            item["text"] for item in value
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
    return ""


def _read_response(response: http.client.HTTPResponse) -> str:
    raw = response.read().decode("utf-8", errors="replace")
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type:
        try:
            payload = json.loads(raw)
            choice = payload.get("choices", [])[0]
            message = choice.get("message", {})
            text = _content(message.get("content"))
            if not text.strip():
                raise RetryableModelError("model gateway returned no final text")
            return text
        except (IndexError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise RetryableModelError("model gateway returned invalid JSON response") from exc

    parts: list[str] = []
    final_message = ""
    finish_reason: str | None = None
    saw_terminator = False
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data:
            continue
        if data == "[DONE]":
            saw_terminator = True
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError as exc:
            raise RetryableModelError("model gateway returned malformed SSE JSON") from exc
        if event.get("error") is not None:
            raise RetryableModelError("model gateway streamed an upstream error")
        choices = event.get("choices", [])
        if not choices or not isinstance(choices[0], dict):
            continue
        choice = choices[0]
        delta = choice.get("delta", {})
        if not isinstance(delta, dict):
            delta = {}
        message = choice.get("message", {})
        if not isinstance(message, dict):
            message = {}
        parts.append(_content(delta.get("content")))
        message_content = _content(message.get("content"))
        if message_content:
            final_message = message_content
        current_finish = choice.get("finish_reason")
        if isinstance(current_finish, str):
            finish_reason = current_finish

    text = "".join(parts) or final_message
    # 正常网关可能只给 finish_reason，也可能额外给 [DONE]；二者至少一个必须存在。
    if not saw_terminator and finish_reason is None:
        raise RetryableModelError(
            f"stream ended without terminal response (partial content: {len(text)} chars)"
        )
    if not text.strip():
        raise RetryableModelError("model gateway returned no final text")
    return text


def _connection(parsed):
    if parsed.scheme == "https":
        return http.client.HTTPSConnection(
            parsed.hostname, parsed.port or 443, timeout=1200,
            context=ssl.create_default_context(),
        )
    return http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=1200)


def _query_once(gateway_url: str, api_key: str, body: bytes) -> str:
    parsed = urlsplit(gateway_url)
    connection = _connection(parsed)
    try:
        endpoint = f"{parsed.path.rstrip('/')}/chat/completions" or "/chat/completions"
        connection.request("POST", endpoint, body=body, headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        })
        response = connection.getresponse()
        if response.status != 200:
            response.read(4096)
            if response.status in RETRYABLE_HTTP_STATUSES:
                raise RetryableModelError(f"model gateway HTTP {response.status}")
            raise RuntimeError(f"model gateway HTTP {response.status}")
        return _read_response(response).strip()
    except (ConnectionError, OSError, TimeoutError) as exc:
        raise RetryableModelError(f"model gateway connection failed: {type(exc).__name__}") from exc
    finally:
        connection.close()


def query(
    gateway_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    max_output_tokens: int,
) -> str:
    parsed = urlsplit(gateway_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("model gateway URL must be an HTTP(S) endpoint")
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(MAXIMUM_UPSTREAM_RETRIES + 1):
        try:
            return _query_once(gateway_url, api_key, body)
        except RetryableModelError as exc:
            last_error = exc
            if attempt >= MAXIMUM_UPSTREAM_RETRIES:
                break
            delay = min(UPSTREAM_RETRY_MAX_DELAY, UPSTREAM_RETRY_BASE_DELAY * (2 ** attempt))
            print(
                f"[model] upstream retry {attempt + 1}/{MAXIMUM_UPSTREAM_RETRIES} "
                f"after {type(exc).__name__}; waiting {delay:.0f}s",
                flush=True,
            )
            time.sleep(delay)
    raise RuntimeError(
        f"model gateway request failed after {MAXIMUM_UPSTREAM_RETRIES + 1} attempts: {last_error}"
    ) from last_error
