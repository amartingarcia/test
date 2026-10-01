import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeLocalBackendOverride } from '../lib/extract/backend-override.mjs';

test('writes an override.tf that forces a local backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-override-'));

  const overridePath = await writeLocalBackendOverride({ scratchPath: dir });

  const content = await fs.readFile(overridePath, 'utf8');
  assert.match(content, /terraform\s*{/);
  assert.match(content, /backend\s+"local"\s*{\s*}/);
});

test('override file is named override.tf so Terraform applies it last', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-override-'));

  const overridePath = await writeLocalBackendOverride({ scratchPath: dir });

  assert.equal(path.basename(overridePath), 'override.tf');
  assert.equal(path.dirname(overridePath), dir);
});

test('refuses to run against a path that looks like a real source repo (has .git)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-diagram-override-'));
  await fs.mkdir(path.join(dir, '.git'));

  await assert.rejects(
    () => writeLocalBackendOverride({ scratchPath: dir }),
    /scratch directory .* must not contain \.git/
  );
});
