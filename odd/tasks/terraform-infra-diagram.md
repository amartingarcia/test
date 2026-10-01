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

## Scope evolution (2026-10-01) — BLOCKING, needs refinement before T3

Original scope assumed: exactly 2 source repos, both pure Terraform, both
following one hardcoded convention (`vars/<account>/<account>.tfvars`).
That assumption no longer holds. New requirement: the tool must **detect**
what kind of repo it's pointed at (not be told), detect the technology/stack
inside it, and correctly relate N repos of possibly different kinds into one
diagram — not just the 2-repo Terraform-only case.

This adds a new layer ahead of Layer A:

- **Layer 0 — Repo classifier** (new): given a repo path, detect repo
  kind(s) present (Terraform, Helm chart, raw Kubernetes manifests, ArgoCD
  Application/ApplicationSet CRDs, Pulumi, CloudFormation/SAM, ...) via file
  fingerprints (`*.tf` + provider blocks, `Chart.yaml`, `apiVersion:` +
  `kind:` YAML, `Pulumi.yaml`, CFN `Resources:` + `Type: AWS::...`), then
  detect the technology/providers actually in use inside that kind (e.g.
  Terraform -> which providers: `aws`, `kubernetes`, `helm`, `azurerm`; raw
  K8s -> which `kind:`s are present: `Deployment`, `ArgoCD Application`,
  `Karpenter NodePool`, ...). Output: a per-repo classification report, not
  a diagram yet.
- Each extractor in Layer A becomes **one of several extractors**, selected
  by what Layer 0 found, instead of a single Terraform-only extractor
  invoked unconditionally.
- Layer B (manifest / entity mapping) and cross-repo linking need to work
  generically across kinds, not just "repo A's vpc module <-> repo B's eks
  module" — e.g. an ArgoCD `Application.spec.source.repoURL` pointing at
  another repo is itself a **detectable** cross-repo link, not something
  that has to be hand-declared every time like the current AWS-tag-based
  network<->EKS link.

## Scope evolution — decisions (resolved 2026-10-01)

1. **Detection scope for v1**: Terraform-only detection first (providers,
   resource kinds). The Layer 0 classifier is a **separate, follow-up
   feature** — not built as part of this feature. This feature (T3–T8)
   stays scoped to the known 2-repo Terraform case.
2. **Classifier mechanism** (applies when that follow-up feature starts):
   static heuristics only (file globs + regex on key fields — `*.tf` +
   `provider` blocks, `Chart.yaml`, `apiVersion:`/`kind:` YAML,
   `Pulumi.yaml`, CFN `Resources:`/`Type: AWS::...`). No LLM-assisted
   classification. Fully offline and deterministic, same philosophy as
   Layer A ("real graph, not invented").
3. **Cross-repo linking**: auto-wire links that are parseable straight from
   config (`terraform_remote_state`, ArgoCD `Application.spec.source.repoURL`)
   without requiring a manifest entry. The manifest (Layer B) stays the
   source of truth only for links that need external knowledge no file
   encodes (e.g. the current AWS-tag-based network<->EKS link — there is no
   `terraform_remote_state` between the network and infra repos in the
   real-world case this is modeled on, confirmed in Layer A validation).
4. **Delivery order**: T3–T8 (Terraform-only, 2 repos) ship first and are
   validated end-to-end. The Layer 0 classifier + multi-kind extractors
   (Helm, raw K8s, ArgoCD, Pulumi, CloudFormation, ...) are a **new feature
   doc**, written after this one closes, that reuses Layer A's Terraform
   extractor as "the Terraform case" of a now-pluggable extractor registry.

## Next step
Resume T3 — DOT parser (`lib/parse/`): raw DOT string -> normalized
nodes/edges JSON (resource address, type, module path). Strict TDD, same as
Layer A.
