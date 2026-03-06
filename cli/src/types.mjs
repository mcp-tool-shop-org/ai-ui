// @ts-check

/**
 * @typedef {Object} AiUiConfig
 * @property {{ globs: string[], cliHelp: string|null }} docs
 * @property {{ baseUrl: string, routes: string[], maxDepth: number, timeout: number, skipLabels: string[], safeOverride: string, basePath: string, goalRoutes: string[] }} probe
 * @property {Record<string, string[]>} featureAliases
 * @property {Record<string, string>} mapping
 * @property {{ atlas: string, probe: string, diff: string, diffReport: string, surfaces: string, graph: string, graphReport: string, graphDot: string, composePlan: string, composeReport: string, composeDot: string, verify: string, verifyReport: string, baseline: string, mustSurface: string, prComment: string, prCommentJson: string, runtimeEffects: string, runtimeEffectsSummary: string, runtimeCoverage: string, runtimeCoverageReport: string, actionSummary: string, replayPack: string, replayDiff: string, replayDiffReport: string, replayDiffSummary: string, designSurfaceInventory: string, designSurfaceInventoryReport: string, designFeatureMap: string, designFeatureMapReport: string, designTaskFlows: string, designIAProposal: string }} output
 * @property {VerifyConfig} verify
 * @property {BaselineConfig} baseline
 * @property {MemoryConfig} memory
 * @property {RuntimeEffectsConfig} runtimeEffects
 * @property {CoverageGateConfig} coverageGate
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
 * @property {CoverageGateResult} [coverage_gate]        - Coverage CI gate result (Phase 8)
 * @property {ActionSummary} [action_summary]             - Compact summary for CI logs (Phase 8)
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
 * @property {CoverageBaselineSlice} [coverage] - Coverage gate data (Phase 8)
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

// =============================================================================
// Phase 8: CI Gate types
// =============================================================================

/** @typedef {'none'|'minimum'|'regressions'} GateMode */

/**
 * @typedef {Object} CoverageGateConfig
 * @property {number} minCoveragePercent       - Floor for coverage_percent in 'minimum' mode
 * @property {number} maxTotalActions          - Max action count in 'minimum' mode
 * @property {Record<string, number>|null} [maxActionsByType] - Per-type caps (optional)
 */

/**
 * @typedef {Object} CoverageGateResult
 * @property {GateMode} mode
 * @property {VerifyBlocker[]} blockers
 * @property {VerifyWarning[]} warnings
 * @property {CoverageGateDelta|null} delta
 */

/**
 * @typedef {Object} CoverageGateDelta
 * @property {string[]} new_action_ids         - actionIds in current but not baseline
 * @property {string[]} resolved_action_ids    - actionIds in baseline but not current
 * @property {number} coverage_change          - current coverage_percent - baseline
 * @property {number} action_count_change      - current total - baseline total
 * @property {Record<string, number>} new_by_type - count of new actions by ActionType
 */

/**
 * @typedef {Object} CoverageBaselineSlice
 * @property {number} coverage_percent
 * @property {number} total_actions
 * @property {Record<string, number>} actions_by_type
 * @property {string[]} action_ids             - sorted for deterministic comparison
 * @property {string} tool_version
 * @property {string} config_hash              - SHA-256 of runtimeEffects.safe config
 */

/**
 * @typedef {Object} ActionSummary
 * @property {number} total_actions
 * @property {Record<string, number>} by_action_type
 * @property {Record<string, number>} by_surprise_category
 * @property {string[]} top_action_ids         - first 5 by priority
 * @property {number} coverage_percent
 */

// =============================================================================
// Phase 9: Replay Pack types
// =============================================================================

/**
 * @typedef {Object} ReplayInputEntry
 * @property {string} key           - Artifact key (e.g. 'runtimeCoverage')
 * @property {string} sha256        - SHA-256 of canonical artifact content
 * @property {boolean} present      - Whether this artifact was present in the pack
 */

