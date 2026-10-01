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
- [x] T3 — DOT parser (`lib/parse/parse-resource-address.mjs` +
      `lib/parse/parse-dot-graph.mjs`) -> normalized nodes/edges JSON
      (resource address, type, module path, data-source flag, count/for_each
      index). Strict TDD (16 new tests). Handles module nesting at any
      depth, filters out non-resource DOT nodes (`provider[...]`, bare
      module boundary nodes, `var./local./output./meta.` references), and
      registers an edge endpoint as a node even without its own `[label=]`
      line so no real resource silently drops. Fixtures are synthetic DOT
      text (no `terraform` binary in this sandbox — see caveat below), but
      the base two-resource shape is kept byte-for-byte in sync with the
      regex already asserted against *real* `terraform graph` output in
      `test/terraform-graph.test.mjs`. Also fixed `package.json`'s `test`
      script: `node --test test/` silently tried to `require` a file named
      `test` instead of globbing the directory on this Node version; changed
      to `node --test "test/**/*.test.mjs"`.
      **Caveat (not blocking, tracked for later):** this sandbox has no
      `terraform` binary, so T3 could not be re-validated against a fresh
      real multi-module DOT graph the way T2 was. Module-nesting and
      provider-filtering behavior is modeled on documented/standard
      `terraform graph` DOT output, not re-confirmed against a live run.
      Re-validate against a real repo (e.g. the 149-node graph from T2) the
      next time this runs somewhere with `terraform` installed, before
      trusting T3 output for anything beyond the synthetic fixtures.
- [x] T4 — Layer B: manifest schema (`schemas/manifest.schema.json`, JSON
      Schema reference) + structural validator (`lib/manifest/validate-manifest.mjs`,
      hand-rolled, zero-dependency — same philosophy as Layer A, no ajv) +
      matcher (`lib/manifest/match-entity.mjs`): first-match-wins rules on
      `type`/`isData`/`modulePathPrefix`/`nameRegex`, three `idFrom`
      strategies (`name`/`address`/`literal`), optional `boundary`. Strict
      TDD (18 new tests across matcher + validator). Authored
      `examples/manifests/network.example.manifest.json` — **generic**
      placeholder manifest (vpc/subnet/sg/nat/igw/route-table/az-lookup)
      illustrating the pattern per the hard constraint (no real repo
      naming); exercised end-to-end in
      `test/network-example-manifest.test.mjs` (DOT -> parseDotGraph ->
      matchEntity, 7/7 nodes mapped, boundary wiring asserted). The
      **real** repo A manifest (authored against the actual network repo's
      resource types) is a separate step once T6+ need it — out of scope
      for a public repo per the hard constraint.
- [ ] T5 — BLOCKED on a real architecture gap, see below. Layer B: authored
      manifest for repo B (incl. EKS detail fields: version, node groups,
      addons, Pod Identity — sourced from static config).

### T5 blocker: `terraform graph` carries zero attribute values

`terraform graph -type=plan` (Layer A's only extraction mechanism so far)
emits **only** the dependency graph: resource addresses and edges between
them. It does not resolve or expose a single attribute value — no EKS
`version`, no node group config, nothing. T5's requirement (drill into an
EKS node and see real version/node-groups/addons) needs attribute-level
data that does not exist anywhere in what's been extracted so far. This
needs a new Layer A2 (attribute extraction), and the right mechanism
depends on a trade-off the hard constraint (`zero AWS credentials, fully
offline`) narrows down:

- **Option A — parse HCL resource block bodies directly** (regex/line-based,
  zero-dependency, consistent with this repo's existing style). Captures
  *literal* attribute values (`version = "1.29"`) correctly. Values that
  come from a variable (`version = var.eks_version`) need a second step:
  resolve `var.eks_version` against the account's already-available
  `.tfvars` content (same file Layer A already copies into
  `terraform.auto.tfvars`) — doable for simple cases, not for computed
  locals or cross-module references without writing a mini expression
  evaluator. Unresolved values must be reported as `"unresolved: <expr>"`,
  never guessed.
- **Option B — `terraform-config-inspect`** (HashiCorp's own shallow HCL
  inspector, shells out like `terraform graph` does). Same fundamental
  limitation as Option A — it returns raw attribute *expressions*, not
  evaluated values — but the HCL parsing itself is already solved and
  battle-tested instead of hand-rolled. Could not be installed in this
  sandbox to prototype against (network-restricted; blocked by this
  session's proxy), so unverified here — would need checking in an
  environment where `terraform`/apt access already works (the same one T2
  was validated in).
- **Option C — `terraform plan` + `terraform show -json`** gives fully
  *resolved* values (after variable interpolation) with no manual
  expression evaluation needed. Rejected as the default: planning a real
  repo very likely touches data sources that call the live AWS API (e.g.
  `data.aws_availability_zones`, `data.aws_ami`) even for a plan of
  not-yet-existing resources, which breaks the "zero credentials, fully
  offline" hard constraint T1–T4 have held to throughout. Only viable if
  that constraint is deliberately relaxed for this one layer.

### T5 resolution: Layer A2 (attribute extraction), Option A implemented

Decision confirmed: parse HCL directly + resolve `var.X` against the
account's `.tfvars` (already available from Layer A). Built as four
composable, independently-tested primitives rather than one big function:

- `lib/parse/parse-hcl-blocks.mjs` — raw HCL text -> top-level `{blockType,
  labels, body}` blocks. Purpose-built brace-depth scanner (not a general
  HCL parser): correctly ignores braces inside string literals (incl.
  escaped `\"`/`\\`) and `#`/`//` comments. Known limitation: does not
  handle heredoc strings (`<<EOT`) — flagged in the docstring, not silently
  wrong.
- `lib/parse/parse-hcl-attributes.mjs` — a block body -> top-level `key =
  value` pairs as **raw, unparsed text** (scalars, full nested
  objects/lists kept verbatim). Skips nested blocks (`lifecycle { ... }`,
  labeled sub-blocks) entirely rather than misreading them as attributes.
- `lib/parse/resolve-hcl-value.mjs` — resolves one raw value into a real JS
  value when it's simple enough: quoted string/number/bool/null literals,
  and `var.NAME` looked up in a resolved vars map. Everything else (string
  interpolation, `local.x`, nested objects/lists) comes back
  `{resolved: false, raw}` — **never guessed**.
- `lib/parse/parse-tfvars.mjs` — `.tfvars` content -> resolved `{name:
  value}` map, built on the same two primitives above (tfvars syntax is a
  subset of attribute assignment). A list/map tfvars value is omitted
  (not guessed) from the map.
- `lib/extract/find-resource-block.mjs` + `lib/extract/extract-resource-details.mjs`
  — Layer A2 entrypoint: given a repo's `.tf` files + a target `{blockType,
  labels}` + resolved vars, finds the block and returns every attribute (or
  just `detailFields` the manifest asks for) resolved or honestly flagged
  unresolved.

33 new tests, strict TDD throughout. 81/83 total (the 2 failures remain the
pre-existing terraform-binary-dependent Layer A tests).

**Architecture clarification that falls out of this** (not yet
implemented, affects T6/T7): EKS "node groups" and "addons" are not nested
attributes inside the `aws_eks_cluster` resource in real Terraform — they
are **separate resources** (`aws_eks_node_group.*`, `aws_eks_addon.*`)
connected to the cluster via a real `terraform graph` dependency edge
(e.g. an addon references `cluster_name = aws_eks_cluster.this.name`).
So "drill into EKS -> see node groups/addons" is Layer C's job (compose
child entities whose edges point at the cluster, via `boundary` + the
already-extracted graph edges), not Layer A2's — A2 only needs to resolve
each *individual* resource's own scalar fields (the cluster's `version`,
each node group's `instance_types`/`min_size`, each addon's
`addon_version`). Layer B manifest rules for `aws_eks_node_group` /
`aws_eks_addon` should set `boundary` to the cluster entity's id so Layer C
can nest them under it.
- [ ] T6 — Layer C: compiler merging repo A + repo B extracted graphs per
      environment via manifests into one compound-node JSON graph.
- [ ] T7 — Viewer: Cytoscape.js + expand-collapse, environment selector,
      drill-down into EKS node showing config-derived details.
- [x] T7b — Viewer redesign: blueprint grid, neon glow per kind, animated link
      flow (toggle), focus-on-select (dims non-neighbours), one-time entrance
      animation, light/dark theme (persisted, follows `prefers-color-scheme`),
      zoom HUD (+/-/reset/fit, wheel, keys `+ - 0 F`). Verified live.
- [x] T5b — Real-world probe against `futurice/terraform-examples/aws/aws_vpc_msk`
      (public; flat root config + tfvars). Found and fixed in
      `parseHclAttributes`: unquoted values were cut at the first space (raw
      `merge(` instead of the whole call; worse, `1 + 2` was captured as `1`
      and resolved as a number — a silent guess). Now an unquoted value runs
      to end of line / top-level comma, balancing `()[]{}` and strings, and
      heredocs (`<<EOF`, `<<-EOT`) are captured whole (never resolved).
      Remaining unresolved-by-design in that repo: `count`/`for_each`
      resources, `merge(...)`, `element(split(...))`, `local.*`, data refs.
      Notes on the AWS examples in general: most are root configs; several
      pull modules from the registry (`terraform-aws-modules/vpc`) or
      `git::ssh://` (needs network/keys at `terraform init`), so Layer A needs
      module download access — only `aws_vpc_msk` is fully self-contained.
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

- [x] T6 — Layer C: compiler (`lib/compile/compile-environment-graph.mjs`)
      merging N repos' graphs into one compound-node graph per environment.
      Compiled entity ids are repo-scoped (`<repoId>:<kind>:<id>`) to
      guarantee uniqueness across repos without coordination. Three
      resolve-or-report rules, consistent with every prior layer:
      (1) a node with no manifest match is **unmapped** — dropped from
      `entities`, listed in `coverage[repoId].unmapped`, never silently
      lost; (2) an entity's `boundary` (target kind, see T5's boundary
      convention fix) resolves to `parent` only when exactly one entity of
      that kind exists in the *same* repo — ambiguous (0 or 2+) is
      `parent: null` + `coverage[repoId].unresolvedBoundaries`; (3) a
      declarative `crossRepoLinks` rule (`{fromKind, toKind, label}`, the
      "repo A's vpc <-> repo B's eks" case from the original scope) wires
      an edge only when exactly one entity of each kind exists across all
      repos combined — otherwise `unresolvedCrossRepoLinks`, not guessed.
      An edge is kept only when both endpoints are mapped entities. 8 new
      tests (merge, edge translation+dropping, unmapped-node reporting,
      boundary resolution happy/zero/ambiguous paths, cross-repo link
      happy/ambiguous paths), strict TDD. 89/91 total (2 pre-existing
      terraform-binary failures, unaffected).
      **Not yet implemented**: `terraform_remote_state`-based auto-wiring
      (decided earlier as the auto-wire mechanism alongside declarative
      `crossRepoLinks`) — deferred because neither target repo actually
      uses `terraform_remote_state` between them (confirmed in the
      original scope doc), so there was nothing to validate it against;
      `crossRepoLinks` alone covers the real case. Revisit if a future repo
      pair does use remote state.

### Backlog item found while building T7's sample data

`boundary` (T4/T6) only resolves within one repo — tried setting the EKS
cluster's boundary to `aws.vpc` (a different repo) in
`scripts/build-sample-data.mjs` and the compiler correctly refused to guess
(`candidateCount: 0`, reported in `coverage.infra.unresolvedBoundaries`),
exactly as designed. But this means a cross-repo parent/child relationship
(EKS nested inside its VPC) cannot be expressed as compound-node containment
today — only as a plain edge via `crossRepoLinks`. The demo's EKS cluster is
therefore a top-level entity linked to the VPC by a labeled edge ("runs
in"), not visually nested inside it. Real nesting across repos (if wanted)
needs `crossRepoLinks` extended with its own `nest: true` option that sets
`parent` the same way same-repo `boundary` does, once there's a concrete
case asking for it — not building it speculatively now.

- [x] T7 — Viewer (`viewer/index.html`, `viewer/app.js`, data in
      `viewer/data/<env>.json` produced by `scripts/build-sample-data.mjs`).
      Cytoscape.js + fcose + expand-collapse, environment dropdown, click ->
      detail panel (kind, repo, source address, parent, resolved/unresolved
      config), coverage banner. Deployed via GitHub Pages
      (`.github/workflows/pages.yml`, source = GitHub Actions; the Pages
      settings page showed "GitHub Actions" with no workflow, which is why it
      404'd until the workflow existed) and **verified live** at
      https://amartingarcia.github.io/test/ — compound nesting, the
      cross-repo "runs in" edge, and the node-group drill-down all render.
      Fixes found by testing the live page: narrow-viewport layout (sidebar
      stacks under the graph below 760px); ambiguous labels (now
      `kind\nname`); redundant child->parent edges no longer drawn
      (containment already shows them).
      **Layer A2 improvement driven by what the live panel showed**: lists
      and objects of literals (`instance_types = ["m5.large"]`,
      `scaling_config = { min_size = 2 ... }`) were shown "unresolved" though
      trivially resolvable. `resolveHclValue` now resolves a list/object into
      an array/object when *every* element resolves (recursive, var refs
      included); all-or-nothing, so anything containing `local.x`,
      cross-resource refs, interpolation, `for` expressions or quoted object
      keys stays unresolved with raw text kept — never half-resolved. Three
      older tests that pinned "lists/objects always unresolved" were
      deliberately rewritten to the new rule. 100/102 total (the 2 failures
      are the pre-existing terraform-binary-dependent Layer A tests).
      Known viewer gaps (not blocking): environment list is hardcoded in
      `app.js` (static site, no directory listing); detail lookup covers
      managed resources only (blockType `resource`), not data sources.
- [ ] T8 — End-to-end validation against real repos (see below).

## Next step
T8 — end-to-end validation against at least one real environment for both
repos, confirming zero writes inside the source repos (`git status
--porcelain` clean). Needs a machine with `terraform` installed and access to
the real repos (this cloud sandbox has neither: no terraform binary, and the
repos are private/local to the user's computer) — the user's linked computer
is the place to run it: `extractTerraformGraph` (Layer A) -> `parseDotGraph`
-> manifests (T4/T5, real ones authored against the actual repos, kept out of
this public repo) -> `compileEnvironmentGraph` -> viewer data file. This also
re-validates T3 against a live multi-module DOT graph (see T3 caveat).
