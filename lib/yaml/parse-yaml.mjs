/**
 * Minimal YAML reader for Kubernetes/Helm/ArgoCD manifests (no dependencies).
 *
 * Supported: block maps/sequences, plain/quoted scalars, flow collections,
 * literal/folded block scalars, comments, multi-document streams.
 * NOT supported (throws YamlError with a line number, never guesses):
 * anchors/aliases/merge keys, tags, multi-line plain scalars, tabs.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(`YAML line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** @returns {unknown[]} one value per non-empty document */
export function parseYamlDocuments(text) {
  const docs = [];
  let current = [];
  let start = 1;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const flush = () => {
    if (current.some((l) => l.text.trim() !== '' && !l.text.trim().startsWith('#'))) docs.push(parseLines(current));
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^---(\s.*)?$/.test(l)) {
      flush();
      const rest = l.slice(3).trim();
      if (rest && !rest.startsWith('#')) throw new YamlError('content after document marker is not supported', i + 1);
      continue;
    }
    if (/^\.\.\.\s*$/.test(l)) { flush(); continue; }
    current.push({ text: l, no: i + 1 });
  }
  flush();
  void start;
  return docs;
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === '"') { if (c === '\\') i++; else if (c === '"') q = null; }
    else if (q === "'") { if (c === "'") q = null; }
    else if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c; }
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function parseLines(raw) {
  const lines = raw.map((l) => ({ ...l }));
  let pos = 0;

  const indentOf = (t) => {
    const m = /^( *)/.exec(t);
    if (t[m[1].length] === '\t') throw new YamlError('tabs are not allowed for indentation', 0);
    return m[1].length;
  };
  const peek = () => {
    while (pos < lines.length) {
      const l = lines[pos];
      if (/^\s*\t/.test(l.text)) throw new YamlError('tabs are not allowed for indentation', l.no);
      const content = stripComment(l.text.trim() === '' ? '' : l.text);
      if (content.trim() === '') { pos++; continue; }
      return { indent: indentOf(content), content: content.trim(), no: l.no };
    }
    return null;
  };

  function parseNode(minIndent) {
    const p = peek();
    if (!p || p.indent < minIndent) return null;
    if (p.content === '-' || p.content.startsWith('- ')) return parseSeq(p.indent);
    if (splitKey(p.content, p.no)) return parseMap(p.indent);
    pos++;
    return parseValue(p.content, p.no, p.indent);
  }

  function parseSeq(ind) {
    const out = [];
    for (;;) {
      const p = peek();
      if (!p || p.indent !== ind || !(p.content === '-' || p.content.startsWith('- '))) break;
      const rest = p.content.slice(1);
      const trimmed = rest.trimStart();
      if (trimmed === '') { pos++; out.push(parseNode(ind + 1)); continue; }
      // re-use the same line, minus the dash, as the first line of the element
      const newIndent = ind + 1 + (rest.length - trimmed.length);
      lines[pos] = { text: ' '.repeat(newIndent) + trimmed, no: p.no };
      out.push(parseNode(newIndent));
    }
    return out;
  }

  function parseMap(ind) {
    const out = {};
    for (;;) {
      const p = peek();
      if (!p || p.indent !== ind) break;
      const kv = splitKey(p.content, p.no);
      if (!kv) break;
      if (kv.key === '<<') throw new YamlError('merge keys (<<) are not supported', p.no);
      pos++;
      const rest = kv.rest;
      if (rest === '') {
        const n = peek();
        if (n && n.indent > ind) out[kv.key] = parseNode(ind + 1);
        else if (n && n.indent === ind && (n.content === '-' || n.content.startsWith('- '))) out[kv.key] = parseSeq(ind);
        else out[kv.key] = null;
      } else if (/^[|>][+-]?[1-9]?[+-]?$/.test(rest)) {
        out[kv.key] = parseBlockScalar(rest, ind);
      } else {
        out[kv.key] = parseValue(rest, p.no, ind);
      }
    }
    return out;
  }

  function parseBlockScalar(header, parentIndent) {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = [];
    while (pos < lines.length) {
      const t = lines[pos].text;
      if (t.trim() === '') { body.push(''); pos++; continue; }
      if (indentOf(t) <= parentIndent) break;
      body.push(t);
      pos++;
    }
    const first = body.find((l) => l !== '');
    const base = first === undefined ? 0 : indentOf(first);
    let trailingBlank = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailingBlank++; }
    const content = body.map((l) => (l === '' ? '' : l.slice(base)));
    let text;
    if (!folded) text = content.join('\n');
    else {
      text = '';
      content.forEach((l, i) => {
        if (i === 0) text = l;
        else if (l === '') text += '\n';
        else text += (content[i - 1] === '' || text.endsWith('\n') ? '' : ' ') + l;
      });
    }
    if (content.length === 0) return '';
    if (chomp === 'strip') return text;
    if (chomp === 'keep') return `${text}\n${'\n'.repeat(trailingBlank)}`;
    return `${text}\n`;
  }

  function parseValue(rest, no, ind) {
    if (/^[&*]/.test(rest)) throw new YamlError('anchors/aliases are not supported', no);
    if (rest.startsWith('!')) throw new YamlError('tags are not supported', no);
    if (rest.startsWith('[') || rest.startsWith('{')) {
      let text = rest;
      while (!balanced(text)) {
        const l = lines[pos++];
        if (!l) throw new YamlError('unterminated flow collection', no);
        text += ` ${stripComment(l.text).trim()}`;
      }
      const f = new Flow(text, no);
      const v = f.value();
      f.end();
      checkContinuation(ind, no);
      return v;
    }
    const v = scalar(rest, no);
    checkContinuation(ind, no);
    return v;
  }

  // a deeper-indented line after a scalar would be a multi-line plain scalar: unsupported
  function checkContinuation(ind, no) {
    const n = peek();
    if (n && n.indent > ind && n.no !== no) throw new YamlError('multi-line plain scalars are not supported', n.no);
  }

  const result = parseNode(0);
  const rest = peek();
  if (rest) throw new YamlError('unexpected content', rest.no);
  return result;
}

