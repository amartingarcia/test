# infra-diagram: project notes for Claude

Skill (`SKILL.md` + `references/`) with an offline Node engine that draws architecture diagrams from real Terraform / Kubernetes source. Unresolved values are reported, never guessed. User prefers Spanish (Spain) replies; code, comments and resource names in English.

## Commands
- `npm test` (expect exactly 2 failures in the sandbox: tests that need the `terraform` binary)
- `npm run build:samples` regenerates `viewer/data/*.json`
- `npm run verify` integrity + coverage gate over the samples
- `npm run export:html` / `npm run export:svg`

## Next steps (agreed 2026-10-01)
1. **T8, tomorrow:** the user runs the tool on their real repos (AWS, Azure, GCP, OCI, K8s with Argo/Karpenter; ideally one with remote modules and one with several tfvars envs). Needs a machine with `terraform`. Review the output together, fix what breaks.
   - Expected weak spots: values only known after apply, `dynamic` blocks, undecidable scheduling. They must surface as findings, not guesses.
   - Before sharing output: it includes resource names and ARNs in `details`.
2. **Only if T8 goes well:** the user moves the repo to the `devops-IA` org. Decide the repo name and logo at that moment (not before).
3. **Deliberately paused until then:** CI running `npm test` on PRs, `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates, Dependabot, secret scanning, architecture guide, CHANGELOG, `package.json` `private: false`, a test that exported diagrams do not leak sensitive values, review whether `odd/tasks/` belongs in the repo.
4. **Ideas, by value:** diff between environments (dev vs prod, or before/after a PR); PR comment Action with the diagram; reach tracing in the viewer; PNG/Mermaid export and `npx` install; security rules on the graph (public subnet with a database, unencrypted resources).

## Known limitations
See README ("Known limitations"). Unverified: kube-proxy `v1.28.2-eksbuild.2` in `examples/sample-platform/envs/dev.tfvars`; several sample arguments were not checked against the Terraform registry (no `terraform validate` in the sandbox).

## Conventions
- Commits end with the `Co-Authored-By` and `Claude-Session` trailers requested by the harness.
- Never `pkill -f` with a pattern that appears in your own command line.
- `.claude/agents/` holds read-only reviewer agents (dev scaffolding, not part of the product).
