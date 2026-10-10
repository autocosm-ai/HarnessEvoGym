# Search Space, Strategy, and Compatibility

English | [中文](search-strategy.zh.md)

## In one sentence

The Target says which modules may change. The SearchStrategy says which of them
to try this round. The Updater diagnoses the Bad Cases and actually edits the
code. The Controller issues the lease, validates, scores, and rolls back.

```text
Target Catalog              SearchStrategy              Controller
which Regions are searchable -> parent Candidate + Region IDs -> validate + MutationLease
                                                              |
                                                              v
Feedback ---------------------------> Updater ---------> Candidate Diff
                                                              |
                                                              v
                                                   Solver -> Evaluator -> Gate
```

With this split, a search algorithm can be linear hill climbing, round robin, a
bandit, an evolutionary algorithm, or a population algorithm. None of them need
to know the real directory layout of DSH or pi-agent.

## Three distinct concepts

| Concept         | Defined by        | Role                                                                 |
| --------------- | ----------------- | -------------------------------------------------------------------- |
| Risk Level      | Target            | L1/L2/L3 express a risk ceiling, not a search algorithm              |
| Mutation Region | Target            | A stable searchable module of one Harness: paths, extensions, deps   |
| Search Strategy | Controller author | Chooses only a parent Candidate and Region IDs; owns no write access |

The current DSH Cowork catalog is:

| Region ID            | Risk | Meaning                                     |
| -------------------- | ---- | ------------------------------------------- |
| `preset-composition` | L1   | Preset composition and declarative config   |
| `skill-guidance`     | L1   | Skill docs, prompts, and working methods    |
| `skill-scripts`      | L2   | Controlled script implementations in Skills |

## Four enforcement boundaries

- The Target Adapter first declares both the legacy L1/L2/L3 permissions and the
  new Catalog. The Controller proves that the union of all Regions under a risk
  ceiling equals the legacy permission set, and refuses to start otherwise.

- The SearchStrategy returns a `MutationPlan` that may contain only `generation`,
  `parentIds`, and `regionIds`. Smuggled `writable`, task records, final results,
  or credential fields are rejected outright.

- The Controller validates the parent Candidate, risk ceiling, Region
  dependencies, and conflicts, then translates Regions into a one-round
  `MutationLease` itself. A SearchStrategy can never specify paths.

- After the Updater finishes, the Controller re-snapshots and re-diffs the entire
  Candidate tree and enforces paths, extensions, file size, executable bit,
  symlinks, and DSH/Cordis semantics. The Mutation Report is not an authorization
  artifact.

## Built-in compatible strategy

`adapters/strategies/linear-hill-climb.yml` is the default. Each round it:

- picks the current Champion as the parent Candidate;

- selects every Region under the risk ceiling;

- promotes on a passing evaluation and otherwise keeps the Champion.

When a legacy `EvolutionExperiment` has no `spec.adapters.strategy`, the loader
injects this strategy automatically. Because the Catalog is proven permission-
equivalent at startup, the actual writable set of a legacy L1/L2 experiment does
not change.

## Progressive risk expansion

`adapters/strategies/progressive-risk-expansion.yml` generalizes HZY's level
progression. It knows no DSH, MSA, or PI Agent paths and uses only the risk levels
and Regions declared by the current Target Catalog:

- each Branch starts at `startRiskLevel`, L1 by default;

- the round selects every Region at or below the Branch's active risk level;

- a promotion clears the consecutive-miss counter and stays at the current level;

- after `missesBeforeExpansion` consecutive non-promotions, it expands to the next
  level defined by the Target;

- once no higher level remains within the Recipe `riskCeiling` and the threshold is
  reached again, it returns `exhausted=true`. The Controller marks that Branch as
  stopped and stops allocating Population budget to it.

So `combined + progressive-risk-expansion` means Branches share evidence and
compete for budget, while each Branch independently walks L1 -> L2 -> L3.

It does not replace the default strategy of existing experiments. The complete,
directly loadable example is:

```text
experiments/reasoning-msa-progressive-strict-smoke.json
  -> recipes/progressive-risk-expansion/single.yml
  -> adapters/strategies/progressive-risk-expansion.yml
  -> evaluation/policies/strict-mean-reward-improvement.json
```

