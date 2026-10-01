import { parseHclAttributes } from './parse-hcl-attributes.mjs';

const VAR_REF_RE = /^var\.([a-zA-Z_][a-zA-Z0-9_-]*)$/;

/**
 * Resolves a single raw HCL attribute value (as returned by
 * `parseHclAttributes`) into a real JS value, when it is simple enough to
 * resolve without a full expression evaluator:
 *
 * - quoted string literal (`"1.29"`) -> the unescaped string
 * - number / `true` / `false` / `null` literal
 * - `var.NAME` -> looked up in `vars` (a plain object of already-resolved
 *   values, e.g. from `parseTfvars`)
 * - a list `[...]` or object `{...}` -> an array / plain object, **only if
 *   every element/value inside it resolves** (recursively, same rules)
 *
 * - a conditional `cond ? a : b` whose condition is a boolean literal, a
 *   boolean `var.X`, `!` of one, or an `==` / `!=` comparison of two
 *   resolvable values; only the branch that is chosen has to resolve
 *
 * Everything else — string interpolation (`"${var.x}-y"`), `local.x`,
 * module output references, `for` expressions, objects with quoted keys,
 * or a list/object containing any of those — is deliberately left
 * **unresolved** rather than guessed or partially resolved. The caller gets
 * the raw text back so it can still be shown (e.g. in a diagram detail
 * panel), just honestly labeled as not evaluated. All-or-nothing on purpose:
 * a half-resolved list would silently drop data.
 *
 * @param {string} rawValue
 * @param {Record<string, unknown>} vars
 * @returns {{ resolved: true, value: unknown } | { resolved: false, raw: string }}
 */
export function resolveHclValue(rawValue, vars) {
  const trimmed = rawValue.trim();
  const unresolved = { resolved: false, raw: rawValue };

  if (isQuotedStringLiteral(trimmed)) {
    return { resolved: true, value: unescapeString(trimmed.slice(1, -1)) };
  }

  if (trimmed === 'true') return { resolved: true, value: true };
  if (trimmed === 'false') return { resolved: true, value: false };
  if (trimmed === 'null') return { resolved: true, value: null };

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { resolved: true, value: Number(trimmed) };
  }

  const conditional = splitConditional(trimmed);
  if (conditional) {
    const cond = resolveCondition(conditional.cond, vars);
    if (cond === null) return unresolved;
    const chosen = resolveHclValue(cond ? conditional.whenTrue : conditional.whenFalse, vars);
    return chosen.resolved ? chosen : unresolved;
  }

  const varMatch = VAR_REF_RE.exec(trimmed);
  if (varMatch) {
    const name = varMatch[1];
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return { resolved: true, value: vars[name] };
    }
    return unresolved;
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return resolveList(trimmed.slice(1, -1), vars) ?? unresolved;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return resolveObject(trimmed.slice(1, -1), vars) ?? unresolved;
  }

  return unresolved;
}

/** `for` expressions (`[for x in y : ...]`, `{for k, v in ...}`) are never evaluated here. */
const FOR_EXPR_RE = /^\s*for\s+\w+/;

function resolveList(inner, vars) {
  if (FOR_EXPR_RE.test(inner)) return null;

  const values = [];
  for (const element of splitTopLevelCommas(inner)) {
    const result = resolveHclValue(element, vars);
    if (!result.resolved) return null;
    values.push(result.value);
  }
  return { resolved: true, value: values };
}

function resolveObject(inner, vars) {
  if (inner.trim() === '') return { resolved: true, value: {} };
  if (FOR_EXPR_RE.test(inner)) return null;
  // quoted keys (`"a/b" = 1`) aren't parsed by parseHclAttributes — refuse
  // rather than silently dropping them
  if (/^\s*"[^"]*"\s*=/m.test(inner)) return null;

  const attrs = parseHclAttributes(inner);
  const keys = Object.keys(attrs);
  if (keys.length === 0) return null;

  const value = {};
  for (const key of keys) {
    const result = resolveHclValue(attrs[key], vars);
    if (!result.resolved) return null;
    value[key] = result.value;
  }
  return { resolved: true, value };
}

/**
 * Splits `a, "b,c", [d, e]` on top-level commas only (ignores commas inside
 * strings and nested `[]`/`{}`/`()`), drops empty pieces (trailing comma,
 * blank lines) and `#`/`//` comments, and trims each element.
 */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      current += text.slice(start, i + 1);
      continue;
    }

    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '[' || ch === '{' || ch === '(') depth++;
    if (ch === ']' || ch === '}' || ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += ch;
  }
  parts.push(current);

  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** One quoted literal (its first unescaped closing quote is the last character), no `${...}` inside. */
function isQuotedStringLiteral(trimmed) {
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') {
    return false;
  }
  if (skipString(trimmed, 0) !== trimmed.length - 1) return false;
  return !/\$\{/.test(trimmed.slice(1, -1));
}

function unescapeString(inner) {
  return inner.replace(/\\(.)/g, (_, c) => c);
}

/**
 * Splits `cond ? a : b` at the top level (outside strings and brackets).
 * Nested conditionals in the false branch associate to the right. Returns
 * null when the text has no top-level `?`.
 */
function splitConditional(text) {
  let depth = 0;
  let q = -1;
  let nested = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { i = skipString(text, i); continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '?') {
      if (q === -1) q = i; else nested++;
    } else if (depth === 0 && ch === ':' && q !== -1) {
      if (nested === 0) {
        return { cond: text.slice(0, q).trim(), whenTrue: text.slice(q + 1, i).trim(), whenFalse: text.slice(i + 1).trim() };
      }
      nested--;
    }
  }
  return null;
}

/** true / false, or null when the condition cannot be decided from what we know. */
function resolveCondition(text, vars) {
  const cmp = splitComparison(text);
  if (cmp) {
    const left = resolveHclValue(cmp.left, vars);
    const right = resolveHclValue(cmp.right, vars);
    if (!left.resolved || !right.resolved) return null;
    const equal = JSON.stringify(left.value) === JSON.stringify(right.value);
    return cmp.op === '==' ? equal : !equal;
  }
  const negated = text.startsWith('!');
  const result = resolveHclValue(negated ? text.slice(1).trim() : text, vars);
  if (!result.resolved || typeof result.value !== 'boolean') return null;
  return negated ? !result.value : result.value;
}

function splitComparison(text) {
  let depth = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch === '"') { i = skipString(text, i); continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (text.startsWith('==', i) || text.startsWith('!=', i))) {
      return { left: text.slice(0, i).trim(), op: text.slice(i, i + 2), right: text.slice(i + 2).trim() };
    }
  }
  return null;
}

/** Index just past the string literal that starts at `start`. */
function skipString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return i;
    i++;
  }
  return i;
}
