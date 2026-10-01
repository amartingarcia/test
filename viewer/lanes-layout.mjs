// Deterministic "lanes" layout for compound infra graphs. A force layout
// scatters boxes; an architecture diagram needs a *meaningful* order
// (edge -> public -> private -> data, left to right). So the order comes from
// data: every node gets an `orderOf(node)` rank, every container kind an
// axis (`row` = children left to right, `column` = top to bottom), and the
// result is a plain packing. Pure function, no DOM: tested in
// test/lanes-layout.test.mjs, used by app.js.
//
// config = {
//   sizeOf(kind) -> {w, h}      size of a leaf box
//   axisOf(kind) -> 'row'|'column'   how a container lays out its children
//   orderOf(node) -> number     lower = earlier (left / top); ties broken by id
//   gap, pad, padTop            spacing between siblings / inside a container
//   rootAxis?                   defaults to 'row'
//   wrap?                       {min, aspect}: containers with >= min children wrap onto
//                               further lines so they approach width:height = aspect
//                               (off unless given: single line, as before)
//   rootWrap?                   same, for the top level (static exports; the live viewer keeps one line)
// }
// nodes = [{ id, parent: id|null, kind }]

export function layoutLanes(nodes, config) {
  const { sizeOf, axisOf, orderOf, gap, pad, padTop, rootAxis = 'row', wrap = null, rootWrap = null } = config;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  const roots = [];
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent)) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    } else {
      roots.push(n);
    }
  }
  const sorted = (list) => [...list].sort((a, b) => (orderOf(a) - orderOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // pass 1: size of every box, bottom-up
  const size = new Map();
  const measure = (n) => {
    const kids = children.get(n.id);
    if (!kids) { size.set(n.id, sizeOf(n.kind)); return; }
    kids.forEach(measure);
    const { w, h } = arrange(sorted(kids).map((k) => size.get(k.id)), axisOf(n.kind), gap, wrap);
    size.set(n.id, { w: w + 2 * pad, h: h + padTop + pad });
  };
  roots.forEach(measure);

  // pass 2: positions, top-down
  const boxes = {};
  const place = (list, axis, originX, originY) => {
    const ordered = sorted(list);
    const layout = arrange(ordered.map((n) => size.get(n.id)), axis, gap, axis === rootAxis && list === roots ? rootWrap : wrap);
    let crossCursor = 0;
    layout.lines.forEach((line, li) => {
      let cursor = 0;
      for (const idx of line) {
        const n = ordered[idx];
        const { w, h } = size.get(n.id);
        const x = axis === 'row' ? originX + cursor : originX + crossCursor + (layout.cross[li] - w) / 2;
        const y = axis === 'row' ? originY + crossCursor + (layout.cross[li] - h) / 2 : originY + cursor;
        boxes[n.id] = { x, y, w, h };
        cursor += (axis === 'row' ? w : h) + gap;
        const kids = children.get(n.id);
        if (kids) place(kids, axisOf(n.kind), x + pad, y + padTop);
      }
      crossCursor += layout.cross[li] + gap;
    });
  };
  place(roots, rootAxis, 0, 0);

  const centers = {};
  for (const [id, b] of Object.entries(boxes)) centers[id] = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return { boxes, centers };
}

/**
 * Splits boxes (already in order) into lines along `axis`, wrapping when
 * wrapping is enabled and the container is crowded.
 * Returns { lines: index[][], cross: per-line cross size, w, h }.
 */
function arrange(sizes, axis, gap, wrap) {
  const along = (s) => (axis === 'row' ? s.w : s.h);
  const across = (s) => (axis === 'row' ? s.h : s.w);
  let limit = Infinity;
  if (wrap && sizes.length >= wrap.min) {
    const area = sizes.reduce((sum, s) => sum + (s.w + gap) * (s.h + gap), 0);
    const target = axis === 'row' ? Math.sqrt(area * wrap.aspect) : Math.sqrt(area / wrap.aspect);
    limit = Math.max(target, ...sizes.map(along));
  }
  const lines = [];
  let line = [];
  let used = 0;
  sizes.forEach((s, i) => {
    if (line.length && used + gap + along(s) > limit) { lines.push(line); line = []; used = 0; }
    used += (line.length ? gap : 0) + along(s);
    line.push(i);
  });
  if (line.length) lines.push(line);
  const lineAlong = lines.map((l) => l.reduce((sum, i) => sum + along(sizes[i]), 0) + gap * (l.length - 1));
  const cross = lines.map((l) => Math.max(0, ...l.map((i) => across(sizes[i]))));
  const a = Math.max(0, ...lineAlong);
  const c = cross.reduce((sum, v) => sum + v, 0) + gap * Math.max(0, lines.length - 1);
  return { lines, cross, w: axis === 'row' ? a : c, h: axis === 'row' ? c : a };
}
