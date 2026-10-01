// infra-diagram viewer — Cytoscape.js + expand-collapse, environment selector,
// attribute drill-down panel, light/dark theme, zoom HUD, animated link flow.
// Static page, no build step: reads a pre-compiled compound graph from
// data/<environment>.json plus data/catalog.json (see
// scripts/build-sample-data.mjs).
//
// Layout is NOT a force layout: boxes are packed by lanes (lanes-layout.mjs)
// using the catalog's "what goes inside what" knowledge and ordering, so the
// diagram reads like an architecture (edge -> public -> private -> data).
//
import { layoutLanes } from './lanes-layout.mjs';

// Environment list comes from data/environments.json (one entry per tfvars file,
// written by the build scripts). The fallback below only matters if that file
// is missing.
const FALLBACK_ENVIRONMENTS = [{ id: 'platform_prod', label: 'platform / prod' }, { id: 'data_dev', label: 'data_dev' }];

// cytoscape-expand-collapse (UMD, v4.x) self-registers against the global
// `cytoscape` once both scripts are loaded — no explicit cytoscape.use() call.

const CLASSES = ['net', 'compute', 'eks', 'k8s', 'data', 'iam', 'cfg', 'edgeapp', 'default'];
const CLASS_NAMES = { net: 'Network', compute: 'Compute', eks: 'EKS', k8s: 'Workloads', data: 'Data stores', iam: 'IAM', cfg: 'Config', edgeapp: 'DNS & LB', default: 'Other' };
const KIND_CLASS = (kind) => {
  if (kind.startsWith('aws.eks')) return 'eks';
  if (kind.startsWith('aws.iam') || kind.startsWith('group.iam')) return 'iam';
  if (kind.startsWith('aws.ec2')) return 'compute';
  if (kind.startsWith('aws.ssm') || kind.startsWith('group.ssm')) return 'cfg';
  if (kind.startsWith('aws.route53') || kind.startsWith('aws.lb')) return 'edgeapp';
  if (kind.startsWith('aws.rds') || kind.startsWith('aws.docdb') || kind.startsWith('aws.dynamodb') || kind.startsWith('aws.elasticache') || kind.startsWith('aws.opensearch')) return 'data';
  if (kind.startsWith('k8s.')) return 'k8s';
  if (/^aws\.(vpc|subnet|nat|internet|route_table|security_group)/.test(kind)) return 'net';
  return 'default';
};

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
const FLOW_EDGE_LIMIT = 400; // per-frame style writes get expensive past this

const envSelect = document.getElementById('env-select');
const sidebar = document.getElementById('sidebar');
const coverageEl = document.getElementById('coverage');
const zoomLevelEl = document.getElementById('zoom-level');
const flowBtn = document.getElementById('flow-btn');
const themeLabel = document.getElementById('theme-label');

async function loadEnvironmentList() {
  let list = FALLBACK_ENVIRONMENTS;
  try {
    const res = await fetch('data/environments.json', { cache: 'no-cache' });
    if (res.ok) list = (await res.json()).environments ?? list;
  } catch { /* offline or missing: use the fallback */ }
  envSelect.innerHTML = '';
  for (const env of list) {
    const opt = document.createElement('option');
    opt.value = env.id;
    opt.textContent = env.label ?? env.id;
    envSelect.appendChild(opt);
  }
  return list;
}

/** `#env=platform_stage` selects an environment, so a view can be linked. */
const envFromHash = () => new URLSearchParams(location.hash.slice(1)).get('env');

let cy = null;
let catalog = { kinds: {}, groups: {} };
let flowOn = !REDUCED_MOTION;
let vertical = false; // false: tiers run left to right; true: top to bottom

/* ---------------------------------------------------------------- catalog */

/** Exact kind, then longest dotted prefix (mirror of lib/catalog/spec-for-kind.mjs). */
function specFor(kind) {
  const parts = kind.split('.');
  for (let n = parts.length; n > 0; n--) {
    const spec = catalog.kinds[parts.slice(0, n).join('.')];
    if (spec) return spec;
  }
  return {};
}

const isGroupKind = (kind) => kind.startsWith('group.');
const groupOfKind = (kind) => (isGroupKind(kind) ? catalog.groups[kind.slice('group.'.length)] : null);

