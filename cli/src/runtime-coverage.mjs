// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';
import { normalizeEffectId, isTriggerSafe } from './runtime-effects.mjs';
import { RUNTIME_INTENT_MAP } from './trigger-graph.mjs';

// =============================================================================
// Load coverage artifacts
// =============================================================================

/**
 * Load all artifacts needed for coverage analysis.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {string} cwd
 * @returns {{ graph: import('./types.mjs').TriggerGraph|null, runtimeSummary: import('./types.mjs').RuntimeEffectsSummary|null, probeEntries: any[]|null, surfaces: import('./types.mjs').Surface[]|null }}
 */
export function loadCoverageArtifacts(config, cwd) {
  // Graph is required
  const graphPath = resolve(cwd, config.output.graph);
  let graph = null;
  if (existsSync(graphPath)) {
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }

  // Runtime summary (optional)
  const runtimePath = resolve(cwd, config.output.runtimeEffectsSummary);
  let runtimeSummary = null;
  if (existsSync(runtimePath)) {
    try {
      runtimeSummary = JSON.parse(readFileSync(runtimePath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }

  // Probe entries (optional)
  const probePath = resolve(cwd, config.output.probe);
  let probeEntries = null;
  if (existsSync(probePath)) {
    try {
      probeEntries = readFileSync(probePath, 'utf-8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
    } catch { /* ignore parse errors */ }
  }

  // Surfaces (optional)
  const surfacesPath = resolve(cwd, config.output.surfaces);
  let surfaces = null;
  if (existsSync(surfacesPath)) {
    try {
      const inv = JSON.parse(readFileSync(surfacesPath, 'utf-8'));
      surfaces = inv.surfaces || [];
    } catch { /* ignore parse errors */ }
  }

  return { graph, runtimeSummary, probeEntries, surfaces };
}

// =============================================================================
// Compute coverage
// =============================================================================

/**
 * Compute per-trigger coverage from pipeline artifacts.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').RuntimeEffectsSummary|null} runtimeSummary
 * @param {any[]|null} probeEntries
 * @returns {import('./types.mjs').CoverageReport}
 */
export function computeCoverage(graph, runtimeSummary, probeEntries) {
  // Build sets for lookup
  const probedLabels = new Set();
  if (probeEntries) {
    for (const entry of probeEntries) {
      if (entry.type === 'trigger') {
        probedLabels.add(`${entry.route}|${entry.label}`);
      }
    }
  }

  const observedTriggers = new Map();
  if (runtimeSummary) {
    for (const t of runtimeSummary.triggers) {
      observedTriggers.set(`${t.route}|${t.label}`, t.effects.map(e => e.kind));
    }
  }

  // Surface mapping: trigger → has maps_to edge
  const hasSurfaceMap = new Set();
  for (const edge of graph.edges) {
    if (edge.type === 'maps_to') {
      hasSurfaceMap.add(edge.from);
    }
  }

  /** @type {import('./types.mjs').TriggerCoverage[]} */
  const triggers = [];

  /** @type {import('./types.mjs').SurpriseEntry[]} */
  const surprises = [];

  // Process graph trigger nodes
  const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');

  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    const probed = probedLabels.has(key);
    const hasSurface = hasSurfaceMap.has(node.id);
    const observedEffects = observedTriggers.get(key) || [];
    const observed = observedEffects.length > 0;

    let status = classifyStatus(probed, hasSurface, observed);

    triggers.push({
      trigger_id: node.id,
      route: node.route || '/',
      label: node.label,
      probed,
      hasSurface,
      observed,
      status,
      effects: observedEffects,
    });
  }

  // Check for surprise triggers: observed in runtime but not in graph
  if (runtimeSummary) {
    const graphTriggerKeys = new Set(triggerNodes.map(n => `${n.route}|${n.label}`));
    for (const t of runtimeSummary.triggers) {
      const key = `${t.route}|${t.label}`;
      if (!graphTriggerKeys.has(key) && t.effects.length > 0) {
        triggers.push({
          trigger_id: `runtime:${t.route}|${t.label}`,
          route: t.route,
          label: t.label,
          probed: false,
          hasSurface: false,
          observed: true,
          status: 'surprise',
          effects: t.effects.map(e => e.kind),
        });
        surprises.push({
          trigger_id: `runtime:${t.route}|${t.label}`,
          label: t.label,
          route: t.route,
          reason: 'new_runtime_effect',
        });
      }
    }
  }

  // Check for risky skipped triggers (in graph with destructive style but not observed)
  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    const observed = observedTriggers.has(key);
    const meta = node.meta || {};
    if (!observed && meta.styleTokens && meta.styleTokens.some(
      /** @param {string} t */ t => ['destructive', 'danger', 'warning'].includes(t)
    )) {
      surprises.push({
        trigger_id: node.id,
        label: node.label,
        route: node.route || '/',
        reason: 'risky_skipped',
      });
    }
  }

  // Sort triggers deterministically
  triggers.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));
  surprises.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));

  // Summary
  let fullyCovered = 0, partial = 0, untested = 0, surprise = 0;
  for (const t of triggers) {
    switch (t.status) {
      case 'fully_covered': fullyCovered++; break;
      case 'partial': partial++; break;
      case 'untested': untested++; break;
      case 'surprise': surprise++; break;
    }
  }

  const total = triggers.length;
  const coveragePercent = total > 0
    ? Math.round((fullyCovered / total) * 10000) / 100
    : 0;

  // Phase 7: typed surprise categories
  const surprisesV2 = classifySurprisesV2(graph, runtimeSummary, probeEntries);

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    triggers,
    summary: {
      total,
      fully_covered: fullyCovered,
      partial,
      untested,
      surprise,
      coverage_percent: coveragePercent,
    },
    surprises,
    surprises_v2: surprisesV2,
  };
}

