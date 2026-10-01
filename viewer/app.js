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
import { CLASSES, CLASS_NAMES, KIND_CLASS, CARD, specForKind, isGroupKind, groupOfKind, sizeOfKind, resolved, buildDiagram, layoutConfigFor } from './diagram-model.mjs';
import { PRESETS, PRESET_IDS, GLYPHS, xmlEscape, renderSvg } from './render-svg.mjs';

// Environment list comes from data/environments.json (one entry per tfvars file,
// written by the build scripts). The fallback below only matters if that file
// is missing.
const FALLBACK_ENVIRONMENTS = [{ id: 'platform_prod', label: 'platform / prod' }, { id: 'data_dev', label: 'data_dev' }];

// cytoscape-expand-collapse (UMD, v4.x) self-registers against the global
// `cytoscape` once both scripts are loaded — no explicit cytoscape.use() call.

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
const FLOW_EDGE_LIMIT = 400; // per-frame style writes get expensive past this

const envSelect = document.getElementById('env-select');
const viewSelect = document.getElementById('view-select');
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
  envList = list;
  // entries that share a `group` are views of one environment (e.g. by namespace / by node pool)
  envSelect.innerHTML = '';
  const seen = new Set();
  for (const env of list) {
    const key = groupKey(env);
    if (seen.has(key)) continue;
    seen.add(key);
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = env.label ?? env.id;
    envSelect.appendChild(opt);
  }
  return list;
}

let envList = [];
let currentEnvId = null;
const groupKey = (env) => env.group ?? env.id;

/** Selects a data file: syncs the environment and view selectors, the URL and the diagram. */
function selectEntry(id) {
  const entry = envList.find((e) => e.id === id);
  if (!entry) return;
  currentEnvId = id;
  envSelect.value = groupKey(entry);
  const views = envList.filter((e) => groupKey(e) === groupKey(entry) && e.view);
  viewSelect.innerHTML = '';
  for (const v of views) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.view;
    viewSelect.appendChild(opt);
  }
  viewSelect.hidden = views.length < 2;
  viewSelect.value = id;
  const h = new URLSearchParams(location.hash.slice(1));
  h.set('env', id);
  history.replaceState(null, '', `#${h.toString()}`);
  loadEnvironment(id);
}

/** `#env=platform_stage` selects an environment, so a view can be linked. */
const envFromHash = () => new URLSearchParams(location.hash.slice(1)).get('env');

let cy = null;
let catalog = { kinds: {}, groups: {} };
let flowOn = !REDUCED_MOTION;
let currentGraph = null; // last compiled graph, for the vector (SVG) export
let vertical = false; // false: tiers run left to right; true: top to bottom

/* ---------------------------------------------------------------- catalog */

const specFor = (kind) => specForKind(catalog, kind);
const sizeOf = (kind) => sizeOfKind(catalog, kind);
const groupOf_ = (kind) => groupOfKind(catalog, kind);

