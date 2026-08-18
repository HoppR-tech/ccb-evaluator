# OhMyForm v1 rule pack

This public directory contains the versioned TypeScript architecture rules used for an OhMyForm campaign.

The candidate agent does not receive this directory during a benchmark run. The benchmark harness isolates the agent workspace, removes outbound network and GitHub access, and invokes the evaluator only after the task completes. See [`docs/architecture.md`](../../../docs/architecture.md).

Each campaign manifest records the rule-pack revision. The evaluator returns aggregate results; detailed dependency diagnostics are retained by the evaluator job rather than sent to the agent.
