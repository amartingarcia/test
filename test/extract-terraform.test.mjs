import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extractTerraformGraph } from '../lib/extract/extract-terraform.mjs';

const TERRAFORM_BIN = process.env.INFRA_DIAGRAM_TEST_TERRAFORM_BIN
  || path.join(os.homedir(), '.tfenv', 'versions', '1.14.9', 'terraform');

/**
 * A fixture that looks like the real repos: a root module plus a nested
 * `vars/<account>/<account>.tfvars`, with VCS/cache noise that must never be
 * touched (this fixture plays the role of a "source repo").
 */
async function makeFixtureRepo() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-e2e-repo-'));
  await fs.mkdir(path.join(repoDir, '.git'));
  await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(
    path.join(repoDir, 'main.tf'),
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
  await fs.mkdir(path.join(repoDir, 'vars', 'data_dev'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, 'vars', 'data_dev', 'data_dev.tfvars'),
    'environment = "data_dev"\n'
  );
  return repoDir;
}

test('extracts a real DOT graph for an account without writing inside the source repo', async () => {
  const repoPath = await makeFixtureRepo();
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-e2e-scratch-'));
  const beforeListing = (await fs.readdir(repoPath)).sort();

  const { dot } = await extractTerraformGraph({
    repoPath,
    accountName: 'data_dev',
    scratchRoot,
    terraformBin: TERRAFORM_BIN,
  });

  assert.match(dot, /digraph/);
  assert.match(dot, /terraform_data\.a/);
  assert.match(dot, /terraform_data\.b/);

  const afterListing = (await fs.readdir(repoPath)).sort();
  assert.deepEqual(afterListing, beforeListing, 'source repo must be untouched');
});

test('rejects with a clear error for an unknown account', async () => {
  const repoPath = await makeFixtureRepo();
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-e2e-scratch-'));

  await assert.rejects(
    () =>
      extractTerraformGraph({
        repoPath,
        accountName: 'backend_pro',
        scratchRoot,
        terraformBin: TERRAFORM_BIN,
      }),
    /var file not found/
  );
});
