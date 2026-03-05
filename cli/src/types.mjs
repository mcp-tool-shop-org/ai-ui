// @ts-check

/**
 * @typedef {Object} AiUiConfig
 * @property {{ globs: string[], cliHelp: string|null }} docs
 * @property {{ baseUrl: string, routes: string[], maxDepth: number, timeout: number, skipLabels: string[], safeOverride: string }} probe
 * @property {Record<string, string>} mapping
 * @property {{ atlas: string, probe: string, diff: string, diffReport: string, surfaces: string, graph: string, graphReport: string, graphDot: string, composePlan: string, composeReport: string, composeDot: string, verify: string, verifyReport: string }} output
 * @property {VerifyConfig} verify
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

// =============================================================================
// Phase 2: Trigger Graph types
// =============================================================================

/**
 * @typedef {'trigger'|'surface'|'effect'|'route'|'feature'} GraphNodeType
 */

/**
 * @typedef {Object} GraphNode
 * @property {string} id         - Unique node ID (type-prefixed)
 * @property {GraphNodeType} type
 * @property {string} label      - Human-readable label
 * @property {string} [route]    - Route context (optional for effects)
 * @property {Record<string, any>} meta - Type-specific metadata
 */

/**
 * @typedef {'maps_to'|'produces'|'writes'|'navigates_to'|'contains'|'documents'} GraphEdgeType
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} from  - Source node ID
 * @property {string} to    - Target node ID
 * @property {GraphEdgeType} type
 * @property {number} [weight] - Edge weight (e.g., matchScore confidence)
 * @property {Record<string, any>} [meta] - Edge-specific metadata
 */

/**
 * @typedef {Object} TriggerGraph
 * @property {string} version
 * @property {string} generated_at
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {TriggerGraphStats} stats
 */

/**
 * @typedef {Object} TriggerGraphStats
 * @property {number} total_nodes
 * @property {Record<GraphNodeType, number>} by_type
 * @property {number} total_edges
 * @property {Record<GraphEdgeType, number>} by_edge_type
 * @property {number} orphan_features
 * @property {number} orphan_triggers
 */

/**
 * @typedef {Object} SurfacingValue
 * @property {string} trigger_id
 * @property {string} label
 * @property {string} route
 * @property {number} value
 * @property {number} feature_edges
 * @property {number} effect_edges
 * @property {boolean} has_surface
 * @property {boolean} parent_nav
 */

// =============================================================================
// Phase 3: Surfacing Composer types
// =============================================================================

/**
 * @typedef {'navigate'|'submit'|'change'|'destructive'|'data'|'display'|'config'} IntentClass
 */

/**
 * @typedef {Object} PlanEntry
 * @property {string} feature_id
 * @property {string} feature_name
 * @property {'P0'|'P1'|'P2'} priority
 * @property {IntentClass} intent_class
 * @property {{ diff_reason: string, evidence: string[] }} why
 * @property {{ rule: string, route: string, surface_id: string|null, pattern_slot: string }} placement
 * @property {{ label: string, pattern_kind: string, style_tokens: string[], data_aiui: string }} control
 * @property {{ event: string }} trigger
 * @property {{ intent: string, target: string }} effect
 * @property {string[]} acceptance_criteria
 */

/**
 * @typedef {Object} SurfacingPlan
 * @property {string} version
 * @property {string} generated_at
 * @property {SurfacingPlanSummary} summary
 * @property {PlanEntry[]} plans
 */

/**
 * @typedef {Object} SurfacingPlanSummary
 * @property {number} features_total
 * @property {number} features_planned
 * @property {string[]} routes_touched
 * @property {Record<string, number>} placements_by_rule
 * @property {Record<string, number>} placements_by_priority
 */

// =============================================================================
// Phase 4A: Verify + Gate types
// =============================================================================

/**
 * @typedef {Object} VerifyConfig
 * @property {number} maxOrphanRatio       - Fail if orphan/total > this (default 0.25)
 * @property {number} maxUndocumentedSurfaces - Fail if discoverable_not_documented > this
 * @property {boolean} failOnP0Orphans     - Fail if any P0 features in surfacing plan
 */

/**
 * @typedef {Object} VerifyBlocker
 * @property {string} rule     - Rule name (e.g. 'max_orphan_ratio')
 * @property {string} message  - Human-readable explanation
 * @property {number} [threshold]
 * @property {number} [actual]
 */

/**
 * @typedef {Object} VerifyWarning
 * @property {string} rule
 * @property {string} message
 */

/**
 * @typedef {Object} VerifyMetrics
 * @property {number} total_features
 * @property {number} orphan_features
 * @property {number} orphan_ratio
 * @property {number} coverage_percent
 * @property {number} p0_count
 * @property {number} p1_count
 * @property {number} p2_count
 * @property {number} undocumented_surfaces
 * @property {number} ambiguous_matches
 * @property {number} high_burial_triggers
 */

/**
 * @typedef {Object} VerifyVerdict
 * @property {string} version
 * @property {string} generated_at
 * @property {boolean} pass
 * @property {number} exit_code
 * @property {VerifyMetrics} metrics
 * @property {VerifyBlocker[]} blockers
 * @property {VerifyWarning[]} warnings
 * @property {Record<string, string>} artifact_versions
 */

export {};
