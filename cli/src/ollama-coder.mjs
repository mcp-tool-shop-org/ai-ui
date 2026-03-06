// @ts-check
/**
 * ollama-coder — Wrapper for qwen2.5-coder with strict JSON edit contract
 *
 * Sends file context + task description to a coder model and parses
 * structured edit responses. Each response must be a JSON object with
 * an `edits` array containing find/replace pairs.
 *
 * Never applies edits — returns them for review.
 */
import { queryOllama, OllamaError } from './ollama.mjs';

/**
 * @typedef {Object} CoderEditResponse
 * @property {string} file           - Relative file path
 * @property {string} find           - Exact snippet to find (best anchor)
 * @property {string} replace        - Replacement snippet
 * @property {string} rationale      - Why this edit was made
 * @property {number} confidence     - 0..1
 */

/** Default context window lines above/below each edit target */
const CONTEXT_LINES = 12;

/**
 * Build a prompt for the coder model.
 *
 * Uses single-line anchor strategy: the model picks ONE exact line as the anchor,
 * provides 2-3 anchor candidates for fallback, and outputs the replacement for
 * that single line. This dramatically reduces hallucination vs multi-line find blocks.
 *
 * @param {{ task: string, description: string, fileContext: { path: string, language: string, content: string }[], artifactContext: string, constraints: string[], targets?: { surfaceId: string, label: string, file: string, nearLine?: string }[] }} params
 * @returns {string}
 */
export function buildCoderPrompt(params) {
  const fileSection = params.fileContext.map(f =>
    `### File: ${f.path} (${f.language})\n\`\`\`${f.language}\n${f.content}\n\`\`\``
  ).join('\n\n');

  const constraintSection = params.constraints.length > 0
    ? `\n\nConstraints:\n${params.constraints.map(c => `- ${c}`).join('\n')}`
    : '';

  const targetSection = params.targets && params.targets.length > 0
    ? `\n\n## Edit Targets\nThese are the specific elements to modify:\n${params.targets.map(t =>
        `- Surface "${t.label || '(icon-only)'}" in \`${t.file}\`${t.nearLine ? ` near: \`${t.nearLine.trim()}\`` : ''}`
      ).join('\n')}`
    : '';

  return `You are a code editor. Your task: ${params.task}

Description: ${params.description}

## Artifact Context
${params.artifactContext}
${targetSection}

## Source Files
${fileSection}
${constraintSection}

## Response Format
Respond with ONLY a JSON object containing an "edits" array. Each edit MUST use single-line anchoring:

- "file": relative file path (must match one of the files above)
- "anchor_candidates": array of 2-3 EXACT single lines from the file, any of which uniquely identify the edit location. Copy the line EXACTLY including whitespace. Prefer lines with distinctive identifiers (component names, prop names, CSS classes).
- "find": your BEST anchor — one EXACT single line from the file content (copy-paste precision). This must be a complete line from the source.
- "replace": the replacement for that line (or the line with additions). For attribute additions, keep the original line content and append/insert the new attribute.
- "rationale": brief explanation
- "confidence": 0.0 to 1.0

Rules:
- find MUST be a single line copied EXACTLY from the file (not multi-line, not a guess)
- anchor_candidates MUST all be real lines from the file — the validator will pick the first that matches
- replace should modify only the anchored line — add attributes, change text, etc.
- For inserting a new line AFTER the anchor: set find to the anchor line, set replace to the anchor line followed by a newline and the new content
- Never delete entire functions or components
- If you're unsure, set confidence < 0.5 and add TODO comments
- Do NOT add import statements unless the module already exists
- Do NOT modify test files, config files, or package.json
- Match the file's indentation style exactly

Example response:
{
  "edits": [
    {
      "file": "src/components/Settings.tsx",
      "anchor_candidates": [
        "      <button onClick={handleClick}>",
        "        <SettingsIcon />",
        "      </button>"
      ],
      "find": "      <button onClick={handleClick}>",
      "replace": "      <button onClick={handleClick} data-aiui-safe=\\"true\\">",
      "rationale": "Add data-aiui-safe attribute for AI-UI probe safety",
      "confidence": 0.95
    }
  ]
}`;
}