/**
 * @typedef {Object} ReplayConfigSnapshot
 * @property {string} verify_config_hash   - SHA-256 of verify config
 * @property {string} safe_config_hash     - SHA-256 of runtimeEffects.safe config
 * @property {import('./types.mjs').CoverageGateConfig} coverage_gate - Gate config used
 */

/**
 * @typedef {Object} ReplaySummary
 * @property {number} coverage_percent
 * @property {number} total_actions
 * @property {import('./types.mjs').GateMode} gate_mode
 * @property {boolean} gate_pass
 * @property {Record<string, number>} actions_by_type
 * @property {Record<string, number>} surprises_by_category
 */

/**
 * @typedef {Object} ReplayManifest
 * @property {{ name: string, version: string }} tool
 * @property {string} created_at
 * @property {ReplayConfigSnapshot} config_snapshot
 * @property {ReplayInputEntry[]} inputs
 * @property {ReplaySummary} summary
 * @property {import('./types.mjs').CoverageBaselineSlice|null} baseline_slice
 */

/**
 * @typedef {Object} ReplayPack
 * @property {string} version
 * @property {ReplayManifest} manifest
 * @property {Record<string, any>} artifacts
 */

// =============================================================================
// Phase 10: Replay Diff types
// =============================================================================

/**
 * @typedef {Object} ManifestDiff
 * @property {{ a: string, b: string, match: boolean }} tool_version
 * @property {{ a: string, b: string, match: boolean }} verify_config_hash
 * @property {{ a: string, b: string, match: boolean }} safe_config_hash
 * @property {{ a: any, b: any, match: boolean }} coverage_gate
 * @property {{ a: string, b: string }} created_at
 */

/**
 * @typedef {Object} TriggerStatusTransition
 * @property {string} trigger_id
 * @property {string} label
 * @property {string} route
 * @property {CoverageStatus|null} status_a
 * @property {CoverageStatus|null} status_b
 */

/**
 * @typedef {Object} ScalarDelta
 * @property {number} a
 * @property {number} b
 * @property {number} change
 */

/**
 * @typedef {Object} CoverageDelta
 * @property {ScalarDelta} coverage_percent
 * @property {ScalarDelta} fully_covered
 * @property {ScalarDelta} partial
 * @property {ScalarDelta} untested
 * @property {ScalarDelta} surprise
 * @property {TriggerStatusTransition[]} transitions
 */

/**
 * @typedef {Object} ActionsDelta
 * @property {CoverageAction[]} added
 * @property {CoverageAction[]} removed
 * @property {ScalarDelta} total_actions
 * @property {{ a: Record<string, number>, b: Record<string, number> }} by_type
 */

/**
 * @typedef {Object} SurprisesDelta
 * @property {{ a: Record<string, number>, b: Record<string, number>, change: Record<string, number> }} by_category
 * @property {SurpriseEntryV2[]} added
 * @property {SurpriseEntryV2[]} removed
 */

/**
 * @typedef {Object} DriftDiagnostic
 * @property {string} trigger_id
 * @property {string} label
 * @property {string} route
 * @property {string} expected_id
 * @property {string} observed_id
 * @property {'added'|'removed'|'unchanged'} status
 */

/**
 * @typedef {Object} ReplayDiff
 * @property {string} version
 * @property {string} generated_at
 * @property {{ a: string, b: string }} pack_paths
 * @property {ManifestDiff} manifest
 * @property {CoverageDelta} coverage
 * @property {ActionsDelta} actions
 * @property {SurprisesDelta} surprises
 * @property {DriftDiagnostic[]} drift_diagnostics
 */

/**
 * @typedef {Object} ReplayDiffSummary
 * @property {string} version
 * @property {{ a: string, b: string }} pack_paths
 * @property {number} coverage_change
 * @property {number} actions_added
 * @property {number} actions_removed
 * @property {number} transitions_count
 * @property {number} drift_count
 * @property {Record<string, number>} surprises_change
 * @property {boolean} config_match
 */

