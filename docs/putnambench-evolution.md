# PutnamBench-Lean Harness RSI Experiment Protocol

English | [中文](putnambench-evolution.zh.md)

## The question

This experiment answers exactly one question: with the model, reasoning effort, per-problem budget, and dataset fixed, can an Updater that openly analyses validation performance and Solver traces and then walks the Harness through L1, L2, then L3 raise the Lean proof pass rate of the Candidate Harness?

The validation set feeds proposal and promotion. The test set only records the performance of frozen Candidates: until the whole evolution loop closes, no score, per-problem result, or trace is returned to the Updater, to a Controller decision branch, or to the experimenter. PutnamBench is public, so "hidden" here means preventing adaptive leakage inside the experiment, not claiming the model has never seen the problems during pretraining.

## Frozen inputs

| Item                 | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| PutnamBench revision | `dfb0a47a1c1ec3a10f2a9acfdf41a2043920f33c`                    |
| Lean                 | `v4.27.0`                                                     |
| mathlib              | `a3a10db0e9d66acbebf76c5e6a135066525ac900`                    |
| Harness source       | `3289531e06e924abb790685f44baf67311f26ec9`                    |
| Primary model        | `gpt-5.6-sol`, Responses API, reasoning effort `max`          |
| Solver preset        | `standard`, headless profile                                  |
| Validation set       | 500 problems, 48 complete years                               |
| Test set             | 172 problems, 16 complete years                               |
| Promotion metric     | validation Lean-verified count                                |
| Level patience       | advance after 3 consecutive non-improving mutations per level |

The primary curve never falls back to another Provider at any granularity — request, problem, partition, or Candidate. A persistent ZCloud failure pauses that campaign only; DashScope (`qwen3.8-max` or `deepseek-v4-pro`) may only start a separate campaign under a new provider/model fingerprint, drawn as its own curve. Provider, model, effort, or budget changes never continue the primary curve. Credentials are read once from inherited anonymous file descriptors and never enter argv, the environment, files, or experiment artifacts.

## Split by source and category

The basic grouping unit is the contest year, so the A and B problems of one year never straddle validation and test. The test years are:

```text
1964, 1969, 1972, 1975, 1986, 1988, 1991, 1997,
1998, 2003, 2007, 2014, 2016, 2017, 2020, 2024
```

The remaining years form the validation set. This combination balances the official multi-label categories, A/B session, problem number, and era; categories stay multi-label rather than being forced into one label per problem. The sorted ID manifests are authoritative:

```text
validation.ids  sha256 0a9c8fb73194e023da449a7bc41755d07c7aaf3d7ec461c47c765541571f2760
test.ids        sha256 2204168d092c0c322d1eedf952bd6e57def58985f35fc24564458aec74e78236
```

Dataset discovery starts from the 672 Lean files and inner-joins `informal/putnam.json`; the metadata-only `putnam_1997_a1` record has no Lean file and must be excluded.

## Evolution state machine

```text
CREATED -> CONFIG_FROZEN -> BASELINE_FROZEN -> BASELINE_EVALUATED
        -> EVOLVING_L1 -> EVOLVING_L2 -> EVOLVING_L3
        -> CLOSING -> CLOSED -> REPORTED
```

Infrastructure failures enter `PAUSED_INFRASTRUCTURE` and are retried without counting as an invalid mutation. Credential leakage, manifest/hash changes, or an out-of-bounds diff enter `ABORTED_SECURITY`. Exhausting an explicit budget enters `STOPPED_BUDGET`.

The core loop is:

1. Copy an immutable Candidate from the current incumbent; freeze the mutation proposal before the Updater is allowed to edit.
2. The Controller verifies the Candidate touched only paths allowed at the active level, then builds and freezes the content digest.
3. The Candidate Harness runs 500 validation problems and 172 test problems under the same model, effort, and budget.
4. Validation results and traces go to the feedback area; test results and traces go only into the sealed vault, and the main loop receives a completion receipt that carries no score.
5. Promote only when `candidate.validation_verified > incumbent.validation_verified`; a tie, a regression, or a Candidate-caused failure rolls back and leaves the incumbent unchanged.
6. A promotion resets the active level's consecutive-miss counter; three consecutive misses inherit the current best Candidate and advance to the next level.
7. After three consecutive L3 misses the experiment closes, and all test aggregate scores are unsealed at once for reporting.

The baseline and every Candidate must run both partitions, so a validation failure still leaves a test point. The system does not promise a monotonically rising test curve; the report must show raw points and may not smooth, cherry-pick, or select the best version by test score.

## L1, L2, L3

The three levels are an outside-in, top-down search of increasing risk: first the declarative solving strategy, then extension capabilities, and finally the Solver core. Only one level is active per round; entering a higher level inherits the best state of the level below.

- L1: `apps/cli/config/agent-presets/**`. May change system prompts, workflows, default tool composition, and context/planning strategy, but not execution implementations.
- L2: compaction, context, extensions, guards, hooks, LLM retry, plan, preset, skill, subagent, todo, workflow, web, and the file, interaction, and shell tool implementations. Agent Loop, Session Core, and the trust root may not be changed.
- L3: apps, packages, native, python, and build configuration inside the Candidate, which may modify Solver Core. The Controller, Evaluator, dataset manifests, vault, credentials, metering, promotion logic, and the pinned Source always stay outside the Candidate.