/**
 * Classify trigger coverage status.
 * @param {boolean} probed
 * @param {boolean} hasSurface
 * @param {boolean} observed
 * @returns {import('./types.mjs').CoverageStatus}
 */
export function classifyStatus(probed, hasSurface, observed) {
  const count = (probed ? 1 : 0) + (hasSurface ? 1 : 0) + (observed ? 1 : 0);
  if (count === 3) return 'fully_covered';
  if (count >= 2) return 'partial';
  if (!probed && !hasSurface && observed) return 'surprise';
  return 'untested';
}

// =============================================================================
// Phase 7: Actionable Coverage — pure functions
// =============================================================================

/**
 * Generate a stable, deterministic action ID from type + IDs.
 * Uses DJB2 hash — no crypto needed.
 * @param {string} type
 * @param {string} triggerId
 * @param {string} [effectId]
 * @returns {string}
 */
export function buildActionId(type, triggerId, effectId) {
  const input = `${type}|${triggerId}|${effectId || ''}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return `act:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Derive expected effect node IDs for a trigger by walking the graph chain:
 * trigger → maps_to → surface → produces/writes → effect
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {string} triggerId
 * @returns {string[]}
 */
export function deriveExpectedEffects(graph, triggerId) {
  // Find surfaces mapped from this trigger
  const surfaceIds = graph.edges
    .filter(e => e.from === triggerId && e.type === 'maps_to')
    .map(e => e.to);

  // Find effects produced/written by those surfaces
  const effectIds = new Set();
  for (const surfaceId of surfaceIds) {
    for (const edge of graph.edges) {
      if (edge.from === surfaceId && (edge.type === 'produces' || edge.type === 'writes')) {
        effectIds.add(edge.to);
      }
    }
  }

  return [...effectIds].sort();
}

/**
 * Classify surprises into Phase 7 typed categories.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').RuntimeEffectsSummary|null} runtimeSummary
 * @param {any[]|null} probeEntries
 * @returns {import('./types.mjs').SurpriseEntryV2[]}
 */
export function classifySurprisesV2(graph, runtimeSummary, probeEntries) {
  /** @type {import('./types.mjs').SurpriseEntryV2[]} */
  const results = [];

  // Build lookup structures
  const probedKeys = new Set();
  if (probeEntries) {
    for (const entry of probeEntries) {
      if (entry.type === 'trigger') {
        probedKeys.add(`${entry.route}|${entry.label}`);
      }
    }
  }

  const observedTriggerEffects = new Map();
  if (runtimeSummary) {
    for (const t of runtimeSummary.triggers) {
      observedTriggerEffects.set(`${t.route}|${t.label}`, t.effects);
    }
  }

  const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');
  const graphTriggerKeys = new Set(triggerNodes.map(n => `${n.route}|${n.label}`));

  // --- Category 1: new_effect ---
  if (runtimeSummary) {
    for (const t of runtimeSummary.triggers) {
      const key = `${t.route}|${t.label}`;
      if (!graphTriggerKeys.has(key) && t.effects.length > 0) {
        results.push({
          trigger_id: `runtime:${t.route}|${t.label}`,
          label: t.label,
          route: t.route,
          category: 'new_effect',
          detail: `Runtime trigger '${t.label}' not in graph, produced ${t.effects.length} effect(s)`,
        });
      }
    }
  }

  // --- Category 2: missing_expected ---
  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    if (!probedKeys.has(key)) continue; // Only for probed triggers

    const expectedEffectIds = deriveExpectedEffects(graph, node.id);
    if (expectedEffectIds.length === 0) continue;

    const runtimeEffects = observedTriggerEffects.get(key) || [];

    // Build set of observed effect identifiers
    const observedIds = new Set();
    for (const effect of runtimeEffects) {
      observedIds.add(normalizeEffectId(effect));
      // Also add intent-based IDs for matching
      const intentKey = effect.kind === 'fetch' ? `fetch:${effect.method || 'GET'}` : effect.kind;
      const intents = RUNTIME_INTENT_MAP[intentKey] || [];
      for (const intent of intents) {
        const intentId = effect.kind === 'storageWrite'
          ? `effect:stateWrite:${effect.key}`
          : `effect:${intent}:${node.route || '/'}`;
        observedIds.add(intentId);
      }
    }

    for (const expectedId of expectedEffectIds) {
      if (!observedIds.has(expectedId)) {
        results.push({
          trigger_id: node.id,
          label: node.label,
          route: node.route || '/',
          category: 'missing_expected',
          expected_id: expectedId,
          detail: `Expected effect '${expectedId}' not observed when '${node.label}' was probed`,
        });
      }
    }
  }

  // --- Category 3: identity_drift ---
  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    if (!probedKeys.has(key)) continue;

    const expectedEffectIds = deriveExpectedEffects(graph, node.id);
    if (expectedEffectIds.length === 0) continue;

    const runtimeEffects = observedTriggerEffects.get(key) || [];

    // Build kind → expected ID mapping
    /** @type {Map<string, string[]>} */
    const expectedByKind = new Map();
    for (const expectedId of expectedEffectIds) {
      const effectNode = graph.nodes.find(n => n.id === expectedId);
      if (effectNode && effectNode.meta && effectNode.meta.kind) {
        const kind = effectNode.meta.kind;
        if (!expectedByKind.has(kind)) expectedByKind.set(kind, []);
        expectedByKind.get(kind).push(expectedId);
      }
    }

    for (const effect of runtimeEffects) {
      const normalizedId = normalizeEffectId(effect);
      // Check if normalized ID matches any expected ID
      if (expectedEffectIds.includes(normalizedId)) continue;

      // Check if intent-based IDs match
      const intentKey = effect.kind === 'fetch' ? `fetch:${effect.method || 'GET'}` : effect.kind;
      const intents = RUNTIME_INTENT_MAP[intentKey] || [];
      let intentMatched = false;
      for (const intent of intents) {
        const intentId = effect.kind === 'storageWrite'
          ? `effect:stateWrite:${effect.key}`
          : `effect:${intent}:${node.route || '/'}`;
        if (expectedEffectIds.includes(intentId)) { intentMatched = true; break; }
      }
      if (intentMatched) continue;

      // Check for same kind but different ID → identity_drift
      const kindExpected = expectedByKind.get(effect.kind);
      if (kindExpected && kindExpected.length > 0) {
        results.push({
          trigger_id: node.id,
          label: node.label,
          route: node.route || '/',
          category: 'identity_drift',
          expected_id: kindExpected[0],
          observed_id: normalizedId,
          detail: `Effect ID mismatch: expected '${kindExpected[0]}', observed '${normalizedId}'`,
        });
      }
    }
  }

  // --- Category 4: low_attribution ---
  const effectNodes = graph.nodes.filter(n => n.type === 'effect' && n.meta.observed && n.meta.confidence === 'low');
  for (const node of effectNodes) {
    // Find which trigger produced this effect
    const triggerEdge = graph.edges.find(e => e.to === node.id && (e.type === 'runtime_observed' || e.type === 'produces'));
    const triggerNode = triggerEdge ? graph.nodes.find(n => n.id === triggerEdge.from) : null;
    results.push({
      trigger_id: triggerNode ? triggerNode.id : 'unknown',
      label: triggerNode ? triggerNode.label : node.label,
      route: triggerNode ? (triggerNode.route || '/') : '/',
      category: 'low_attribution',
      effect_id: node.id,
      detail: `Effect '${node.id}' has low attribution confidence`,
    });
  }

  // --- Category 5: risky_skipped ---
  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    const observed = observedTriggerEffects.has(key);
    const meta = node.meta || {};
    if (!observed && meta.styleTokens && meta.styleTokens.some(
      /** @param {string} t */ t => ['destructive', 'danger', 'warning'].includes(t)
    )) {
      results.push({
        trigger_id: node.id,
        label: node.label,
        route: node.route || '/',
        category: 'risky_skipped',
        detail: `Destructive trigger '${node.label}' was not observed at runtime`,
      });
    }
  }

  // Sort deterministically
  results.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id) || a.category.localeCompare(b.category));
  return results;
}

