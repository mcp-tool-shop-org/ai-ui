// @ts-check

/**
 * @typedef {Object} AiUiConfig
 * @property {{ globs: string[], cliHelp: string|null }} docs
 * @property {{ baseUrl: string, routes: string[], maxDepth: number, timeout: number, skipLabels: string[], safeOverride: string }} probe
 * @property {Record<string, string>} mapping
 * @property {{ atlas: string, probe: string, diff: string, diffReport: string, surfaces: string, graph: string, graphReport: string, graphDot: string, composePlan: string, composeReport: string, composeDot: string, verify: string, verifyReport: string, baseline: string, mustSurface: string, prComment: string, prCommentJson: string, runtimeEffects: string, runtimeEffectsSummary: string, runtimeCoverage: string, runtimeCoverageReport: string }} output
 * @property {VerifyConfig} verify
 * @property {BaselineConfig} baseline
 * @property {MemoryConfig} memory
 * @property {RuntimeEffectsConfig} runtimeEffects
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
 * @property {{ diff_reason: string, evidence: string[], memory_decision?: string }} why
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
 * @property {number} memory_excluded     - Features excluded by memory exceptions
 * @property {number} must_surface_violations - Required features that are orphaned
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
 * @property {BaselineDelta[]} [baseline_deltas] - Delta comparison if baseline existed
 * @property {string} [baseline_id]              - Baseline created_at timestamp
 * @property {MustSurfaceResult[]} [must_surface_results] - Per-feature must-surface check results
 */

// =============================================================================
// Phase 4B: Baseline types
// =============================================================================

/**
 * @typedef {Object} BaselineConfig
 * @property {boolean} failOnOrphanIncrease       - Fail if orphan_features > baseline
 * @property {number} maxUndocumentedIncrease     - Fail if undocumented increased by > N
 * @property {boolean} warnOnCoverageDecrease     - Warn if coverage_percent decreased
 */

/**
 * @typedef {Object} BaselineSnapshot
 * @property {string} version
 * @property {string} created_at
 * @property {VerifyMetrics} metrics
 * @property {Record<string, string>} artifact_versions
 * @property {string} memory_hash
 * @property {string} verify_config_hash
 */

/**
 * @typedef {Object} BaselineDelta
 * @property {string} metric
 * @property {number} baseline_value
 * @property {number} current_value
 * @property {number} change
 * @property {'improved'|'regressed'|'unchanged'} direction
 */

// =============================================================================
// Phase 4C: Must-Surface types
// =============================================================================

/**
 * @typedef {Object} MustSurfaceConfig
 * @property {string} version
 * @property {MustSurfaceEntry[]} required
 */

/**
 * @typedef {Object} MustSurfaceEntry
 * @property {string} feature_id
 * @property {'P0'|'P1'|'P2'} severity
 * @property {string} [reason]
 */

/**
 * @typedef {Object} MustSurfaceResult
 * @property {string} feature_id
 * @property {'P0'|'P1'|'P2'} severity
 * @property {'ok'|'orphaned'|'missing'} status
 * @property {string} [reason]
 */

// =============================================================================
// Memory v0 types
// =============================================================================

/**
 * @typedef {Object} MemoryConfig
 * @property {string} dir    - Directory for memory files (default: 'ai-ui-memory')
 * @property {boolean} strict - Fail if memory files don't parse (default: false)
 */

/**
 * @typedef {Object} MemoryMapping
 * @property {string} trigger_label - Force-match to this trigger/surface label
 * @property {string} [reason]      - Why this mapping was established
 */

/**
 * @typedef {Object} MemoryDecision
 * @property {'P0'|'P1'|'P2'} priority - Override priority
 * @property {string} rule              - Override placement rule
 * @property {string} route             - Override target route
 * @property {string} [reason]          - Why this decision was made
 */

/**
 * @typedef {Object} MemoryException
 * @property {string} reason                              - Why excluded
 * @property {('orphan_count'|'coverage'|'p0')[]} exclude_from - Which calculations to exclude from
 */

