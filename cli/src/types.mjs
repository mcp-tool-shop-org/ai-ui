// @ts-check

/**
 * @typedef {Object} AiUiConfig
 * @property {{ globs: string[], cliHelp: string|null }} docs
 * @property {{ baseUrl: string, routes: string[], maxDepth: number, timeout: number, skipLabels: string[], safeOverride: string }} probe
 * @property {Record<string, string>} mapping
 * @property {{ atlas: string, probe: string, diff: string, diffReport: string, surfaces: string }} output
 */

/**
 * @typedef {Object} Feature
 * @property {string} id
 * @property {string} name
 * @property {string[]} synonyms
 * @property {{ file: string, line: number, type: string, section: string|null }[]} sources
 * @property {string[]} expected_entrypoints
 */

/**
 * @typedef {Object} Surface
 * @property {string} nodeId       - Stable content-addressed node ID
 * @property {string} route        - URL path where this surface was captured
 * @property {string} role         - UIRole (BUTTON, LINK, INPUT, etc.)
 * @property {string|null} label   - Semantic hint or null
 * @property {string|null} pattern - PatternSignal kind or null
 * @property {string[]} styleTokens - StyleIntent tokens (primary, destructive, etc.)
 * @property {{ event: string, intent: string }[]} handlers - HandlerSignals
 * @property {{ key: string, access: string }[]} state - StateSignals (write|readwrite only)
 */

/**
 * @typedef {Object} SurfaceInventory
 * @property {string} version
 * @property {string} generated_at
 * @property {string} source_capture - Path or URL of the source capture
 * @property {Surface[]} surfaces
 * @property {{ total_nodes: number, surfaces_extracted: number }} stats
 */

// =============================================================================
// Phase 1.3: Diagnostic types
// =============================================================================

/**
 * @typedef {Object} CandidateAttempt
 * @property {'trigger'|'surface'} source_type
 * @property {string} source_id     - trigger key or surface nodeId
 * @property {string} source_label  - display label
 * @property {string} source_route  - route where candidate was found
 * @property {number} label_score   - matchScore(feature, candidate)
 * @property {number} pattern_score - pattern affinity (0-1)
 * @property {number} intent_score  - intent affinity (0-1)
 * @property {number} style_score   - style token affinity (0-1)
 * @property {number} composite_score - weighted combination
 * @property {string} match_dimension - highest-scoring dimension
 */

/**
 * @typedef {'label_mismatch'|'intent_mismatch'|'pattern_mismatch'|'missing_surface'} FailureReason
 */

/**
 * @typedef {Object} FixSuggestion
 * @property {string} action   - Human-readable fix
 * @property {string} rule     - Which heuristic fired
 * @property {string} tag_hint - data-aiui attribute suggestion
 */

/**
 * @typedef {Object} EnrichedUnmatched
 * @property {string} feature_id
 * @property {string} feature_name
 * @property {string[]} sources
 * @property {FailureReason} failure_reason
 * @property {CandidateAttempt[]} top_candidates - up to 3
 * @property {FixSuggestion[]} suggestions
 * @property {string} reason - backward-compat reason string
 */

/**
 * @typedef {Object} AmbiguousMatch
 * @property {string} feature_id
 * @property {string} feature_name
 * @property {CandidateAttempt[]} tied_candidates
 * @property {number} confidence_gap
 */

export {};
