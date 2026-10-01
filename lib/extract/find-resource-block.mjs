import { parseHclBlocks } from '../parse/parse-hcl-blocks.mjs';

/**
 * Searches a set of `.tf` files for the top-level block matching the given
 * `blockType` + `labels` (e.g. `{ blockType: 'resource', labels:
 * ['aws_eks_cluster', 'this'] }` for `resource "aws_eks_cluster" "this"
 * { ... }`). Returns the first match's file path and parsed block, or
 * `null` if no file declares it.
 *
 * Does not resolve module nesting (a resource declared inside a called
 * module is found by searching that module's own files, not by composing
 * the caller's module-path address) — see the T5 architecture note in
 * odd/tasks/terraform-infra-diagram.md for why that's deliberately out of
 * scope here.
 *
 * @param {{ filePath: string, content: string }[]} files
 * @param {{ blockType: string, labels: string[] }} target
 * @returns {{ filePath: string, block: { blockType: string, labels: string[], body: string } } | null}
 */
export function findResourceBlock(files, target) {
  for (const file of files) {
    const blocks = parseHclBlocks(file.content);
    const match = blocks.find((b) => blockMatches(b, target));
    if (match) {
      return { filePath: file.filePath, block: match };
    }
  }
  return null;
}

function blockMatches(block, target) {
  if (block.blockType !== target.blockType) return false;
  if (block.labels.length !== target.labels.length) return false;
  return block.labels.every((label, i) => label === target.labels[i]);
}
