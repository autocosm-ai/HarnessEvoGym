"""通过网关或直连 API 调用 OpenAI Chat Completions。

与候选 workspace 里的原版 model.py 接口完全一致（query() 签名不变），
唯一区别：在 query() 内部加了对上游故障的指数退避重试，覆盖：
  - HTTP 429 / 500 / 502 / 503 / 504 / 524
  - SSE 流中途断开（stream ended without terminal response、stream_read_error）
  - 底层 TCP 连接异常（ConnectionError、OSError）

此外支持 https:// scheme，可直连上游 API 而无需本地 model-gateway 容器。
agent.py / run.py / tools.py / profiles / skills 均未改动。
"""

from __future__ import annotations

import http.client
import json
import ssl
import time
from urllib.parse import urlsplit

MAXIMUM_EMPTY_RESPONSE_ATTEMPTS = 3

# ── 上游故障重试配置 ──────────────────────────────────────────────────────────
_RETRYABLE_HTTP_STATUSES = {429, 500, 502, 503, 504, 524}
_UPSTREAM_RETRY_MAX = 8
_UPSTREAM_RETRY_BASE_DELAY = 5.0   # 秒，指数退避基础
_UPSTREAM_RETRY_MAX_DELAY  = 60.0  # 秒，单次等待上限


