const LABEL_RE = /"([^"]*)"/g;
const TYPE_RE = /([a-zA-Z_][a-zA-Z0-9_-]*)/;

/**
 * Parses raw HCL text (a `.tf` or `.tfvars` file's content) into top-level
 * blocks: `{ blockType, labels, body }`. `body` is the raw, unparsed text
 * between the block's outer `{` and `}` — nested blocks/objects inside it
 * are NOT recursed into here (see `parseHclAttributes` for that).
 *
 * Correctly treats braces that appear inside string literals (including
 * escaped `\"` and `\\`) and `#`/`//` line comments as non-structural, so a
 * JSON-string attribute value or a comment mentioning `{` does not throw
 * off brace-depth tracking.
 *
 * This is a purpose-built scanner, not a general HCL parser: it assumes
 * well-formed Terraform (single/double-quoted labels, balanced braces) and
 * does not handle heredoc strings (`<<EOT`) — a heredoc containing `{`/`}`
 * would miscount depth. Flagged as a known limitation rather than handled
 * silently wrong.
 *
 * @param {string} text
 * @returns {{ blockType: string, labels: string[], body: string }[]}
 */
export function parseHclBlocks(text) {
  const blocks = [];
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let headerBuffer = '';
  let bodyStart = -1;
  let pendingHeader = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inString) {
      if (depth === 0) headerBuffer += ch;
      if (ch === '\\') {
        i++;
        if (depth === 0 && text[i] !== undefined) headerBuffer += text[i];
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '#' || (ch === '/' && next === '/')) {
      inLineComment = true;
      continue;
    }

    if (ch === '"') {
      inString = true;
      if (depth === 0) headerBuffer += ch;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        pendingHeader = parseHeader(headerBuffer);
        headerBuffer = '';
        bodyStart = i + 1;
      }
      depth++;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (depth === 0 && pendingHeader) {
        blocks.push({ ...pendingHeader, body: text.slice(bodyStart, i) });
        pendingHeader = null;
      }
      continue;
    }

    if (depth === 0) {
      headerBuffer += ch;
    }
  }

  return blocks;
}

function parseHeader(headerText) {
  const labels = [...headerText.matchAll(LABEL_RE)].map((m) => m[1]);
  const typeMatch = TYPE_RE.exec(headerText);
  return { blockType: typeMatch ? typeMatch[1] : null, labels };
}
