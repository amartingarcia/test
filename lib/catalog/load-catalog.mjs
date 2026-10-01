import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Loads the knowledge catalog: one JSON file per provider in
 * `catalog/providers/` ({ kinds, groups }), merged into one { kinds, groups }.
 * A kind or group defined by two files is an error (two sources of truth).
 */
export async function loadCatalog(dir) {
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const merged = { kinds: {}, groups: {} };
  const origin = { kinds: {}, groups: {} };
  for (const name of names) {
    const part = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    for (const section of ['kinds', 'groups']) {
      for (const [key, value] of Object.entries(part[section] ?? {})) {
        if (key in merged[section]) throw new Error(`catalog ${section.slice(0, -1)} "${key}" is defined in both ${origin[section][key]} and ${name}`);
        merged[section][key] = value;
        origin[section][key] = name;
      }
    }
  }
  return merged;
}