/**
 * Build a deterministic action queue from coverage data and surprises.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').CoverageReport} report
 * @param {import('./types.mjs').SurpriseEntryV2[]} surprisesV2
 * @param {import('./types.mjs').RuntimeEffectsSafeConfig} safeConfig
 * @returns {import('./types.mjs').CoverageAction[]}
 */
export function buildActionQueue(graph, report, surprisesV2, safeConfig) {
  /** @type {Map<string, import('./types.mjs').CoverageAction>} */
  const actionMap = new Map();
  const total = Math.max(report.summary.total, 1);

  // probe_trigger for untested triggers
  for (const t of report.triggers) {
    if (t.status !== 'untested') continue;
    const outDegree = graph.edges.filter(e => e.from === t.trigger_id).length;
    const triggerNode = graph.nodes.find(n => n.id === t.trigger_id);
    const safeResult = triggerNode ? isTriggerSafe(triggerNode.meta || {}, safeConfig) : { safe: true };
    const risk = safeResult.safe ? 'safe' : 'unsafe';
    const expectedCount = deriveExpectedEffects(graph, t.trigger_id).length;

    const action = {
      actionId: buildActionId('probe_trigger', t.trigger_id),
      type: /** @type {const} */ ('probe_trigger'),
      priority: 10 + outDegree,
      impact: Math.round(100 / total),
      risk: /** @type {'safe'|'caution'|'unsafe'} */ (risk),
      effort: /** @type {const} */ ('low'),
      rationale: `Probe '${t.label}' on ${t.route} to observe ${expectedCount} expected effect(s)`,
      triggerId: t.trigger_id,
    };
    actionMap.set(action.actionId, action);
  }

  // Actions from surprises
  for (const s of surprisesV2) {
    /** @type {import('./types.mjs').CoverageAction|null} */
    let action = null;

    switch (s.category) {
      case 'missing_expected':
        action = {
          actionId: buildActionId('investigate_missing', s.trigger_id, s.expected_id),
          type: 'investigate_missing',
          priority: 20,
          impact: Math.round(100 / total),
          risk: 'caution',
          effort: 'med',
          rationale: `Expected effect '${s.expected_id}' not observed when '${s.label}' was probed`,
          triggerId: s.trigger_id,
          effectId: s.expected_id,
        };
        break;
      case 'new_effect':
        action = {
          actionId: buildActionId('review_new_effect', s.trigger_id),
          type: 'review_new_effect',
          priority: 15,
          impact: 0,
          risk: 'caution',
          effort: 'low',
          rationale: `New runtime trigger '${s.label}' has no static graph match`,
          triggerId: s.trigger_id,
        };
        break;
      case 'identity_drift':
        action = {
          actionId: buildActionId('resolve_drift', s.trigger_id, s.expected_id),
          type: 'resolve_drift',
          priority: 25,
          impact: 0,
          risk: 'safe',
          effort: 'med',
          rationale: `Effect ID mismatch: expected '${s.expected_id}', observed '${s.observed_id}'`,
          triggerId: s.trigger_id,
          effectId: s.observed_id,
        };
        break;
      case 'low_attribution':
        action = {
          actionId: buildActionId('increase_confidence', s.trigger_id, s.effect_id),
          type: 'increase_confidence',
          priority: 12,
          impact: 0,
          risk: 'safe',
          effort: 'low',
          rationale: `Effect '${s.effect_id}' has low attribution confidence`,
          triggerId: s.trigger_id,
          effectId: s.effect_id,
        };
        break;
      // risky_skipped generates a probe_trigger if not already present
      case 'risky_skipped': {
        const id = buildActionId('probe_trigger', s.trigger_id);
        if (!actionMap.has(id)) {
          action = {
            actionId: id,
            type: 'probe_trigger',
            priority: 8,
            impact: Math.round(100 / total),
            risk: 'unsafe',
            effort: 'low',
            rationale: `Destructive trigger '${s.label}' was not observed (risky if untested)`,
            triggerId: s.trigger_id,
          };
        }
        break;
      }
    }

    if (action && !actionMap.has(action.actionId)) {
      actionMap.set(action.actionId, action);
    }
  }

  // Sort by priority desc, then actionId for determinism
  const actions = [...actionMap.values()];
  actions.sort((a, b) => b.priority - a.priority || a.actionId.localeCompare(b.actionId));
  return actions;
}

