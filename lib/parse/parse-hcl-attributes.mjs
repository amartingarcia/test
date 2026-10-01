/**
 * Parses the top-level `key = value` attribute assignments inside an HCL
 * block body (see `parseHclBlocks`'s `body` field) into
 * `{ [key]: rawValueText }`. Values are returned as raw, unparsed text —
 * resolving them into real JS values (strings, numbers, variable lookups)
 * is `resolveHclValue`'s job, kept separate so a complex nested
 * object/list value can still be captured and displayed even when it is
 * not (yet) deeply parsed.
 *
 * Deliberately NOT an attribute:
 * - a nested labeled block, e.g. `provisioner "local-exec" { ... }`
 * - a nested unlabeled block, e.g. `lifecycle { ... }`
 * Both are skipped in full (including anything inside them) rather than
 * misread as attributes of the outer block.
 *
 * @param {string} bodyText
 * @returns {Record<string, string>}
 */
export function parseHclAttributes(bodyText) {
  const attrs = {};
  const n = bodyText.length;
  let i = 0;

  while (i < n) {
    while (i < n && /\s/.test(bodyText[i])) i++;
    if (i >= n) break;

    if (bodyText[i] === '#' || (bodyText[i] === '/' && bodyText[i + 1] === '/')) {
      while (i < n && bodyText[i] !== '\n') i++;
      continue;
    }

    const idMatch = /^[a-zA-Z_][a-zA-Z0-9_-]*/.exec(bodyText.slice(i));
    if (!idMatch) {
      i++; // unrecognized character; skip to avoid an infinite loop
      continue;
    }
    const identifier = idMatch[0];
    let j = i + identifier.length;

    while (j < n && (bodyText[j] === ' ' || bodyText[j] === '\t')) j++;

    if (bodyText[j] === '"') {
      // labeled nested block (e.g. provisioner "local-exec" { ... }) — skip whole thing
      j = skipLabels(bodyText, j);
      while (j < n && /\s/.test(bodyText[j])) j++;
      i = bodyText[j] === '{' ? skipBalanced(bodyText, j, '{', '}') : j;
      continue;
    }

    if (bodyText[j] === '{') {
      // unlabeled nested block (e.g. lifecycle { ... }) — skip whole thing
      i = skipBalanced(bodyText, j, '{', '}');
      continue;
    }

    if (bodyText[j] !== '=') {
      // bare identifier that isn't an attribute assignment or a recognized
      // block shape; skip just it and keep scanning
      i = j;
      continue;
    }

    j++; // consume '='
    while (j < n && (bodyText[j] === ' ' || bodyText[j] === '\t')) j++;

    const { value, end } = captureValue(bodyText, j);
    attrs[identifier] = value;
    i = end;
  }

  return attrs;
}

function captureValue(text, start) {
  const ch = text[start];
  if (ch === '"') {
    const end = skipString(text, start);
    return { value: text.slice(start, end), end };
  }
  if (ch === '{') {
    const end = skipBalanced(text, start, '{', '}');
    return { value: text.slice(start, end), end };
  }
  if (ch === '[') {
    const end = skipBalanced(text, start, '[', ']');
    return { value: text.slice(start, end), end };
  }
  if (ch === '<' && text[start + 1] === '<') {
    const heredoc = captureHeredoc(text, start);
    if (heredoc) return heredoc;
  }
  return captureBareToken(text, start);
}

/**
 * An unquoted value runs to the end of the line, or to a top-level comma
 * (`{ a = 1, b = 2 }`), whichever comes first — but newlines and commas
 * inside (), [] or {} don't end it, so multi-line function calls and
 * conditionals are captured whole. Capturing only up to the first space
 * used to turn `1 + 2` into `1`, which then resolved as a number.
 */
function captureBareToken(text, start) {
  let end = start;
  let depth = 0;
  while (end < text.length) {
    const c = text[end];
    if (c === '"') {
      end = skipString(text, end);
      continue;
    }
    if (c === '#' || (c === '/' && text[end + 1] === '/')) {
      if (depth === 0) break;
      while (end < text.length && text[end] !== '\n') end++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === '\n' || c === ',')) break;
    end++;
  }
  return { value: text.slice(start, end).trimEnd(), end };
}

/** `<<TAG` / `<<-TAG` heredoc: captured whole (marker through terminator line), never resolved. */
function captureHeredoc(text, start) {
  const marker = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[^\S\n]*\n/.exec(text.slice(start));
  if (!marker) return null;
  const tag = marker[1];
  let lineStart = start + marker[0].length;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    if (text.slice(lineStart, lineEnd).trim() === tag) {
      return { value: text.slice(start, lineEnd).trimEnd(), end: lineEnd };
    }
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  return { value: text.slice(start), end: text.length }; // unterminated: take the rest
}

function skipString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return i;
}

function skipBalanced(text, start, openChar, closeChar) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch === openChar) {
      depth++;
      i++;
      continue;
    }
    if (ch === closeChar) {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

function skipLabels(text, start) {
  let i = start;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '"') {
      i = skipString(text, i);
    } else {
      break;
    }
  }
  return i;
}
