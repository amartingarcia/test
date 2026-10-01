import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Runs `terraform init` (local-backend only, no remote state) followed by
 * `terraform graph -type=plan` against an already-prepared scratch copy
 * (see {@link copyRepoToScratch} and {@link writeLocalBackendOverride}).
 *
 * Important: the `terraform graph` command does not accept `-var`/`-var-file`
 * flags. To resolve variables that affect `for_each`/`count`/conditional
 * expressions, the referenced var file's content is copied into the scratch
 * root as `terraform.auto.tfvars`, which Terraform auto-loads. This keeps the
 * whole extraction fully offline: `terraform graph -type=plan` only resolves
 * static configuration, it never calls out to AWS.
 *
 * @param {object} options
 * @param {string} options.scratchPath - absolute path to the prepared scratch copy.
 * @param {string} options.varFilePath - path to the account's tfvars file, relative to scratchPath (e.g. "vars/data_dev/data_dev.tfvars").
 * @param {string} [options.terraformBin] - terraform binary to invoke (defaults to "terraform" on PATH).
 * @returns {Promise<{ dot: string }>}
 */
export async function runTerraformGraph({ scratchPath, varFilePath, terraformBin = 'terraform' }) {
  const absoluteVarFilePath = path.join(scratchPath, varFilePath);
  const varFileContent = await readVarFile(absoluteVarFilePath);

  const autoTfvarsPath = path.join(scratchPath, 'terraform.auto.tfvars');
  await fs.writeFile(autoTfvarsPath, varFileContent, 'utf8');

  await runCommand(terraformBin, ['init', '-reconfigure', '-input=false', '-no-color'], scratchPath);
  const { stdout } = await runCommand(terraformBin, ['graph', '-type=plan', '-no-color'], scratchPath);

  return { dot: stdout };
}

async function readVarFile(absoluteVarFilePath) {
  try {
    return await fs.readFile(absoluteVarFilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`var file not found: ${absoluteVarFilePath}`);
    }
    throw error;
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with code ${code} in ${cwd}\n${stderr || stdout}`
          )
        );
      }
    });
  });
}
