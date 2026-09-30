# HarnessEvoGym Generic Control-Plane Architecture

English | [中文](architecture.zh.md)

## Decision

HarnessEvoGym uses an independent GitHub repository as its trusted control plane. It is no longer a DeepSeek Harness fork. Official history enters only through the pinned `sources/deepseek-harness/` submodule, whose remote remains `deepseek-ai/deepseek-harness`; an Updater never edits that directory directly.

This separates the mutable Solver from the immutable evaluation root and allows projects such as DeepSeek Harness and pi-agent to become Targets or Updaters through adapters without changing the Controller loop.

## Target × Environment × EvolutionAlgorithm × EvolutionRecipe

The Future Population Controller remains the algorithmic base, but now consumes
only a generic BranchEvolutionDriver and EvaluationSummary. Targets define the
evolved Harness and Regions, Environments define tasks and scoring, and Recipes
combine population coordination with module search.

| Composition                 | Branch execution                 | Environment isolation                                      | Search                         |
|-----------------------------|----------------------------------|------------------------------------------------------------|--------------------------------|
| MSA Cowork + OfficeVal      | Generic Cowork Branch Driver     | Office runtime, offline Verifier, Docker internal network  | Recipe + SearchStrategy        |
| MSA + HLE Text-only Math    | HLE Partition Runner             | Distinct UIDs, bubblewrap, Unix gateway, sealed broker     | Campaign mapped to modes       |

Experiment Chat Completions gateway lifecycle is implemented by
`cowork-model-gateway.mjs`; the HLE Responses/Unix-socket
gateway remains in `model-gateway.mjs`. They
serve different provider and isolation contracts rather than duplicating one
protocol.

## Core objects

| Object          | Responsibility                                                        | Updater-writable             |
|-----------------|-----------------------------------------------------------------------|------------------------------|
| Source          | Trusted, pinned upstream source revision                              | No                           |
| Target          | Source, CandidateSeed, Materializer, Driver, Validator, and Catalog  | No                           |
| Environment     | Tasks, task workspaces, verifier, and primary metrics                | No                           |
| EvolutionRecipe | Algorithm, population mode, module search, budget, and peer sharing   | No                           |
| EvolutionAlgorithm | Branch topology, budget allocation, selection, stopping, and resume | No                           |
| SearchStrategy  | Selects parent Candidate and region IDs                               | No; cannot edit a Candidate  |
| Solver          | Performs tasks with the Candidate Harness                             | Indirectly through Candidate |
| Updater         | Reads evidence and code, then analyzes and edits in one session       | Current lease paths only     |
| Controller      | Permissions, scheduling, diff validation, lineage, promotion/rollback | No                           |
| Evaluator       | Frozen tasks, rubrics, cost, and safety gates                         | No                           |

The Updater does not require fixed failure-analyzer, proposal, or builder
services. It reasons, edits, and checks in one context. EvolutionAlgorithm
decides how the population runs, while SearchStrategy chooses where to search;
neither
performs natural-language diagnosis nor edits Candidate code.

## Server API and Core Engine

Run control and experiment execution now have an explicit boundary. `server/`
is a thin Server API: it accepts repository-relative Experiment paths, creates
durable Run descriptors, and exposes status, Resume/Cancel, events, and version
summaries. It does not accept arbitrary shell commands or own Solver/Updater
permissions.

`controller/src/` remains the Core Engine for Controller, Environment, Solver,
Updater, Population Store, and Checkpoint. The current implementation starts a
trusted Controller CLI child process and persists local Run state/events. The
same facade can later be backed by a recoverable Worker or queue without
changing the HTTP contract. Authentication, tenant isolation, a database, and
public deployment are not yet part of this local Server API guarantee.

Evaluation identity and result-reuse rules are documented in
[Evaluation Run Modes](evaluation-modes.md). `resume` and official `sealed-final` runs
still require an exact execution and evaluation identity. Changing the model, provider,
budget, or timeout requires a `fork` or `exploratory` identity; old results are never
silently presented as results for the new configuration.

