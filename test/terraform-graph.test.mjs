import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTerraformGraph } from '../lib/extract/terraform-graph.mjs';
import { writeLocalBackendOverride } from '../lib/extract/backend-override.mjs';

const TERRAFORM_BIN = process.env.INFRA_DIAGRAM_TEST_TERRAFORM_BIN
  || path.join(os.homedir(), '.tfenv', 'versions', '1.14.9', 'terraform');

/**
 * Builds a tiny, fully offline Terraform fixture (uses only the built-in
 * `terraform_data` resource, no provider download needed) with a nested
 * account var file, mirroring the real repos' `vars/<account>/<account>.tfvars`
 * layout.
 */
async function makeFixtureModule() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-tf-fixture-'));
  await fs.writeFile(
    path.join(dir, 'main.tf'),
    `variable "environment" {
  type = string
}

resource "terraform_data" "a" {
  input = var.environment
}

resource "terraform_data" "b" {
  input = terraform_data.a.output
}
`
  );
  await fs.mkdir(path.join(dir, 'vars', 'data_dev'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'vars', 'data_dev', 'data_dev.tfvars'),
    'environment = "data_dev"\n'
  );
  await writeLocalBackendOverride({ scratchPath: dir });
  return dir;
}

test('runs terraform init + graph fully offline and returns real DOT output', async () => {
  const scratchPath = await makeFixtureModule();

  const { dot } = await runTerraformGraph({
    scratchPath,
    varFilePath: path.join('vars', 'data_dev', 'data_dev.tfvars'),
    terraformBin: TERRAFORM_BIN,
  });

  assert.match(dot, /digraph/);
  assert.match(dot, /terraform_data\.a/);
  assert.match(dot, /terraform_data\.b/);
  // the real dependency edge must be present, proving var resolution worked
  assert.match(dot, /terraform_data\.b \(expand\)"\s*->\s*"\[root\] terraform_data\.a \(expand\)"/);
});

test('rejects with a clear error when the var file path does not exist', async () => {
  const scratchPath = await makeFixtureModule();

  await assert.rejects(
    () =>
      runTerraformGraph({
        scratchPath,
        varFilePath: path.join('vars', 'does_not_exist', 'x.tfvars'),
        terraformBin: TERRAFORM_BIN,
      }),
    /var file not found/
  );
});
