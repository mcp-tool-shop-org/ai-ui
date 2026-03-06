// @ts-check
/**
 * Prompt builder for ai-suggest Brain queries.
 * Constructs structured prompts and validates Brain JSON output.
 */

/**
 * JSON schema the Brain must follow — embedded in the prompt.
 */
const OUTPUT_SCHEMA = `{
  "best_candidates": [
    {
      "surface_id": "trigger:/|Audio Settings",
      "label": "Audio Settings",
      "score": 0.85,
      "rationale": "Button opens audio configuration panel matching this feature"
    }
  ],
  "alias_terms": ["audio", "sound", "mute"],
  "anchor_label": "Audio Settings",
  "confidence": 0.85,
  "notes": "Strong match via label and functional overlap"
}`;

/**
 * Build a prompt for the Brain to evaluate one feature against candidate surfaces.
 *
 * @param {object} params
 * @param {string} params.featureText       - Atlas feature name/description
 * @param {string|null} params.docSection   - Doc section heading (if available)
 * @param {{ surface_id: string, label: string, route: string, location_group: string, safety: string, aria_label?: string, role?: string }[]} params.candidates - Top N surface candidates
 * @param {Record<string, string[]>} params.existingAliases - Current featureAliases from config
 * @returns {string} Full prompt ready for Ollama
 */
export function buildSuggestPrompt({ featureText, docSection, candidates, existingAliases }) {
  const existingStr = Object.keys(existingAliases).length > 0
    ? `\nExisting featureAliases (do NOT re-suggest these):\n${JSON.stringify(existingAliases, null, 2)}`
    : '\nNo existing featureAliases.';

  const candidateLines = candidates.map((c, i) =>
    `  ${i + 1}. surface_id: "${c.surface_id}"
     label: "${c.label}"
     route: "${c.route}"
     location: ${c.location_group}
     safety: ${c.safety}
     role: ${c.role || 'unknown'}${c.aria_label ? `\n     aria-label: "${c.aria_label}"` : ''}`
  ).join('\n\n');

  return `You are a UI/UX semantic matcher. Your job is to match a documented software feature to the most relevant UI surface elements.

TASK:
Given a feature described in documentation and a list of candidate UI surface elements, determine which surfaces best represent or provide access to this feature.

FEATURE:
  Text: "${featureText}"${docSection ? `\n  Doc section: "${docSection}"` : ''}

CANDIDATE SURFACES:
${candidateLines}
${existingStr}

RULES:
1. Score each candidate 0.0 to 1.0 based on how well it provides access to or represents the feature.
2. Only include candidates with score >= 0.3 in best_candidates.
3. Rank best_candidates from highest to lowest score.
4. Generate alias_terms: short keywords/phrases a user might associate with this feature AND the matching surface. Lowercase, no duplicates. Do not include terms already in existing aliases.
5. anchor_label: set to the exact label of the best candidate IF it's a strong match (score >= 0.7). Otherwise null.
6. confidence: your overall confidence (0.0-1.0) that at least one candidate genuinely represents this feature.
7. notes: one sentence explaining your reasoning.
8. If no candidate is relevant, return empty best_candidates, empty alias_terms, null anchor_label, confidence 0.0.

OUTPUT FORMAT (strict JSON, no prose, no markdown):
${OUTPUT_SCHEMA}

Respond with ONLY the JSON object. No other text.`;
}

/**
 * Validate and normalize Brain response JSON.
 *
 * @param {Record<string, any>} raw - Parsed JSON from Ollama
 * @param {string} featureId - For error context
 * @returns {import('./types.mjs').AiSuggestion & { _raw: Record<string, any> }}
 * @throws {Error} If response doesn't match expected shape
 */
export function parseBrainResponse(raw, featureId) {
  // Validate required fields
  if (!raw || typeof raw !== 'object') {
    throw new BrainParseError(featureId, 'Response is not an object');
  }

  const bestCandidates = Array.isArray(raw.best_candidates) ? raw.best_candidates : [];
  const aliasTerms = Array.isArray(raw.alias_terms) ? raw.alias_terms : [];
  const anchorLabel = typeof raw.anchor_label === 'string' ? raw.anchor_label : null;
  const confidence = typeof raw.confidence === 'number' ? clamp(raw.confidence, 0, 1) : 0;
  const notes = typeof raw.notes === 'string' ? raw.notes : '';

  // Validate and normalize candidates
  const candidates = bestCandidates
    .filter(c => c && typeof c === 'object' && typeof c.surface_id === 'string')
    .map(c => ({
      surface_id: c.surface_id,
      label: String(c.label || ''),
      route: String(c.route || '/'),
      location_group: String(c.location_group || 'inline'),
      score: typeof c.score === 'number' ? clamp(c.score, 0, 1) : 0,
      rationale: String(c.rationale || ''),
    }))
    .sort((a, b) => b.score - a.score);

  // Normalize alias terms
  const aliases = aliasTerms
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim().toLowerCase())
    .filter((t, i, arr) => arr.indexOf(t) === i); // dedupe

  return {
    feature_id: featureId,
    feature_text: '',   // Filled by caller
    doc_section: null,  // Filled by caller
    candidates,
    recommended_aliases: aliases,
    recommended_anchor: anchorLabel,
    confidence,
    notes,
    _raw: raw,
  };
}

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Structured error for Brain parse failures.
 */
export class BrainParseError extends Error {
  /**
   * @param {string} featureId
   * @param {string} detail
   */
  constructor(featureId, detail) {
    super(`Brain response parse error for feature "${featureId}": ${detail}`);
    this.name = 'BrainParseError';
    this.featureId = featureId;
  }
}
