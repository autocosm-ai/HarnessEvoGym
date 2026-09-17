"""验证 SSE 完整性判定：正常响应必须放行，截断必须被识别为可重试。"""
import importlib.util, sys, json, io
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "rmodel",
    Path(__file__).with_name("model.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeResp:
    """最小化模拟 http.client.HTTPResponse。"""
    def __init__(self, body: str, ctype="text/event-stream"):
        self._b = body.encode()
        self.headers = {"content-type": ctype}
    def read(self, n=None):
        return self._b


def sse(*events, done=False):
    out = []
    for e in events:
        out.append("data: " + json.dumps(e))
    if done:
        out.append("data: [DONE]")
    return "\n".join(out) + "\n"


def delta(txt, finish=None):
    return {"choices": [{"delta": {"content": txt}, "finish_reason": finish}]}


fails = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got={got} want={want}")
    if not ok:
        fails.append(name)


print("=== _read_response 的 saw_terminator / finish_reason ===")

# 1. 正常：有内容 + [DONE] + finish_reason
r = m._read_response(FakeResp(sse(delta("hel"), delta("lo", "stop"), done=True)))
check("normal: saw_terminator", r["saw_terminator"], True)
check("normal: finish_reason", r["finish_reason"], "stop")
check("normal: text", r["text"], "hello")

# 2. 正常但无 [DONE]，只有 finish_reason（宽容路径）
r = m._read_response(FakeResp(sse(delta("hel"), delta("lo", "stop"), done=False)))
check("no-DONE: saw_terminator", r["saw_terminator"], False)
check("no-DONE: finish_reason", r["finish_reason"], "stop")

# 3. 截断：有内容，无 [DONE]，无 finish_reason
r = m._read_response(FakeResp(sse(delta("hal"), delta("f"), done=False)))
check("truncated: saw_terminator", r["saw_terminator"], False)
check("truncated: finish_reason", r["finish_reason"], None)
check("truncated: text", r["text"], "half")

# 4. 非流式 JSON 响应 —— 天然完整
body = json.dumps({"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}]})
r = m._read_response(FakeResp(body, ctype="application/json"))
check("non-stream: saw_terminator", r["saw_terminator"], True)

print()
print("=== complete 判定（query 中的表达式）===")
def complete(res):
    return res["saw_terminator"] or res["finish_reason"] is not None

check("normal -> complete",
      complete({"saw_terminator": True, "finish_reason": "stop"}), True)
check("only finish_reason -> complete",
      complete({"saw_terminator": False, "finish_reason": "stop"}), True)
check("only DONE -> complete",
      complete({"saw_terminator": True, "finish_reason": None}), True)
check("neither -> INCOMPLETE",
      complete({"saw_terminator": False, "finish_reason": None}), False)

print()
print("=== 截断错误必须被判定为可重试 ===")
for detail in ("partial content: 4 chars", "no content"):
    exc = RuntimeError(f"stream ended without terminal response ({detail}, finish_reason=missing)")
    check(f"retryable [{detail}]", m._is_retryable(exc), True)

# 反向：真正的内容过滤不该被重试
check("content-filter NOT retryable",
      m._is_retryable(RuntimeError("model gateway refused or filtered the completion")), False)

print()
if fails:
    print(f"FAILED: {fails}")
    sys.exit(1)
print("all checks passed")
