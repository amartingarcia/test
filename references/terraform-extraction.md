# Terraform extraction (Layer A)

How `lib/extract/` turns a Terraform repository + account name into a real
dependency graph, fully offline and without ever writing inside the source
repo.

## Procedure

1. **Copy to scratch** (`scratch-copy.mjs`) — copy the repo into a brand-new
   temp directory. Never operate on the source repo in place. Excluded on
   copy: `.git`, `.terraform`, `.terraform.lock.hcl`, any
   `terraform.tfstate*` file, any `*.tfplan`.
2. **Override the backend** (`backend-override.mjs`) — write an
   `override.tf` with `terraform { backend "local" {} }` into the scratch
   copy. This makes `terraform init` skip the real S3 backend entirely: no
   remote state is read or touched, no AWS credentials are required for init.
   As a safety check, this refuses to run if the target directory still
   contains `.git` (a sign the caller passed a real repo by mistake instead
   of a scratch copy).
3. **Run `terraform init` + `terraform graph`** (`terraform-graph.mjs`):
   - `terraform init -reconfigure -input=false` against the local-backend
     override.
   - `terraform graph -type=plan` — **note:** the `graph` subcommand does
     **not** accept `-var` / `-var-file` flags (verified against Terraform
     1.14.9; confirmed by `terraform graph -help`). To resolve variables that
     affect `for_each`/`count`/conditionals, the account's var file content
     (e.g. `vars/data_dev/data_dev.tfvars`) is copied into the scratch root
     as `terraform.auto.tfvars`, which Terraform auto-loads for every
     command, including `graph`.
   - `terraform graph -type=plan` only resolves the static configuration —
     it never calls AWS, so this step is genuinely credential-free.
4. **Orchestration** (`extract-terraform.mjs`) — ties the three steps
   together: given `{ repoPath, accountName, scratchRoot }`, resolves the
   account's var file at the conventional `vars/<accountName>/<accountName>.tfvars`
   path (true for both the network and infra repos) and returns the raw DOT.

## Verified facts (Terraform 1.14.9)

- `terraform graph -type=plan -var-file=...` **fails** with `Error parsing
  command-line flags: flag provided but not defined: -var-file`. Any
  reference elsewhere to passing `-var-file` directly to `graph` is wrong for
  this Terraform version — use the `terraform.auto.tfvars` copy technique
  instead.
- A minimal fixture using only the Terraform-core builtin `terraform_data`
  resource (no provider download) is enough to prove the whole pipeline
  end-to-end offline — see `test/terraform-graph.test.mjs` and
  `test/extract-terraform.test.mjs`.
- Both target repos declare `required_version = "~> 1.13"`; a local
  `~/.tfenv/versions/1.14.9/terraform` binary satisfies this without
  depending on a global `tfenv use` default (which is unset in this
  environment and should not be changed, since this isn't a dedicated
  sandbox).

## Hard constraint

Steps 1–3 must only ever run against the scratch copy. `accountName` must
match an existing `vars/<accountName>/<accountName>.tfvars` in the source
repo; `extractTerraformGraph` surfaces a clear "var file not found" error
otherwise instead of silently running against unresolved variables.
