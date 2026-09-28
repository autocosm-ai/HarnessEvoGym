# Evaluation Run Modes

HarnessEvoGym models result reuse explicitly so exploratory runs cannot be mistaken for
official results.

| Mode | Purpose | Parameter changes | Old result handling |
| --- | --- | --- | --- |
| `resume` | Continue the same Run | Execution, benchmark, model, provider, and resource identity must match | Reuse only when the identity is exact |
| `sealed-final` | Official hidden-set evaluation | Identity must match and the Final unlock flow is required | Produces the official Final result |
| `fork` | Derive a new experiment from a Checkpoint | Model, provider, budget, and timeout may change | Records `parentRunId`; old scores become stale and must be reevaluated |
| `exploratory` | Fast comparison or debugging | Evaluation configuration may change | Report-only; never an official result |

`controller/src/evaluation-profile.mjs` creates the identity from public experiment
parameters. API keys, tokens, passwords, and other credentials are rejected. The report
records `evaluationMode` and `evaluationIdentityDigest`.

The common Evaluator now validates this identity. `resume` and `sealed-final` remain fail
closed. `fork` and `exploratory` have a shared stale-result protocol, while the CLI command
that materializes a new Run from a Checkpoint is still future work. It will not mutate the
parent Run or overwrite its report.
