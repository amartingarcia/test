// Client code of the standalone HTML export. Runs after the bundled renderer (renderSvg, paletteFor,
// PRESETS, PALETTES, CLASSES, CLASS_NAMES, KIND_CLASS, buildDiagram ...) in the same scope.
// No network, no storage: everything the page needs is inside the file.
(function () {
  var DATA = JSON.parse(document.getElementById('infra-data').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), viewport = $('viewport'), panel = $('panel'), envSel = $('env');
  var graphs = DATA.graphs;
  var byId = {};
  graphs.forEach(function (g) { byId[g.id] = g; });

  var hash = new URLSearchParams(location.hash.slice(1));
  var state = {
    env: byId[hash.get('env')] ? hash.get('env') : graphs[0].id,
    preset: PRESETS[hash.get('style')] ? hash.get('style') : (PRESETS[DATA.preset] ? DATA.preset : 'blueprint'),
    theme: hash.get('theme') === 'light' || hash.get('theme') === 'dark' ? hash.get('theme')
      : (DATA.theme === 'light' || DATA.theme === 'dark' ? DATA.theme
        : (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')),
  };
  var view = { x: 0, y: 0, k: 1 };
  var current = null; // { svg, width, height, nodes, edges }
  var entityById = {};

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function setHash() {
    var h = new URLSearchParams();
    h.set('env', state.env); h.set('style', state.preset); h.set('theme', state.theme);
    try { history.replaceState(null, '', '#' + h.toString()); } catch (e) { /* file:// in some browsers */ }
  }

  function applyChrome() {
    var pal = paletteFor(state.preset, state.theme);
    var r = document.documentElement.style;
    ['bg', 'text', 'muted', 'node', 'border', 'net', 'compute', 'eks', 'k8s', 'data', 'iam', 'cfg', 'edgeapp', 'def'].forEach(function (t) { r.setProperty('--' + t, pal[t]); });
    document.documentElement.setAttribute('data-theme', state.theme);
    document.querySelectorAll('#presets button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)); });
    $('theme').textContent = state.theme === 'light' ? 'Light' : 'Dark';
  }

  function fit() {
    if (!current) return;
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var k = Math.min(vw / current.width, vh / current.height, 1.5) * 0.96;
    view.k = k;
    view.x = (vw - current.width * k) / 2;
    view.y = Math.max(8, (vh - current.height * k) / 2);
    paint();
  }
  function paint() {
    stage.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
    $('zoom').textContent = Math.round(view.k * 100) + '%';
  }
  function zoomAt(factor, cx, cy) {
    var k = Math.min(4, Math.max(0.05, view.k * factor));
    var f = k / view.k;
    view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f; view.k = k;
    paint();
  }

  function render() {
    var g = byId[state.env];
    current = renderSvg(g.graph, DATA.catalog, { preset: state.preset, theme: state.theme, title: g.label });
    stage.innerHTML = current.svg;
    stage.style.width = current.width + 'px'; stage.style.height = current.height + 'px';
    entityById = {};
    g.graph.entities.forEach(function (e) { entityById[e.id] = e; });
    applyChrome(); renderCoverage(g.graph); renderLegend(g.graph); setHash();
    clearFocus();
    fit();
  }

  function renderCoverage(graph) {
    var parts = [];
    Object.keys(graph.coverage || {}).forEach(function (repo) {
      var c = graph.coverage[repo];
      if (c.unmapped && c.unmapped.length) parts.push(repo + ': ' + c.unmapped.length + ' unmapped resource(s)');
      if (c.unresolvedBoundaries && c.unresolvedBoundaries.length) parts.push(repo + ': ' + c.unresolvedBoundaries.length + ' unresolved boundary(ies)');
    });
    if ((graph.unresolvedCrossRepoLinks || []).length) parts.push(graph.unresolvedCrossRepoLinks.length + ' unresolved cross-repo link(s)');
    if ((graph.unresolvedPlacements || []).length) parts.push(graph.unresolvedPlacements.length + ' ambiguous placement(s)');
    if ((graph.findings || []).length) parts.push(graph.findings.length + ' finding(s)');
    var el = $('coverage');
    el.textContent = parts.length ? '⚠ ' + parts.join(' · ') : '';
    el.title = (graph.findings || []).map(function (f) { return f.message; }).join('\n');
  }

  function renderLegend(graph) {
    var counts = {};
    graph.entities.forEach(function (e) { if (!e.embedded) { var c = KIND_CLASS(e.kind); counts[c] = (counts[c] || 0) + 1; } });
    $('legend').innerHTML = CLASSES.filter(function (c) { return counts[c]; }).map(function (c) {
      return '<span class="key"><i style="background:var(--' + (c === 'default' ? 'def' : c) + ')"></i>' + esc((graph.legend || {})[c] || CLASS_NAMES[c]) + ' ' + counts[c] + '</span>';
    }).join('');
  }

  function table(details) {
    var html = '<table>';
    Object.keys(details).forEach(function (k) {
      var r = details[k];
      html += '<tr><td class="k">' + esc(k) + '</td><td>' + (r.resolved ? esc(JSON.stringify(r.value)) : '<span class="unres">unresolved</span><div class="raw">' + esc(r.raw) + '</div>') + '</td></tr>';
    });
    return html + '</table>';
  }

  function showDetails(id) {
    var e = entityById[id];
    if (!e) return;
    var cls = KIND_CLASS(e.kind);
    var name = id.split(':').slice(2).join(':'); name = name.indexOf('.') >= 0 ? name.split('.').pop() : name;
    var html = '<h2>' + esc(name) + '<span class="badge" style="color:var(--' + (cls === 'default' ? 'def' : cls) + ')">' + esc(cls === 'default' ? 'other' : cls) + '</span></h2><div class="kind">' + esc(e.kind) + '</div>';
    html += '<table><tr><td class="k">repo</td><td>' + esc(e.repoId) + '</td></tr><tr><td class="k">source address</td><td>' + esc(e.sourceAddress) + '</td></tr><tr><td class="k">inside</td><td>' + esc(e.parent || '—') + '</td></tr></table>';
    html += e.details ? '<h3>Configuration</h3>' + table(e.details) : '<h3>Configuration</h3><div class="empty">No attribute details extracted for this resource.</div>';
    var owned = graph().entities.filter(function (o) { return o.embedded && o.parent === id; });
    if (owned.length) {
      html += '<h3>Owned by this resource (' + owned.length + ')</h3>';
      owned.forEach(function (o) { html += '<h2 class="sub">' + esc(o.id.split(':').slice(2).join(':')) + '</h2>' + (o.details ? table(o.details) : ''); });
    }
    panel.innerHTML = html;
  }
  function graph() { return byId[state.env].graph; }

  function clearFocus() {
    stage.classList.remove('focus');
    stage.querySelectorAll('.hot').forEach(function (n) { n.classList.remove('hot'); });
    panel.innerHTML = '<div class="empty">Click a resource to see its configuration.<br>Scroll to zoom, drag to pan.</div>';
  }
  function focusOn(id) {
    stage.querySelectorAll('.hot').forEach(function (n) { n.classList.remove('hot'); });
    var keep = {}; keep[id] = true;
    stage.querySelectorAll('path.e').forEach(function (p) {
      var f = p.getAttribute('data-from'), t = p.getAttribute('data-to');
      if (f === id || t === id) { p.classList.add('hot'); keep[f] = true; keep[t] = true; }
    });
    stage.querySelectorAll('g.n').forEach(function (n) { if (keep[n.getAttribute('data-id')]) n.classList.add('hot'); });
    stage.classList.add('focus');
  }

  /* ---- interaction ---- */
  viewport.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var r = viewport.getBoundingClientRect();
    zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  var drag = null;
  viewport.addEventListener('pointerdown', function (ev) { drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, target: ev.target }; viewport.setPointerCapture(ev.pointerId); });
  viewport.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; paint(); }
  });
  viewport.addEventListener('pointerup', function () {
    if (drag && !drag.moved) {
      var card = drag.target.closest && drag.target.closest('g.n');
      if (card) { var id = card.getAttribute('data-id'); showDetails(id); focusOn(id); } else clearFocus();
    }
    drag = null;
  });
  $('zin').addEventListener('click', function () { zoomAt(1.25, viewport.clientWidth / 2, viewport.clientHeight / 2); });
  $('zout').addEventListener('click', function () { zoomAt(1 / 1.25, viewport.clientWidth / 2, viewport.clientHeight / 2); });
  $('fit').addEventListener('click', fit);
  window.addEventListener('resize', fit);
  envSel.innerHTML = graphs.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.label) + '</option>'; }).join('');
  envSel.value = state.env;
  envSel.addEventListener('change', function () { state.env = envSel.value; render(); });
  envSel.disabled = graphs.length < 2;
  document.querySelectorAll('#presets button').forEach(function (b) { b.addEventListener('click', function () { state.preset = b.dataset.preset; render(); }); });
  $('theme').addEventListener('click', function () { state.theme = state.theme === 'light' ? 'dark' : 'light'; render(); });
  $('svg').addEventListener('click', function () {
    var url = URL.createObjectURL(new Blob([current.svg], { type: 'image/svg+xml;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = state.env + '-' + state.preset + '-' + state.theme + '.svg';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $('print').addEventListener('click', function () { window.print(); });
  window.addEventListener('hashchange', function () { var h = new URLSearchParams(location.hash.slice(1)); if (byId[h.get('env')] && h.get('env') !== state.env) { state.env = h.get('env'); envSel.value = state.env; render(); } });

  render();
})();