/**
 * @typedef {Object} LoadedMemory
 * @property {Record<string, MemoryMapping>} mappings
 * @property {Record<string, MemoryDecision>} decisions
 * @property {Record<string, MemoryException>} exceptions
 */

/**
 * @typedef {Object} SuggestedMapping
 * @property {string} feature_id
 * @property {string} trigger_label
 * @property {number} confidence
 * @property {string} source - 'ambiguous' | 'near_miss'
 * @property {string} hint   - Human-readable suggestion
 */

/**
 * @typedef {Object} SuggestedMemory
 * @property {SuggestedMapping[]} mappings
 */

// =============================================================================
// Phase 5A: PR Comment types
// =============================================================================

/**
 * @typedef {Object} PrCommentConfig
 * @property {number} maxFixes
 * @property {number} maxBlockers
 * @property {number} maxWarnings
 * @property {'github'|'gitlab'|'markdown'} format
 */

/**
 * @typedef {Object} PrCommentFix
 * @property {string} feature_id
 * @property {string} feature_name
 * @property {'P0'|'P1'|'P2'} priority
 * @property {string} pattern_kind
 * @property {string} route
 * @property {string} label
 * @property {string[]} acceptance_criteria
 */

/**
 * @typedef {Object} PrCommentMemorySuggestion
 * @property {string} feature_id
 * @property {string} feature_name
 * @property {string} suggested_trigger
 * @property {string} hint
 */

/**
 * @typedef {Object} PrCommentModel
 * @property {boolean} pass
 * @property {number} exit_code
 * @property {VerifyMetrics} metrics
 * @property {VerifyBlocker[]} blockers
 * @property {number} blockers_truncated
 * @property {PrCommentFix[]} fixes
 * @property {number} fixes_truncated
 * @property {PrCommentMemorySuggestion[]} memory_suggestions
 * @property {VerifyWarning[]} warnings
 * @property {number} warnings_truncated
 * @property {BaselineDelta[]} [baseline_deltas]
 * @property {string} [baseline_id]
 * @property {MustSurfaceResult[]} [must_surface_results]
 */

// =============================================================================
// Runtime Effects types
// =============================================================================

/** @typedef {'fetch'|'navigate'|'download'|'storageWrite'|'domEffect'} RuntimeEffectKind */

/** @typedef {'low'|'med'|'high'} ConfidenceLevel */

/**
 * @typedef {Object} EvidenceEntry
 * @property {string} key              - Stable key: `${kind}:${normalizedTarget}`
 * @property {RuntimeEffectKind} kind
 * @property {string} [method]
 * @property {string} [url]
 * @property {number} [status]
 * @property {string} [filename]
 * @property {string} [detail]
 * @property {string} [scope]
 * @property {string} [evidenceKey]    - storageWrite key (avoiding property name clash)
 */

/**
 * @typedef {Object} DomMutationSummary
 * @property {number} nodesAdded
 * @property {number} nodesRemoved
 * @property {number} attributesChanged
 * @property {number} textChanged
 */

/**
 * @typedef {Object} RuntimeEffect
 * @property {RuntimeEffectKind} kind
 * @property {string} trigger_id
 * @property {string} route
 * @property {number} window_ms
 * @property {string} [method]     - fetch only
 * @property {string} [url]        - fetch only
 * @property {number} [status]     - fetch only
 * @property {string} [from]       - navigate only
 * @property {string} [to]         - navigate only
 * @property {string} [filename]   - download only
 * @property {string} [scope]      - storageWrite only (local|session)
 * @property {string} [key]        - storageWrite only
 * @property {string} [detail]     - domEffect only (modal_open|toast|clipboard_write)
 * @property {DomMutationSummary} [domMutation] - domEffect only
 * @property {string[]} [initiatorChain] - fetch only — redirect chain
 */

/**
 * @typedef {Object} RuntimeTriggerSummary
 * @property {string} trigger_id
 * @property {string} route
 * @property {string} label
 * @property {RuntimeEffect[]} effects
 */

