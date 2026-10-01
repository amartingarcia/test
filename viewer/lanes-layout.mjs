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
// }
// nodes = [{ id, parent: id|null, kind }]

export function layoutLanes(nodes, config) {
  const { sizeOf, axisOf, orderOf, gap, pad, padTop, rootAxis = 'row' } = config;

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
    const { w, h } = pack(kids.map((k) => size.get(k.id)), axisOf(n.kind), gap);
    size.set(n.id, { w: w + 2 * pad, h: h + padTop + pad });
  };
  roots.forEach(measure);

  // pass 2: positions, top-down
  const boxes = {};
  const place = (list, axis, originX, originY, crossSize) => {
    let cursor = 0;
    for (const n of sorted(list)) {
      const { w, h } = size.get(n.id);
      const x = axis === 'row' ? originX + cursor : originX + (crossSize - w) / 2;
      const y = axis === 'row' ? originY + (crossSize - h) / 2 : originY + cursor;
      boxes[n.id] = { x, y, w, h };
      cursor += (axis === 'row' ? w : h) + gap;
      const kids = children.get(n.id);
      if (kids) {
        const innerAxis = axisOf(n.kind);
        const inner = pack(sorted(kids).map((k) => size.get(k.id)), innerAxis, gap);
        place(kids, innerAxis, x + pad, y + padTop, innerAxis === 'row' ? inner.h : inner.w);
      }
    }
  };
  const rootPack = pack(sorted(roots).map((r) => size.get(r.id)), rootAxis, gap);
  place(roots, rootAxis, 0, 0, rootAxis === 'row' ? rootPack.h : rootPack.w);

  const centers = {};
  for (const [id, b] of Object.entries(boxes)) centers[id] = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return { boxes, centers };
}

/** Total extent of boxes laid out along an axis; the other axis is the max. */
function pack(sizes, axis, gap) {
  const along = sizes.reduce((sum, s) => sum + (axis === 'row' ? s.w : s.h), 0) + gap * Math.max(0, sizes.length - 1);
  const across = Math.max(0, ...sizes.map((s) => (axis === 'row' ? s.h : s.w)));
  return axis === 'row' ? { w: along, h: across } : { w: across, h: along };
}
