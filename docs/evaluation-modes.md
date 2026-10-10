# Evaluation Run Modes

HarnessEvoGym models result reuse explicitly so exploratory runs cannot be mistaken for
official results.

| Mode           | Purpose                                   | Parameter changes                                                       | Old result handling                                                    |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `resume`       | Continue the same Run                     | Execution, benchmark, model, provider, and resource identity must match | Reuse only when the identity is exact                                  |
| `sealed-final` | Official hidden-set evaluation            | Identity must match and the Final unlock flow is required               | Produces the official Final result                                     |
| `fork`         | Derive a new experiment from a Checkpoint | Model, provider, budget, and timeout may change                         | Records `parentRunId`; old scores become stale and must be reevaluated |
| `exploratory`  | Fast comparison or debugging              | Evaluation configuration may change                                     | Report-only; never an official result                                  |

The evaluation identity is produced by `controller/src/evaluation-profile.mjs` and contains
only public experiment parameters and digests. API keys, tokens, passwords, and other
credentials are rejected. The identity is pinned with SHA-256, and the report records
`evaluationMode` and `evaluationIdentityDigest`.

The current version already wires identity validation into the shared `Evaluator`. `resume`
and `sealed-final` therefore stay strictly fail-closed, while `fork` and `exploratory` share
a stale-result protocol. The complete "create a new Run from a Checkpoint" CLI operation is
still future work; it will not modify the old Run and will not overwrite old scores with
scores taken under new parameters.

## Code example

```js
import {
  compareEvaluationIdentity,
  createEvaluationIdentity,
} from '../controller/src/evaluation-profile.mjs'

const identity = createEvaluationIdentity({
  mode: 'fork',
  runId: 'officeval-fork-001',
  parentRunId: 'officeval-main-001',
  evaluation: {
    benchmark: 'officeval-v1',
    model: 'gpt-5.6-terra',
    provider: 'zcloud',
    timeoutSeconds: 7200,
  },
})

const reuse = compareEvaluationIdentity(previousIdentity, identity, { mode: 'fork' })
// reuse.reuse === 'stale'; the old score is reference only and cannot be reused directly.
```

Provider credentials may still only be injected at runtime through the environment. Never put
a key into configuration, a Checkpoint, or an evaluation identity.
