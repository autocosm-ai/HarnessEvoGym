import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { validateTargetAdapter } from '../src/adapters.mjs'
import { materializeCandidate } from '../src/candidate-materializers.mjs'
import { readConfigFile } from '../src/config.mjs'
import { resolveTargetSource } from '../src/target-sources.mjs'

const execute = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('物化后的 Cowork Candidate 使用 Seed 重试且保留原请求和结束语义', async () => {
  const target = validateTargetAdapter(await readConfigFile(
    join(repositoryRoot, 'adapters/targets/msa-minimal-cowork-rsi.yml'),
  ))
  const source = await resolveTargetSource({ repositoryRoot, source: target.source })
  const scratch = await mkdtemp(join(tmpdir(), 'rsi-seed-model-retry-'))
  const workspace = join(scratch, 'candidate')
  await materializeCandidate({ repositoryRoot, target, sourceRoot: source.root, destination: workspace })
  assert.equal(await readFile(join(workspace, 'model.py'), 'utf8'),
    await readFile(join(repositoryRoot, target.materialization.seedPath, 'model.py'), 'utf8'))

  // 从真实物化候选导入客户端，以免测试只覆盖被 Seed 覆盖掉的 Source。
  const script = String.raw`
import http.client, json, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import model

def sse(text, finish=None, done=False):
    choice = {"delta": {"content": text}}
    if finish is not None:
        choice["finish_reason"] = finish
    return ("data: " + json.dumps({"choices": [choice]}) + "\n\n"
            + ("data: [DONE]\n\n" if done else "")).encode()

class Response:
    headers = {"content-type": "text/event-stream"}
    def __init__(self, status=200, raw=None):
        self.status = status
        self.raw = sse("<final>ok</final>", "stop", True) if raw is None else raw
    def read(self, *args):
        if isinstance(self.raw, Exception):
            raise self.raw
        return self.raw

def run(responses):
    requests, closed, delays = [], [], []
    class Connection:
        def __init__(self, *args, **kwargs): pass
        def request(self, method, endpoint, body, headers):
            requests.append((method, endpoint, body, headers))
        def getresponse(self):
            response = responses.pop(0)
            if isinstance(response, Exception): raise response
            return response
        def close(self): closed.append(True)
    error = None
    answer = None
    with patch.object(model.http.client, "HTTPConnection", Connection), patch.object(model.time, "sleep", delays.append):
        try:
            answer = model.query("http://gateway:8080/v1", "dummy-secret", "fixture", [{"role":"user","content":"same task"}], 77)
        except RuntimeError as exc:
            error = str(exc)
    assert len(closed) == len(requests)
    assert all(request == requests[0] for request in requests), "重试改变了同一轮请求"
    assert requests[0][1] == "/v1/chat/completions"
    return answer, error, requests, delays

cases = 0
for status in (429, 500, 502, 503, 504, 524):
    answer, error, requests, delays = run([Response(status), Response()])
    assert answer == "<final>ok</final>" and error is None and len(requests) == 2
    assert delays == [5.0]
    cases += 1
for broken in (
    Response(raw=sse("partial must not be used")),
    Response(raw=sse("partial") + b'data: {"error":{"message":"upstream failed"}}\n\n'),
    Response(raw=b'data: {broken-json\n\n'),
    Response(raw=http.client.IncompleteRead(b"partial", 100)),
    http.client.RemoteDisconnected("closed"),
    ConnectionResetError("reset"),
):
    answer, error, requests, delays = run([broken, Response()])
    assert answer == "<final>ok</final>" and error is None and len(requests) == 2
    cases += 1
for raw in (sse("complete", "stop"), sse("complete", done=True)):
    answer, error, requests, delays = run([Response(raw=raw)])
    assert answer == "complete" and len(requests) == 1 and not delays
    cases += 1
for status in (401, 403):
    answer, error, requests, delays = run([Response(status)])
    assert answer is None and f"HTTP {status}" in error and len(requests) == 1
    assert "dummy-secret" not in error and not delays
    cases += 1
answer, error, requests, delays = run([Response(502) for _ in range(9)])
assert answer is None and "after 9 attempt(s)" in error and len(requests) == 9
assert delays == [5, 10, 20, 40, 60, 60, 60, 60]
cases += 1
print(json.dumps({"cases": cases}))
`
  const { stdout } = await execute('python3', ['-c', script, workspace], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30_000,
  })
  assert.equal(JSON.parse(stdout).cases, 17)
})
