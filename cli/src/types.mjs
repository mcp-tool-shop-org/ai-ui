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

export {};
