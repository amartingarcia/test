// Pure SVG renderer: compiled graph + catalog -> a self-contained, VECTOR svg string
// (rects, paths, text; no raster, no external fonts, no scripts). Used by the "SVG" export button
// of the viewer and by scripts/export-html.mjs (standalone HTML), so both draw the same picture.
// No DOM: testable in Node (test/render-svg.test.mjs).

import { buildDiagram, layoutDiagram, groupOfKind, specForKind, isGroupKind, resolved } from './diagram-model.mjs';

/*
 * Style presets: the shape/type decisions (colours live in PALETTES / index.html).
 *  radius: node corner radius; chip: icon chip shape; fill: card fill style (gradient | flat | tint);
 *  border: node border width; group: container border style; edge: line style.
 */
export const PRESETS = {
  blueprint: { label: 'Blueprint', radius: 14, groupRadius: 18, chip: 10, fill: 'gradient', border: 1.5, group: 'dashed', edgeStyle: 'dashed', edgeWidth: 2, taxiRadius: 10, nameFont: "system-ui, -apple-system, 'Segoe UI', sans-serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: true },
  draft:     { label: 'Draft', radius: 3, groupRadius: 3, chip: 0, fill: 'flat', border: 1.2, group: 'dotted', edgeStyle: 'solid', edgeWidth: 1.4, taxiRadius: 0, nameFont: "Georgia, 'Times New Roman', serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: false },
  neon:      { label: 'Neon', radius: 20, groupRadius: 26, chip: 99, fill: 'gradient', border: 2, group: 'solid', edgeStyle: 'solid', edgeWidth: 2.4, taxiRadius: 14, nameFont: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: true },
  soft:      { label: 'Soft', radius: 16, groupRadius: 22, chip: 12, fill: 'tint', border: 1, group: 'solid', edgeStyle: 'solid', edgeWidth: 2, taxiRadius: 16, nameFont: "system-ui, -apple-system, 'Segoe UI', sans-serif", monoFont: "ui-monospace, Menlo, Consolas, monospace", flow: false },
};
export const PRESET_IDS = Object.keys(PRESETS);

// Mirror of the CSS tokens in index.html (a test fails if they drift apart). `def` is the colour of the "default" class.
export const PALETTES = {
  'blueprint/dark': { 'bg': '#07111f', 'border': 'rgba(111,177,255,.26)', 'text': '#d6e6ff', 'muted': '#7e95b3', 'node': '#0b1b30', 'hit': '#ffffff', 'net': '#6fb1ff', 'compute': '#52d1e6', 'eks': '#b59bff', 'k8s': '#5fdc9a', 'data': '#ff8fb3', 'iam': '#f2c14e', 'cfg': '#9db0c4', 'edgeapp': '#4fdcc2', 'def': '#52d1e6', glow: .34 },
  'blueprint/light': { 'bg': '#eef4fb', 'border': 'rgba(31,111,209,.26)', 'text': '#10304f', 'muted': '#5a7089', 'node': '#ffffff', 'hit': '#10304f', 'net': '#1f6fd1', 'compute': '#0a7f96', 'eks': '#6b4bd6', 'k8s': '#178a56', 'data': '#c2336b', 'iam': '#9a6a00', 'cfg': '#52667c', 'edgeapp': '#0a8573', 'def': '#0a7f96', glow: .12 },
  'draft/dark': { 'bg': '#17201c', 'border': 'rgba(232,239,230,.4)', 'text': '#e8efe6', 'muted': '#9fb0a3', 'node': '#202b26', 'hit': '#ffffff', 'net': '#9db8e8', 'compute': '#8fd0d8', 'eks': '#c0b4ec', 'k8s': '#9fd3b4', 'data': '#e3a3b6', 'iam': '#e0c27a', 'cfg': '#b4bcc6', 'edgeapp': '#96d6cc', 'def': '#8fd0d8', glow: 0 },
  'draft/light': { 'bg': '#f1f3f4', 'border': 'rgba(27,39,51,.5)', 'text': '#1b2733', 'muted': '#5b6773', 'node': '#fbfcfc', 'hit': '#1b2733', 'net': '#2f4f8f', 'compute': '#1d6b78', 'eks': '#5b4a8a', 'k8s': '#2f6b4a', 'data': '#8f3a55', 'iam': '#8a6414', 'cfg': '#55606c', 'edgeapp': '#1f6a60', 'def': '#1d6b78', glow: 0 },
  'neon/dark': { 'bg': '#05060d', 'border': 'rgba(255,255,255,.16)', 'text': '#eaf0ff', 'muted': '#7a86a8', 'node': '#0a0c1a', 'hit': '#ffffff', 'net': '#3b9eff', 'compute': '#00e5ff', 'eks': '#b26bff', 'k8s': '#39ff88', 'data': '#ff4fa3', 'iam': '#ffd400', 'cfg': '#8aa0b8', 'edgeapp': '#1de9b6', 'def': '#00e5ff', glow: .6 },
  'neon/light': { 'bg': '#f7f5ff', 'border': 'rgba(90,60,200,.28)', 'text': '#1a1740', 'muted': '#62608a', 'node': '#ffffff', 'hit': '#1a1740', 'net': '#1b6fe0', 'compute': '#0097b2', 'eks': '#8a3ff0', 'k8s': '#0f9d58', 'data': '#e0287f', 'iam': '#b88a00', 'cfg': '#5b6b82', 'edgeapp': '#0a9e82', 'def': '#0097b2', glow: .22 },
  'soft/dark': { 'bg': '#12141c', 'border': 'rgba(255,255,255,.1)', 'text': '#e7eaf3', 'muted': '#8c96ad', 'node': '#1b1f2b', 'hit': '#ffffff', 'net': '#6ba2ff', 'compute': '#3cc9de', 'eks': '#a089f5', 'k8s': '#4cc795', 'data': '#f57fae', 'iam': '#f5b95a', 'cfg': '#93a1b6', 'edgeapp': '#44d1b4', 'def': '#3cc9de', glow: .08 },
  'soft/light': { 'bg': '#f6f7fb', 'border': 'rgba(31,42,68,.1)', 'text': '#1f2a44', 'muted': '#6b778f', 'node': '#ffffff', 'hit': '#1f2a44', 'net': '#4f8df7', 'compute': '#22b8cf', 'eks': '#8b6cf0', 'k8s': '#34b37e', 'data': '#f0629a', 'iam': '#f2a93b', 'cfg': '#7b8aa0', 'edgeapp': '#2ec4a6', 'def': '#22b8cf', glow: .08 },
};

export const GLYPHS = {
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
  clock: 'M10 3a7 7 0 1 0 .01 0zM10 6v4l3 2',
  argo: 'M10 2l7 4v8l-7 4-7-4V6zM6.5 10l2.5 2.5L14 7.5',
  box: 'M4 4h12v12H4z',
};

export const xmlEscape = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const dash = (style) => (style === 'dashed' ? '8 6' : style === 'dotted' ? '2 5' : null);
const r1 = (n) => Math.round(n * 10) / 10;

export function paletteFor(preset, theme) {
  return PALETTES[`${preset}/${theme}`] ?? PALETTES['blueprint/dark'];
}
const colorOf = (pal, cls) => (cls === 'default' ? pal.def : pal[cls] ?? pal.def);

/** Card (leaf) markup at (x, y). Mirrors the viewer's node card. */
function card(n, box, ctx) {
  const { P, pal, catalog } = ctx;
  const accent = colorOf(pal, n.class);
  const group = groupOfKind(catalog, n.kind);
  const spec = group ?? specForKind(catalog, n.kind);
  const { w, h } = box;
  const compact = h < 60;
  let name = n.name;
  let kindShort = n.kind.split('.').slice(1).join('.');
  if (group) { const [head, ...rest] = (n.groupLabel ?? '').split(' · '); name = head; kindShort = rest.join(' · ') || 'group'; }

  let sub = kindShort;
  if (compact) {
    const chart = resolved(n.details, 'chart');
    const version = resolved(n.details, 'version');
    const image = resolved(n.details, 'image');
    const ns = resolved(n.details, 'namespace');
    const shortImage = typeof image === 'string' ? image.split('/').pop() : undefined;
    const withNs = ns && n.parentKind !== 'k8s.namespace' ? `${ns} · ` : '';
    sub = chart ? `${chart}${version ? ` v${version}` : ''}` : shortImage ? `${withNs}${shortImage}` : kindShort;
  }
  const chip = compact ? 30 : 36;
  const cy0 = (h - chip) / 2;
  const gs = chip / 36;
  const tx = chip + 24;
  const rx = P.radius;
  const chipRx = Math.min(P.chip, chip / 2);
  const fillLayer = P.fill === 'gradient'
    ? `<rect width="${w}" height="${h}" rx="${rx}" fill="url(#g-${n.class})"/>`
    : P.fill === 'tint' ? `<rect width="${w}" height="${h}" rx="${rx}" fill="${accent}" fill-opacity=".07"/>` : '';
  ctx.usedClasses.add(n.class);
  return `<g class="n" data-id="${xmlEscape(n.id)}" transform="translate(${r1(box.x)} ${r1(box.y)})">
<rect width="${w}" height="${h}" rx="${rx}" fill="${pal.node}" stroke="${accent}" stroke-width="${P.border}"/>${fillLayer}
<rect x="12" y="${cy0}" width="${chip}" height="${chip}" rx="${chipRx}" fill="${P.fill === 'flat' ? 'none' : accent}" fill-opacity=".16" stroke="${accent}" stroke-opacity="${P.fill === 'flat' ? 0.9 : 0.55}"/>
<g transform="translate(${12 + (chip - 20 * gs) / 2} ${cy0 + (chip - 20 * gs) / 2}) scale(${gs})" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${GLYPHS[spec.glyph] ?? GLYPHS.box}"/></g>
<text x="${tx}" y="${compact ? 22 : 30}" font-family="${xmlEscape(P.nameFont)}" font-size="${compact ? 12.5 : 14}" font-weight="700" fill="${pal.text}">${xmlEscape(clip(name ?? '', compact ? 20 : 15))}</text>
<text x="${tx}" y="${compact ? 37 : 46}" font-family="${xmlEscape(P.monoFont)}" font-size="10" fill="${pal.muted}">${xmlEscape(clip(sub, compact ? 22 : 21))}</text>
<circle cx="${w - 14}" cy="14" r="3" fill="${accent}"/>
</g>`;
}

function container(n, box, ctx) {
  const { P, pal } = ctx;
  const accent = colorOf(pal, n.class);
  const d = dash(P.group);
  return `<g class="c" data-id="${xmlEscape(n.id)}" transform="translate(${r1(box.x)} ${r1(box.y)})"><rect width="${r1(box.w)}" height="${r1(box.h)}" rx="${P.groupRadius}" fill="${accent}" fill-opacity=".07" stroke="${accent}" stroke-width="${P.border}"${d ? ` stroke-dasharray="${d}"` : ''}/></g>`;
}

/** Container tab: drawn above the links, on a pill of the background colour, so lines never strike through it. */
function containerLabel(n, box, ctx) {
  const { P, pal } = ctx;
  const lines = String(n.groupLabel ?? n.name ?? '').split('\n').map((l) => clip(l, Math.max(12, Math.floor(box.w / 7.4))));
  const width = Math.min(box.w - 16, Math.max(...lines.map((l) => l.length)) * 7.3 + 16);
  const tspans = lines.map((l, i) => `<tspan x="${r1(box.w / 2)}" dy="${i === 0 ? 0 : 14}">${xmlEscape(l)}</tspan>`).join('');
  return `<g class="l" transform="translate(${r1(box.x)} ${r1(box.y)})"><rect x="${r1((box.w - width) / 2)}" y="8" width="${r1(width)}" height="${12 + lines.length * 14}" rx="6" fill="${pal.bg}" fill-opacity=".92"/><text x="${r1(box.w / 2)}" y="22" text-anchor="middle" font-family="${xmlEscape(P.monoFont)}" font-size="12" font-weight="700" fill="${pal.text}">${tspans}</text></g>`;
}

/** Orthogonal route between two boxes, attach points spread along the side they share. */
function routeEdges(edges, boxes) {
  const sideOf = new Map(); // `${nodeId}|${side}` -> edge ids
  const plan = [];
  for (const e of edges) {
    const a = boxes[e.source]; const b = boxes[e.target];
    if (!a || !b) continue;
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }; const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = bc.x - ac.x; const dy = bc.y - ac.y;
    // horizontal flow only when the boxes are separated horizontally; otherwise flow vertically
    const gapX = dx >= 0 ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
    const gapY = dy >= 0 ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
    const horizontal = gapX > 0 && (gapX >= gapY || gapY <= 0) && Math.abs(dx) >= Math.abs(dy) * 0.5 ? true : gapY > 0 ? false : gapX > 0;
    const sSide = horizontal ? (dx >= 0 ? 'r' : 'l') : (dy >= 0 ? 'b' : 't');
    const tSide = horizontal ? (dx >= 0 ? 'l' : 'r') : (dy >= 0 ? 't' : 'b');
    for (const [id, side] of [[e.source, sSide], [e.target, tSide]]) {
      const k = `${id}|${side}`;
      if (!sideOf.has(k)) sideOf.set(k, []);
      sideOf.get(k).push(e.id);
    }
    plan.push({ e, a, b, horizontal, sSide, tSide });
  }
  const attach = (box, side, edgeId, id) => {
    const list = sideOf.get(`${id}|${side}`);
    const i = list.indexOf(edgeId); const n = list.length;
    const span = side === 'l' || side === 'r' ? box.h : box.w;
    const step = Math.min(12, (span - 24) / Math.max(1, n));
    const off = (i - (n - 1) / 2) * step;
    if (side === 'r') return { x: box.x + box.w, y: box.y + box.h / 2 + off };
    if (side === 'l') return { x: box.x, y: box.y + box.h / 2 + off };
    if (side === 'b') return { x: box.x + box.w / 2 + off, y: box.y + box.h };
    return { x: box.x + box.w / 2 + off, y: box.y };
  };
  return plan.map(({ e, a, b, horizontal, sSide, tSide }) => {
    const s = attach(a, sSide, e.id, e.source); const t = attach(b, tSide, e.id, e.target);
    let pts;
    if (horizontal) { const mx = (s.x + t.x) / 2; pts = [s, { x: mx, y: s.y }, { x: mx, y: t.y }, t]; }
    else { const my = (s.y + t.y) / 2; pts = [s, { x: s.x, y: my }, { x: t.x, y: my }, t]; }
    return { edge: e, pts };
  });
}

function pathOf(pts, radius) {
  // drop collinear/zero-length points, then round the corners
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 0.5);
  if (p.length < 2) return `M${r1(pts[0].x)} ${r1(pts[0].y)}`;
  let d = `M${r1(p[0].x)} ${r1(p[0].y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]; const b = p[i]; const c = p[i + 1];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    if (r < 1) { d += `L${r1(b.x)} ${r1(b.y)}`; continue; }
    const ux = Math.sign(b.x - a.x); const uy = Math.sign(b.y - a.y);
    const vx = Math.sign(c.x - b.x); const vy = Math.sign(c.y - b.y);
    d += `L${r1(b.x - ux * r)} ${r1(b.y - uy * r)}Q${r1(b.x)} ${r1(b.y)} ${r1(b.x + vx * r)} ${r1(b.y + vy * r)}`;
  }
  const last = p[p.length - 1];
  return `${d}L${r1(last.x)} ${r1(last.y)}`;
}

/**
 * @param {{entities: object[], edges: object[]}} graph compiled environment graph
 * @param {{kinds: object, groups?: object}} catalog
 * @param {{preset?: string, theme?: 'dark'|'light', vertical?: boolean, margin?: number, background?: boolean, title?: string}} [options]
 * @returns {{svg: string, width: number, height: number, vertical: boolean, nodes: number, edges: number}}
 */
export function renderSvg(graph, catalog, options = {}) {
  const preset = PRESETS[options.preset] ? options.preset : 'blueprint';
  const theme = options.theme === 'light' ? 'light' : 'dark';
  const margin = options.margin ?? 40;
  const P = PRESETS[preset];
  const pal = paletteFor(preset, theme);
  const { nodes, edges } = buildDiagram(graph, catalog);
  const empty = { svg: '', width: 0, height: 0, vertical: false, nodes: 0, edges: 0 };
  if (!nodes.length) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120"><rect width="320" height="120" fill="${pal.bg}"/><text x="20" y="64" font-family="${xmlEscape(P.monoFont)}" fill="${pal.muted}">empty graph</text></svg>`;
    return { ...empty, svg, width: 320, height: 120 };
  }
  const { boxes, width: lw, height: lh, vertical } = layoutDiagram(nodes, catalog, { vertical: options.vertical });
  const hasChildren = new Set(nodes.filter((n) => n.parent && boxes[n.parent]).map((n) => n.parent));
  const depth = (n, byId, guard = 0) => (n.parent && byId.get(n.parent) && guard < 30 ? 1 + depth(byId.get(n.parent), byId, guard + 1) : 0);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ctx = { P, pal, catalog, usedClasses: new Set() };

  const containers = nodes.filter((n) => hasChildren.has(n.id)).sort((a, b) => depth(a, byId) - depth(b, byId));
  const leaves = nodes.filter((n) => !hasChildren.has(n.id));
  const containerSvg = containers.map((n) => container(n, boxes[n.id], ctx)).join('\n');
  const labelSvg = containers.map((n) => containerLabel(n, boxes[n.id], ctx)).join('\n');
  const leafSvg = leaves.map((n) => card(n, boxes[n.id], ctx)).join('\n');

  const routed = routeEdges(edges, boxes);
  const usedEdgeClasses = new Set(routed.map((r) => r.edge.cls));
  const ed = dash(P.edgeStyle);
  const edgeSvg = routed.map(({ edge, pts }) => {
    const color = colorOf(pal, edge.cls === 'iam' || edge.cls === 'data' || edge.cls === 'k8s' ? edge.cls : 'default');
    const title = edge.label ? `<title>${xmlEscape(edge.label)}</title>` : '';
    return `<path class="e" data-from="${xmlEscape(edge.source)}" data-to="${xmlEscape(edge.target)}" d="${pathOf(pts, P.taxiRadius)}" fill="none" stroke="${color}" stroke-width="${P.edgeWidth}" stroke-opacity=".6"${ed ? ` stroke-dasharray="${ed}"` : ''} marker-end="url(#ah-${edge.cls === 'iam' || edge.cls === 'data' || edge.cls === 'k8s' ? edge.cls : 'default'})">${title}</path>`;
  }).join('\n');

  const W = Math.ceil(lw + margin * 2); const H = Math.ceil(lh + margin * 2);
  const markerClasses = [...new Set([...usedEdgeClasses].map((c) => (c === 'iam' || c === 'data' || c === 'k8s' ? c : 'default')))];
  const defs = [
    ...[...ctx.usedClasses].filter(() => P.fill === 'gradient').map((cls) => `<linearGradient id="g-${cls}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colorOf(pal, cls)}" stop-opacity=".20"/><stop offset=".6" stop-color="${colorOf(pal, cls)}" stop-opacity="0"/></linearGradient>`),
    ...markerClasses.map((cls) => `<marker id="ah-${cls}" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="${colorOf(pal, cls)}"/></marker>`),
  ].join('');
  const title = options.title ? `<title>${xmlEscape(options.title)}</title>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-preset="${preset}" data-theme="${theme}" role="img">${title}
<defs>${defs}</defs>
${options.background === false ? '' : `<rect width="${W}" height="${H}" fill="${pal.bg}"/>`}
<g transform="translate(${margin} ${margin})">
${containerSvg}
${edgeSvg}
${labelSvg}
${leafSvg}
</g>
</svg>`;
  return { svg, width: W, height: H, vertical, nodes: nodes.length, edges: routed.length };
}

export { isGroupKind };
