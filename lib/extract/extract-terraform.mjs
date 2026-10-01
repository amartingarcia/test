import path from 'node:path';

import { copyRepoToScratch } from './scratch-copy.mjs';
import { writeLocalBackendOverride } from './backend-override.mjs';
import { runTerraformGraph } from './terraform-graph.mjs';

/**
 * Layer A entrypoint: given a (read-only) Terraform repo and an account
 * name, produces the real `terraform graph -type=plan` DOT output for that
 * account — fully offline, with zero writes inside the source repo.
 *
 * Assumes the repo follows the `vars/<accountName>/<accountName>.tfvars`
 * convention used by both the network and infra Terraform repos.
 *
 * @param {object} options
 * @param {string} options.repoPath - absolute path to the source repo (read-only).
 * @param {string} options.accountName - e.g. "data_dev", "backend_pro".
 * @param {string} options.scratchRoot - directory under which a scratch copy is created.
 * @param {string} [options.terraformBin] - terraform binary to invoke.
 * @returns {Promise<{ dot: string, scratchPath: string }>}
 */
export async function extractTerraformGraph({ repoPath, accountName, scratchRoot, terraformBin = 'terraform' }) {
  const scratchPath = await copyRepoToScratch({ repoPath, scratchRoot });
  await writeLocalBackendOverride({ scratchPath });

  const varFilePath = path.join('vars', accountName, `${accountName}.tfvars`);
  const { dot } = await runTerraformGraph({ scratchPath, varFilePath, terraformBin });

  return { dot, scratchPath };
}
