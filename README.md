# CCB Evaluator

Public static-analysis runner and reproducibility protocol for [CodeConform-Bench](https://github.com/HoppR-tech/codeconform-bench).

## Transparent rules, isolated agents

This repository publishes the evaluator runner, its input/output contract, active rule packs, sample fixtures, campaign manifests, and the versions used to execute evaluations.

CCB prevents rule access during a benchmark by isolating the agent—not by hiding the rules:

- Agent tools receive only the candidate workspace; this repository is not mounted or cloned.
- The agent execution container has no outbound network, GitHub credential, browser relay, or web-search capability.
- OpenRouter model traffic is brokered by a host-side gateway outside the agent sandbox.
- The evaluator runs after the candidate task on separate ephemeral compute.
- An egress-canary check must prove the sandbox cannot reach `github.com`.

This provides operational isolation, not a cryptographic blind test. Public rules may eventually be learned by models or humans outside the sandbox; campaigns must record model version/date and disclose that residual risk.

See [the evaluator architecture](docs/architecture.md). The implementation follows GitHub's secure-use guidance for untrusted workflow code.

## Layout

- `runners/typescript/evaluate.mjs` — static TypeScript evaluator.
- `test/fixtures/` — public runner fixtures.
- public OhMyForm v2 code-quality rules — public rule-pack location.
- `manifests/campaigns/` — immutable campaign provenance records.

## Runner contract

```sh
node runners/typescript/evaluate.mjs \
  --candidate /readonly/candidate \
  --rule-config /readonly/rules/config.cjs \
  --result /results/evaluation.json
```

The runner writes one versioned evaluation JSON object after the candidate agent has finished.
Scores are normalized to `[0, 1]`. `evidence.schemaVersion` versions the human-audit contract:
every dimension contains stable check IDs, pass/fail status, mandatory status, earned and maximum
points, observed values, comparison operators, thresholds, bounded candidate-relative
`file:line` snippets, and complete dependency paths. The evidence also contains every evaluated
source/test file as complete redacted scored-source content with its original SHA-256 digest, plus
the complete normalized dependency graph. The overall and dimension totals, qualification
decision, and violation count can therefore be recomputed and every awarded absence/maximum claim
can be inspected from the canonical result.

```json
{
  "status": "passing",
  "violations": 0,
  "qualityScore": 1,
  "qualityQualified": true,
  "dimensions": {
    "architecture": 1,
    "maintainability": 1,
    "clarity": 1,
    "tests": 1,
    "robustness": 1
  },
  "evidence": {
    "schemaVersion": 1,
    "overall": {
      "score": 1,
      "earned": 100,
      "max": 100,
      "qualifiedThreshold": 0.7,
      "qualified": true
    },
    "dimensions": [
      {
        "dimension": "architecture",
        "score": 1,
        "earned": 45,
        "max": 45,
        "weight": 30,
        "minimum": 0.75,
        "qualified": true,
        "checks": []
      }
    ],
    "inventory": {
      "sourceFileCount": 5,
      "testFileCount": 1,
      "fileCount": 6,
      "files": [],
      "omittedUnsafePathCount": 0,
      "filesTruncated": false
    },
    "sources": [
      {
        "path": "api/src/application/start-submission.ts",
        "digest": "sha256:...",
        "lineCount": 12,
        "redactionCount": 0,
        "content": "import ..."
      }
    ],
    "structure": {
      "nodes": [],
      "nodeCount": 0,
      "nodesTruncated": false,
      "edges": [],
      "edgeCount": 0,
      "edgesTruncated": false
    }
  }
}
```

The abbreviated arrays above omit records for readability. Each scoring check has this shape:

```json
{
  "id": "maintainability.max-function-lines",
  "dimension": "maintainability",
  "title": "Functions stay within the line limit",
  "status": "passed",
  "mandatory": false,
  "earned": 1,
  "max": 1,
  "violations": 0,
  "observed": 12,
  "operator": "lte",
  "threshold": 80,
  "expected": "at most 80 lines",
  "locations": [
    {
      "path": "api/src/application/start-submission.ts",
      "line": 4,
      "endLine": 8,
      "snippet": "export class StartSubmission {"
    }
  ],
  "locationCount": 1,
  "locationsTruncated": false,
  "paths": [],
  "pathCount": 0,
  "pathsTruncated": false
}
```

Possible statuses are `passing`, `failing`, and `evaluator_error`. The rule pack versions the
dimension weights, minimums, qualification threshold, and architecture check IDs. A candidate is
`passing` only when its weighted quality score and every dimension minimum pass. Dependency
boundaries and TypeScript source metrics are evaluated deterministically.

`evaluator_error` is a versioned safe contract rather than an empty sentinel:

```json
{
  "status": "evaluator_error",
  "diagnostic": {
    "schemaVersion": 1,
    "phase": "dependency_analysis",
    "code": "dependency_analysis_failed",
    "reason": "dependency analysis did not produce a valid graph"
  }
}
```

Stable producer phases are `candidate_inspection`, `rule_pack`, `dependency_analysis`,
`source_analysis`, `serialization`, and `internal`. Codes distinguish inaccessible/invalid/oversized
candidate trees, unsafe candidate paths, invalid rule packs, failed dependency or source analysis,
serialization overflow, and an unexpected internal failure. Reasons are redacted, free of host
paths, and capped at 240 characters. Evaluator failures remain distinct from candidate failures and
never carry a partial score or evidence payload.

Raw dependency-cruiser output is never emitted because it contains host paths, environment data,
and unrelated analyzer internals. Canonical evidence instead accepts normalized
candidate-relative Unicode paths, redacts likely credentials (including URL userinfo) while
retaining source line structure, caps inline snippets/diagnostic lists, and preserves every
score-determining path, every evaluated source, and every normalized graph edge. If the complete
canonical sources or result exceed their fixed safety limits, the failure contract reports the
responsible phase/code rather than a score with incomplete proof. The evidence is produced
post-agent and is never returned to the model.

## Local verification

```sh
npm ci --ignore-scripts
npm test
```

The fixtures calibrate the public runner contract and active OhMyForm rule pack; campaign repositories remain responsible for functional verification.
