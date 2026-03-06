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
 * @property {string} find           - Exact snippet to find
 * @property {string} replace        - Replacement snippet
 * @property {string} rationale      - Why this edit was made
 * @property {number} confidence     - 0..1
 */

/**
 * Build a prompt for the coder model.
 *
 * @param {{ task: string, description: string, fileContext: { path: string, language: string, content: string }[], artifactContext: string, constraints: string[] }} params
 * @returns {string}
 */
export function buildCoderPrompt(params) {
  const fileSection = params.fileContext.map(f =>
    `### File: ${f.path} (${f.language})\n\`\`\`${f.language}\n${f.content}\n\`\`\``
  ).join('\n\n');

  const constraintSection = params.constraints.length > 0
    ? `\n\nConstraints:\n${params.constraints.map(c => `- ${c}`).join('\n')}`
    : '';

  return `You are a code editor. Your task: ${params.task}

Description: ${params.description}

## Artifact Context
${params.artifactContext}

## Source Files
${fileSection}
${constraintSection}

## Response Format
Respond with ONLY a JSON object containing an "edits" array. Each edit must have:
- "file": relative file path (must match one of the files above)
- "find": the EXACT string to find in the file (copy-paste precision, include surrounding context for uniqueness)
- "replace": the replacement string
- "rationale": brief explanation of why this edit helps
- "confidence": 0.0 to 1.0 (your confidence this edit is correct and safe)

Rules:
- find must be an EXACT substring of the file content (not a regex, not a summary)
- find must be long enough to be unique in the file (include 2-3 surrounding lines if needed)
- replace must be syntactically valid code
- Never delete entire functions or components — only modify specific parts
- If you're unsure, set confidence < 0.5 and add TODO comments in the replacement
- Do NOT add import statements unless the imported module already exists in the project
- Do NOT modify test files, config files, or package.json

Example response:
{
  "edits": [
    {
      "file": "src/components/Settings.tsx",
      "find": "<button onClick={handleClick}>",
      "replace": "<button onClick={handleClick} data-aiui-safe=\\"true\\">",
      "rationale": "Add data-aiui-safe attribute for AI-UI probe safety",
      "confidence": 0.95
    }
  ]
}`;
}

/**
 * Parse and validate coder model response.
 *
 * @param {Record<string, any>} raw - Parsed JSON from coder model
 * @param {string} taskId - For error reporting
 * @param {Set<string>} validFiles - Set of file paths we sent to the model
 * @returns {CoderEditResponse[]}
 * @throws {CoderParseError}
 */
export function parseCoderResponse(raw, taskId, validFiles) {
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
    const find = typeof edit.find === 'string' ? edit.find : '';
    const replace = typeof edit.replace === 'string' ? edit.replace : '';
    const rationale = typeof edit.rationale === 'string' ? edit.rationale.trim() : '';
    let confidence = typeof edit.confidence === 'number' ? edit.confidence : 0;

    // Validate file is in our context
    if (!file) continue;
    if (!validFiles.has(file)) {
      // Model hallucinated a file path — skip silently
      continue;
    }

    // Empty find or replace — skip
    if (!find) continue;

    // Clamp confidence
    confidence = Math.max(0, Math.min(1, confidence));

    validated.push({ file, find, replace, rationale, confidence });
  }

  return validated;
}

/**
 * Query the coder model for edits.
 *
 * @param {{ task: string, description: string, fileContext: { path: string, language: string, content: string }[], artifactContext: string, constraints: string[] }} params
 * @param {{ model: string, timeout: number, verbose?: boolean }} opts
 * @returns {Promise<CoderEditResponse[]>}
 */
export async function queryCoderForEdits(params, opts) {
  const prompt = buildCoderPrompt(params);
  const validFiles = new Set(params.fileContext.map(f => f.path));

  const raw = await queryOllama(prompt, {
    model: opts.model,
    timeout: opts.timeout,
    temperature: 0,
    verbose: opts.verbose,
  });

  return parseCoderResponse(raw, params.task, validFiles);
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