/**
 * Rank unprobed/untested triggers by coverage value.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').CoverageReport} report
 * @param {import('./types.mjs').RuntimeEffectsSafeConfig} safeConfig
 * @param {{ topN?: number }} [opts]
 * @returns {import('./types.mjs').NextBestProbe[]}
 */
export function scoreNextBestProbes(graph, report, safeConfig, opts) {
  const topN = opts?.topN || 10;

  /** @type {import('./types.mjs').NextBestProbe[]} */
  const probes = [];

  for (const t of report.triggers) {
    // Compute score components
    const expectedEffects = deriveExpectedEffects(graph, t.trigger_id);
    const unobservedExpected = expectedEffects.filter(eid => {
      const node = graph.nodes.find(n => n.id === eid);
      return node && !node.meta.observed;
    }).length;

    // Unknown surface effects: effects from surfaces not yet verified
    const surfaceIds = graph.edges
      .filter(e => e.from === t.trigger_id && e.type === 'maps_to')
      .map(e => e.to);
    let unknownSurfaceEffects = 0;
    for (const sid of surfaceIds) {
      const surfaceEffects = graph.edges.filter(e => e.from === sid && (e.type === 'produces' || e.type === 'writes'));
      for (const se of surfaceEffects) {
        const effectNode = graph.nodes.find(n => n.id === se.to);
        if (effectNode && !effectNode.meta.observed) unknownSurfaceEffects++;
      }
    }

    const outDegree = graph.edges.filter(e => e.from === t.trigger_id).length;

    const triggerNode = graph.nodes.find(n => n.id === t.trigger_id);
    const safeResult = triggerNode ? isTriggerSafe(triggerNode.meta || {}, safeConfig) : { safe: true };
    const riskPenalty = safeResult.safe ? 0 : 1;
    const alreadyProbed = t.probed ? 1 : 0;

    const score = (unobservedExpected * 5)
      + (unknownSurfaceEffects * 3)
      + (outDegree * 2)
      - (riskPenalty * 10)
      - (alreadyProbed * 4);

    if (score <= 0 && t.status === 'fully_covered') continue;

    const reasons = [];
    if (unobservedExpected > 0) reasons.push(`${unobservedExpected} unobserved expected effect(s)`);
    if (unknownSurfaceEffects > 0) reasons.push(`${unknownSurfaceEffects} unverified surface effect(s)`);
    if (outDegree > 0) reasons.push(`${outDegree} outgoing edge(s)`);
    if (riskPenalty > 0) reasons.push('risk penalty (destructive)');
    if (alreadyProbed) reasons.push('already probed (penalty)');

    probes.push({
      trigger_id: t.trigger_id,
      label: t.label,
      route: t.route,
      score,
      reasons,
      risk: safeResult.safe ? 'safe' : (riskPenalty > 0 ? 'unsafe' : 'caution'),
    });
  }

  probes.sort((a, b) => b.score - a.score || a.trigger_id.localeCompare(b.trigger_id));
  return probes.slice(0, topN);
}

