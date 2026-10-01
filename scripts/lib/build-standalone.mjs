// Single-file HTML export: renderer + data + page, all inlined. No network, no build tooling.
// Pure string work (the renderer is the same module the viewer's SVG button uses), so it takes
// milliseconds and needs neither a browser nor Terraform.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/** Concatenate ES modules into one classic script: drop imports, un-export. Only for our own, controlled sources. */
export function bundleModules(sources) {
  return sources.map((s) => s
    .replace(/^import\s[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+(const|let|function|class|async function)\s/gm, '$1 ')).join('\n');
}

const htmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** JSON that is safe inside <script type="application/json">: no `</script`, `<!--` or line-separator surprises. */
export const safeJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(new RegExp('\\u2028', 'g'), '\\u2028')
  .replace(new RegExp('\\u2029', 'g'), '\\u2029');

/**
 * @param {{graphs: {id: string, label: string, graph: object}[], catalog: object, title?: string, preset?: string, theme?: 'light'|'dark'|'auto'}} input
 * @returns {string} one self-contained HTML document
 */
export function buildStandaloneHtml({ graphs, catalog, title = 'infra-diagram', preset = 'blueprint', theme = 'auto' }) {
  if (!graphs?.length) throw new Error('no graphs to export');
  const bundle = bundleModules([
    read('viewer', 'lanes-layout.mjs'),
    read('viewer', 'diagram-model.mjs'),
    read('viewer', 'render-svg.mjs'),
  ]);
  const template = read('scripts', 'lib', 'standalone-template.html');
  const page = read('scripts', 'lib', 'standalone-page.js');
  const data = safeJson({ graphs, catalog, preset, theme });
  // split/join, not replace(): the payloads contain `$&`-style sequences
  return template
    .split('__TITLE__').join(htmlEscape(title))
    .split('__DATA__').join('\u0000DATA\u0000')
    .split('__BUNDLE__').join('\u0000BUNDLE\u0000')
    .split('__PAGE__').join('\u0000PAGE\u0000')
    .split('\u0000DATA\u0000').join(data)
    .split('\u0000BUNDLE\u0000').join(bundle)
    .split('\u0000PAGE\u0000').join(page);
}
