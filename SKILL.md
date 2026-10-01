---
name: infra-diagram
description: Generate interactive, drill-down architecture diagrams of real AWS/Terraform/Kubernetes infrastructure by extracting the static dependency graph directly from Terraform configuration (via `terraform graph`, no cloud credentials required) and compiling it into a browser-based explorable diagram with environment selection and per-resource detail panels (e.g. EKS cluster version, node groups, addons). Use when the user asks to visualize, catalog, or audit real infrastructure topology across one or more Terraform repositories, and wants to navigate from a bird's-eye view down into a specific resource's configuration.
license: MIT
metadata:
  version: "0.1"
  structurally_based_on: archify (skill folder conventions only, not logic)
---

# Infra Diagram

Turn one or more Terraform repositories into a single interactive, drill-down
infrastructure diagram — grounded in real configuration, not hand-drawn.

Unlike a generic diagram renderer, this skill has domain knowledge of
Terraform/AWS/Kubernetes resource relationships: it reads the actual
`terraform graph` dependency graph (static, offline, no AWS credentials
needed) instead of asking the user to describe the architecture.

## Why not just describe the diagram in JSON?

Infrastructure diagrams drift from reality the moment they are hand-authored.
This skill extracts the graph from the source of truth (Terraform
configuration) so the diagram self-updates when the repo changes, and so
`terraform graph` evidence — not assumption — decides what connects to what.

## Workflow (3 layers)

1. **Extract** (`lib/extract/`) — for each target repo + account/environment:
   copy the repo to a scratch directory (never write inside the source repo),
   override the backend to `local`, run `terraform init -reconfigure
   -input=false` then `terraform graph -type=plan -var-file=<account>.tfvars`.
   This resolves the static module/resource dependency graph with zero AWS
   API calls. See [Terraform extraction](references/terraform-extraction.md).
2. **Compile** (`lib/compile/`) — parse the raw DOT graph into normalized
   nodes/edges (`lib/parse/`), then apply a hand-authored manifest
   (`schemas/manifest.schema.json`) per repo that maps resource/module
   addresses to friendly entities (id, display name, AWS type, boundary
   group), and declares any cross-repo links that are not expressible as a
   Terraform dependency (e.g. network \<-\> EKS discovered via AWS tags, not
   `terraform_remote_state`). Multiple repos' compiled graphs merge into one
   per-environment JSON graph with compound (nested) nodes.
3. **Render** — the compiled JSON drives a Cytoscape.js viewer with
   expand/collapse compound nodes (bird's-eye view that drills down into e.g.
   an EKS node to show cluster version/node groups/addons) and an
   environment selector when multiple accounts share one view.

## When to activate

- The user wants a diagram of real infrastructure (not a conceptual sketch)
  and has one or more Terraform repositories to point at.
- The user wants to navigate into a specific resource (EKS, RDS, VPC, ...)
  for its real configuration details, not just see a box on a canvas.
- The user has infrastructure split across multiple repos (network, app
  infra, GitOps) and wants them correlated into one view, or several
  consistent views keyed by the same join rules.

## Constraints (hard rules, always apply)

- **Never write inside a source repository.** Extraction always copies repo
  content to a scratch directory first; `override.tf` and any Terraform
  state/plan artifacts are created only in that scratch copy.
- **No cloud credentials are required or used** for extraction — `terraform
  graph -type=plan` only resolves static configuration, it never
  refreshes/executes. If a requested detail genuinely requires live AWS/K8s
  state (not present in the static config), say so explicitly instead of
  inventing it.
- Resource-to-entity friendly naming always goes through the manifest layer
  (Layer B); never hardcode repo-specific knowledge into the extractor or
  parser.

## References

- [Terraform extraction](references/terraform-extraction.md) — scratch-dir
  copy procedure, backend override, account/tfvars resolution.
- [Manifest authoring](references/manifest-authoring.md) — how to map
  resource addresses to entities and declare cross-repo links.