// =============================================================================
// Stage 0B: Design Map types
// =============================================================================

/** @typedef {'primary_nav'|'secondary_nav'|'toolbar'|'overflow'|'settings'|'modal'|'inline'|'footer'} LocationGroup */

/**
 * @typedef {Object} SurfaceInventoryEntry
 * @property {string} route
 * @property {string} label
 * @property {string} role           - BUTTON, LINK, INPUT, etc.
 * @property {string|null} selector  - CSS selector or stable id
 * @property {LocationGroup} location
 * @property {'safe'|'destructive'|'unknown'} safety
 * @property {string[]} linked_triggers
 * @property {string[]} linked_effects
 * @property {number} depth
 * @property {number} [route_coverage]    - Number of routes this item appears on (deduplicated entries only)
 * @property {number} [coverage_percent]  - route_coverage / total_routes (deduplicated entries only)
 */

/**
 * @typedef {Object} DesignSurfaceInventory
 * @property {string} version
 * @property {string} generated_at
 * @property {Record<LocationGroup, SurfaceInventoryEntry[]>} groups
 * @property {{ primary_nav: SurfaceInventoryEntry[], secondary_nav: SurfaceInventoryEntry[] }} [deduplicated]
 * @property {{ total: number, unique: number, by_location: Record<string, number>, by_location_unique: Record<string, number>, destructive_count: number, total_routes: number }} stats
 */

/**
 * @typedef {Object} FeatureMapEntry
 * @property {string} feature_id
 * @property {string} feature_name
 * @property {string[]} entry_points
 * @property {Record<string, number>} click_depth
 * @property {number} discoverability  - 0.0 (visible) to 1.0 (hidden)
 * @property {number} runtime_confidence - 0.0 to 1.0
 * @property {'promote'|'keep'|'demote'|'merge'|'rename'|'skip'} recommended_action
 * @property {string} rationale
 * @property {boolean} from_atlas
 */

/**
 * @typedef {Object} DesignFeatureMap
 * @property {string} version
 * @property {string} generated_at
 * @property {FeatureMapEntry[]} features
 * @property {{ total: number, from_atlas: number, auto_clustered: number, promote_count: number, demote_count: number, ungrounded_count: number }} stats
 */

/**
 * @typedef {Object} TaskFlowStep
 * @property {string} trigger_label
 * @property {string} route
 * @property {'navigate'|'action'|'confirmation'|'dead_end'} step_type
 * @property {string[]} effects
 * @property {boolean} is_destructive
 */

/**
 * @typedef {Object} TaskFlow
 * @property {string} task_name
 * @property {TaskFlowStep[]} steps
 * @property {boolean} has_dead_end
 * @property {boolean} has_loop
 * @property {'browse_loop'|'circular'|'nav_loop'|null} loop_type  - null if no loop
 * @property {boolean} goal_reached         - true if flow reaches a detail/docs/install page
 * @property {boolean} has_destructive_step
 * @property {number} total_depth
 */

/**
 * @typedef {Object} IAProposalItem
 * @property {string} label
 * @property {string} route
 * @property {string} reason
 */

/**
 * @typedef {Object} DesignIAProposal
 * @property {string} version
 * @property {string} generated_at
 * @property {IAProposalItem[]} primary_nav
 * @property {IAProposalItem[]} secondary_nav
 * @property {IAProposalItem[]} must_surface
 * @property {IAProposalItem[]} documented_non_surface
 * @property {IAProposalItem[]} demote_to_advanced
 * @property {IAConversionPath[]} [conversion_paths]
 * @property {string[]} grouping_notes
 */

/**
 * @typedef {Object} IAConversionPath
 * @property {string} from_label   - Nav item label
 * @property {string} to_route     - Goal route
 * @property {boolean} goal_reached
 */

export {};