def _content(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


def _response_result(
    text: str,
    finish_reason: str | None,
    saw_reasoning: bool,
    refused: bool,
    saw_terminator: bool = True,
) -> dict:
    """saw_terminator: 是否收到了明确的流结束信号（SSE 的 data: [DONE]）。
    非流式响应天然是完整的，故默认 True。"""
    return {
        "text": text,
        "finish_reason": finish_reason,
        "saw_reasoning": saw_reasoning,
        "refused": refused,
        "saw_terminator": saw_terminator,
    }


def _read_response(response: http.client.HTTPResponse) -> dict:
    raw = response.read().decode("utf-8", errors="replace")
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type:
        payload = json.loads(raw)
        choices = payload.get("choices", [])
        if not choices or not isinstance(choices[0], dict):
            return _response_result("", None, False, False)
        choice = choices[0]
        message = choice.get("message", {})
        if not isinstance(message, dict):
            message = {}
        finish_reason = choice.get("finish_reason")
        if not isinstance(finish_reason, str):
            finish_reason = None
        return _response_result(
            _content(message.get("content")),
            finish_reason,
            bool(_content(message.get("reasoning_content")).strip()),
            bool(_content(message.get("refusal")).strip()),
        )

    parts: list[str] = []
    final_message = ""
    finish_reason: str | None = None
    saw_reasoning = False
    refused = False
    saw_terminator = False
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            saw_terminator = True
            continue
        if not data:
            continue
        event = json.loads(data)
        if event.get("error") is not None:
            raise RuntimeError("model gateway streamed an upstream error")
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
        saw_reasoning = saw_reasoning or bool(
            _content(delta.get("reasoning_content")).strip()
            or _content(message.get("reasoning_content")).strip()
        )
        refused = refused or bool(
            _content(delta.get("refusal")).strip()
            or _content(message.get("refusal")).strip()
        )
        current_finish = choice.get("finish_reason")
        if isinstance(current_finish, str):
            finish_reason = current_finish
    text = "".join(parts)
    return _response_result(
        text if text else final_message,
        finish_reason,
        saw_reasoning,
        refused,
        saw_terminator,
    )


def _empty_response_error(result: dict, attempts: int) -> RuntimeError:
    finish_reason = result["finish_reason"] or "missing"
    reasoning_discarded = "true" if result["saw_reasoning"] else "false"
    return RuntimeError(
        "model gateway returned no final content "
        f"after {attempts} attempt(s) "
        f"(finish_reason={finish_reason}, reasoning_content_discarded={reasoning_discarded})"
    )


def _is_retryable(exc: Exception) -> bool:
    msg = str(exc).lower()
    for status in _RETRYABLE_HTTP_STATUSES:
        if f"http {status}" in msg:
            return True
    retryable_phrases = (
        "stream ended without",
        "stream_read_error",
        "service temporarily unavailable",
        "bad response status code 524",
        "streamed an upstream error",
        "connection reset",
        "remote end closed connection",
        "broken pipe",
        "incomplete read",
        "connection refused",
    )
    return any(p in msg for p in retryable_phrases)


def query(
    gateway_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    max_output_tokens: int,
) -> str:
    """Drop-in replacement for the original query(); adds upstream retry with
    exponential backoff.  Supports both http:// (local gateway) and https://
    (direct upstream API).
    """
    import sys as _sys

    parsed = urlsplit(gateway_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname \
            or parsed.username or parsed.password:
        raise RuntimeError("model gateway URL must be an http or https endpoint")
    base_path = parsed.path.rstrip("/")
    endpoint = f"{base_path}/chat/completions" or "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode("utf-8")

    def _connect() -> http.client.HTTPConnection:
        if parsed.scheme == "https":
            ctx = ssl.create_default_context()
            return http.client.HTTPSConnection(
                parsed.hostname, parsed.port or 443, timeout=1200, context=ctx
            )
        return http.client.HTTPConnection(
            parsed.hostname, parsed.port or 80, timeout=1200
        )

    last_exc: Exception | None = None
    for upstream_attempt in range(_UPSTREAM_RETRY_MAX + 1):
        if upstream_attempt > 0:
            delay = min(
                _UPSTREAM_RETRY_MAX_DELAY,
                _UPSTREAM_RETRY_BASE_DELAY * (2 ** (upstream_attempt - 1)),
            )
            print(
                f"[model] upstream retry {upstream_attempt}/{_UPSTREAM_RETRY_MAX},"
                f" waiting {delay:.0f}s  (cause: {last_exc})",
                file=_sys.stderr,
            )
            time.sleep(delay)

        try:
            for attempt in range(1, MAXIMUM_EMPTY_RESPONSE_ATTEMPTS + 1):
                connection = _connect()
                try:
                    connection.request(
                        "POST",
                        endpoint,
                        body=body,
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                            "Content-Length": str(len(body)),
                        },
                    )
                    response = connection.getresponse()
                    if response.status != 200:
                        error = response.read(4096).decode("utf-8", errors="replace")
                        raise RuntimeError(f"model gateway HTTP {response.status}: {error}")
                    result = _read_response(response)
                finally:
                    connection.close()

                if result["refused"] or result["finish_reason"] == "content_filter":
                    raise RuntimeError("model gateway refused or filtered the completion")

                text = result["text"].strip()

                # 完整性判定：必须收到明确的终止信号，才认为这次响应是完整的。
                # 该 provider 正常响应同时给出 data: [DONE] 和 finish_reason（已实测），
                # 因此二者任一存在即视为完整；两者都缺失说明流在中途断开。
                complete = result["saw_terminator"] or result["finish_reason"] is not None

                if text and complete:
                    return text

                if not complete:
                    # 流被截断。两种情况都必须走上游重试：
                    #  - 有正文：绝不能返回，agent 会拿着被截断的输出继续工作，
                    #    把基础设施故障表现成能力不足（这正是 run 1 的 bug）。
                    #  - 无正文：也不能落入下面的"空响应"分支 —— 那条路最终抛出
                    #    _empty_response_error，而它不被 _is_retryable() 匹配，
                    #    会导致整道题直接失败而非退避重试。
                    detail = f"partial content: {len(text)} chars" if text else "no content"
                    raise RuntimeError(
                        "stream ended without terminal response "
                        f"({detail}, finish_reason=missing)"
                    )

                if (
                    attempt < MAXIMUM_EMPTY_RESPONSE_ATTEMPTS
                    and result["finish_reason"] in {None, "stop"}
                ):
                    continue
                raise _empty_response_error(result, attempt)

            raise RuntimeError("unreachable model gateway retry state")

        except RuntimeError as exc:
            if _is_retryable(exc) and upstream_attempt < _UPSTREAM_RETRY_MAX:
                last_exc = exc
                continue
            raise

        except (ConnectionError, OSError, http.client.HTTPException) as exc:
            if upstream_attempt < _UPSTREAM_RETRY_MAX:
                last_exc = exc
                continue
            raise RuntimeError(f"model gateway connection failed: {exc}") from exc

    raise RuntimeError(
        f"model gateway failed after {_UPSTREAM_RETRY_MAX} upstream retries: {last_exc}"
    )
