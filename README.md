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
- public OhMyForm v1 architecture rules — public rule-pack location.
- `manifests/campaigns/` — immutable campaign provenance records.

## Runner contract

```sh
node runners/typescript/evaluate.mjs \
  --candidate /readonly/candidate \
  --rule-config /readonly/rules/config.cjs \
  --result /results/aggregate.json
```

The runner writes one aggregate JSON object:

```json
{"status":"passing","violations":0}
```

Possible statuses are `passing`, `failing`, and `evaluator_error`. A non-zero dependency-cruiser result becomes `failing`; raw analyzer output is not emitted.

## Local verification

```sh
npm ci --ignore-scripts
npm test
```

The fixtures demonstrate the runner contract only. They are not an OhMyForm campaign rule pack.