A Candidate at the current level may carry lower-level improvements, but this round's new diff must touch at least one path exclusive to the active level and may not touch a higher level or a permanently read-only path.

## Updater and Solver responsibilities

The Solver is the object under evaluation: it sees one solution-patched Lean problem at a time and tries to fill in the main theorem proof in an isolated working directory. The Updater is the evolution model: it reads the incumbent's validation summary, representative success and failure traces, and the Candidate source, writes a falsifiable proposal first, then makes a minimal complete code change. The Controller supplies no human-authored failure taxonomy and no fixed mutation template.

Every proposal is frozen before editing and contains at least: the main improvement direction, cross-case evidence, the hypothesis, the expected mechanism, target files, and risks. The improvement labels on the final curve come from these pre-registered proposals; a story cannot be written after seeing test results.

## Correctness and isolation boundary

"Not using a rule-based verifier" does not mean letting the model declare its own proof correct. The score must come from a trusted Lean kernel replay; human rules take no part in failure attribution or proposal generation. The runner uses the official `rewrite_solutions.py` to produce the given-answer version, allows the Solver to fill only the main theorem proof, and rebuilds and compiles it inside the trusted template. `sorry`, `admit`, new axioms, statement changes, and unauthorized writes do not score.

Validation and test use different short-lived directories and separate `DSH_HOME` roots. Solver, Updater, Build, and Verifier run under distinct host UID/GID values; untrusted phases run through `setpriv` and bubblewrap with private process and temporary-directory namespaces, explicit minimal mounts, and fail-closed dual-stack egress, and the Verifier additionally runs in a network-free namespace. Candidate source is read-only during evaluation, and each process receives only the current problem. The Updater does not mount the Controller repository, the dataset root, the test manifest, the sealed vault, test receipt details, or another Candidate's working directory. Only the sealed broker child may open and digest-verify the test manifest; the main Controller does not materialize test IDs before closure.

The trusted validation ledger keeps real completion times and latency for the terminal wall-clock report, but it is never mounted into the Updater. Immediately before each proposal, the Controller rebuilds an independent read-only projection containing only validation scores, per-problem outcomes, and sanitized trace content. The projection removes absolute timestamp fields, normalizes textual timestamps and every projected file mtime, and gives the proposal and apply prompts a logical `createdAt` marker. Relative validation duration, latency, token usage, and reasoning remain available as useful validation evidence. The Updater therefore cannot infer sealed-test duration from the interval between validation completion and the next proposal, and no costly fixed-time padding is needed.

## Immutable artifacts

```text
../.rsi/runtime/putnambench-lean/campaigns/<campaign-id>/
  public/
    config.snapshot.json
    state.json
    events.jsonl
    candidates/<id>/proposal.json
    candidates/<id>/mutation-bundle.json
    candidates/<id>/build.json
    candidates/<id>/validation-summary.json
  private/
    validation/<candidate-id>/...     # trusted raw validation ledger, never mounted into the Updater
    feedback/<candidate-id>/...       # timestamp-free feedback projection rebuilt each round
    checkpoints/validation/...
  sealed/
    test/<candidate-id>/summary.json
    test/<candidate-id>/records.jsonl
    test/<candidate-id>/receipt.opaque.json
    test/<candidate-id>/receipt.internal.json
    test/<candidate-id>/traces/...
  candidates/<id>/workspace/          # frozen after mutation
  report/curve.csv
  report/curve.svg
  report/improvements.md
```

Proposals are committed atomically and write-once. The mutation report, the validated diff, the round outcome, the actual evaluation target, and the frozen workspace digest are merged into a single atomic `mutation-bundle.json`; on recovery the workspace digest must be recomputed and match before the checkpoint advances, and a mismatch terminates safely. `state.json` is the authoritative ledger, while `events.jsonl` is atomically rebuilt from the complete event history after each state commit, so a crash can at most leave derived logs temporarily behind — never ahead of state.

When proposal or apply output does not satisfy the contract it is recorded as `candidate_failure`: the Controller restores the incumbent but still runs the full validation set and sealed test under this round's Candidate ID and counts one miss. Provider, timeout, launcher, and other explicitly classified operational failures only enter the infrastructure pause and do not consume patience. Each Candidate records its parent digest, content digest, level, model/budget fingerprint, start and end times, validation decision, and opaque test receipt. Before closure, ordinary state and logs must not contain test problem IDs, test scores, or any field from which a score can be back-computed.

## Final report

The horizontal axis is cumulative wall-clock hours since the baseline freeze; the vertical axis plots both the validation 500 and test 172 pass rates. The figure keeps the baseline, every promoted and rolled-back Candidate, the L1/L2/L3 regions, proposal directions, and promotion markers, and a machine-readable CSV/JSON is emitted alongside it. The report also lists attempts per level, main improvement directions, API and infrastructure events, total call volume, tokens, latency, and known threats to validity.
