import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Paths that must never be copied into the scratch directory: VCS metadata,
 * cached provider/module installs, and any existing state/plan artifacts.
 * Re-running `terraform init` in the scratch copy must always start clean.
 */
const EXCLUDED_ENTRIES = new Set(['.git', '.terraform', '.terraform.lock.hcl']);

function isExcluded(entryName) {
  if (EXCLUDED_ENTRIES.has(entryName)) return true;
  if (entryName.startsWith('terraform.tfstate')) return true;
  if (entryName.endsWith('.tfplan')) return true;
  return false;
}

/**
 * Copies a Terraform repository into a brand-new scratch directory, never
 * touching the source repo. Used so `terraform init`/`graph` can run against
 * a local-backend override without writing inside the (read-only) source
 * repository.
 *
 * @param {object} options
 * @param {string} options.repoPath - absolute path to the source repo (read-only).
 * @param {string} options.scratchRoot - directory under which a fresh scratch copy is created.
 * @returns {Promise<string>} absolute path to the new scratch copy.
 */
export async function copyRepoToScratch({ repoPath, scratchRoot }) {
  await fs.mkdir(scratchRoot, { recursive: true });
  const scratchPath = await fs.mkdtemp(path.join(scratchRoot, 'repo-'));

  await copyDirectory(repoPath, scratchPath);

  return scratchPath;
}

async function copyDirectory(sourceDir, destDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;

    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirectory(sourcePath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destPath);
    }
    // symlinks are intentionally skipped: Terraform repos here don't rely on
    // them, and following them could escape the intended source tree.
  }
}

export { EXCLUDED_ENTRIES };
