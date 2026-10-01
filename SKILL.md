---
name: infra-diagram
description: Generate interactive, drill-down architecture diagrams of real AWS/Terraform/Kubernetes infrastructure from the Terraform source itself (offline `terraform graph` + HCL attribute extraction, no cloud credentials), compiled into a browser viewer with environments (one per tfvars), nested containers (VPC > subnet > EKS > node group > workloads), per-resource detail panels, selectable styles and PNG/PDF export. Use when the user wants to visualize, catalog or audit real infrastructure topology across one or more Terraform repos.
license: MIT
metadata:
  version: "0.2"
---

# Infra Diagram

Real Terraform in, interactive architecture diagram out. The diagram is derived,
never hand-drawn: if something cannot be resolved from the source it is reported
(coverage / unresolved placements), not guessed.

## Pipeline

1. **Extract (A)** `lib/extract/` — scratch copy of the repo (never write in the source repo), local backend override, `terraform graph -type=plan` with the environment's tfvars as `terraform.auto.tfvars`. Offline, no credentials. See [terraform-extraction](references/terraform-extraction.md).
2. **Details (A2)** `lib/extract/extract-resource-details.mjs` + `lib/parse/` — HCL attributes (nested blocks flattened to dotted keys), resolved against tfvars: literals, `var.x`, lists/objects, `cond ? a : b`. Unresolvable values are returned as `{resolved:false, raw}`, never coerced. `count` resolving to 0 = resource not instantiated.
3. **Manifest (B)** per repo, hand/model-authored: ordered rules, first match wins, mapping resource addresses to entities (`kind`, `idFrom`, `boundary`, `embed`) or `ignore`. See [manifest-authoring](references/manifest-authoring.md).
4. **Compile (C)** `lib/compile/compile-environment-graph.mjs` — merges repos into one compound graph per environment. Placement precedence: explicit `boundary` > cross-repo `nest` link > `inferPlacement` (references found in source) > catalog kind-level placement. Ambiguity is reported in `unresolvedPlacements`.
5. **Catalog** `catalog/kinds.json` — the "architect": what goes inside what, ordering, glyph per kind. See [catalog](references/catalog.md).
6. **Viewer** `viewer/` — Cytoscape; 4 styles (Blueprint, Draft, Neon, Soft) x light/dark, zoom, expand/collapse, fixed layout (no dragging), PNG/PDF export, `#env=<id>&style=<preset>` links.

Kubernetes (rendered manifests, Karpenter, ArgoCD) has its own layer: see [kubernetes](references/kubernetes.md).

Environments = tfvars files: each one is compiled separately and may yield a different infrastructure.

## Workflow when asked to diagram a repo

1. Identify repos, environments (tfvars) and which one is the target. Ask once if missing.
2. Extract the DOT graph per environment (A). If `terraform` is not available, stop and say so; do not fabricate a graph.
3. List resource types present; author the manifest (B) following the checklist.
4. **Always** run `node scripts/lint.mjs <manifest.json>` and fix every error; read each warning.
5. Compile and inspect coverage: `unmapped`, `unresolvedBoundaries`, `unresolvedPlacements`. Iterate on the manifest/catalog until each is empty or consciously accepted.
6. Compare entity counts with `terraform` resource counts per type; explain the difference (ignored helpers, `count = 0`).
7. Report to the user: what was mapped, what is unresolved and why.

Follow the model-specific rules in [model-guidance](references/model-guidance.md).

## Hard rules

- Never write inside a source repository; extraction works on a scratch copy.
- No credentials. If a detail needs live state, say it is unavailable.
- Real manifests and compiled data of private infrastructure must not be committed to public repos; only synthetic data (`examples/`).
- Never invent kinds, ids, resource types, flags or attributes. Unknown = ask or report.
- Repo-specific knowledge lives in the manifest, never in extractor/parser code.

## Status

End-to-end validation against real multi-module repos (spec task T8) is pending; the sample pipeline is `scripts/build-platform-sample.mjs` (synthetic data in `examples/sample-platform/`).
