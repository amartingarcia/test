import fs from 'node:fs/promises';
import path from 'node:path';

const OVERRIDE_CONTENT = `terraform {
  backend "local" {}
}
`;

/**
 * Writes an \`override.tf\` into a scratch copy that forces Terraform to use
 * a local backend instead of whatever remote (S3) backend the source repo
 * declares. This is what lets \`terraform init\`/\`graph\` run fully offline,
 * without touching the real remote state or requiring AWS credentials.
 *
 * Only ever call this against a scratch copy produced by
 * {@link copyRepoToScratch} — as a safety check, it refuses to run against a
 * directory that still contains \`.git\`, which would indicate the caller
 * passed a real source repo by mistake.
 *
 * @param {object} options
 * @param {string} options.scratchPath - absolute path to the scratch copy.
 * @returns {Promise<string>} absolute path to the written override.tf.
 */
export async function writeLocalBackendOverride({ scratchPath }) {
  const gitDir = path.join(scratchPath, '.git');
  const hasGitDir = await pathExists(gitDir);
  if (hasGitDir) {
    throw new Error(
      `scratch directory ${scratchPath} must not contain .git — refusing to write a backend override into what looks like a real source repo`
    );
  }

  const overridePath = path.join(scratchPath, 'override.tf');
  await fs.writeFile(overridePath, OVERRIDE_CONTENT, 'utf8');
  return overridePath;
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}
