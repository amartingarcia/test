// infra-diagram viewer — Cytoscape.js + expand-collapse, environment selector,
// attribute drill-down panel, light/dark theme, zoom HUD, animated link flow.
// Static page, no build step: reads a pre-compiled compound graph from
// data/<environment>.json (see scripts/build-sample-data.mjs).
//
// Known limitation: the environment list below is hardcoded because this
// is a static site with no directory listing — add an entry here whenever
// scripts/build-sample-data.mjs (or its real-repo equivalent) writes a new
// data/<env>.json.
const ENVIRONMENTS = ['data_dev'];

cytoscape.use(cytoscapeFcose);
// cytoscape-expand-collapse (UMD, v4.x) self-registers against the global
// `cytoscape` once both scripts are loaded — no explicit cytoscape.use() call.

const KIND_CLASS = (kind) => {
  if (kind.startsWith('aws.vpc') || kind.startsWith('aws.subnet') || kind.startsWith('aws.nat') || kind.startsWith('aws.internet') || kind.startsWith('aws.route') || kind.startsWith('aws.security_group')) return 'net';
  if (kind.startsWith('aws.eks')) return 'eks';
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

for (const env of ENVIRONMENTS) {
  const opt = document.createElement('option');
  opt.value = env;
  opt.textContent = env;
  envSelect.appendChild(opt);
}

let cy = null;
let flowOn = !REDUCED_MOTION;

/* ------------------------------------------------------------------ theme */

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const currentTheme = () => document.documentElement.getAttribute('data-theme');

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

// Cytoscape can't draw HTML in a node, so each resource card is an SVG
// (icon chip, name, kind) rendered to a data URI and used as the node's
// background image. Regenerated on theme change. Fonts: an SVG used as an
// <img> can't load web fonts, hence the system stacks.
const CARD_W = 176;
const CARD_H = 64;
const GLYPHS = [
  ['eks.nodegroup', 'M3 6l7-3 7 3-7 3zM3 10l7 3 7-3M3 14l7 3 7-3'],
  ['eks.addon', 'M4 4h12v12H4zM10 7v6M7 10h6'],
  ['eks', 'M10 2l7 4v8l-7 4-7-4V6z'],
  ['internet_gateway', 'M3 10h14M10 3c3 3 3 11 0 14M10 3c-3 3-3 11 0 14M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0'],
  ['nat', 'M4 10h12M12 6l4 4-4 4'],
  ['route', 'M4 15l4-4 3 3 5-6'],
  ['security_group', 'M10 3l6 2v5c0 4-3 6-6 7-3-1-6-3-6-7V5z'],
  ['subnet', 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z'],
  ['vpc', 'M6 15a3.5 3.5 0 0 1 .5-6.9A5 5 0 0 1 16 9a3 3 0 0 1 0 6H6z'],
];
const glyphFor = (kind) => (GLYPHS.find(([k]) => kind.includes(k)) ?? [null, 'M4 4h12v12H4z'])[1];
const xmlEscape = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function cardSvg({ name, kind, class: cls }) {
  const accent = { net: cssVar('--net'), eks: cssVar('--eks'), default: cssVar('--def') }[cls] ?? cssVar('--def');
  const nodeBg = cssVar('--node');
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const kindShort = kind.split('.').slice(1).join('.');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity=".20"/><stop offset=".6" stop-color="${accent}" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="${nodeBg}"/>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#g)"/>
  <rect x="12" y="14" width="36" height="36" rx="10" fill="${accent}" fill-opacity=".16" stroke="${accent}" stroke-opacity=".55"/>
  <g transform="translate(20 22)" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${glyphFor(kind)}"/></g>
  <text x="58" y="30" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="14" font-weight="700" fill="${text}">${xmlEscape(clip(name, 15))}</text>
  <text x="58" y="46" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="10" fill="${muted}">${xmlEscape(clip(kindShort, 21))}</text>
  <circle cx="${CARD_W - 14}" cy="14" r="3" fill="${accent}"/>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function paintCards() {
  cy?.batch(() => cy.nodes().forEach((n) => n.data('card', cardSvg(n.data()))));
}

/* ----------------------------------------------------------------- styles */

function buildStyle() {
  const colors = { net: cssVar('--net'), eks: cssVar('--eks'), default: cssVar('--def') };
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const nodeBg = cssVar('--node');
  const bg = cssVar('--bg');
  const glow = Number(cssVar('--glow')) || 0.3;
  const hit = cssVar('--hit');
  const edgeAlt = cssVar('--edge-alt');

  const style = [
    { selector: 'node', style: {
      'label': '', 'shape': 'round-rectangle', 'corner-radius': 14, 'width': CARD_W, 'height': CARD_H,
      'background-color': nodeBg, 'background-image': 'data(card)', 'background-fit': 'cover', 'background-clip': 'node',
      'border-width': 1.5, 'border-color': colors.default,
      'underlay-color': colors.default, 'underlay-opacity': glow, 'underlay-padding': 7, 'underlay-shape': 'round-rectangle',
      'transition-property': 'opacity, border-width, underlay-opacity', 'transition-duration': '0.18s',
    }},
    { selector: ':parent', style: {
      'background-image': 'none', 'background-opacity': 0.07, 'background-color': colors.default, 'border-width': 1.5, 'border-style': 'dashed',
      'label': 'data(groupLabel)', 'color': text, 'font-family': 'JetBrains Mono, ui-monospace, monospace', 'font-size': 12, 'font-weight': 'bold',
      'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -2, 'padding': '30px', 'corner-radius': 18,
      'text-background-color': bg, 'text-background-opacity': 1, 'text-background-padding': '5px', 'text-background-shape': 'round-rectangle',
      'underlay-opacity': glow * 0.35,
    }},
    ...Object.entries(colors).filter(([k]) => k !== 'default').flatMap(([cls, c]) => [
      { selector: `node[class = "${cls}"]`, style: { 'border-color': c, 'underlay-color': c } },
      { selector: `:parent[class = "${cls}"]`, style: { 'background-color': c, 'border-color': c, 'underlay-color': c } },
    ]),
    { selector: 'edge', style: {
      'width': 2, 'curve-style': 'bezier', 'line-color': colors.default, 'target-arrow-color': colors.default,
      'target-arrow-shape': 'triangle', 'arrow-scale': 1.1,
      'line-style': 'dashed', 'line-dash-pattern': [8, 6],
      'underlay-color': colors.default, 'underlay-opacity': glow * 0.7, 'underlay-padding': 3,
      'label': 'data(label)', 'font-size': 10, 'font-family': 'JetBrains Mono, ui-monospace, monospace', 'color': muted,
      'text-background-color': bg, 'text-background-opacity': 0.85, 'text-background-padding': '3px', 'text-background-shape': 'round-rectangle',
      'text-rotation': 'autorotate',
      'transition-property': 'opacity', 'transition-duration': '0.18s',
    }},
    // cross-repo links get their own hot color: they are the whole point of the tool
    { selector: 'edge[crossRepo]', style: { 'line-color': edgeAlt, 'target-arrow-color': edgeAlt, 'underlay-color': edgeAlt } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': hit, 'underlay-opacity': Math.min(glow * 2, 0.6), 'underlay-padding': 10 } },
    { selector: '.dim', style: { 'opacity': 0.16 } },
    { selector: 'edge.hot', style: { 'width': 3.2, 'underlay-opacity': Math.min(glow * 1.6, 0.6) } },
  ];
  return style;
}

/* ------------------------------------------------------------------- data */

async function loadEnvironment(env) {
  // `no-cache` = always revalidate (cheap, ETag-based): GitHub Pages serves
  // max-age=600, so without this a fresh deploy's data can look stale for 10 min.
  const res = await fetch(`data/${env}.json`, { cache: 'no-cache' });
  if (!res.ok) {
    sidebar.innerHTML = `<div class="empty">Could not load data/${escapeHtml(env)}.json (HTTP ${res.status}).<br />Check that the file exists in viewer/data/.</div>`;
    return;
  }
  const graph = await res.json();
  renderGraph(graph);
  renderCoverage(graph);
  renderLegend(graph);
}

function entityName(entity) {
  const rawName = entity.id.split(':').slice(2).join(':');
  return rawName.includes('.') ? rawName.split('.').pop() : rawName;
}

/** "vpc\nmain", "subnet.public\npublic", "eks.nodegroup\ndefault": kind first, then name. */
function entityLabel(entity) {
  const kindShort = entity.kind.split('.').slice(1).join('.');
  return `${kindShort}\n${entityName(entity)}`;
}

function renderCoverage(graph) {
  const parts = [];
  for (const [repoId, cov] of Object.entries(graph.coverage ?? {})) {
    if (cov.unmapped.length) parts.push(`${repoId}: ${cov.unmapped.length} unmapped resource(s)`);
    if (cov.unresolvedBoundaries.length) parts.push(`${repoId}: ${cov.unresolvedBoundaries.length} unresolved boundary(ies)`);
  }
  if ((graph.unresolvedCrossRepoLinks ?? []).length) {
    parts.push(`${graph.unresolvedCrossRepoLinks.length} unresolved cross-repo link(s)`);
  }
  coverageEl.textContent = parts.length ? `⚠ ${parts.join(' · ')}` : '';
}

function renderLegend(graph) {
  const counts = { net: 0, eks: 0, default: 0 };
  for (const e of graph.entities) counts[KIND_CLASS(e.kind)]++;
  const names = { net: 'Network', eks: 'Kubernetes', default: 'Other' };
  const cls = { net: 'net', eks: 'eks', default: 'def' };
  document.getElementById('legend-row').innerHTML = Object.keys(counts)
    .filter((k) => counts[k] > 0)
    .map((k) => `<span class="key-dot ${cls[k]}"><i></i><span>${names[k]} ${counts[k]}</span></span>`)
    .join('');
}

function renderGraph(graph) {
  const elements = [];
  const byId = new Map(graph.entities.map((e) => [e.id, e]));

  for (const entity of graph.entities) {
    elements.push({
      data: {
        id: entity.id,
        label: entityLabel(entity),
        name: entityName(entity),
        groupLabel: `${entity.kind.split('.').slice(1).join('.')} · ${entityName(entity)}`,
        kind: entity.kind,
        parent: entity.parent ?? undefined,
        repoId: entity.repoId,
        sourceAddress: entity.sourceAddress,
        details: entity.details ?? null,
        class: KIND_CLASS(entity.kind),
      },
    });
  }

  // Containment already says "child belongs to parent"; an edge from a child
  // to its own parent (e.g. subnet -> vpc, addon -> cluster) would just draw a
  // noisy loop on top of it, so skip those.
  for (const [i, edge] of graph.edges.entries()) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from?.parent === edge.to || to?.parent === edge.from) continue;
    const data = { id: `e${i}`, source: edge.from, target: edge.to, label: edge.label ?? '' };
    if (from && to && from.repoId !== to.repoId) data.crossRepo = true;
    elements.push({ data });
  }

  if (cy) { cy.destroy(); cy = null; }
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: buildStyle(),
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    wheelSensitivity: 0.25,
    layout: { name: 'fcose', nodeDimensionsIncludeLabels: true, animate: false, padding: 60, nodeRepulsion: () => 14000, idealEdgeLength: () => 150 },
  });

  cy.on('tap', 'node', (evt) => { renderDetails(evt.target.data()); focusNeighborhood(evt.target); });
  cy.on('tap', (evt) => {
    if (evt.target !== cy) return;
    clearFocus();
    sidebar.innerHTML = '<div class="empty">Click a resource to see its configuration.<br />Scroll to zoom, drag to pan.</div>';
  });
  cy.on('zoom', updateZoomLabel);

  if (cy.expandCollapse) {
    cy.expandCollapse({ layoutBy: { name: 'fcose', animate: false }, fisheye: false, undoable: false });
  }

  paintCards();
  updateZoomLabel();
  playEntrance();
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

function renderDetails(data) {
  const badge = `<span class="badge ${data.class}">${data.class === 'default' ? 'other' : data.class}</span>`;
  let html = `<h2>${escapeHtml(data.name)}${badge}</h2><div class="kind">${escapeHtml(data.kind)}</div>`;
  html += `<table>
    <tr><td class="key">repo</td><td class="val">${escapeHtml(data.repoId)}</td></tr>
    <tr><td class="key">source address</td><td class="val">${escapeHtml(data.sourceAddress)}</td></tr>
    <tr><td class="key">parent</td><td class="val">${escapeHtml(data.parent ?? '—')}</td></tr>
  </table>`;

  if (data.details) {
    html += '<h3>Configuration (from source .tf)</h3><table>';
    for (const [key, result] of Object.entries(data.details)) {
      const val = result.resolved
        ? `<span class="val">${escapeHtml(JSON.stringify(result.value))}</span>`
        : `<span class="unresolved">unresolved</span><div class="raw">${escapeHtml(result.raw)}</div>`;
      html += `<tr><td class="key">${escapeHtml(key)}</td><td class="val">${val}</td></tr>`;
    }
    html += '</table>';
  } else {
    html += '<h3>Configuration</h3><div class="empty" style="margin-top:4px">No attribute details extracted for this resource.</div>';
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

function zoomBy(factor) {
  if (!cy) return;
  const level = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cy.zoom() * factor));
  cy.animate({ zoom: { level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: REDUCED_MOTION ? 0 : 160 });
}

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

/* --------------------------------------------------------------- wiring */

document.getElementById('fit-btn').addEventListener('click', fit);
document.getElementById('zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
zoomLevelEl.addEventListener('click', () => cy?.animate({ zoom: { level: 1, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: REDUCED_MOTION ? 0 : 160 }));
document.getElementById('expand-all-btn').addEventListener('click', () => cy?.expandCollapse('get').expandAll());
document.getElementById('collapse-all-btn').addEventListener('click', () => cy?.expandCollapse('get').collapseAll());
document.getElementById('theme-btn').addEventListener('click', toggleTheme);
flowBtn.addEventListener('click', () => setFlow(!flowOn));
envSelect.addEventListener('change', () => loadEnvironment(envSelect.value));

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
  else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
  else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '0') cy?.zoom({ level: 1, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
});

flowBtn.setAttribute('aria-pressed', String(flowOn));
syncThemeLabel();
requestAnimationFrame(flowTick);
loadEnvironment(ENVIRONMENTS[0]);