function balanced(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === '"') { if (c === '\\') i++; else if (c === '"') q = null; }
    else if (q === "'") { if (c === "'") q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** `key: rest` split, honouring quoted keys; null when the line is not a mapping entry. */
function splitKey(content, no) {
  if (content.startsWith('[') || content.startsWith('{')) return null;
  let i = 0;
  let key;
  if (content[0] === '"' || content[0] === "'") {
    const q = content[0];
    i = 1;
    while (i < content.length && content[i] !== q) { if (q === '"' && content[i] === '\\') i++; i++; }
    key = scalar(content.slice(0, i + 1), no);
    i++;
    if (content[i] !== ':') return null;
  } else {
    const m = /:(\s|$)/.exec(content);
    if (!m) return null;
    i = m.index;
    key = content.slice(0, i);
    if (/^[&*!]/.test(key)) throw new YamlError('anchors/aliases/tags are not supported', no);
  }
  return { key: String(key), rest: content.slice(i + 1).trim() };
}

function scalar(s, no) {
  if (s[0] === '"') {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated double-quoted string', no);
    return unescapeDouble(s.slice(1, -1));
  }
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('unterminated single-quoted string', no);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?(0|[1-9]\d*)$/.test(s)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }
  if (/^-?(0|[1-9]\d*)\.\d+([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function unescapeDouble(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0' }[c] ?? c;
  });
}

class Flow {
  constructor(text, no) { this.s = text; this.i = 0; this.no = no; }
  ws() { while (/\s/.test(this.s[this.i] ?? '')) this.i++; }
  end() { this.ws(); if (this.i < this.s.length) throw new YamlError('unexpected text after flow collection', this.no); }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    return scalar(this.token(false), this.no);
  }
  token(isKey) {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      const start = this.i++;
      while (this.i < this.s.length && this.s[this.i] !== c) { if (c === '"' && this.s[this.i] === '\\') this.i++; this.i++; }
      this.i++;
      return this.s.slice(start, this.i);
    }
    const start = this.i;
    while (this.i < this.s.length) {
      const d = this.s[this.i];
      if (d === ',' || d === ']' || d === '}') break;
      if (isKey && d === ':' && /[\s,\]}]|$/.test(this.s[this.i + 1] ?? ' ')) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }
  seq() {
    this.i++;
    const out = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return out; }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') throw new YamlError('malformed flow sequence', this.no);
    }
  }
  map() {
    this.i++;
    const out = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return out; }
      const key = String(scalar(this.token(true), this.no));
      this.ws();
      if (this.s[this.i] === ':') { this.i++; out[key] = this.value(); } else out[key] = null;
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') throw new YamlError('malformed flow mapping', this.no);
    }
  }
}
