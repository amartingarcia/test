#!/usr/bin/env node
// Offline gate for compiled graphs: integrity + coverage, JSON report with repair hints.
// Exit 0 = pass, 1 = errors (or warnings with --strict), 2 = usage.
//
//   node scripts/verify.mjs --graph out/prod.json [--graph ...] [--manifest m.json ...] [--catalog dir|file] [--strict] [--format json|text]
//   node scripts/verify.mjs --all            # every environment in viewer/data

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../lib/catalog/load-catalog.mjs';
import { findSpec } from '../lib/catalog/spec-for-kind.mjs';
import { lintManifest } from '../lib/manifest/lint-manifest.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = { graph: [], manifest: [], format: 'json' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all' || a === '--strict') opts[a.slice(2)] = true;
  else if (a === '--graph' || a === '--manifest') opts[a.slice(2)].push(argv[++i]);
  else if (['--catalog', '--data-dir', '--format'].includes(a)) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  else usage(`unknown argument: ${a}`);
}
function usage(msg) { console.error(`${msg}\nusage: node scripts/verify.mjs (--all | --graph <file>...) [--manifest <file>...] [--catalog <dir|file>] [--strict] [--format json|text]`); process.exit(2); }
if (!['json', 'text'].includes(opts.format)) usage('--format must be json or text');
if (!opts.all && !opts.graph.length) usage('nothing to verify');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const dataDir = path.resolve(opts.dataDir ?? path.join(root, 'viewer', 'data'));
const catalogPath = path.resolve(opts.catalog ?? path.join(root, 'catalog', 'providers'));
const catalog = fs.statSync(catalogPath).isDirectory() ? await loadCatalog(catalogPath) : readJson(catalogPath);

const jobs = opts.graph.length
  ? opts.graph.map((f) => ({ source: f, graph: readJson(path.resolve(f)) }))
  : readJson(path.join(dataDir, 'environments.json')).environments.map((e) => ({ source: `${e.id}`, graph: readJson(path.join(dataDir, `${e.id}.json`)) }));

const issues = [];
const add = (scope, level, code, message, hint) => issues.push({ scope, level, code, message, hint });

for (const p of opts.manifest) {
  for (const f of lintManifest(readJson(path.resolve(p)), catalog)) {
    add(p, f.level, 'manifest-lint', f.message, 'Fix the manifest rule named in the message and re-run.');
  }
}

for (const { source, graph } of jobs) {
  const ids = new Map();
  for (const e of graph.entities ?? []) {
    if (ids.has(e.id)) add(source, 'error', 'duplicate-entity-id', `entity id ${e.id} appears more than once`, 'Two resources compile to the same id; make the manifest rule produce distinct names.');
    ids.set(e.id, e);
    if (!findSpec(catalog.kinds ?? {}, e.kind)) add(source, 'warn', 'kind-not-in-catalog', `${e.id}: kind ${e.kind} has no catalog entry (generic box)`, `Add ${e.kind} to catalog/providers/<provider>.json.`);
  }
  for (const e of graph.entities ?? []) {
    if (e.parent && !ids.has(e.parent)) add(source, 'error', 'dangling-parent', `${e.id}: parent ${e.parent} does not exist`, 'The parent was dropped (ignored or unmapped); fix the rule or the placement.');
    const seen = new Set([e.id]);
    for (let p = e.parent; p && ids.has(p); p = ids.get(p).parent) {
      if (seen.has(p)) { add(source, 'error', 'parent-cycle', `${e.id}: parent chain loops through ${p}`, 'Break the cycle in boundary / placement rules.'); break; }
      seen.add(p);
    }
  }
  const seenEdges = new Set();
  for (const ed of graph.edges ?? []) {
    for (const end of ['from', 'to']) if (!ids.has(ed[end])) add(source, 'error', 'dangling-edge', `edge ${ed.from} -> ${ed.to}: ${end} endpoint does not exist`, 'An endpoint was dropped; remove the edge or map the resource.');
    const k = `${ed.from}|${ed.to}|${ed.label ?? ''}`;
    if (seenEdges.has(k)) add(source, 'warn', 'duplicate-edge', `edge ${ed.from} -> ${ed.to} (${ed.label ?? 'no label'}) is repeated`, 'Deduplicate at the rule that produces it.');
    seenEdges.add(k);
  }
  for (const [repo, cov] of Object.entries(graph.coverage ?? {})) {
    if (cov.unmapped?.length) add(source, 'warn', 'unmapped-resources', `${repo}: ${cov.unmapped.length} resource(s) unmapped: ${cov.unmapped.slice(0, 5).join(', ')}${cov.unmapped.length > 5 ? ', …' : ''}`, 'Add an `entity`, `ignore` or `link` rule per address.');
    for (const u of cov.unresolvedBoundaries ?? []) add(source, 'warn', 'unresolved-boundary', `${u.entityId}: boundary ${u.boundary} matched ${u.candidateCount} candidates`, 'Make the boundary unique in the repo or use a crossRepoLink.');
  }
  for (const u of graph.unresolvedPlacements ?? []) add(source, 'warn', 'unresolved-placement', `${u.entityId}: ${u.parentKind ?? 'placement'} ${u.reason ?? `has ${u.candidateCount} candidates`}`, u.reason ? 'Scheduling is not decidable to a single node pool: narrow nodeSelector/affinity/tolerations in the workload, or accept it at cluster level.' : 'Add a boundary or crossRepoLink so the parent is unambiguous.');
  for (const u of graph.unresolvedCrossRepoLinks ?? []) add(source, 'warn', 'unresolved-cross-repo-link', `${u.fromKind} -> ${u.toKind}: ${u.fromCount} from / ${u.toCount} to${u.reason ? ` (${u.reason})` : ''}`, 'Both sides must resolve to exactly one entity.');
  for (const f of graph.findings ?? []) add(source, 'warn', f.type, f.message, 'Reported by the compiler: the value is unknown offline, never guessed.');
}

const errors = issues.filter((i) => i.level === 'error').length;
const warnings = issues.length - errors;
const ok = errors === 0 && !(opts.strict && warnings > 0);
if (opts.format === 'json') {
  console.log(JSON.stringify({ ok, verified: jobs.map((j) => j.source), errors, warnings, issues }, null, 2));
} else {
  for (const i of issues) console.log(`${i.level === 'error' ? 'ERROR' : 'warn '} [${i.scope}] ${i.code}: ${i.message}\n      -> ${i.hint}`);
  console.log(`\n${jobs.length} graph(s), ${errors} error(s), ${warnings} warning(s): ${ok ? 'PASS' : 'FAIL'}`);
}
process.exit(ok ? 0 : 1);
