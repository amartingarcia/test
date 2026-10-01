# Feature: Terraform infra diagram (merged source repos)

## Objective
Build a reusable diagram-generation tool (skill-like, modeled structurally on
a prior diagram-rendering skill — folder conventions only, not its logic)
that produces an interactive, drill-down architecture diagram of
Terraform-managed infrastructure, merging two source repos into one logical
graph per environment:

- **Repo A ("network")** — VPCs, subnets, security groups, and related
  networking resources, organized per account/environment.
- **Repo B ("infra")** — the rest of the infrastructure (EKS, DNS, databases,
  ...), organized the same way.

GitOps (e.g. ArgoCD ApplicationSets + Helm values repos) is explicitly OUT of
scope for this feature for now — Terraform-only first.

## Hard constraint
The real source Terraform repos this tool is designed against are private
and must stay out of this (public) repo entirely: no absolute paths, no
company/project names, no real account or resource naming conventions beyond
what's needed to describe the generic pattern (e.g. "one directory per
account/environment"). All extraction must copy repo content OUT to a
scratch directory before running `terraform init`/`graph` — never write
inside a source repo.

## Problem / why
A purely declarative/hand-authored diagram drifts from reality the moment
it's drawn. We validated that `terraform graph -type=plan` (after a local
backend override + `terraform init -reconfigure`) produces the real static
dependency graph with zero AWS API calls/credentials. This is the ground
truth source for this diagram.

## Scope (this feature)
- N accounts/environments shared by both repos (real-world example pattern:
  one directory per `<team>_<environment>` combination, e.g.
  `vars/<account>/<account>.tfvars`).
- One merged graph per environment (repo A's module graph + repo B's module
  graph in the same view), with an environment selector in the viewer.
- Interactive drill-down: click an EKS node -> see cluster-level details
  (version, node groups, addons, Pod Identity associations) sourced from the
  Terraform config, not live AWS state.
- Cross-repo linking between repo A and repo B graphs is DECLARATIVE for now
  (manifest-authored), because there is no Terraform remote-state link
  between the two repos in the real-world case this is modeled on (repo B
  discovers repo A's resources via AWS resource tags, not
  `terraform_remote_state`).

## Architecture (3 layers)
- **Layer A — extractor**: per repo, per account: copy repo to scratch dir,
  add `override.tf` (`backend "local" {}`), `terraform init -reconfigure
  -input=false`, `terraform graph -type=plan` -> raw DOT. Parse DOT ->
  normalized nodes/edges JSON.
- **Layer B — manifest**: hand-authored YAML per repo mapping
  resource/module address patterns -> friendly entity id/display
  name/AWS type/boundary group (VPC, EKS, RDS, ...), plus the declarative
  cross-repo link rules (e.g. "repo B's eks module <-> repo A's vpc module
  for same environment").
- **Layer C — compiler + viewer**: merge repo A + repo B extracted graphs per
  environment using Layer B manifests into one JSON graph with compound
  (nested) nodes; viewer = Cytoscape.js + `cytoscape-expand-collapse` for
  drill-down, plus an environment dropdown selector.

## Tasks
- [x] T1 — Scaffold skill directory structure (SKILL.md, bin/, references/,
      schemas/, examples/).
- [x] T2 — Layer A: extractor (`lib/extract/`: `scratch-copy.mjs`,
      `backend-override.mjs`, `terraform-graph.mjs`, `extract-terraform.mjs`)
      that, given a repo path + account name, copies to scratch dir (outside
      the source repo), overrides backend to local, runs `terraform init
      -reconfigure -input=false` + `terraform graph -type=plan`. Built with
      strict TDD (11 tests). Validated against a synthetic offline fixture
      AND a real-world Terraform repo (one real account: 149-node real DOT
      graph, source repo confirmed unchanged via `git status --porcelain`).
      Correction: `terraform graph` does NOT accept `-var-file` (confirmed
      on Terraform 1.14.9) — resolved via copying the account tfvars into
      `terraform.auto.tfvars`. See references/terraform-extraction.md.
      Perf note (not blocking): first real-repo run took ~5 min due to a
      776MB AWS provider download (no plugin cache configured); worth adding
      `TF_PLUGIN_CACHE_DIR` support later to speed up repeated runs.
- [ ] T3 — DOT parser -> normalized nodes/edges JSON schema (resource
      address, type, module path).
- [ ] T4 — Layer B: manifest schema (JSON Schema) + authored manifest for
      repo A (resource/module address pattern -> entity).
- [ ] T5 — Layer B: authored manifest for repo B (incl. EKS detail fields:
      version, node groups, addons, Pod Identity — sourced from static
      config).
- [ ] T6 — Layer C: compiler merging repo A + repo B extracted graphs per
      environment via manifests into one compound-node JSON graph.
- [ ] T7 — Viewer: Cytoscape.js + expand-collapse, environment selector,
      drill-down into EKS node showing config-derived details.
- [ ] T8 — End-to-end validation against at least one environment for both
      repos; confirm zero writes happened inside the source repos (e.g.
      `git status --porcelain` clean).

## Decisions log
- Merged "infra" diagram = repo A (network) + repo B (rest of infra)
  combined into one view. GitOps (appsets/helm-values) explicitly
  deferred/out of scope for now — Terraform only, first.
- Source Terraform repos are read-only; all writes confined to this tool
  repo (and ephemeral scratch directories outside any source repo).

## TDD mode
Strict TDD (test first, red -> green -> refactor) for all testable logic
(parser, compiler, ...), using Node's built-in test runner
(`node --test test/`).

## Next step
T3 — DOT parser.
