# Model-specific guidance

The output quality depends on the model running the skill. The pipeline is the same; what changes is how much structure and verification you impose. Never skip the verification loop, whatever the model.

## Common rules (all models)

- Work from the real extracted data; copy resource types and addresses verbatim from the DOT graph, never from memory.
- One manifest rule per distinct resource type; keep a written list of types seen vs types covered.
- After every manifest edit: lint, compile, read coverage. Stop only when `unmapped`, `unresolvedBoundaries` and `unresolvedPlacements` are empty or explained.
- Unsure about a kind, a flag, an attribute name or a placement: say so and ask; do not invent.

## Small / fast models (Haiku-class)

Follow the steps literally, one at a time, and write intermediate artifacts to files:

1. `types.txt`: sorted unique `type` values from the DOT nodes.
2. Draft the manifest in small batches (max ~10 rules), lint after each batch.
3. Use only kinds present in `catalog/providers/<provider>.json` (list them first). If a type has no kind, mark it `ignore` or add a catalog entry copying the closest existing one, and flag it in the report.
4. Do not use `boundary` or `crossRepoLinks` unless the placement report explicitly asks for it.
5. Never edit extractor/compiler code. If a value stays unresolved, report it.
6. Final answer: counts (types, mapped, ignored, unmapped), remaining warnings, nothing else.

## Mid-size models (Sonnet-class)

Same loop, but batches can be whole files. You may add catalog entries for new kinds and use `boundary`/`nest` when lint and coverage show it is needed. Cross-check entity counts against resource counts per type for each environment (tfvars). Explain every difference.

## Large models (Opus/Mythos-class)

More autonomy: design the kind taxonomy, propose catalog extensions, wire cross-repo links and inference improvements. Still mandatory: lint + coverage loop, per-environment count reconciliation, and a short list of assumptions and unresolved items for the user. Prefer a small test (`test/*.test.mjs`, node:test) for any change to library code.

## Failure signals (any model)

Manifest passes lint but entities are missing, kinds without catalog entry, many `unresolvedPlacements`, resources with `count = 0` shown, values shown as resolved that were conditional on unknown vars. Treat each as a stop-and-fix, not as noise.
