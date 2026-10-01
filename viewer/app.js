// infra-diagram viewer — T7 (Cytoscape.js + expand-collapse, environment
// selector, attribute drill-down panel). Static page, no build step: reads
// a pre-compiled compound graph from data/<environment>.json (see
// scripts/build-sample-data.mjs for how that file is produced from
// Layer A/A2/B/C).
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

const envSelect = document.getElementById('env-select');
const sidebar = document.getElementById('sidebar');
const coverageEl = document.getElementById('coverage');

for (const env of ENVIRONMENTS) {
  const opt = document.createElement('option');
  opt.value = env;
  opt.textContent = env;
  envSelect.appendChild(opt);
}

let cy = null;

async function loadEnvironment(env) {
  const res = await fetch(`data/${env}.json`);
  if (!res.ok) {
    sidebar.innerHTML = `<div class="empty">Could not load data/${env}.json (${res.status})</div>`;
    return;
  }
  const graph = await res.json();
  renderGraph(graph);
  renderCoverage(graph);
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

function renderGraph(graph) {
  const elements = [];

  for (const entity of graph.entities) {
    elements.push({
      data: {
        id: entity.id,
        label: entityLabel(entity),
        name: entityName(entity),
        kind: entity.kind,
        parent: entity.parent ?? undefined,
        repoId: entity.repoId,
        sourceAddress: entity.sourceAddress,
        details: entity.details ?? null,
        class: KIND_CLASS(entity.kind),
      },
    });
  }

  for (const entity of graph.entities) {
    if (entity.parent) {
      elements.find((e) => e.data.id === entity.id).data.parent = entity.parent;
    }
  }

  // Containment already says "child belongs to parent"; an edge from a child
  // to its own parent (e.g. subnet -> vpc, addon -> cluster) would just draw a
  // noisy loop on top of it, so skip those.
  const parentOf = new Map(graph.entities.map((e) => [e.id, e.parent]));
  for (const [i, edge] of graph.edges.entries()) {
    if (parentOf.get(edge.from) === edge.to || parentOf.get(edge.to) === edge.from) continue;
    elements.push({ data: { id: `e${i}`, source: edge.from, target: edge.to, label: edge.label ?? '' } });
  }

  if (cy) cy.destroy();
  cy = cytoscape({
    container: document.getElementById('graph'),
    elements,
    style: [
      { selector: 'node', style: {
        'label': 'data(label)', 'font-size': 10, 'color': '#c9d1d9',
        'text-wrap': 'wrap', 'text-max-width': 110,
        'background-color': '#21262d', 'border-width': 1, 'border-color': '#30363d',
        'shape': 'round-rectangle', 'padding': '8px', 'text-valign': 'center',
      }},
      { selector: 'node[class = "net"]', style: { 'border-color': '#f0883e', 'background-color': '#2b1f14' } },
      { selector: 'node[class = "eks"]', style: { 'border-color': '#d2a8ff', 'background-color': '#241a2e' } },
      { selector: ':parent', style: {
        'background-opacity': 0.08, 'border-width': 1.5, 'text-valign': 'top', 'font-weight': 'bold',
      }},
      { selector: 'edge', style: {
        'width': 1.5, 'line-color': '#30363d', 'target-arrow-color': '#30363d',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
        'label': 'data(label)', 'font-size': 9, 'color': '#8b949e',
      }},
      { selector: 'node:selected', style: { 'border-color': '#58a6ff', 'border-width': 2 } },
    ],
    layout: { name: 'fcose', nodeDimensionsIncludeLabels: true, animate: false },
  });

  cy.on('tap', 'node', (evt) => renderDetails(evt.target.data()));
  cy.on('tap', (evt) => { if (evt.target === cy) sidebar.innerHTML = '<div class="empty">Click a node to see its details.</div>'; });

  if (cy.expandCollapse) {
    cy.expandCollapse({ layoutBy: { name: 'fcose', animate: false }, fisheye: false, undoable: false });
  }
}

function renderDetails(data) {
  const badge = data.class !== 'default' ? `<span class="badge ${data.class}">${data.class}</span>` : '';
  let html = `<h2>${data.name}${badge}</h2><div class="kind">${data.kind}</div>`;
  html += `<table>
    <tr><td class="key">repo</td><td class="val">${data.repoId}</td></tr>
    <tr><td class="key">source address</td><td class="val">${data.sourceAddress}</td></tr>
    <tr><td class="key">parent</td><td class="val">${data.parent ?? '—'}</td></tr>
  </table>`;

  if (data.details) {
    html += '<h3>Configuration (from source .tf)</h3><table>';
    for (const [key, result] of Object.entries(data.details)) {
      const val = result.resolved
        ? `<span class="val">${JSON.stringify(result.value)}</span>`
        : `<span class="unresolved">unresolved</span><div class="raw">${escapeHtml(result.raw)}</div>`;
      html += `<tr><td class="key">${key}</td><td class="val">${val}</td></tr>`;
    }
    html += '</table>';
  } else {
    html += '<h3>Configuration</h3><div class="empty" style="margin-top:4px">No attribute details extracted for this entity.</div>';
  }

  sidebar.innerHTML = html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('fit-btn').addEventListener('click', () => cy?.fit(undefined, 40));
document.getElementById('expand-all-btn').addEventListener('click', () => cy?.expandCollapse('get').expandAll());
document.getElementById('collapse-all-btn').addEventListener('click', () => cy?.expandCollapse('get').collapseAll());
envSelect.addEventListener('change', () => loadEnvironment(envSelect.value));

loadEnvironment(ENVIRONMENTS[0]);