/**
 * Compose the full actionable report.
 * @param {import('./types.mjs').CoverageAction[]} actions
 * @param {import('./types.mjs').NextBestProbe[]} probes
 * @returns {import('./types.mjs').ActionableReport}
 */
export function buildActionableReport(actions, probes) {
  /** @type {Record<string, number>} */
  const byType = {};
  let totalImpact = 0;
  for (const a of actions) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    totalImpact += a.impact;
  }

  return {
    version: '7.0.0',
    generated_at: new Date().toISOString(),
    actions,
    next_best_probes: probes,
    summary: {
      total_actions: actions.length,
      by_type: byType,
      estimated_coverage_gain: Math.min(totalImpact, 100),
    },
  };
}

/**
 * Render the actionable report as markdown.
 * @param {import('./types.mjs').ActionableReport} actionReport
 * @returns {string}
 */
export function renderActionsMarkdown(actionReport) {
  const lines = [];

  lines.push('## Action Queue');
  lines.push('');
  if (actionReport.actions.length === 0) {
    lines.push('No actions needed.');
  } else {
    lines.push('| # | Type | Priority | Risk | Effort | Rationale |');
    lines.push('|---|------|----------|------|--------|-----------|');
    for (let i = 0; i < actionReport.actions.length; i++) {
      const a = actionReport.actions[i];
      lines.push(`| ${i + 1} | ${a.type} | ${a.priority} | ${a.risk} | ${a.effort} | ${a.rationale} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Next Best Probes');
  lines.push('');
  if (actionReport.next_best_probes.length === 0) {
    lines.push('All triggers probed.');
  } else {
    lines.push('| # | Trigger | Route | Score | Risk | Reasons |');
    lines.push('|---|---------|-------|-------|------|---------|');
    for (let i = 0; i < actionReport.next_best_probes.length; i++) {
      const p = actionReport.next_best_probes[i];
      lines.push(`| ${i + 1} | ${p.label} | ${p.route} | ${p.score} | ${p.risk} | ${p.reasons.join('; ')} |`);
    }
  }
  lines.push('');

  const gain = actionReport.summary.estimated_coverage_gain;
  lines.push(`**${actionReport.summary.total_actions} actions, estimated +${gain}% coverage gain**`);
  lines.push('');

  return lines.join('\n');
}

// =============================================================================
// Render markdown
// =============================================================================

/**
 * Render a coverage report as markdown.
 * @param {import('./types.mjs').CoverageReport} report
 * @returns {string}
 */
export function renderCoverageMarkdown(report) {
  const lines = [];
  const s = report.summary;

  lines.push('# Runtime Coverage Report');
  lines.push('');

  // --- Coverage Summary ---
  lines.push('## Coverage Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Total triggers | ${s.total} |`);
  lines.push(`| Fully covered | ${s.fully_covered} |`);
  lines.push(`| Partial | ${s.partial} |`);
  lines.push(`| Untested | ${s.untested} |`);
  lines.push(`| Surprise | ${s.surprise} |`);
  lines.push(`| Coverage | ${s.coverage_percent}% |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Per-trigger matrix ---
  lines.push('## Per-Trigger Matrix');
  lines.push('');
  if (report.triggers.length === 0) {
    lines.push('No triggers found.');
  } else {
    lines.push('| Trigger | Route | Probed | Surface | Observed | Status | Effects |');
    lines.push('|---------|-------|--------|---------|----------|--------|---------|');
    for (const t of report.triggers) {
      const check = (/** @type {boolean} */ v) => v ? 'yes' : 'no';
      const effectStr = t.effects.length > 0 ? t.effects.join(', ') : '-';
      lines.push(`| ${t.label} | ${t.route} | ${check(t.probed)} | ${check(t.hasSurface)} | ${check(t.observed)} | ${t.status} | ${effectStr} |`);
    }
  }
  lines.push('');

  // --- Most Surprising (conditional) ---
  if (report.surprises.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Most Surprising');
    lines.push('');
    lines.push('| Trigger | Route | Reason |');
    lines.push('|---------|-------|--------|');
    for (const s of report.surprises) {
      lines.push(`| ${s.label} | ${s.route} | ${s.reason} |`);
    }
    lines.push('');
  }

  // --- Surprise Details V2 (conditional) ---
  if (report.surprises_v2 && report.surprises_v2.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Surprise Details');
    lines.push('');
    lines.push('| Trigger | Route | Category | Detail |');
    lines.push('|---------|-------|----------|--------|');
    for (const s of report.surprises_v2) {
      lines.push(`| ${s.label} | ${s.route} | ${s.category} | ${s.detail} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the runtime-coverage command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, withRuntime?: boolean, actions?: boolean, actionsTop?: number }} flags
 */
export async function runRuntimeCoverage(config, flags) {
  const cwd = process.cwd();

  const artifacts = loadCoverageArtifacts(config, cwd);

  if (!artifacts.graph) {
    fail('COVERAGE_NO_GRAPH', 'Trigger graph not found.', 'Run "ai-ui graph" first.');
  }

  if (flags.verbose) {
    console.log('Coverage: loaded artifacts');
    console.log(`  Graph: ${artifacts.graph.nodes.length} nodes, ${artifacts.graph.edges.length} edges`);
    if (artifacts.runtimeSummary) {
      console.log(`  Runtime: ${artifacts.runtimeSummary.triggers.length} triggers`);
    } else {
      console.log('  Runtime: not found (all triggers will show as untested)');
    }
    if (artifacts.probeEntries) {
      const probeTriggers = artifacts.probeEntries.filter(e => e.type === 'trigger').length;
      console.log(`  Probe: ${probeTriggers} triggers`);
    }
  }

  // If --with-runtime, re-augment graph first
  let graph = artifacts.graph;
  if (flags.withRuntime && artifacts.runtimeSummary) {
    const { augmentWithRuntime } = await import('./trigger-graph.mjs');
    graph = augmentWithRuntime(graph, artifacts.runtimeSummary);
    if (flags.verbose) {
      console.log(`  Augmented graph: v${graph.version}`);
    }
  }

  const report = computeCoverage(graph, artifacts.runtimeSummary, artifacts.probeEntries);

  // Write JSON
  const coveragePath = resolve(cwd, config.output.runtimeCoverage);
  mkdirSync(dirname(coveragePath), { recursive: true });
  writeFileSync(coveragePath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // Write markdown
  const reportPath = resolve(cwd, config.output.runtimeCoverageReport);
  let md = renderCoverageMarkdown(report);

  // Phase 7: Action queue
  if (flags.actions) {
    const surprisesV2 = report.surprises_v2 || classifySurprisesV2(graph, artifacts.runtimeSummary, artifacts.probeEntries);
    const actions = buildActionQueue(graph, report, surprisesV2, config.runtimeEffects.safe);
    const topN = flags.actionsTop || 20;
    const probes = scoreNextBestProbes(graph, report, config.runtimeEffects.safe, { topN });
    const actionReport = buildActionableReport(actions.slice(0, topN), probes);

    const actionsPath = coveragePath.replace('.json', '.actions.json');
    writeFileSync(actionsPath, JSON.stringify(actionReport, null, 2) + '\n', 'utf-8');

    md += '\n' + renderActionsMarkdown(actionReport);

    if (flags.verbose) {
      console.log(`  Actions: ${actionReport.summary.total_actions} (top ${topN}) → ${relative(cwd, actionsPath)}`);
      console.log(`  Next best probes: ${actionReport.next_best_probes.length}`);
      console.log(`  Estimated gain: +${actionReport.summary.estimated_coverage_gain}%`);
    }
  }

  writeFileSync(reportPath, md, 'utf-8');

  console.log(`Coverage: ${report.summary.total} triggers, ${report.summary.coverage_percent}% covered → ${relative(cwd, coveragePath)}`);
  if (flags.verbose) {
    console.log(`  Fully covered: ${report.summary.fully_covered}, Partial: ${report.summary.partial}, Untested: ${report.summary.untested}, Surprise: ${report.summary.surprise}`);
    console.log(`  Report: ${relative(cwd, reportPath)}`);
  }
}