Population Recipes may select a registered Population-compatible driver through optional `spec.algorithm`.
When omitted, the compatibility default is `population-v1`; this Recipe path
still keeps its PopulationStore and Branch/budget contract. Independent
algorithms such as Beam or MCTS prototypes can use the SDK v2
`initialize`, `step`, `resume`, `report`, and `freezeBaseline` lifecycle with
their own RunStore and versioned Checkpoint state through the trusted
`harness-rsi algorithm run` CLI. That generic path is not yet wired into the
standard Experiment Recipe or Server Run API. Factories are registered by
trusted code in the same process; the CLI does not dynamically execute
untrusted modules.

## One evolution round

```text
pin Source Revision
-> materialize Baseline and Candidate instances
-> SearchStrategy selects a parent and Target-owned region IDs
-> Controller validates the plan and issues a one-round MutationLease
-> run the parent on feedback tasks and produce an objective Feedback Packet
-> launch one isolated Updater session
-> Updater analyzes evidence and applies a coherent edit inside the lease
-> Controller recomputes and validates the full Candidate diff
-> run paired Champion/Candidate selection
-> frozen gates choose Reject or Promote
-> persist immutable Candidate, parent, results, and decision rationale
```

## Runtime layout

Portability rule: host datasets, persistent roots, scratch roots, and CLI installations must be supplied through Runtime JSON relative paths or RSI_* environment references; a machine user's home directory must never be committed. /workspace, /candidate, /opt/harness-rsi, and /usr/bin/... are fixed container or system-toolchain protocol paths and remain absolute because they define the sandbox boundary. npm run check:paths blocks common machine-specific paths from re-entering the repository.

OfficeVal and HLE campaigns keep mutable state outside the Git checkout. The repository, persistent root, and scratch root must be pairwise disjoint; the sealed-test subtree is never mounted into an untrusted phase. Runtime JSON uses relative paths and resolves them beside the repository into `.rsi/`:

```text
../.rsi/runtime/hle-text-math/
  campaigns/<campaign-id>/
    public/                 # resumable state, summaries, proposals, opaque receipts
    private/                # validation records, traces, and per-task checkpoints
    candidates/             # immutable baseline/candidate lineage
    sealed/test/            # test records; unreadable by Solver and Updater
    report/                 # emitted only after campaign closure
  runtimes/<campaign-id>/   # trusted aliases for frozen evaluation instances
  runtime-cache/v1/<sha256>/ # attested, content-addressed frozen builds
  datasets/                 # pinned data and evaluation inputs
  trusted-baseline/         # prebuilt pinned Harness source
  pnpm-store/               # root-owned offline build inputs
  control/                  # attested runtime patch

../.rsi/scratch/hle-text-math/
  <campaign-id>/            # disposable Updater/evaluation workspaces
```

Campaign runtime paths are trusted read-only aliases into the shared cache. The
cache key binds the Candidate source digest, benchmark, pinned Node/pnpm
versions, build recipe, OS, and architecture. A hit validates the frozen
attestation and critical launch closure before use; a mismatch fails closed.
Only a miss traverses the immutable dependency store and performs the offline
install/build/freeze sequence.

Infrastructure retries are phase-local: Solver and verifier each receive the
frozen retry allowance, so a recovered Solver request cannot consume the
verifier's allowance. Retries use exponential backoff with jitter. The gateway
also normalizes the provider's explicit HTTP 400 `upstream_error` marker into a
non-sensitive infrastructure audit classification while leaving ordinary 400
Candidate request failures unchanged.

The lightweight linear path creates one campaign-owned Git worktree and a separate Git metadata directory once, then reuses both across rounds. The Updater sees only that Candidate plus validation feedback and the append-only evolution log—not the Controller repository, dataset, test manifest, sealed vault, credentials, or another Candidate. Evaluation mounts Candidate source read-only. Build, Solver, Updater, and verifier run under distinct host identities and bubblewrap mount namespaces; the current HLE path reaches its credential-hiding gateway through a Unix-socket relay while keeping the Solver and Updater network namespaces isolated.

## Mutation boundary

Generic MSA Cowork and text-Reasoning Experiments use `MutationCatalog ->
MutationPlan -> MutationLease -> full Diff Guard`. L1/L2/L3 are risk ceilings;
regions are Target-specific searchable
modules. A strategy returns only region IDs. The trusted Controller maps them
to paths, while external strategies run through a no-network, no-mount,
no-host-environment Docker JSON protocol. See [Search space, strategy, and
compatibility](search-strategy.md).

Reasoning/Future retains the following proven soft-layer Git workflow:

L1, L2, and L3 are soft search categories whose descriptions and paths belong to the Target runtime configuration. In `updater-soft` mode the complete catalogue is inserted into every Updater prompt. The Updater is guided to start with the smallest plausible L1 change and expand to L2/L3 only when validation evidence indicates diminishing returns or a deeper mechanism.

- Semantic guidance: the prompt explains all three layers, cumulative writable paths, and prohibited changes.
- Self-declaration: the one allowed commit uses `rsi(l1|l2|l3): ...` to record the chosen layer and direction.
- Lightweight result enforcement: the Controller requires one descendant commit, a clean worktree, a known declared layer, and changed paths within that layer and outside permanent forbidden paths.

The Controller does not select a layer, count three misses, or automatically advance levels in this mode. It retains a commit only for a strict validation improvement and otherwise resets the same worktree to the incumbent. An Updater may explicitly stop an unbounded campaign when no evidence-backed mutation remains. The legacy `controller-sequential` mode remains available for frozen historical campaign definitions.

Generic Experiments map the level-progression semantics of
`controller-sequential` to the Target-independent
`progressive-risk-expansion` SearchStrategy. It tracks consecutive
non-promotions per Branch, expands across Target-owned risk levels, and marks a
Branch exhausted after stagnation at the Recipe risk ceiling.

L1, L2, and L3 are Target Adapter semantics rather than universal directories. A DeepSeek Harness preset and an MSA-derived math Harness live at different paths; the Controller understands only the normalized configured allowlist.

## Feedback and generalization

A Feedback Packet contains aggregate metrics, representative successes and failures, trajectories, verifier outputs, cost, latency, and environment facts without prescribing a fixed causal taxonomy. The Updater infers the change from evidence across cases.

The implemented HLE policy uses one feedback validation partition and one operationally hidden test partition. Promotion is based exclusively on a strict validation increase. Test cannot affect promotion, rollback, retries, level changes, or stopping. A Candidate may affect task-solving behavior but never tasks, final scoring, resource accounting, or promotion rules.

## Benchmark and two-level evaluation

The stable adapters target OmegaUse-OfficeVal and HLE Text-only Math. OfficeVal uses isolated Office workspaces and a separate verifier; HLE pins the dataset revision, validation/test manifests, and judge. Before closure the parent receives only an opaque sealed-Broker completion receipt.

The Solver proposes a replacement for the theorem proof. A separate trusted replay reconstructs that proof in the frozen source template and asks the pinned Lean kernel to compile it. It rejects placeholders, new axioms, changed statements, unsafe file types, and out-of-bound writes. Thus the model chooses mutations without a human-authored failure classifier while correctness remains objective.

The generic normalized-result and partition APIs remain available for adapter experiments. Harbor, KernelBench GPU smoke, SWE-bench, PutnamBench, and Synthetic Text Reasoning remain experimental or compatibility paths rather than stable environments.

## Submodule update semantics

The superproject pins a DeepSeek Harness SHA, making every experiment reproducible. `git submodule update --remote` fetches an upstream revision locally; it becomes a trusted Source Revision only after the new submodule pointer is committed. Existing Candidates retain their original SHA.

## Implemented paths and current boundary

The shared control plane now includes frozen manifests, registered Source resolvers,
Source-plus-Seed Candidate materialization, configurable L1/L2/L3 diff
enforcement, Mutation Catalog/Plan/Lease, registered EvolutionAlgorithm, builtin and sandboxed SearchStrategy,
generic Population/Branch protocols, one-session mutations, Candidate builds,
per-task checkpoints, validation feedback, permission leases, and
implementation/runtime attestation. The HLE path provides child-only sealed tests, strict promotion and rollback,
crash recovery, single-writer locking, FD-only credentials, and post-closure
reports. Generic Experiments prove that MSA Minimal can reuse all five modes and
one SearchStrategy on OfficeVal; HLE uses its dedicated sealed Partition Runner. They fail closed into
`PAUSED_INFRASTRUCTURE`. Cowork Populations support same-Controller-revision
cross-process resume and one-time sealed final after closure. Resume revalidates
the frozen Bundle and Candidates, archives incomplete artifacts, and retains the
failed attempt's resource ledger. Gateway request budgets remain Branch-scoped.
The text tasks are an engineering smoke, not HLE; SWE-bench remains a contract stub.