/**
 * Parse and validate coder model response.
 * Supports anchor_candidates: if `find` doesn't validate, tries each candidate.
 *
 * @param {Record<string, any>} raw - Parsed JSON from coder model
 * @param {string} taskId - For error reporting
 * @param {Set<string>} validFiles - Set of file paths we sent to the model
 * @param {Map<string, string>} [fileContents] - file path → content, for anchor candidate validation
 * @returns {CoderEditResponse[]}
 * @throws {CoderParseError}
 */
export function parseCoderResponse(raw, taskId, validFiles, fileContents) {
  if (!raw || typeof raw !== 'object') {
    throw new CoderParseError(taskId, 'Response is not an object');
  }

  const edits = raw.edits;
  if (!Array.isArray(edits)) {
    throw new CoderParseError(taskId, 'Response missing "edits" array');
  }

  /** @type {CoderEditResponse[]} */
  const validated = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit || typeof edit !== 'object') {
      continue; // skip malformed entries
    }

    const file = typeof edit.file === 'string' ? edit.file.trim() : '';
    let find = typeof edit.find === 'string' ? edit.find : '';
    const replace = typeof edit.replace === 'string' ? edit.replace : '';
    const rationale = typeof edit.rationale === 'string' ? edit.rationale.trim() : '';
    let confidence = typeof edit.confidence === 'number' ? edit.confidence : 0;

    // Validate file is in our context
    if (!file) continue;
    if (!validFiles.has(file)) continue;

    // Empty find — skip
    if (!find) continue;

    // Anchor candidate resolution: if find doesn't match, try each candidate
    if (fileContents && fileContents.has(file)) {
      const content = fileContents.get(file);
      const findCount = countOccurrences(content, find);
      if (findCount !== 1) {
        // Try anchor_candidates
        const candidates = Array.isArray(edit.anchor_candidates) ? edit.anchor_candidates : [];
        let resolved = false;
        for (const candidate of candidates) {
          if (typeof candidate !== 'string' || !candidate) continue;
          const candidateCount = countOccurrences(content, candidate);
          if (candidateCount === 1) {
            // This candidate matches uniquely — use it as the anchor
            // Rebuild replace: substitute the candidate line in place of the original find
            find = candidate;
            resolved = true;
            break;
          }
        }
        // If no candidate worked but we had candidates, still emit with original find
        // (validator downstream will mark as proposal_only)
        if (!resolved && candidates.length > 0) {
          // Keep original find — downstream validateEdit will flag it
        }
      }
    }

    // Clamp confidence
    confidence = Math.max(0, Math.min(1, confidence));

    validated.push({ file, find, replace, rationale, confidence });
  }

  return validated;
}

/**
 * Count exact occurrences of a substring in content.
 * @param {string} content
 * @param {string} sub
 * @returns {number}
 */
function countOccurrences(content, sub) {
  if (!sub) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

/**
 * Query the coder model for edits.
 *
 * @param {{ task: string, description: string, fileContext: { path: string, language: string, content: string }[], artifactContext: string, constraints: string[], targets?: { surfaceId: string, label: string, file: string, nearLine?: string }[] }} params
 * @param {{ model: string, timeout: number, verbose?: boolean }} opts
 * @returns {Promise<CoderEditResponse[]>}
 */
export async function queryCoderForEdits(params, opts) {
  const prompt = buildCoderPrompt(params);
  const validFiles = new Set(params.fileContext.map(f => f.path));
  const fileContents = new Map(params.fileContext.map(f => [f.path, f.content]));

  const raw = await queryOllama(prompt, {
    model: opts.model,
    timeout: opts.timeout,
    temperature: 0,
    verbose: opts.verbose,
  });

  return parseCoderResponse(raw, params.task, validFiles, fileContents);
}

/**
 * Structured error for coder parse failures.
 */
export class CoderParseError extends Error {
  /**
   * @param {string} taskId
   * @param {string} reason
   */
  constructor(taskId, reason) {
    super(`Coder parse error for task "${taskId}": ${reason}`);
    this.name = 'CoderParseError';
    this.taskId = taskId;
  }
}
