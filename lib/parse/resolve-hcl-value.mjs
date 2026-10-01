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
 *
 * Everything else — string interpolation (`"${var.x}-y"`), `local.x`,
 * module output references, nested objects/lists — is deliberately left
 * **unresolved** rather than guessed. The caller gets the raw text back so
 * it can still be shown (e.g. in a diagram detail panel), just honestly
 * labeled as not evaluated.
 *
 * @param {string} rawValue
 * @param {Record<string, unknown>} vars
 * @returns {{ resolved: true, value: unknown } | { resolved: false, raw: string }}
 */
export function resolveHclValue(rawValue, vars) {
  const trimmed = rawValue.trim();

  if (isQuotedStringLiteral(trimmed)) {
    return { resolved: true, value: unescapeString(trimmed.slice(1, -1)) };
  }

  if (trimmed === 'true') return { resolved: true, value: true };
  if (trimmed === 'false') return { resolved: true, value: false };
  if (trimmed === 'null') return { resolved: true, value: null };

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { resolved: true, value: Number(trimmed) };
  }

  const varMatch = VAR_REF_RE.exec(trimmed);
  if (varMatch) {
    const name = varMatch[1];
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return { resolved: true, value: vars[name] };
    }
    return { resolved: false, raw: rawValue };
  }

  return { resolved: false, raw: rawValue };
}

/** A quoted literal with no `${...}` interpolation inside it. */
function isQuotedStringLiteral(trimmed) {
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') {
    return false;
  }
  const inner = trimmed.slice(1, -1);
  return !/\$\{/.test(inner);
}

function unescapeString(inner) {
  return inner.replace(/\\(.)/g, (_, c) => c);
}