/* ------------------------------------------------------------------ theme */

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const currentTheme = () => document.documentElement.getAttribute('data-theme');
const CSS_NAME = { default: 'def', edgeapp: 'edgeapp' };

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
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function cardSvg({ name, kind, class: cls, details, parentKind }) {
  // (groups, e.g. IAM, only get a card while collapsed; their name arrives as the tab label)
  const accent = classColor(cls);
  const nodeBg = cssVar('--node');
  const text = cssVar('--text');
  const muted = cssVar('--muted');
  const group = groupOf_(kind);
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
    const image = resolved(details, 'image');
    const ns = resolved(details, 'namespace');
    const shortImage = typeof image === 'string' ? image.split('/').pop() : undefined;
    // a workload drawn outside its namespace container (node-pool view) carries the namespace in its sub line
    const withNs = ns && parentKind !== 'k8s.namespace' ? `${ns} · ` : '';
    sub = chart ? `${chart}${version ? ` v${version}` : ''}` : shortImage ? `${withNs}${shortImage}` : kindShort;
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
  <text x="${tx}" y="${compact ? 22 : 30}" font-family="${P.nameFont}" font-size="${compact ? 12.5 : 14}" font-weight="700" fill="${text}">${xmlEscape(clip(name, compact ? 20 : 15))}</text>
  <text x="${tx}" y="${compact ? 37 : 46}" font-family="${P.monoFont}" font-size="10" fill="${muted}">${xmlEscape(clip(sub, compact ? 22 : 21))}</text>
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
      'label': '', 'shape': 'round-rectangle', 'corner-radius': P.radius, 'width': 'data(w)', 'height': 'data(h)',
      'background-color': nodeBg, 'background-image': 'data(card)', 'background-fit': 'cover', 'background-clip': 'node',
      'border-width': P.border, 'border-color': classColor('default'),
      'underlay-color': classColor('default'), 'underlay-opacity': glow, 'underlay-padding': 7, 'underlay-shape': 'round-rectangle',
      'transition-property': 'opacity, border-width, underlay-opacity', 'transition-duration': '0.18s',
    }},
    { selector: 'node[h < 60]', style: { 'corner-radius': Math.min(P.radius, 12) } },
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
  if ((graph.findings ?? []).length) parts.push(`${graph.findings.length} finding(s)`);
  // the details behind the counts, readable on hover
  coverageEl.title = [
    ...(graph.unresolvedPlacements ?? []).map((u) => `${u.entityId}: ${u.reason}${u.candidates?.length ? ` (${u.candidates.join(', ')})` : ''}`),
    ...(graph.findings ?? []).map((f) => f.message),
  ].join('\n');
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
    .map((c) => `<span class="key-dot ${c === 'default' ? 'def' : c}"><i></i><span>${(graph.legend ?? {})[c] ?? CLASS_NAMES[c]} ${counts[c]}</span></span>`)
    .join('');
}

function renderGraph(graph) {
  currentGraph = graph;
  // boxes and links come from the shared model (also used by the SVG export)
  const { nodes, edges } = buildDiagram(graph, catalog);
  const elements = [
    ...nodes.map((data) => ({ data })),
    ...edges.map((data) => ({ data })),
  ];

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

const layoutConfig = () => layoutConfigFor(catalog, vertical);

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
    html += `<h3>Configuration (from ${data.repoId === 'k8s' ? 'manifests' : 'source .tf'})</h3>${configTable(data.details)}`;
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

const exportName = () => `${currentEnvId || 'diagram'}-${document.documentElement.getAttribute('data-preset')}-${currentTheme()}`;

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

// Vector export: the whole diagram from the shared pure renderer (rects, paths, text; no raster).
function exportSvg() {
  if (!currentGraph) return;
  const preset = document.documentElement.getAttribute('data-preset');
  const { svg } = renderSvg(currentGraph, catalog, { preset, theme: currentTheme(), vertical, title: currentEnvId });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  download(url, `${exportName()}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
document.getElementById('export-svg').addEventListener('click', exportSvg);
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
  // switching environment keeps the current view (by namespace / by node pool) when the new one has it
  const current = envList.find((e) => e.id === currentEnvId);
  const inGroup = envList.filter((e) => groupKey(e) === envSelect.value);
  selectEntry((inGroup.find((e) => current?.view && e.view === current.view) ?? inGroup[0]).id);
});
viewSelect.addEventListener('change', () => selectEntry(viewSelect.value));
window.addEventListener('hashchange', () => {
  const wanted = envFromHash();
  if (wanted && wanted !== currentEnvId && envList.some((e) => e.id === wanted)) selectEntry(wanted);
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
// the pane can change size after first paint (side panel, window): keep canvas and view in sync
if (window.ResizeObserver) {
  let first = true;
  new ResizeObserver(() => { if (!cy) return; cy.resize(); if (first) { first = false; return; } }).observe(document.getElementById('cy'));
}
flowBtn.setAttribute('aria-pressed', String(flowOn));
// web fonts (labels, UI) arrive after first paint: restyle once they are in
document.fonts?.ready.then(() => { if (cy) cy.style(buildStyle()); });
requestAnimationFrame(flowTick);
loadEnvironmentList().then((list) => {
  const wanted = envFromHash();
  selectEntry(list.some((e) => e.id === wanted) ? wanted : list[0].id);
});