The Recipe gives a Single Branch at most nine rounds, exactly covering the default
`three L1 misses -> three L2 misses -> three L3 misses -> exhausted`. The strict
policy requires at least one Reward improvement and zero Reward regressions, so
`0 -> 0` and `1 -> 1` are both rejected and cannot wrongly reset the strategy's
consecutive-miss counter.

## External Contributor Strategy

External algorithms use `docker-json-v1` and exchange one JSON document over
stdin/stdout without being imported into the Controller. The runtime is fixed:

- `--network none`;

- no bind mounts;

- no host environment variables or credentials;

- read-only root filesystem with only a 16 MiB temporary directory;

- CPU, memory, PID, and timeout limits enforced by the Adapter;

- the image pinned to a `sha256` RepoDigest.

The core fields of a `propose` request are:

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "SearchStrategyRequest",
  "operation": "propose",
  "strategy": { "id": "my-strategy", "configuration": {} },
  "state": null,
  "context": {
    "generation": 1,
    "riskCeiling": "l1",
    "catalog": {},
    "championId": "h0",
    "allowedParentIds": ["h0"],
    "candidates": [],
    "searchHistory": []
  }
}
```

The response may return only strategy state and a Plan:

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "SearchStrategyResponse",
  "operation": "propose",
  "state": { "cursor": 1 },
  "plan": {
    "apiVersion": "harness-rsi/v1alpha1",
    "kind": "MutationPlan",
    "metadata": { "id": "generation-0001-my-strategy" },
    "spec": {
      "generation": 1,
      "parentIds": ["h0"],
      "regionIds": ["skill-guidance"]
    }
  }
}
```

Besides updated `state`, an `observe` response may return `exhausted: true` to ask
the Controller to mark the current Branch as search-exhausted. That signal can
only stop the current Branch; it cannot widen permissions or change scoring.

See `strategies/examples/round-robin/`. Its Adapter template is
`adapters/strategies/docker-round-robin.example.yml`:

```bash
docker build -t harness-rsi-round-robin:local strategies/examples/round-robin
# After pushing to a registry and obtaining the RepoDigest, replace the image in the example Adapter.
npm run rsi -- adapter validate --config adapters/strategies/docker-round-robin.example.yml
```

## Driver plugin boundary

Solver, Updater, and Environment implementations are no longer hard-branched in
the main orchestration loop; they are resolved through a versioned Driver
Registry. The built-in protocols are DSH, MSA Minimal, OmegaUse-OfficeVal, and
Synthetic Text Reasoning; the legacy `dsh-headless-docker` protocol name still
works.

This is a trusted extension interface, but it does not mean pi-agent is already
plug-and-play. The repository already implements a registrable Source Resolver,
Candidate Materializer, and Candidate Validator, and proves one non-DSH Target
end to end with MSA Minimal. A new Harness still has to contribute its own Adapter
Schema and Source/Seed/Materialization lifecycle as reviewed code, then call
`registerSolverDriver`, `registerUpdaterDriver`, or `registerEnvironmentDriver`.
Once that is done, the main evolution loop no longer needs to understand its
execution details.

Drivers actually execute Harnesses and mount workspaces, so they are trusted
Controller code; a SearchStrategy only makes algorithmic decisions and can run in
a network-isolated Docker sandbox. The two Contributor interfaces are not at the
same trust level.

## Current compatibility matrix

| Execution plane                 | Search configuration                  | Mutation enforcement             | Status                     |
| ------------------------------- | ------------------------------------- | -------------------------------- | -------------------------- |
| Generic `experiment` Population | EvolutionRecipe + SearchStrategy      | Catalog -> Plan -> Lease -> Diff | Cowork/Reasoning shared    |
| Legacy Reasoning `campaign`     | Five `controller_config.mode`s        | Git commit + layer path audit    | Existing HZY behavior kept |
| Legacy Cowork experiment        | No Recipe/Strategy                    | Single + all-Region lease        | Fully compatible           |
| Legacy Target adapter           | No `mutation.catalog`                 | Each L1/L2/L3 mapped to Regions  | Fully compatible           |
| MSA Minimal Target              | Target-owned Cowork/Reasoning Catalog | Hard lease + semantic validator  | End-to-end implemented     |

The Reasoning/Future production path still uses its proven single-commit Updater,
sealed broker, and Git lineage. The new Text Reasoning smoke uses the generic
Experiment path and can already combine the same SearchStrategy with all five
Population modes; it proves engineering compatibility, not replacement of HLE
production evaluation.
