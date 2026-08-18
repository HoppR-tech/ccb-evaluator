# Campaign manifests

Each completed campaign must persist an immutable manifest containing:

- target repository URL and pinned target revision;
- base and candidate SHA or patch digest;
- campaign ID;
- evaluator image digest;
- private rule-pack revision or digest;
- model, prompt, tool, token, and step-budget provenance;
- aggregate functional and architectural results.

Manifests must not include active rule text, credentials, raw diagnostics, or dependency graphs.
