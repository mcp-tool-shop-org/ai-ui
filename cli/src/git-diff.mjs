// @ts-check
/**
 * git-diff — Minimal Unified Diff Builder
 *
 * Produces unified diff format from HandsEdit[] entries.
 * No git dependency — builds diffs from find/replace pairs.
 */

/**
 * Build a unified diff string from a set of edits.
 *
 * @param {import('./types.mjs').HandsEdit[]} edits
 * @returns {string}
 */
export function buildUnifiedDiff(edits) {
  if (edits.length === 0) return '';

  // Group edits by file
  /** @type {Map<string, import('./types.mjs').HandsEdit[]>} */
  const byFile = new Map();
  for (const edit of edits) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push(edit);
  }

  const chunks = [];
  for (const [filePath, fileEdits] of byFile) {
    chunks.push(buildFileDiff(filePath, fileEdits));
  }

  return chunks.join('\n');
}

/**
 * Build a unified diff for a single file from its edits.
 *
 * @param {string} filePath
 * @param {import('./types.mjs').HandsEdit[]} edits
 * @returns {string}
 */
function buildFileDiff(filePath, edits) {
  const lines = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);

  for (const edit of edits) {
    const oldLines = edit.find.split('\n');
    const newLines = edit.replace.split('\n');

    // Minimal hunk header (line numbers are approximate since we don't have full file)
    lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

    // Comment with rationale
    if (edit.rationale) {
      lines.push(`# ${edit.rationale}`);
    }
    if (edit.artifact_trigger) {
      lines.push(`# artifact: ${edit.artifact_trigger}`);
    }

    for (const l of oldLines) {
      lines.push(`-${l}`);
    }
    for (const l of newLines) {
      lines.push(`+${l}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build a files.json manifest from edits.
 * Lists every file touched with edit count and total lines changed.
 *
 * @param {import('./types.mjs').HandsEdit[]} edits
 * @returns {{ path: string, edits: number, lines_added: number, lines_removed: number, proposal_only: boolean }[]}
 */
export function buildFilesManifest(edits) {
  /** @type {Map<string, { edits: number, linesAdded: number, linesRemoved: number, proposalOnly: boolean }>} */
  const byFile = new Map();

  for (const edit of edits) {
    const existing = byFile.get(edit.file) || { edits: 0, linesAdded: 0, linesRemoved: 0, proposalOnly: true };
    existing.edits++;
    existing.linesRemoved += edit.find.split('\n').length;
    existing.linesAdded += edit.replace.split('\n').length;
    if (!edit.proposal_only) existing.proposalOnly = false;
    byFile.set(edit.file, existing);
  }

  return [...byFile.entries()].map(([path, data]) => ({
    path,
    edits: data.edits,
    lines_added: data.linesAdded,
    lines_removed: data.linesRemoved,
    proposal_only: data.proposalOnly,
  }));
}

/**
 * Validate an edit against a file's content.
 * Returns true if the `find` string exists exactly once in the content.
 *
 * @param {string} content - File content
 * @param {string} find - String to find
 * @returns {{ valid: boolean, occurrences: number }}
 */
export function validateEdit(content, find) {
  if (!find || find.length === 0) return { valid: false, occurrences: 0 };

  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(find, pos)) !== -1) {
    count++;
    pos += find.length;
  }

  return { valid: count === 1, occurrences: count };
}