const CARD = { w: 176, h: 64 };
const CHIP = { w: 172, h: 50 };
const sizeOf = (kind) => (specFor(kind).size === 'chip' ? CHIP : CARD);

/* ------------------------------------------------------------------ theme */

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const currentTheme = () => document.documentElement.getAttribute('data-theme');
const CSS_NAME = { default: 'def', edgeapp: 'edgeapp' };

/*
 * Style presets. Colours live in CSS (index.html); these are the shape/type
 * decisions that Cytoscape and the SVG cards need in JS.
 *  radius: node corner radius; chip: icon chip shape; fill: card fill style
 *  (gradient | flat | tint); border: node border width; group: container
 *  border style; edge: line style + curve; flow: default link animation.
 */
const PRESETS = {
  blueprint: { label: 'Blueprint', radius: 14, groupRadius: 18, chip: 10, fill: 'gradient', border: 1.5, group: 'dashed', edgeStyle: 'dashed', edgeWidth: 2, taxiRadius: 10, nameFont: "system-ui, -apple-system, 'Segoe UI', sans-serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: true },
  draft:     { label: 'Draft', radius: 3, groupRadius: 3, chip: 0, fill: 'flat', border: 1.2, group: 'dotted', edgeStyle: 'solid', edgeWidth: 1.4, taxiRadius: 0, nameFont: "Georgia, 'Times New Roman', serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: false },
  neon:      { label: 'Neon', radius: 20, groupRadius: 26, chip: 99, fill: 'gradient', border: 2, group: 'solid', edgeStyle: 'solid', edgeWidth: 2.4, taxiRadius: 14, nameFont: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: true },
  soft:      { label: 'Soft', radius: 16, groupRadius: 22, chip: 12, fill: 'tint', border: 1, group: 'solid', edgeStyle: 'solid', edgeWidth: 2, taxiRadius: 16, nameFont: "system-ui, -apple-system, 'Segoe UI', sans-serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: false },
};
const PRESET_IDS = Object.keys(PRESETS);
const currentPreset = () => PRESETS[document.documentElement.getAttribute('data-preset')] ?? PRESETS.blueprint;

function syncPresetPicker() {
  const id = document.documentElement.getAttribute('data-preset');
  document.querySelectorAll('#style-pick button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preset === id)));
}

function setPreset(id, { persist = true } = {}) {
  if (!PRESETS[id]) return;
  document.documentElement.setAttribute('data-preset', id);
  if (persist) {
    try { localStorage.setItem('infra-preset', id); } catch { /* storage blocked */ }
    const h = new URLSearchParams(location.hash.slice(1));
    h.set('style', id);
    history.replaceState(null, '', `#${h.toString()}`);
  }
  syncPresetPicker();
  // a preset has a preferred link animation; the Flow button can still override it
  if (!REDUCED_MOTION) setFlow(PRESETS[id].flow);
  if (cy) { cy.style(buildStyle()); paintCards(); }
}
const classColor = (cls) => cssVar(`--${CSS_NAME[cls] ?? cls}`);

function syncThemeLabel() {
  themeLabel.textContent = currentTheme() === 'light' ? 'Light' : 'Dark';
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('infra-theme', next); } catch { /* storage blocked: choice just isn't remembered */ }
  syncThemeLabel();
  if (cy) { cy.style(buildStyle()); paintCards(); }
}

/* ------------------------------------------------------------------ cards */

// Cytoscape can't draw HTML in a node, so each resource is an SVG card
// (icon chip, name, kind) rendered to a data URI and used as the node's
// background image. Regenerated on theme change. Fonts: an SVG used as an
// <img> can't load web fonts, hence the system stacks.
const GLYPHS = {
  vpc: 'M6 15a3.5 3.5 0 0 1 .5-6.9A5 5 0 0 1 16 9a3 3 0 0 1 0 6H6z',
  internet_gateway: 'M3 10h14M10 3c3 3 3 11 0 14M10 3c-3 3-3 11 0 14M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0',
  subnet: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z',
  nat: 'M4 10h12M12 6l4 4-4 4',
  route: 'M4 15l4-4 3 3 5-6',
  security_group: 'M10 3l6 2v5c0 4-3 6-6 7-3-1-6-3-6-7V5z',
  eks: 'M10 2l7 4v8l-7 4-7-4V6z',
  nodegroup: 'M3 6l7-3 7 3-7 3zM3 10l7 3 7-3M3 14l7 3 7-3',
  addon: 'M4 4h12v12H4zM10 7v6M7 10h6',
  database: 'M4 5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5S4 6.4 4 5zM4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5',
  document: 'M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 10h5M7.5 13h5',
  key: 'M12.5 3a4.5 4.5 0 1 0 .8 8.9L14 13h2v2h2v-2.3l-4.8-4.8A4.5 4.5 0 0 0 12.5 3zM11 7.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0',
  pod: 'M10 2l6.5 3.7v7.6L10 17l-6.5-3.7V5.7zM10 9.5l6.5-3.8M10 9.5L3.5 5.7M10 9.5V17',
  server: 'M3 4h14v5H3zM3 11h14v5H3zM6.5 6.5h.01M6.5 13.5h.01',
  bolt: 'M11 2L4 11h5l-1 7 7-9h-5z',
  search: 'M9 3a6 6 0 1 0 .01 0zM14 14l4 4',
  sliders: 'M4 6h12M4 10h12M4 14h12M7 4v4M13 8v4M9 12v4',
  dns: 'M3 10h14M10 3c3 3 3 11 0 14M10 3c-3 3-3 11 0 14M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0',
  record: 'M4 4h12v12H4zM7 8h6M7 12h4',
  balance: 'M10 3v14M5 17h10M4 6l3 5H1zM16 6l3 5h-6z',
  link: 'M8 12l4-4M7 9L5 11a3 3 0 0 0 4 4l2-2M13 11l2-2a3 3 0 0 0-4-4L9 7',
  box: 'M4 4h12v12H4z',
};
const xmlEscape = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const resolved = (details, key) => (details?.[key]?.resolved ? details[key].value : undefined);

function cardSvg({ name, kind, class: cls, details }) {
  // (groups, e.g. IAM, only get a card while collapsed; their name arrives as the tab label)
  const accent = classColor(cls);
  const nodeBg = cssVar('--node');
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const group = groupOfKind(kind);
  const spec = group ?? specFor(kind);
  const { w, h } = sizeOf(kind);
  const compact = h < 60;
  let kindShort = kind.split('.').slice(1).join('.');
  if (group) { const [head, ...rest] = (name ?? '').split(' · '); name = head; kindShort = rest.join(' · ') || 'group'; }

  // chips (workloads): "chart vX.Y" is more useful than the kind
  let sub = kindShort;
  if (compact) {
    const chart = resolved(details, 'chart');
    const version = resolved(details, 'version');
    sub = chart ? `${chart}${version ? ` v${version}` : ''}` : kindShort;
  }

  const P = currentPreset();
  const chip = compact ? 30 : 36;
  const cy0 = (h - chip) / 2;
  const glyphScale = chip / 36;
  const tx = chip + 24;
  const chipRx = Math.min(P.chip, chip / 2);
  const fillLayer = P.fill === 'gradient'
    ? `<rect width="${w}" height="${h}" fill="url(#g)"/>`
    : P.fill === 'tint' ? `<rect width="${w}" height="${h}" fill="${accent}" fill-opacity=".07"/>` : '';
  const chipFill = P.fill === 'flat' ? 'none' : accent;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".20"/><stop offset=".6" stop-color="${accent}" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="${nodeBg}"/>
  ${fillLayer}
  <rect x="12" y="${cy0}" width="${chip}" height="${chip}" rx="${chipRx}" fill="${chipFill}" fill-opacity=".16" stroke="${accent}" stroke-opacity="${P.fill === 'flat' ? 0.9 : 0.55}"/>
  <g transform="translate(${12 + (chip - 20 * glyphScale) / 2} ${cy0 + (chip - 20 * glyphScale) / 2}) scale(${glyphScale})" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${GLYPHS[spec.glyph] ?? GLYPHS.box}"/></g>
  <text x="${tx}" y="${compact ? 22 : 30}" font-family="${P.nameFont}" font-size="${compact ? 13 : 14}" font-weight="700" fill="${text}">${xmlEscape(clip(name, compact ? 16 : 15))}</text>
  <text x="${tx}" y="${compact ? 37 : 46}" font-family="${P.monoFont}" font-size="10" fill="${muted}">${xmlEscape(clip(sub, compact ? 20 : 21))}</text>
  <circle cx="${w - 14}" cy="14" r="3" fill="${accent}"/>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function paintCards() {
  cy?.batch(() => cy.nodes().forEach((n) => n.data('card', cardSvg(isGroupKind(n.data('kind')) ? { ...n.data(), name: n.data('groupLabel') } : n.data()))));
}

/* ----------------------------------------------------------------- styles */

function buildStyle() {
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const nodeBg = cssVar('--node');
  const bg = cssVar('--bg');
  const glow = Number(cssVar('--glow')) || 0.3;
  const hit = cssVar('--hit');
  const P = currentPreset();
  const mono = `${cssVar('--font-mono')}, ui-monospace, monospace`;

  const style = [
    { selector: 'node', style: {
      'label': '', 'shape': 'round-rectangle', 'corner-radius': P.radius, 'width': CARD.w, 'height': CARD.h,
      'background-color': nodeBg, 'background-image': 'data(card)', 'background-fit': 'cover', 'background-clip': 'node',
      'border-width': P.border, 'border-color': classColor('default'),
      'underlay-color': classColor('default'), 'underlay-opacity': glow, 'underlay-padding': 7, 'underlay-shape': 'round-rectangle',
      'transition-property': 'opacity, border-width, underlay-opacity', 'transition-duration': '0.18s',
    }},
    { selector: 'node[kind ^= "k8s."]', style: { 'width': CHIP.w, 'height': CHIP.h, 'corner-radius': Math.min(P.radius, 12) } },
    { selector: ':parent', style: {
      'background-image': 'none', 'background-opacity': 0.07, 'background-color': classColor('default'), 'border-width': P.border, 'border-style': P.group,
      'label': 'data(groupLabel)', 'color': text, 'font-family': mono, 'font-size': 12, 'font-weight': 'bold', 'text-wrap': 'wrap', 'line-height': 1.35,
      'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -2, 'padding': '30px', 'corner-radius': P.groupRadius,
      'text-background-color': bg, 'text-background-opacity': 1, 'text-background-padding': '5px', 'text-background-shape': 'round-rectangle',
      'underlay-opacity': glow * 0.35, 'underlay-shape': 'round-rectangle',
    }},
    ...CLASSES.filter((c) => c !== 'default').flatMap((cls) => {
      const c = classColor(cls);
      return [
        { selector: `node[class = "${cls}"]`, style: { 'border-color': c, 'underlay-color': c } },
        { selector: `:parent[class = "${cls}"]`, style: { 'background-color': c, 'border-color': c, 'underlay-color': c } },
      ];
    }),
    { selector: 'edge', style: {
      'width': P.edgeWidth, 'curve-style': 'taxi', 'taxi-direction': 'auto', 'taxi-turn': '50%', 'taxi-radius': P.taxiRadius,
      'line-color': classColor('default'), 'target-arrow-color': classColor('default'),
      'target-arrow-shape': 'triangle', 'arrow-scale': 1.1,
      'line-style': P.edgeStyle, 'line-dash-pattern': [8, 6],
      'underlay-color': classColor('default'), 'underlay-opacity': glow * 0.7, 'underlay-padding': 3,
      'label': '', 'opacity': 0.5, 'font-size': 10, 'font-family': mono, 'color': muted,
      'text-background-color': bg, 'text-background-opacity': 0.9, 'text-background-padding': '3px', 'text-background-shape': 'round-rectangle',
      'transition-property': 'opacity', 'transition-duration': '0.18s',
    }},
    // relationship type decides the link color: who may call whom (iam), where data lands (data), plain connectivity
    ...['iam', 'data', 'k8s'].map((cls) => ({
      selector: `edge[cls = "${cls}"]`,
      style: { 'line-color': classColor(cls), 'target-arrow-color': classColor(cls), 'underlay-color': classColor(cls) },
    })),
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': hit, 'underlay-opacity': Math.min(glow * 2, 0.6), 'underlay-padding': 10 } },
    { selector: '.dim', style: { 'opacity': 0.12 } },
    { selector: 'edge.hot', style: { 'width': 3.2, 'opacity': 1, 'label': 'data(label)', 'underlay-opacity': Math.min(glow * 1.6, 0.6) } },
  ];
  return style;
}

/* ------------------------------------------------------------------- data */

async function loadEnvironment(env) {
  // `no-cache` = always revalidate (cheap, ETag-based): GitHub Pages serves
  // max-age=600, so without this a fresh deploy's data can look stale for 10 min.
  const [res, catRes] = await Promise.all([
    fetch(`data/${env}.json`, { cache: 'no-cache' }),
    fetch('data/catalog.json', { cache: 'no-cache' }),
  ]);
  if (!res.ok) {
    sidebar.innerHTML = `<div class="empty">Could not load data/${escapeHtml(env)}.json (HTTP ${res.status}).<br />Check that the file exists in viewer/data/.</div>`;
    return;
  }
  catalog = catRes.ok ? await catRes.json() : { kinds: {}, groups: {} };
  const graph = await res.json();
  renderGraph(graph);
  renderCoverage(graph);
  renderLegend(graph);
}

function entityName(entity) {
  const rawName = entity.id.split(':').slice(2).join(':');
  return rawName.includes('.') ? rawName.split('.').pop() : rawName;
}

const kindShort = (kind) => kind.split('.').slice(1).join('.');

function renderCoverage(graph) {
  const parts = [];
  for (const [repoId, cov] of Object.entries(graph.coverage ?? {})) {
    if (cov.unmapped.length) parts.push(`${repoId}: ${cov.unmapped.length} unmapped resource(s)`);
    if (cov.unresolvedBoundaries.length) parts.push(`${repoId}: ${cov.unresolvedBoundaries.length} unresolved boundary(ies)`);
  }
  if ((graph.unresolvedCrossRepoLinks ?? []).length) {
    parts.push(`${graph.unresolvedCrossRepoLinks.length} unresolved cross-repo link(s)`);
  }
  if ((graph.unresolvedPlacements ?? []).length) {
    parts.push(`${graph.unresolvedPlacements.length} ambiguous placement(s)`);
  }
  coverageEl.textContent = parts.length ? `⚠ ${parts.join(' · ')}` : '';
}

function renderLegend(graph) {
  const counts = {};
  for (const e of graph.entities) {
    if (e.embedded) continue;
    const cls = KIND_CLASS(e.kind);
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  document.getElementById('legend-row').innerHTML = CLASSES.filter((c) => counts[c])
    .map((c) => `<span class="key-dot ${c === 'default' ? 'def' : c}"><i></i><span>${CLASS_NAMES[c]} ${counts[c]}</span></span>`)
    .join('');
}

/** Name shown on a container's tab; a cluster also shows its version and the addons it owns. */
function groupLabel(entity, embeddedOf) {
  const first = `${kindShort(entity.kind)} · ${entityName(entity)}`;
  const owned = embeddedOf.get(entity.id);
  if (!owned?.length) return first;
  const version = resolved(entity.details, 'version');
  const names = owned.map((o) => resolved(o.details, 'addon_name') ?? entityName(o));
  return `${first}\n${version ? `v${version} · ` : ''}addons: ${names.join(', ')}`;
}

/** true when `maybeAncestor` contains `id` anywhere up its parent chain. */
function isAncestor(byId, maybeAncestor, id) {
  for (let cur = byId.get(id)?.parent, guard = 0; cur && guard < 20; cur = byId.get(cur)?.parent, guard++) {
    if (cur === maybeAncestor) return true;
  }
  return false;
}

function renderGraph(graph) {
  const elements = [];
  const visible = graph.entities.filter((e) => !e.embedded);
  const byId = new Map(graph.entities.map((e) => [e.id, e]));

  // Embedded entities (e.g. EKS addons) are properties of their parent, not boxes.
  const embeddedOf = new Map();
  for (const e of graph.entities) {
    if (!e.embedded || !e.parent) continue;
    if (!embeddedOf.has(e.parent)) embeddedOf.set(e.parent, []);
    embeddedOf.get(e.parent).push(e);
  }

  // Global groups from the catalog (IAM is account-wide, so it sits outside any VPC).
  const groupIds = new Set();
  const groupOf = (e) => {
    const gid = specFor(e.kind).group;
    return gid && !e.parent ? `group:${gid}` : null;
  };
  for (const e of visible) { const g = groupOf(e); if (g) groupIds.add(g); }
  for (const gid of groupIds) {
    const key = gid.slice('group:'.length);
    elements.push({ data: { id: gid, kind: gid.replace(':', '.'), name: key, class: KIND_CLASS(`group.${key}`), groupLabel: catalog.groups[key]?.label ?? key } });
  }

  for (const entity of visible) {
    const name = entityName(entity);
    elements.push({
      data: {
        id: entity.id,
        name,
        groupLabel: groupLabel(entity, embeddedOf),
        kind: entity.kind,
        parent: entity.parent ?? groupOf(entity) ?? undefined,
        repoId: entity.repoId,
        sourceAddress: entity.sourceAddress,
        details: entity.details ?? null,
        embedded: (embeddedOf.get(entity.id) ?? []).map((o) => ({ name: resolved(o.details, 'addon_name') ?? entityName(o), details: o.details ?? null })),
        class: KIND_CLASS(entity.kind),
      },
    });
  }

  // Containment already says "child belongs to parent": an edge from a child
  // to its own parent would just draw a loop on top of it. Edges touching an
  // embedded entity have nothing to attach to.
  const shown = new Set(visible.map((e) => e.id));
  for (const [i, edge] of graph.edges.entries()) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!shown.has(edge.from) || !shown.has(edge.to)) continue;
    if (isAncestor(byId, edge.to, edge.from) || isAncestor(byId, edge.from, edge.to)) continue;
    elements.push({ data: { id: `e${i}`, source: edge.from, target: edge.to, label: edge.label ?? '', cls: to ? KIND_CLASS(to.kind) : 'default' } });
  }

  if (cy) { cy.destroy(); cy = null; }
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: buildStyle(),
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    wheelSensitivity: 0.25,
    autoungrabify: true, // layout is computed, never hand-edited: nothing persists, so boxes stay put
  });

  cy.on('tap', 'node', (evt) => {
    if (isGroupKind(evt.target.data('kind'))) return;
    renderDetails(evt.target.data());
    focusNeighborhood(evt.target);
  });
  cy.on('tap', (evt) => {
    if (evt.target !== cy) return;
    clearFocus();
    sidebar.innerHTML = '<div class="empty">Click a resource to see its configuration.<br />Scroll to zoom, drag to pan.</div>';
  });
  cy.on('zoom', updateZoomLabel);
  window.__infraCy = cy; // handle for debugging / browser tests

  paintCards();
  vertical = pickOrientation();
  applyLayout();
  cy.fit(undefined, 60);
  // the container may still be settling (stacked layout on narrow screens): refit once it has its final size
  requestAnimationFrame(() => { cy?.resize(); cy?.fit(undefined, 60); });

  if (cy.expandCollapse) {
    cy.expandCollapse({ layoutBy: () => applyLayout(true), fisheye: false, undoable: false, animate: false });
  }

  updateZoomLabel();
  playEntrance();
}

/* ----------------------------------------------------------------- layout */

const flip = (axis) => (vertical ? (axis === 'row' ? 'column' : 'row') : axis);
const layoutConfig = () => ({
  sizeOf,
  rootAxis: flip('row'),
  axisOf: (kind) => flip(groupOfKind(kind)?.axis ?? specFor(kind).axis ?? 'column'),
  orderOf: (n) => groupOfKind(n.kind)?.order ?? specFor(n.kind).order ?? 50,
  gap: 44,
  pad: 30,
  padTop: 50,
});

/** Whichever orientation lets the diagram be drawn larger in the current container. */
function pickOrientation() {
  const nodes = cy.nodes().map((n) => ({ id: n.id(), parent: n.parent().length ? n.parent().id() : null, kind: n.data('kind') }));
  const scaleFor = (isVertical) => {
    const previous = vertical;
    vertical = isVertical;
    const { boxes } = layoutLanes(nodes, layoutConfig());
    vertical = previous;
    const all = Object.values(boxes);
    const width = Math.max(...all.map((b) => b.x + b.w)) - Math.min(...all.map((b) => b.x));
    const height = Math.max(...all.map((b) => b.y + b.h)) - Math.min(...all.map((b) => b.y));
    return Math.min(cy.width() / width, cy.height() / height);
  };
  return scaleFor(true) > scaleFor(false);
}

/** Packs the currently visible nodes by lanes; also used after expand/collapse. */
function applyLayout(animate = false, onDone = null) {
  if (!cy) return;
  const nodes = cy.nodes().map((n) => ({ id: n.id(), parent: n.parent().length ? n.parent().id() : null, kind: n.data('kind') }));
  const { centers } = layoutLanes(nodes, layoutConfig());
  cy.layout({
    name: 'preset',
    positions: (n) => centers[n.id()] ?? n.position(),
    fit: false,
    animate: animate && !REDUCED_MOTION,
    animationDuration: 250,
    stop: () => onDone?.(),
  }).run();
}

/** One orchestrated moment: nodes light up outermost-first, then links. */
function playEntrance() {
  if (REDUCED_MOTION) return;
  cy.elements().style('opacity', 0);
  const nodes = cy.nodes().sort((a, b) => a.ancestors().length - b.ancestors().length);
  nodes.forEach((n, i) => n.animate({ style: { opacity: 1 } }, { duration: 420, queue: false, delay: i * 55 }));
  const t0 = nodes.length * 55 + 150;
  cy.edges().forEach((e, i) => e.animate({ style: { opacity: 1 } }, { duration: 500, queue: false, delay: t0 + i * 40 }));
  // drop the inline overrides afterwards so theme/focus styles apply cleanly
  setTimeout(() => { if (cy) cy.elements().removeStyle('opacity'); }, t0 + cy.edges().length * 40 + 700);
}

function focusNeighborhood(node) {
  cy.batch(() => {
    cy.elements().addClass('dim').removeClass('hot');
    const hood = node.closedNeighborhood().union(node.ancestors()).union(node.descendants());
    hood.removeClass('dim');
    node.connectedEdges().addClass('hot');
  });
}

function clearFocus() {
  cy?.batch(() => cy.elements().removeClass('dim').removeClass('hot'));
}

/* ------------------------------------------------------------ details panel */

function configTable(details) {
  let html = '<table>';
  for (const [key, result] of Object.entries(details)) {
    const val = result.resolved
      ? `<span class="val">${escapeHtml(JSON.stringify(result.value))}</span>`
      : `<span class="unresolved">unresolved</span><div class="raw">${escapeHtml(result.raw)}</div>`;
    html += `<tr><td class="key">${escapeHtml(key)}</td><td class="val">${val}</td></tr>`;
  }
  return `${html}</table>`;
}

function renderDetails(data) {
  const badge = `<span class="badge ${data.class}">${data.class === 'default' ? 'other' : data.class}</span>`;
  let html = `<h2>${escapeHtml(data.name)}${badge}</h2><div class="kind">${escapeHtml(data.kind)}</div>`;
  html += `<table>
    <tr><td class="key">repo</td><td class="val">${escapeHtml(data.repoId)}</td></tr>
    <tr><td class="key">source address</td><td class="val">${escapeHtml(data.sourceAddress)}</td></tr>
    <tr><td class="key">inside</td><td class="val">${escapeHtml(data.parent ?? '—')}</td></tr>
  </table>`;

  if (data.details) {
    html += `<h3>Configuration (from source .tf)</h3>${configTable(data.details)}`;
  } else {
    html += '<h3>Configuration</h3><div class="empty" style="margin-top:4px">No attribute details extracted for this resource.</div>';
  }

  // properties owned by this resource (e.g. the addons of an EKS cluster)
  if (data.embedded?.length) {
    html += `<h3>Owned by this resource (${data.embedded.length})</h3>`;
    for (const owned of data.embedded) {
      html += `<h2 style="font-size:14px;margin-top:10px">${escapeHtml(owned.name)}</h2>`;
      if (owned.details) html += configTable(owned.details);
    }
  }

  sidebar.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------- zoom */

function updateZoomLabel() {
  if (cy) zoomLevelEl.textContent = `${Math.round(cy.zoom() * 100)}%`;
}

function zoomTo(level) {
  if (!cy) return;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
  cy.animate({ zoom: { level: clamped, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: REDUCED_MOTION ? 0 : 160 });
}
const zoomBy = (factor) => cy && zoomTo(cy.zoom() * factor);

function fit() { cy?.animate({ fit: { eles: cy.elements(), padding: 60 } }, { duration: REDUCED_MOTION ? 0 : 260 }); }

/* ------------------------------------------------------------ link flow */

let lastTick = 0;
let dashOffset = 0;
function flowTick(ts) {
  requestAnimationFrame(flowTick);
  if (!flowOn || !cy || ts - lastTick < 33) return; // ~30 fps is plenty for marching dashes
  lastTick = ts;
  const edges = cy.edges();
  if (edges.length > FLOW_EDGE_LIMIT) return;
  dashOffset = (dashOffset - 0.8) % 1000;
  edges.style('line-dash-offset', dashOffset);
}

function setFlow(on) {
  flowOn = on;
  flowBtn.setAttribute('aria-pressed', String(on));
  if (!on) cy?.edges().style('line-dash-offset', 0);
}

/* --------------------------------------------------------------- export */

const exportName = () => `${envSelect.value || 'diagram'}-${document.documentElement.getAttribute('data-preset')}-${currentTheme()}`;

function download(href, filename) {
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

// Whole diagram (not just the viewport), at 2x, on the current background colour.
function renderPng(scale = 2) {
  return cy.png({ full: true, scale, bg: cssVar('--bg'), output: 'base64uri' });
}

function exportPng() {
  if (cy) download(renderPng(), `${exportName()}.png`);
}

let jspdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf);
  jspdfLoading ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    el.onload = () => resolve(window.jspdf);
    el.onerror = () => { jspdfLoading = null; reject(new Error('jsPDF failed to load')); };
    document.head.appendChild(el);
  });
  return jspdfLoading;
}