/**
 * @typedef {Object} RuntimeEffectsSummary
 * @property {string} version
 * @property {string} generated_at
 * @property {string} url
 * @property {RuntimeTriggerSummary[]} triggers
 * @property {{ total_triggers: number, triggers_fired: number, triggers_skipped: number, effects_captured: number, by_kind: Record<string, number> }} stats
 */

// =============================================================================
// Runtime Coverage Report types
// =============================================================================

/** @typedef {'fully_covered'|'partial'|'untested'|'surprise'} CoverageStatus */

/**
 * @typedef {Object} TriggerCoverage
 * @property {string} trigger_id
 * @property {string} route
 * @property {string} label
 * @property {boolean} probed
 * @property {boolean} hasSurface
 * @property {boolean} observed
 * @property {CoverageStatus} status
 * @property {string[]} effects
 */

/**
 * @typedef {Object} CoverageSummary
 * @property {number} total
 * @property {number} fully_covered
 * @property {number} partial
 * @property {number} untested
 * @property {number} surprise
 * @property {number} coverage_percent
 */

/**
 * @typedef {Object} SurpriseEntry
 * @property {string} trigger_id
 * @property {string} label
 * @property {string} route
 * @property {string} reason
 */

/**
 * @typedef {Object} CoverageReport
 * @property {string} version
 * @property {string} generated_at
 * @property {TriggerCoverage[]} triggers
 * @property {CoverageSummary} summary
 * @property {SurpriseEntry[]} surprises
 * @property {SurpriseEntryV2[]} [surprises_v2]
 */

// =============================================================================
// Phase 7: Actionable Coverage types
// =============================================================================

/** @typedef {'new_effect'|'missing_expected'|'identity_drift'|'low_attribution'|'risky_skipped'} SurpriseCategory */

/**
 * @typedef {Object} SurpriseEntryV2
 * @property {string} trigger_id
 * @property {string} label
 * @property {string} route
 * @property {SurpriseCategory} category
 * @property {string} [effect_id]
 * @property {string} [expected_id]
 * @property {string} [observed_id]
 * @property {string} detail
 */

/** @typedef {'probe_trigger'|'investigate_missing'|'review_new_effect'|'resolve_drift'|'increase_confidence'} ActionType */

/**
 * @typedef {Object} CoverageAction
 * @property {string} actionId
 * @property {ActionType} type
 * @property {number} priority
 * @property {number} impact
 * @property {'safe'|'caution'|'unsafe'} risk
 * @property {'low'|'med'|'high'} effort
 * @property {string} rationale
 * @property {string} [triggerId]
 * @property {string} [effectId]
 */

/**
 * @typedef {Object} NextBestProbe
 * @property {string} trigger_id
 * @property {string} label
 * @property {string} route
 * @property {number} score
 * @property {string[]} reasons
 * @property {'safe'|'caution'|'unsafe'} risk
 */

/**
 * @typedef {Object} ActionableReport
 * @property {string} version
 * @property {string} generated_at
 * @property {CoverageAction[]} actions
 * @property {NextBestProbe[]} next_best_probes
 * @property {{ total_actions: number, by_type: Record<string, number>, estimated_coverage_gain: number }} summary
 */

/**
 * @typedef {Object} GraphDelta
 * @property {number} nodesAdded
 * @property {number} nodesUpdated
 * @property {number} observedEffects
 * @property {number} newEdges
 * @property {string} reason
 */

/**
 * @typedef {Object} RuntimeEffectsSafeConfig
 * @property {string} denyLabelRegex
 * @property {boolean} requireSafeAttrForDestructive
 * @property {string|null} [denyHrefRegex]
 * @property {{ method: string, urlPattern: string }[]} [denyMethodPatterns]
 */

/**
 * @typedef {Object} RuntimeEffectsConfig
 * @property {string[]} routes
 * @property {number} maxTriggersPerRoute
 * @property {number} windowMs
 * @property {RuntimeEffectsSafeConfig} safe
 */

export {};
