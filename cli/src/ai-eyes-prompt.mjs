// @ts-check
/**
 * Prompt builder for ai-eyes LLaVA queries.
 * Constructs vision prompts and validates LLaVA JSON output.
 */

/**
 * Build a vision prompt for LLaVA to describe a UI element screenshot.
 *
 * @param {object} params
 * @param {string} params.existingLabel  - Current text label (may be empty)
 * @param {string} params.role           - Element role (button, link, etc.)
 * @param {string} params.route          - Route where element was found
 * @param {string} params.locationGroup  - Location group (primary_nav, toolbar, etc.)
 * @returns {string} Prompt ready for LLaVA
 */
export function buildEyesPrompt({ existingLabel, role, route, locationGroup }) {
  return `You are a UI element identifier. You are looking at a screenshot of a single interactive UI element (a ${role}) from a web application.

CONTEXT:
  Current text label: "${existingLabel || '(none)'}"
  Element type: ${role}
  Page route: ${route}
  UI location: ${locationGroup}

TASK:
Describe what this UI element is and what it does. Focus on:
1. If it's an icon, what does the icon represent? (e.g., "gear/settings", "speaker/audio", "three dots/menu")
2. Any visible text in or near the element
3. What action would clicking this element likely perform?

OUTPUT FORMAT (strict JSON, no other text):
{
  "icon_guess": "settings",
  "visible_text": "any text you can read",
  "nearby_context": "short description of surrounding context",
  "action_guess": "what clicking this would do",
  "confidence": 0.85
}

Rules:
- icon_guess: one or two words describing the icon's meaning. Use lowercase. If no icon, use "none".
- visible_text: exact text visible in the element. Use "" if none.
- nearby_context: brief description of nearby UI elements or headings. Use "" if nothing notable.
- action_guess: one short phrase for the likely action. Use "" if unclear.
- confidence: 0.0 to 1.0 how confident you are in your identification.

Respond with ONLY the JSON object.`;
}

/**
 * Validate and normalize LLaVA response JSON.
 *
 * @param {Record<string, any>} raw - Parsed JSON from LLaVA
 * @param {string} surfaceId - For error context
 * @returns {{ icon_guess: string, visible_text: string, nearby_context: string, action_guess: string, confidence: number }}
 * @throws {EyesParseError} If response doesn't match expected shape
 */
export function parseEyesResponse(raw, surfaceId) {
  if (!raw || typeof raw !== 'object') {
    throw new EyesParseError(surfaceId, 'Response is not an object');
  }

  return {
    icon_guess: typeof raw.icon_guess === 'string' ? raw.icon_guess.toLowerCase().trim() : '',
    visible_text: typeof raw.visible_text === 'string' ? raw.visible_text.trim() : '',
    nearby_context: typeof raw.nearby_context === 'string' ? raw.nearby_context.trim() : '',
    action_guess: typeof raw.action_guess === 'string' ? raw.action_guess.trim() : '',
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
  };
}

/**
 * Structured error for Eyes parse failures.
 */
export class EyesParseError extends Error {
  /**
   * @param {string} surfaceId
   * @param {string} detail
   */
  constructor(surfaceId, detail) {
    super(`Eyes response parse error for surface "${surfaceId}": ${detail}`);
    this.name = 'EyesParseError';
    this.surfaceId = surfaceId;
  }
}