async function exportPdf() {
  if (!cy) return;
  const [{ jsPDF }, uri] = await Promise.all([loadJsPdf(), Promise.resolve(renderPng(2))]);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
  const landscape = img.width >= img.height;
  // page sized to the diagram (px → pt at 0.5 since the PNG is 2x): one page, vector-free but sharp
  const pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'pt', format: [img.width / 2, img.height / 2] });
  pdf.addImage(uri, 'PNG', 0, 0, img.width / 2, img.height / 2);
  pdf.save(`${exportName()}.pdf`);
}

/* --------------------------------------------------------------- wiring */

document.getElementById('export-png').addEventListener('click', exportPng);
document.getElementById('export-pdf').addEventListener('click', () => exportPdf().catch((e) => { coverageEl.textContent = `⚠ PDF export failed: ${e.message}`; }));

document.getElementById('fit-btn').addEventListener('click', fit);
document.getElementById('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
zoomLevelEl.addEventListener('click', () => zoomTo(1));
document.getElementById('expand-all-btn').addEventListener('click', () => { cy?.expandCollapse('get').expandAll(); setTimeout(fit, REDUCED_MOTION ? 0 : 320); });
document.getElementById('collapse-all-btn').addEventListener('click', () => { cy?.expandCollapse('get').collapseAll(); setTimeout(fit, REDUCED_MOTION ? 0 : 320); });
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
document.querySelectorAll('#style-pick button').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
document.getElementById('rotate-btn').addEventListener('click', () => { vertical = !vertical; applyLayout(true, fit); });
flowBtn.addEventListener('click', () => setFlow(!flowOn));
envSelect.addEventListener('change', () => {
  {
    const h = new URLSearchParams(location.hash.slice(1));
    h.set('env', envSelect.value);
    history.replaceState(null, '', `#${h.toString()}`);
  }
  loadEnvironment(envSelect.value);
});
window.addEventListener('hashchange', () => {
  const wanted = envFromHash();
  if (wanted && wanted !== envSelect.value && [...envSelect.options].some((o) => o.value === wanted)) {
    envSelect.value = wanted;
    loadEnvironment(wanted);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
  else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
  else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '0') zoomTo(1);
});

flowBtn.setAttribute('aria-pressed', String(flowOn));
syncThemeLabel();
syncPresetPicker();
if (!REDUCED_MOTION) flowOn = currentPreset().flow;
flowBtn.setAttribute('aria-pressed', String(flowOn));
// web fonts (labels, UI) arrive after first paint: restyle once they are in
document.fonts?.ready.then(() => { if (cy) cy.style(buildStyle()); });
requestAnimationFrame(flowTick);
loadEnvironmentList().then((list) => {
  const wanted = envFromHash();
  const initial = list.some((e) => e.id === wanted) ? wanted : list[0].id;
  envSelect.value = initial;
  loadEnvironment(initial);
});
