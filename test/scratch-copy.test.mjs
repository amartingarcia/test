import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { copyRepoToScratch } from '../lib/extract/scratch-copy.mjs';

async function makeFixtureRepo() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-fixture-'));
  await fs.mkdir(path.join(repoDir, '.git'));
  await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.mkdir(path.join(repoDir, '.terraform'));
  await fs.writeFile(path.join(repoDir, '.terraform', 'cached-plugin'), 'binary-stub');
  await fs.writeFile(path.join(repoDir, 'terraform.tfstate'), '{"version":4}');
  await fs.writeFile(path.join(repoDir, 'main.tf'), 'resource "null_resource" "x" {}\n');
  await fs.mkdir(path.join(repoDir, 'vars', 'data_dev'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, 'vars', 'data_dev', 'data_dev.tfvars'),
    'environment = "data_dev"\n'
  );
  return repoDir;
}

test('copies tracked-looking source files into a new scratch directory', async () => {
  const repoDir = await makeFixtureRepo();
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-scratch-'));

  const scratchPath = await copyRepoToScratch({ repoPath: repoDir, scratchRoot });

  const mainTf = await fs.readFile(path.join(scratchPath, 'main.tf'), 'utf8');
  assert.equal(mainTf, 'resource "null_resource" "x" {}\n');

  const tfvars = await fs.readFile(
    path.join(scratchPath, 'vars', 'data_dev', 'data_dev.tfvars'),
    'utf8'
  );
  assert.match(tfvars, /environment = "data_dev"/);
});

test('excludes .git, .terraform, and state files from the scratch copy', async () => {
  const repoDir = await makeFixtureRepo();
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-scratch-'));

  const scratchPath = await copyRepoToScratch({ repoPath: repoDir, scratchRoot });

  await assert.rejects(fs.access(path.join(scratchPath, '.git')));
  await assert.rejects(fs.access(path.join(scratchPath, '.terraform')));
  await assert.rejects(fs.access(path.join(scratchPath, 'terraform.tfstate')));
});

test('never writes inside the source repo path', async () => {
  const repoDir = await makeFixtureRepo();
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-scratch-'));
  const beforeListing = (await fs.readdir(repoDir)).sort();

  await copyRepoToScratch({ repoPath: repoDir, scratchRoot });

  const afterListing = (await fs.readdir(repoDir)).sort();
  assert.deepEqual(afterListing, beforeListing);
});

test('scratch path is a fresh directory distinct from the source repo', async () => {
  const repoDir = await makeFixtureRepo();
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-scratch-'));

  const scratchPath = await copyRepoToScratch({ repoPath: repoDir, scratchRoot });

  assert.notEqual(scratchPath, repoDir);
  assert.ok(scratchPath.startsWith(scratchRoot));
});
