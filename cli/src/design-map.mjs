// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fail } from './config.mjs';
import { ADVANCED_WORDS } from './diagnostics.mjs';
import { loadReplayPack } from './replay-pack.mjs';
import { normalize, matchScore, stripBasePath, detectBasePath } from './normalize.mjs';
import { FEATURE_SECTIONS } from './markdown.mjs';

const VERSION = '1.0.0';
const DESTRUCTIVE_RE = /delete|remove|destroy|reset|logout|revoke|disable|unsubscribe/i;
const OVERFLOW_RE = /^(more\s*\.{0,3}|…|\.{3}|overflow|menu|\u2026)$/i;
const SAFE_EFFECT_KINDS = new Set(['navigate', 'filter', 'search']);
const GOAL_RE = /\/[^/]+\/[^/]+\/?$|docs|start|install|quickstart|get-started|guide|tutorial|\/run\b|\/session\b|\/results?\b/i;
const ARCHITECTURE_KEYWORDS = /\b(offline|local[- ]?only|persistence|accessible|accessibility|a11y|service[- ]?worker|cache|pwa|progressive|privacy|security|encryption|responsive|cross[- ]?platform)\b/i;
const GOAL_EFFECT_KINDS = new Set(['storageWrite', 'domEffect', 'fetch']);

// =============================================================================
// I/O boundary
// =============================================================================

/**
 * Load all artifacts needed for design-map.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {string} cwd
 * @param {{ replay?: string, verbose?: boolean }} flags
 * @returns {{ graph: import('./types.mjs').TriggerGraph, diff: any, coverage: import('./types.mjs').CoverageReport|null, atlas: any|null }}
 */
export function loadDesignMapInputs(config, cwd, flags) {
  let graph = null;
  let coverage = null;

  if (flags.replay) {
    const pack = loadReplayPack(resolve(cwd, flags.replay));
    if (pack.artifacts.graph) graph = pack.artifacts.graph;
    if (pack.artifacts.runtimeCoverage) coverage = pack.artifacts.runtimeCoverage;
  }

  // Graph — required
  if (!graph) {
    const graphPath = resolve(cwd, config.output.graph);
    if (!existsSync(graphPath)) {
      fail('DMAP_NO_GRAPH', 'trigger-graph.json not found', 'Run "ai-ui graph" first, or use --replay.');
    }
    graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
  }

  // Diff — required
  const diffPath = resolve(cwd, config.output.diff);
  if (!existsSync(diffPath)) {
    fail('DMAP_NO_DIFF', 'diff.json not found', 'Run "ai-ui diff" first.');
  }
  const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));

  // Coverage — optional
  if (!coverage) {
    const covPath = resolve(cwd, config.output.runtimeCoverage);
    if (existsSync(covPath)) {
      coverage = JSON.parse(readFileSync(covPath, 'utf-8'));
    }
  }

  // Atlas — optional
  let atlas = null;
  const atlasPath = resolve(cwd, config.output.atlas);
  if (existsSync(atlasPath)) {
    atlas = JSON.parse(readFileSync(atlasPath, 'utf-8'));
  }

  return { graph, diff, coverage, atlas };
}

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Classify a trigger into a location group.
 * @param {import('./types.mjs').GraphNode} triggerNode
 * @param {import('./types.mjs').GraphEdge[]} edges
 * @returns {import('./types.mjs').LocationGroup}
 */
export function classifyLocation(triggerNode, edges) {
  const meta = triggerNode.meta || {};
  const parentNav = !!meta.parent_nav;
  const depth = typeof meta.depth === 'number' ? meta.depth : 999;
  const label = triggerNode.label || '';
  const route = triggerNode.route || '';
  const selector = meta.selector || '';

  // 1. Primary nav
  if (parentNav && depth === 0) return 'primary_nav';

  // 2. Secondary nav
  if (parentNav && depth > 0) return 'secondary_nav';

  // 3. Overflow (before settings, since overflow buttons can be on any route)
  if (OVERFLOW_RE.test(label.trim())) return 'overflow';

  // 4. Settings
  if (route.includes('settings') || route.includes('preferences')) return 'settings';
  const labelWords = label.toLowerCase().split(/\s+/);
  if (labelWords.some(w => ADVANCED_WORDS.has(w)) && route !== '/') return 'settings';

  // 5. Modal — check if trigger produces a domEffect with modal
  const surfaceIds = edges.filter(e => e.from === triggerNode.id && e.type === 'maps_to').map(e => e.to);
  for (const sid of surfaceIds) {
    const effectEdges = edges.filter(e => e.from === sid && e.type === 'produces');
    for (const ee of effectEdges) {
      // Check if the effect node meta indicates modal
      // We don't have the node here, but we can check edge meta
      if (ee.meta && ee.meta.intent === 'modal') return 'modal';
    }
  }

  // 6. Toolbar
  if (depth === 0 && !parentNav && (meta.element === 'button' || meta.element === '[role=button]')) return 'toolbar';

  // 7. Footer
  if (selector.includes('footer') || route.includes('footer')) return 'footer';

  // 8. Default
  return 'inline';
}

/**
 * Classify trigger safety.
 * @param {import('./types.mjs').GraphNode} triggerNode
 * @param {import('./types.mjs').GraphEdge[]} edges
 * @param {import('./types.mjs').GraphNode[]} allNodes
 * @returns {'safe'|'destructive'|'unknown'}
 */
export function classifySafety(triggerNode, edges, allNodes) {
  const label = triggerNode.label || '';

  // 1. Destructive label
  if (DESTRUCTIVE_RE.test(label)) return 'destructive';

  // 2. Linked surface with destructive styleTokens
  const surfaceEdges = edges.filter(e => e.from === triggerNode.id && e.type === 'maps_to');
  for (const se of surfaceEdges) {
    const surfaceNode = allNodes.find(n => n.id === se.to);
    if (surfaceNode && surfaceNode.meta) {
      const tokens = surfaceNode.meta.styleTokens || [];
      if (tokens.includes('destructive') || tokens.includes('danger')) return 'destructive';
    }
  }

  // 3. Linked effect with delete kind
  const surfaceIds = surfaceEdges.map(e => e.to);
  const effectEdges = edges.filter(e => surfaceIds.includes(e.from) && (e.type === 'produces' || e.type === 'writes'));
  for (const ee of effectEdges) {
    const effectNode = allNodes.find(n => n.id === ee.to);
    if (effectNode && effectNode.meta && effectNode.meta.kind === 'delete') return 'destructive';
  }

  // 4. All linked effects are safe kinds
  if (effectEdges.length > 0) {
    const effectNodes = effectEdges.map(e => allNodes.find(n => n.id === e.to)).filter(Boolean);
    const allSafe = effectNodes.every(n => n.meta && SAFE_EFFECT_KINDS.has(n.meta.kind));
    if (allSafe) return 'safe';
  }

  // 5. No surface links but has safe navigates_to
  if (surfaceEdges.length === 0) {
    const navEdges = edges.filter(e => e.from === triggerNode.id && e.type === 'navigates_to');
    if (navEdges.length > 0) return 'safe';
  }

  return 'unknown';
}

/**
 * Compute discoverability score from burial index entry.
 * @param {{ depth: number, in_primary_nav: boolean, behind_overflow: boolean }} entry
 * @returns {number} 0.0 (visible) to 1.0 (hidden)
 */
export function computeDiscoverability(entry) {
  const depthScore = Math.min(entry.depth / 5, 1.0) * 0.4;
  const navScore = entry.in_primary_nav ? 0 : 0.3;
  const overflowScore = entry.behind_overflow ? 0.3 : 0;
  return Math.min(1.0, depthScore + navScore + overflowScore);
}

/**
 * Compute runtime confidence from coverage status.
 * @param {string} triggerId
 * @param {import('./types.mjs').CoverageReport|null} coverage
 * @returns {number} 0.0 to 1.0
 */
export function computeRuntimeConfidence(triggerId, coverage) {
  if (!coverage) return 0;
  const trig = coverage.triggers.find(t => t.trigger_id === triggerId);
  if (!trig) return 0;
  const map = { fully_covered: 1.0, partial: 0.5, untested: 0.0, surprise: 0.25 };
  return map[trig.status] ?? 0;
}

/**
 * Deduplicate nav entries by normalized label + first linked effect.
 * @param {import('./types.mjs').SurfaceInventoryEntry[]} entries
 * @param {number} totalRoutes
 * @returns {import('./types.mjs').SurfaceInventoryEntry[]}
 */
function deduplicateNavGroup(entries, totalRoutes) {
  /** @type {Map<string, import('./types.mjs').SurfaceInventoryEntry[]>} */
  const groups = new Map();
  for (const e of entries) {
    const key = normalize(e.label) + '|' + (e.linked_effects[0] || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  /** @type {import('./types.mjs').SurfaceInventoryEntry[]} */
  const deduped = [];
  for (const [, grouped] of groups) {
    // Use first occurrence (alphabetically by route) as representative
    grouped.sort((a, b) => a.route.localeCompare(b.route));
    const rep = { ...grouped[0] };
    rep.route_coverage = grouped.length;
    rep.coverage_percent = totalRoutes > 0 ? grouped.length / totalRoutes : 0;
    deduped.push(rep);
  }
  deduped.sort((a, b) => (b.coverage_percent || 0) - (a.coverage_percent || 0) || a.label.localeCompare(b.label));
  return deduped;
}

// =============================================================================
// Surface Inventory
// =============================================================================

/**
 * Build the surface inventory — every trigger grouped by location.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {any} diff
 * @param {import('./types.mjs').CoverageReport|null} coverage
 * @returns {import('./types.mjs').DesignSurfaceInventory}
 */
export function buildSurfaceInventory(graph, diff, coverage) {
  /** @type {Record<import('./types.mjs').LocationGroup, import('./types.mjs').SurfaceInventoryEntry[]>} */
  const groups = {
    primary_nav: [], secondary_nav: [], toolbar: [], overflow: [],
    settings: [], modal: [], inline: [], footer: [],
  };

  const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');

  for (const trig of triggerNodes) {
    const location = classifyLocation(trig, graph.edges);
    const safety = classifySafety(trig, graph.edges, graph.nodes);

    // Find linked triggers (the trigger itself)
    const linked_triggers = [trig.id];

    // Find linked effects via surface chain
    const surfaceIds = graph.edges
      .filter(e => e.from === trig.id && e.type === 'maps_to')
      .map(e => e.to);
    const linked_effects = graph.edges
      .filter(e => surfaceIds.includes(e.from) && (e.type === 'produces' || e.type === 'writes'))
      .map(e => e.to);

    // Also include effects from navigates_to
    const navEffects = graph.edges
      .filter(e => e.from === trig.id && e.type === 'navigates_to')
      .map(e => e.to);

    const role = surfaceIds.length > 0
      ? (graph.nodes.find(n => n.id === surfaceIds[0])?.meta?.role || trig.meta?.element || 'unknown')
      : (trig.meta?.element || 'unknown');

    groups[location].push({
      route: trig.route || '',
      label: trig.label,
      role,
      selector: trig.meta?.selector || null,
      location,
      safety,
      linked_triggers,
      linked_effects: [...new Set([...linked_effects, ...navEffects])],
      depth: trig.meta?.depth ?? 0,
    });
  }

  // Sort each group by route then label
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.route.localeCompare(b.route) || a.label.localeCompare(b.label));
  }

  // Compute total routes for deduplication
  const totalRoutes = new Set(graph.nodes.filter(n => n.type === 'route').map(n => n.id)).size;

  // Deduplicate nav groups
  const deduplicated = {
    primary_nav: deduplicateNavGroup(groups.primary_nav, totalRoutes),
    secondary_nav: deduplicateNavGroup(groups.secondary_nav, totalRoutes),
  };

  let total = 0;
  let destructive_count = 0;
  const by_location = {};
  const by_location_unique = {};
  for (const [loc, entries] of Object.entries(groups)) {
    by_location[loc] = entries.length;
    total += entries.length;
    destructive_count += entries.filter(e => e.safety === 'destructive').length;
    by_location_unique[loc] = (loc === 'primary_nav' || loc === 'secondary_nav')
      ? deduplicated[loc].length
      : entries.length;
  }

  const unique = Object.values(by_location_unique).reduce((s, n) => s + n, 0);

  return {
    version: VERSION,
    generated_at: new Date().toISOString(),
    groups,
    deduplicated,
    stats: { total, unique, by_location, by_location_unique, destructive_count, total_routes: totalRoutes },
  };
}

/**
 * Check if a documented-not-discoverable feature is grounded in a real UI capability.
 * @param {object} d - documented_not_discoverable entry from diff
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {any|null} atlas
 * @returns {{ grounded: boolean, reason: string }}
 */
function isGrounded(d, graph, atlas) {
  // Condition 1: Has at least one maps_to surface edge
  const featureNodeId = `feature:${d.feature_id}`;
  const hasSurfaceEdge = graph.edges.some(
    e => e.from === featureNodeId && e.type === 'maps_to'
  );
  if (hasSurfaceEdge) return { grounded: true, reason: 'Has surface match in graph' };

  // Condition 2: Feature name fuzzy-matches a trigger label (score > 0.3)
  const triggerLabels = graph.nodes
    .filter(n => n.type === 'trigger')
    .map(n => n.label);
  const bestScore = triggerLabels.reduce(
    (max, label) => Math.max(max, matchScore(d.feature_name, label)), 0
  );
  if (bestScore > 0.3) return { grounded: true, reason: `Trigger label match (score=${bestScore.toFixed(2)})` };

  // Condition 3: Source section is a FEATURE_SECTIONS member,
  // BUT NOT if the feature name looks like a sentence
  if (atlas) {
    const atlasFeature = atlas.features?.find(f => f.id === d.feature_id);
    if (atlasFeature) {
      const sections = atlasFeature.sources.map(s => (s.section || '').toLowerCase());
      const inFeatureSection = sections.some(sec =>
        FEATURE_SECTIONS.some(fs => sec.includes(fs))
      );
      if (inFeatureSection && !looksLikeSentence(d.feature_name)) {
        return { grounded: true, reason: 'In a feature section and not sentence-like' };
      }
    }
  }

  return { grounded: false, reason: 'Documented concept, not a UI capability' };
}

/**
 * Heuristic: does this string look like a prose instruction rather than a feature name?
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikeSentence(name) {
  const words = name.trim().split(/\s+/);
  if (words.length > 8) return true;
  const lower = name.toLowerCase();
  if (lower.startsWith('do not') || lower.startsWith("don't") || lower.startsWith('never')) return true;
  const imperativeStarters = ['use', 'add', 'set', 'make', 'ensure', 'avoid', 'keep', 'prefer', 'always', 'include'];
  if (imperativeStarters.some(v => lower.startsWith(v + ' ')) && words.length > 5) return true;
  return false;
}

/**
 * Check if a feature name describes an architectural capability (no UI surface expected).
 * @param {string} name
 * @returns {boolean}
 */
export function isArchitecturalCapability(name) {
  return ARCHITECTURE_KEYWORDS.test(name);
}

// =============================================================================
// Feature Map
// =============================================================================

/**
 * Build the feature map — clusters of triggers/effects into capabilities.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {any} diff
 * @param {import('./types.mjs').CoverageReport|null} coverage
 * @param {any|null} atlas
 * @returns {import('./types.mjs').DesignFeatureMap}
 */
export function buildFeatureMap(graph, diff, coverage, atlas) {
  /** @type {import('./types.mjs').FeatureMapEntry[]} */
  const features = [];

  // Build burial index lookup
  const burialMap = new Map();
  for (const b of (diff.burial_index || [])) {
    burialMap.set(`${b.trigger_label}|${b.route}`, b);
  }

  // 1. Atlas-matched features
  for (const m of (diff.matched || [])) {
    const burial = burialMap.get(`${m.trigger_label}|${m.trigger_route}`);
    const discoverability = burial ? computeDiscoverability(burial) : 0.5;
    const triggerId = `trigger:${m.trigger_route}|${m.trigger_label}`;
    const confidence = computeRuntimeConfidence(triggerId, coverage);

    // Find entry points (surfaces linked to the matched trigger)
    const surfaceEdges = graph.edges.filter(e => e.from === triggerId && e.type === 'maps_to');
    const entryPoints = surfaceEdges.length > 0
      ? surfaceEdges.map(e => {
          const node = graph.nodes.find(n => n.id === e.to);
          return node ? node.label : e.to;
        })
      : [m.trigger_label];

    // Click depth from root routes
    const clickDepth = {};
    if (burial) {
      clickDepth[m.trigger_route] = burial.depth;
    }

    // Recommended action
    let action = 'keep';
    let rationale = 'Feature is documented and discoverable';
    if (discoverability > 0.7) {
      action = 'promote';
      rationale = `Documented feature buried at depth ${burial?.depth ?? '?'}, not easily discoverable`;
    } else if (m.confidence < 0.5) {
      action = 'rename';
      rationale = `Low match confidence (${m.confidence}), label may not align with docs`;
    }

    features.push({
      feature_id: m.feature_id,
      feature_name: m.feature_name,
      entry_points: entryPoints,
      click_depth: clickDepth,
      discoverability,
      runtime_confidence: confidence,
      recommended_action: action,
      rationale,
      from_atlas: true,
    });
  }

  // 2. Documented-not-discoverable features → promote (if grounded) or skip
  for (const d of (diff.documented_not_discoverable || [])) {
    const { grounded, reason: groundReason } = isGrounded(d, graph, atlas);
    features.push({
      feature_id: d.feature_id,
      feature_name: d.feature_name,
      entry_points: [],
      click_depth: {},
      discoverability: 1.0,
      runtime_confidence: 0,
      recommended_action: grounded ? 'promote' : 'skip',
      rationale: grounded
        ? `Documented in ${(d.sources || []).join(', ')} but has no UI surface`
        : groundReason,
      from_atlas: true,
    });
  }

  // 3. Auto-cluster unmatched triggers by route
  const clustersByRoute = new Map();
  for (const d of (diff.discoverable_not_documented || [])) {
    const route = d.trigger_route || '/';
    if (!clustersByRoute.has(route)) clustersByRoute.set(route, []);
    clustersByRoute.get(route).push(d);
  }

  for (const [route, triggers] of clustersByRoute) {
    const triggerLabels = triggers.map(t => t.trigger_label);
    const featureId = `auto:${route}:${triggerLabels.join('+')}`;
    const featureName = triggerLabels.length === 1
      ? triggerLabels[0]
      : `${route} actions (${triggerLabels.join(', ')})`;

    // Compute average discoverability
    let avgDisc = 0.5;
    const burials = triggers.map(t => burialMap.get(`${t.trigger_label}|${t.trigger_route}`)).filter(Boolean);
    if (burials.length > 0) {
      avgDisc = burials.reduce((s, b) => s + computeDiscoverability(b), 0) / burials.length;
    }

    // Average confidence
    let avgConf = 0;
    if (coverage) {
      const confs = triggers.map(t => {
        const tid = `trigger:${t.trigger_route}|${t.trigger_label}`;
        return computeRuntimeConfidence(tid, coverage);
      });
      avgConf = confs.reduce((s, c) => s + c, 0) / confs.length;
    }

    // Action: demote if prominent but undocumented
    let action = 'keep';
    let rationale = 'Undocumented trigger cluster on this route';
    if (avgDisc < 0.2 && triggerLabels.length === 1) {
      action = 'demote';
      rationale = 'Prominent but undocumented — consider moving to settings or documenting';
    } else if (triggerLabels.length > 1) {
      action = 'merge';
      rationale = `${triggerLabels.length} related triggers could be consolidated`;
    }

    features.push({
      feature_id: featureId,
      feature_name: featureName,
      entry_points: triggerLabels,
      click_depth: Object.fromEntries(burials.map(b => [b.route, b.depth])),
      discoverability: avgDisc,
      runtime_confidence: avgConf,
      recommended_action: action,
      rationale,
      from_atlas: false,
    });
  }

  // Sort: atlas features first (alphabetical), then auto-clustered
  features.sort((a, b) => {
    if (a.from_atlas !== b.from_atlas) return a.from_atlas ? -1 : 1;
    return a.feature_id.localeCompare(b.feature_id);
  });

  const fromAtlas = features.filter(f => f.from_atlas).length;
  const autoClustered = features.length - fromAtlas;
  const promoteCount = features.filter(f => f.recommended_action === 'promote').length;
  const demoteCount = features.filter(f => f.recommended_action === 'demote').length;
  const ungroundedCount = features.filter(f => f.recommended_action === 'skip').length;

  return {
    version: VERSION,
    generated_at: new Date().toISOString(),
    features,
    stats: {
      total: features.length,
      from_atlas: fromAtlas,
      auto_clustered: autoClustered,
      promote_count: promoteCount,
      demote_count: demoteCount,
      ungrounded_count: ungroundedCount,
    },
  };
}

// =============================================================================
// Task Flows
// =============================================================================

/**
 * Infer task flows from navigation chains in the graph.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').CoverageReport|null} coverage
 * @param {string} basePath
 * @param {string[]} goalRoutes
 * @param {import('./types.mjs').GoalRule[]} goalRules
 * @returns {import('./types.mjs').TaskFlow[]}
 */
export function inferTaskFlows(graph, coverage, basePath = '', goalRoutes = [], goalRules = []) {
  // Build adjacency: route → triggers, trigger → navigates_to route
  const routeTriggers = new Map();
  const triggerNavTo = new Map();

  for (const e of graph.edges) {
    if (e.type === 'contains') {
      if (!routeTriggers.has(e.from)) routeTriggers.set(e.from, []);
      routeTriggers.get(e.from).push(e.to);
    }
    if (e.type === 'navigates_to') {
      triggerNavTo.set(e.from, e.to);
    }
  }

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  // Hub detection: a route is a "hub" if its NON-NAV triggers navigate to 5+ distinct routes
  // Skip parent_nav triggers — persistent nav links don't make a page a hub
  const hubRoutes = new Set();
  for (const [routeId, triggerIds] of routeTriggers) {
    const outRoutes = new Set();
    for (const tid of triggerIds) {
      const trigNode = nodeMap.get(tid);
      if (trigNode?.meta?.parent_nav) continue;
      if (triggerNavTo.has(tid)) outRoutes.add(triggerNavTo.get(tid));
    }
    if (outRoutes.size >= 5) hubRoutes.add(routeId.replace('route:', ''));
  }

  const flows = [];

  // Find all triggers that navigate somewhere — each is a potential flow start
  for (const [triggerId, targetRouteId] of triggerNavTo) {
    const startNode = nodeMap.get(triggerId);
    if (!startNode) continue;

    /** @type {import('./types.mjs').TaskFlowStep[]} */
    const steps = [];
    const visitedRoutes = new Set();
    let hasDeadEnd = false;
    let hasLoop = false;
    let hasDestructive = false;

    // First step: the starting trigger
    const startEffects = getEffectKinds(triggerId, graph);
    const startDestructive = DESTRUCTIVE_RE.test(startNode.label);
    if (startDestructive) hasDestructive = true;

    steps.push({
      trigger_label: startNode.label,
      route: startNode.route || '',
      step_type: 'navigate',
      effects: startEffects,
      is_destructive: startDestructive,
    });

    // Follow the chain
    let currentRoute = targetRouteId;
    visitedRoutes.add(startNode.route || '');

    const MAX_STEPS = 10;
    while (currentRoute && steps.length < MAX_STEPS) {
      const routeLabel = currentRoute.replace('route:', '');

      if (visitedRoutes.has(routeLabel)) {
        hasLoop = true;
        break;
      }
      visitedRoutes.add(routeLabel);

      // Find triggers on this route that navigate further
      const triggersOnRoute = routeTriggers.get(currentRoute) || [];
      let nextTrigger = null;
      let nextRoute = null;

      for (const tid of triggersOnRoute) {
        if (triggerNavTo.has(tid)) {
          nextTrigger = nodeMap.get(tid);
          nextRoute = triggerNavTo.get(tid);
          break;
        }
      }

      if (nextTrigger) {
        const effects = getEffectKinds(nextTrigger.id, graph);
        const destructive = DESTRUCTIVE_RE.test(nextTrigger.label);
        if (destructive) hasDestructive = true;

        steps.push({
          trigger_label: nextTrigger.label,
          route: routeLabel,
          step_type: 'navigate',
          effects,
          is_destructive: destructive,
        });
        currentRoute = nextRoute;
      } else {
        // Dead end — route has triggers but none navigate further
        if (triggersOnRoute.length > 0) {
          const deadTrig = nodeMap.get(triggersOnRoute[0]);
          if (deadTrig) {
            const effects = getEffectKinds(deadTrig.id, graph);
            const destructive = DESTRUCTIVE_RE.test(deadTrig.label);
            if (destructive) hasDestructive = true;

            steps.push({
              trigger_label: deadTrig.label,
              route: routeLabel,
              step_type: 'dead_end',
              effects,
              is_destructive: destructive,
            });
          }
        }
        hasDeadEnd = true;
        break;
      }
    }

    // Only include flows with at least 2 steps (a single trigger isn't a flow)
    if (steps.length >= 2 || hasDeadEnd) {
      // Classify loop type
      let loopType = null;
      if (hasLoop) {
        // Check if ALL steps use parent_nav triggers → nav_loop
        const allNav = steps.every(s => {
          const trigKey = `trigger:${s.route}|${s.trigger_label}`;
          const trigNode = nodeMap.get(trigKey);
          return trigNode?.meta?.parent_nav;
        });
        if (allNav) {
          loopType = 'nav_loop';
        } else {
          const touchesHub = [...visitedRoutes].some(r => hubRoutes.has(r));
          loopType = touchesHub ? 'browse_loop' : 'circular';
        }
      }

      // --- Goal detection (three tiers) ---

      // Evaluate goal rules per step (Stage 0E)
      const runtimePresent = hasRuntimeEvidence(graph);
      if (goalRules.length > 0) {
        for (const step of steps) {
          const trigKey = `trigger:${step.route}|${step.trigger_label}`;
          step.goals_hit = evaluateGoalRules(trigKey, graph, goalRules, runtimePresent);
        }
      }

      // Tier 1: Route-based goal (unchanged)
      const goalRouteSet = new Set(goalRoutes);
      const routeGoal = steps.some(s => {
        const r = stripBasePath(s.route, basePath);
        return GOAL_RE.test(r) || goalRouteSet.has(r);
      }) || [...visitedRoutes].some(r => {
        const sr = stripBasePath(r, basePath);
        return GOAL_RE.test(sr) || goalRouteSet.has(sr);
      });

      // Tier 2: GoalRule-based — any step has goals_hit > 0
      const ruleGoalHits = steps.flatMap(s => s.goals_hit || []);
      const ruleGoal = ruleGoalHits.length > 0;

      // Tier 3: Legacy effect-based (fallback when NO goalRules configured)
      const effectGoal = !routeGoal && !ruleGoal && goalRules.length === 0 && steps.some(s => {
        const trigKey = `trigger:${s.route}|${s.trigger_label}`;
        const observed = getObservedEffectDetails(trigKey, graph);
        return observed.length > 0;
      });

      /** @type {import('./types.mjs').TaskFlow} */
      const flow = {
        task_name: `${startNode.label} flow`,
        steps,
        has_dead_end: hasDeadEnd,
        has_loop: hasLoop,
        loop_type: loopType,
        goal_reached: routeGoal || ruleGoal || effectGoal,
        has_destructive_step: hasDestructive,
        total_depth: steps.length,
      };

      // Stage 0E: aggregate goals per flow
      if (ruleGoalHits.length > 0) {
        flow.goals_reached = deduplicateGoalHits(ruleGoalHits);
        flow.goal_score_total = flow.goals_reached.reduce((sum, h) => sum + h.score, 0);
      }

      flows.push(flow);
    }
  }

  // --- Action flows: non-navigating triggers with goal hits ---
  // Triggers that don't navigate (dialogs, toggles, saves) won't appear in
  // navigation flows. Evaluate goal rules for them and create single-step
  // "action" flows so goals are visible in the design map.
  if (goalRules.length > 0) {
    const runtimePresent = hasRuntimeEvidence(graph);
    const navigatingTriggers = new Set(triggerNavTo.keys());
    const flowTriggerLabels = new Set(flows.flatMap(f => f.steps.map(s => `${s.route}|${s.trigger_label}`)));

    for (const node of graph.nodes) {
      if (node.type !== 'trigger') continue;
      if (navigatingTriggers.has(node.id)) continue;

      const trigKey = node.id; // "trigger:<route>|<label>"
      const routeLabel = node.route || node.id.replace(/^trigger:/, '').split('|')[0];
      const label = node.label || node.id.split('|').pop();

      // Skip if this trigger already appears in a flow step
      if (flowTriggerLabels.has(`${routeLabel}|${label}`)) continue;

      const hits = evaluateGoalRules(trigKey, graph, goalRules, runtimePresent);
      if (hits.length === 0) continue;

      const effects = getEffectKinds(trigKey, graph);
      /** @type {import('./types.mjs').TaskFlowStep} */
      const step = {
        trigger_label: label,
        route: routeLabel,
        step_type: 'action',
        effects,
        is_destructive: DESTRUCTIVE_RE.test(label),
        goals_hit: hits,
      };

      /** @type {import('./types.mjs').TaskFlow} */
      const flow = {
        task_name: `Action: ${label}`,
        entry_trigger: label,
        total_depth: 1,
        steps: [step],
        goal_reached: true,
        goals_reached: deduplicateGoalHits(hits),
        goal_score_total: hits.reduce((sum, h) => sum + h.score, 0),
      };

      flows.push(flow);
    }
  }

  // Split: action flows with goals go first, then nav flows sorted by depth
  const actionWithGoals = flows.filter(f => f.goals_reached?.length > 0);
  const navFlows = flows.filter(f => !(f.goals_reached?.length > 0));
  navFlows.sort((a, b) => b.total_depth - a.total_depth || a.task_name.localeCompare(b.task_name));

  // Cap nav flows at 15, then prepend action flows (uncapped)
  return [...actionWithGoals, ...navFlows.slice(0, 15)];
}

/**
 * Get effect kinds for a trigger via its surface chain.
 * @param {string} triggerId
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {string[]}
 */
function getEffectKinds(triggerId, graph) {
  const surfaceIds = graph.edges
    .filter(e => e.from === triggerId && e.type === 'maps_to')
    .map(e => e.to);
  const effectIds = graph.edges
    .filter(e => surfaceIds.includes(e.from) && (e.type === 'produces' || e.type === 'writes'))
    .map(e => e.to);
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  return [...new Set(effectIds.map(id => nodeMap.get(id)?.meta?.kind).filter(Boolean))];
}

/**
 * Get observed runtime effect nodes for a trigger (SPA goal detection).
 * Follows trigger → maps_to → produces/writes → effect, plus runtime_observed edges.
 * @param {string} triggerId
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {import('./types.mjs').GraphNode[]}
 */
export function getObservedEffectDetails(triggerId, graph) {
  const surfaceIds = graph.edges
    .filter(e => e.from === triggerId && e.type === 'maps_to')
    .map(e => e.to);
  const effectIds = graph.edges
    .filter(e => surfaceIds.includes(e.from) && (e.type === 'produces' || e.type === 'writes'))
    .map(e => e.to);
  // Also check runtime_observed edges directly from trigger
  const runtimeIds = graph.edges
    .filter(e => e.from === triggerId && e.type === 'runtime_observed')
    .map(e => e.to);

  const allIds = [...new Set([...effectIds, ...runtimeIds])];
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  return allIds
    .map(id => nodeMap.get(id))
    .filter(n => n && n.meta?.observed && GOAL_EFFECT_KINDS.has(n.meta?.kind));
}

// =============================================================================
// Goal Rule Evaluation (Stage 0E)
// =============================================================================

/**
 * Check if the graph contains ANY runtime evidence at all.
 * Used to distinguish "no goals reached" from "unknown (no runtime data)".
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {boolean}
 */
export function hasRuntimeEvidence(graph) {
  return graph.nodes.some(n => n.type === 'effect' && n.meta?.observed === true);
}

/**
 * Get ALL effect nodes for a trigger (observed or not).
 * Used for "unknown" confidence when runtime data is absent.
 * @param {string} triggerId
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {import('./types.mjs').GraphNode[]}
 */
function getAllEffectNodes(triggerId, graph) {
  const surfaceIds = graph.edges
    .filter(e => e.from === triggerId && e.type === 'maps_to')
    .map(e => e.to);
  const effectIds = graph.edges
    .filter(e => surfaceIds.includes(e.from) && (e.type === 'produces' || e.type === 'writes'))
    .map(e => e.to);
  const runtimeIds = graph.edges
    .filter(e => e.from === triggerId && e.type === 'runtime_observed')
    .map(e => e.to);
  const allIds = [...new Set([...effectIds, ...runtimeIds])];
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  return allIds.map(id => nodeMap.get(id)).filter(n => n && GOAL_EFFECT_KINDS.has(n.meta?.kind));
}

/**
 * @typedef {{ matched: boolean, summary?: string, confidence?: 'observed'|'unknown' }} MatchResult
 */

/**
 * Match a storageWrite rule against effect nodes.
 * @param {{ keyRegex?: string, valueRegex?: string }} config
 * @param {import('./types.mjs').GraphNode[]} observed
 * @param {import('./types.mjs').GraphNode[]} all
 * @param {boolean} runtimePresent
 * @param {boolean} requiresObserved
 * @returns {MatchResult}
 */
function matchStorageRule(config, observed, all, runtimePresent, requiresObserved) {
  const candidates = requiresObserved ? observed : all;
  const storageNodes = candidates.filter(n => n.meta?.kind === 'storageWrite');

  for (const n of storageNodes) {
    const resolvedKey = resolveStorageKey(n);
    const keyMatch = !config.keyRegex || (resolvedKey && new RegExp(config.keyRegex, 'i').test(resolvedKey));
    const valMatch = !config.valueRegex || (n.meta?.value && new RegExp(config.valueRegex, 'i').test(n.meta.value));
    if (keyMatch && valMatch) {
      return {
        matched: true,
        summary: `storageWrite: ${resolvedKey || '(key)'}`,
        confidence: n.meta?.observed ? 'observed' : 'unknown',
      };
    }
  }

  // If no runtime evidence, check unobserved nodes for structural match → unknown
  if (!runtimePresent && requiresObserved) {
    const unobserved = all.filter(n => n.meta?.kind === 'storageWrite' && !n.meta?.observed);
    for (const n of unobserved) {
      const resolvedKey = resolveStorageKey(n);
      const keyMatch = !config.keyRegex || (resolvedKey && new RegExp(config.keyRegex, 'i').test(resolvedKey));
      const valMatch = !config.valueRegex || (n.meta?.value && new RegExp(config.valueRegex, 'i').test(n.meta.value));
      if (keyMatch && valMatch) {
        return { matched: true, summary: `storageWrite: ${resolvedKey || '(key)'} (unverified)`, confidence: 'unknown' };
      }
    }
  }

  return { matched: false };
}

/**
 * Resolve the storage key from a graph node.
 * Checks: meta.key → evidence[].key (strips prefix) → node ID (strips prefix).
 * @param {import('./types.mjs').GraphNode} n
 * @returns {string|undefined}
 */
function resolveStorageKey(n) {
  if (n.meta?.key) return n.meta.key;
  // evidence[].key format: "storageWrite:local:actualKey"
  const evKey = n.meta?.evidence?.[0]?.key;
  if (evKey) {
    const stripped = evKey.replace(/^storageWrite:(local|session):/, '');
    if (stripped !== evKey) return stripped;
    return evKey;
  }
  // node ID format: "effect:stateWrite:actualKey"
  if (n.id?.startsWith('effect:stateWrite:')) return n.id.slice('effect:stateWrite:'.length);
  return undefined;
}

/**
 * Match a fetch rule against effect nodes.
 * @param {{ method?: string[], urlRegex?: string, status?: number[] }} config
 * @param {import('./types.mjs').GraphNode[]} observed
 * @param {import('./types.mjs').GraphNode[]} all
 * @param {boolean} runtimePresent
 * @param {boolean} requiresObserved
 * @returns {MatchResult}
 */
function matchFetchRule(config, observed, all, runtimePresent, requiresObserved) {
  const candidates = requiresObserved ? observed : all;
  const fetchNodes = candidates.filter(n => n.meta?.kind === 'fetch');

  for (const n of fetchNodes) {
    const methodMatch = !config.method || config.method.includes(n.meta?.method);
    const urlMatch = !config.urlRegex || (n.meta?.url && new RegExp(config.urlRegex, 'i').test(n.meta.url));
    const statusMatch = !config.status || config.status.includes(n.meta?.status);
    if (methodMatch && urlMatch && statusMatch) {
      return {
        matched: true,
        summary: `fetch: ${n.meta?.method || ''} ${n.meta?.url || '(url)'}`,
        confidence: n.meta?.observed ? 'observed' : 'unknown',
      };
    }
  }

  if (!runtimePresent && requiresObserved) {
    const unobserved = all.filter(n => n.meta?.kind === 'fetch' && !n.meta?.observed);
    for (const n of unobserved) {
      const methodMatch = !config.method || config.method.includes(n.meta?.method);
      const urlMatch = !config.urlRegex || (n.meta?.url && new RegExp(config.urlRegex, 'i').test(n.meta.url));
      if (methodMatch && urlMatch) {
        return { matched: true, summary: `fetch: ${n.meta?.method || ''} ${n.meta?.url || '(url)'} (unverified)`, confidence: 'unknown' };
      }
    }
  }

  return { matched: false };
}

/**
 * Match a domEffect rule against effect nodes.
 * @param {{ selector?: string, textRegex?: string, goalId?: string }} config
 * @param {import('./types.mjs').GraphNode[]} observed
 * @param {import('./types.mjs').GraphNode[]} all
 * @param {boolean} runtimePresent
 * @param {boolean} requiresObserved
 * @returns {MatchResult}
 */
function matchDomRule(config, observed, all, runtimePresent, requiresObserved, triggerLabel = '') {
  const candidates = requiresObserved ? observed : all;
  const domNodes = candidates.filter(n => n.meta?.kind === 'domEffect');

  for (const n of domNodes) {
    // Direct goalId match (from data-aiui-goal attribute)
    if (config.goalId && n.meta?.goalId && n.meta.goalId === config.goalId) {
      return { matched: true, summary: `goalId: ${n.meta.goalId}`, confidence: n.meta?.observed ? 'observed' : 'unknown' };
    }
    // textRegex match against detail, node label, trigger label, or meta.text
    if (config.textRegex) {
      const textTargets = [n.meta?.detail, n.label, n.meta?.text, triggerLabel].filter(Boolean);
      for (const target of textTargets) {
        if (new RegExp(config.textRegex, 'i').test(target)) {
          return { matched: true, summary: `domEffect: ${target}`, confidence: n.meta?.observed ? 'observed' : 'unknown' };
        }
      }
    }
    // selector match
    if (config.selector && n.meta?.selector) {
      if (n.meta.selector.includes(config.selector)) {
        return { matched: true, summary: `selector: ${config.selector}`, confidence: n.meta?.observed ? 'observed' : 'unknown' };
      }
    }
  }

  if (!runtimePresent && requiresObserved) {
    const unobserved = all.filter(n => n.meta?.kind === 'domEffect' && !n.meta?.observed);
    for (const n of unobserved) {
      if (config.goalId && n.meta?.goalId && n.meta.goalId === config.goalId) {
        return { matched: true, summary: `goalId: ${n.meta.goalId} (unverified)`, confidence: 'unknown' };
      }
      if (config.textRegex) {
        const textTargets = [n.meta?.detail, n.label, n.meta?.text].filter(Boolean);
        for (const target of textTargets) {
          if (new RegExp(config.textRegex, 'i').test(target)) {
            return { matched: true, summary: `domEffect: ${target} (unverified)`, confidence: 'unknown' };
          }
        }
      }
    }
  }

  return { matched: false };
}

/**
 * Evaluate goal rules against a trigger's observed effects.
 * @param {string} triggerId
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').GoalRule[]} goalRules
 * @param {boolean} runtimePresent - true if graph has ANY runtime evidence
 * @returns {import('./types.mjs').GoalHit[]}
 */
export function evaluateGoalRules(triggerId, graph, goalRules, runtimePresent) {
  if (goalRules.length === 0) return [];

  const observed = getObservedEffectDetails(triggerId, graph);
  const all = getAllEffectNodes(triggerId, graph);

  // Resolve trigger label for domEffect textRegex matching
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const triggerNode = nodeMap.get(triggerId);
  const triggerLabel = triggerNode?.label || '';

  /** @type {import('./types.mjs').GoalHit[]} */
  const hits = [];

  for (const rule of goalRules) {
    const requiresObserved = rule.requiresObserved !== false;
    const score = rule.score ?? 1;

    if (rule.kind === 'composite') {
      /** @type {MatchResult[]} */
      const subResults = [];
      if (rule.storage) subResults.push(matchStorageRule(rule.storage, observed, all, runtimePresent, requiresObserved));
      if (rule.fetch) subResults.push(matchFetchRule(rule.fetch, observed, all, runtimePresent, requiresObserved));
      if (rule.dom) subResults.push(matchDomRule(rule.dom, observed, all, runtimePresent, requiresObserved, triggerLabel));

      if (subResults.length === 0) continue;
      // ALL sub-predicates must match (AND logic)
      if (subResults.every(r => r.matched)) {
        hits.push({
          rule_id: rule.id,
          rule_label: rule.label,
          score,
          evidence_summary: subResults.map(r => r.summary).join(' + '),
          confidence: subResults.some(r => r.confidence === 'unknown') ? 'unknown' : 'observed',
        });
      }
    } else {
      // Single-kind rule — dispatch by kind
      /** @type {MatchResult} */
      let result = { matched: false };
      if (rule.kind === 'storageWrite' && rule.storage) {
        result = matchStorageRule(rule.storage, observed, all, runtimePresent, requiresObserved);
      } else if (rule.kind === 'fetch' && rule.fetch) {
        result = matchFetchRule(rule.fetch, observed, all, runtimePresent, requiresObserved);
      } else if (rule.kind === 'domEffect' && rule.dom) {
        result = matchDomRule(rule.dom, observed, all, runtimePresent, requiresObserved, triggerLabel);
      }

      if (result.matched) {
        hits.push({
          rule_id: rule.id,
          rule_label: rule.label,
          score,
          evidence_summary: result.summary || '',
          confidence: result.confidence || 'unknown',
        });
      }
    }
  }

  return hits;
}

/**
 * Deduplicate GoalHits by rule_id, keeping highest score.
 * @param {import('./types.mjs').GoalHit[]} hits
 * @returns {import('./types.mjs').GoalHit[]}
 */
export function deduplicateGoalHits(hits) {
  /** @type {Map<string, import('./types.mjs').GoalHit>} */
  const best = new Map();
  for (const h of hits) {
    const existing = best.get(h.rule_id);
    if (!existing || h.score > existing.score) {
      best.set(h.rule_id, h);
    }
  }
  return [...best.values()];
}

// =============================================================================
// IA Proposal
// =============================================================================

/**
 * Propose an information architecture based on inventory and feature map.
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').DesignFeatureMap} featureMap
 * @param {import('./types.mjs').TaskFlow[]} taskFlows
 * @returns {import('./types.mjs').DesignIAProposal}
 */
export function proposeIA(inventory, featureMap, taskFlows) {
  /** @type {import('./types.mjs').IAProposalItem[]} */
  const primaryNav = [];
  /** @type {import('./types.mjs').IAProposalItem[]} */
  const secondaryNav = [];
  /** @type {import('./types.mjs').IAProposalItem[]} */
  const mustSurface = [];
  /** @type {import('./types.mjs').IAProposalItem[]} */
  const documentedNonSurface = [];
  /** @type {import('./types.mjs').IAProposalItem[]} */
  const demoteToAdvanced = [];
  /** @type {string[]} */
  const groupingNotes = [];

  // Primary nav: high-visibility, high-confidence atlas features (cap at 7)
  const primaryCandidates = featureMap.features
    .filter(f => f.from_atlas && f.discoverability < 0.3 && f.recommended_action !== 'demote')
    .sort((a, b) => a.discoverability - b.discoverability);

  for (const f of primaryCandidates.slice(0, 7)) {
    const route = Object.keys(f.click_depth)[0] || '/';
    primaryNav.push({
      label: f.feature_name,
      route,
      reason: `Documented, visible (disc=${f.discoverability.toFixed(2)}), confidence=${f.runtime_confidence.toFixed(2)}`,
    });
  }

  // Fallback: when atlas yields 0 primary nav candidates, use site structure
  if (primaryNav.length === 0 && inventory.deduplicated?.primary_nav?.length > 0) {
    const deduped = inventory.deduplicated.primary_nav;
    for (const entry of deduped.slice(0, 7)) {
      primaryNav.push({
        label: entry.label,
        route: entry.route,
        reason: `Site structure (${(entry.coverage_percent * 100).toFixed(0)}% route coverage)`,
      });
    }
    groupingNotes.push('Primary nav derived from site structure (no atlas candidates met threshold)');
  }

  // Must-surface: features recommended for promotion, split from architectural capabilities
  for (const f of featureMap.features.filter(f => f.recommended_action === 'promote')) {
    const route = Object.keys(f.click_depth)[0] || '/';
    if (isArchitecturalCapability(f.feature_name)) {
      documentedNonSurface.push({
        label: f.feature_name,
        route,
        reason: `${f.rationale} — architectural capability, no UI surface expected`,
      });
    } else {
      mustSurface.push({
        label: f.feature_name,
        route,
        reason: f.rationale,
      });
    }
  }

  // Demote to advanced: undocumented prominent items, or ADVANCED_WORDS matches from inventory
  for (const f of featureMap.features.filter(f => f.recommended_action === 'demote')) {
    const route = Object.keys(f.click_depth)[0] || '/';
    demoteToAdvanced.push({
      label: f.feature_name,
      route,
      reason: f.rationale,
    });
  }

  // Also check inventory for settings-classified items that are currently in primary_nav
  for (const entry of inventory.groups.settings || []) {
    if (!demoteToAdvanced.find(d => d.label === entry.label)) {
      demoteToAdvanced.push({
        label: entry.label,
        route: entry.route,
        reason: 'Classified as settings/advanced based on label',
      });
    }
  }

  // Secondary nav: features that aren't primary and aren't demoted
  for (const f of featureMap.features.filter(f =>
    f.from_atlas &&
    f.discoverability >= 0.3 && f.discoverability < 0.7 &&
    f.recommended_action === 'keep'
  )) {
    const route = Object.keys(f.click_depth)[0] || '/';
    secondaryNav.push({
      label: f.feature_name,
      route,
      reason: `Mid-range discoverability (${f.discoverability.toFixed(2)})`,
    });
  }

  // Grouping notes
  const deadEndFlows = taskFlows.filter(f => f.has_dead_end);
  if (deadEndFlows.length > 0) {
    groupingNotes.push(`${deadEndFlows.length} task flow(s) end in dead ends — consider adding back-navigation`);
  }

  const browseLoops = taskFlows.filter(f => f.loop_type === 'browse_loop');
  const circularLoops = taskFlows.filter(f => f.loop_type === 'circular');
  const navLoops = taskFlows.filter(f => f.loop_type === 'nav_loop');
  if (browseLoops.length > 0) {
    groupingNotes.push(`${browseLoops.length} browse loop(s) through hub pages — normal for catalog sites`);
  }
  if (circularLoops.length > 0) {
    groupingNotes.push(`${circularLoops.length} circular navigation loop(s) — review for UX issues`);
  }
  if (navLoops.length > 0) {
    groupingNotes.push(`${navLoops.length} nav loop(s) from persistent navigation — expected in SPAs`);
  }

  const destructiveCount = inventory.stats.destructive_count;
  if (destructiveCount > 0) {
    groupingNotes.push(`${destructiveCount} destructive action(s) found — ensure confirmation UX`);
  }

  const mergeFeatures = featureMap.features.filter(f => f.recommended_action === 'merge');
  if (mergeFeatures.length > 0) {
    groupingNotes.push(`${mergeFeatures.length} feature cluster(s) could be consolidated`);
  }

  // Build conversion paths: for each primary nav item, find task flows that start
  // from that label and reach a goal
  /** @type {import('./types.mjs').IAConversionPath[]} */
  const conversionPaths = [];
  for (const navItem of primaryNav) {
    const labelLower = navItem.label.toLowerCase();
    const matchingFlows = taskFlows.filter(f =>
      f.steps.length > 0 && f.steps[0].trigger_label.toLowerCase() === labelLower
    );
    const goalFlows = matchingFlows.filter(f => f.goal_reached);
    // Stage 0E: collect distinct goals across matching flows
    const flowGoalHits = goalFlows.flatMap(f => f.goals_reached || []);
    const distinctGoals = deduplicateGoalHits(flowGoalHits);
    const bestScore = goalFlows.reduce((max, f) => Math.max(max, f.goal_score_total || 0), 0);

    conversionPaths.push({
      nav_label: navItem.label,
      route: navItem.route,
      flow_count: matchingFlows.length,
      goal_reached_count: goalFlows.length,
      sample_goal: goalFlows.length > 0
        ? goalFlows[0].steps[goalFlows[0].steps.length - 1]?.route || null
        : null,
      goals_hit: distinctGoals.length > 0 ? distinctGoals : undefined,
      goal_score: bestScore > 0 ? bestScore : undefined,
    });
  }

  return {
    version: VERSION,
    generated_at: new Date().toISOString(),
    primary_nav: primaryNav,
    secondary_nav: secondaryNav,
    must_surface: mustSurface,
    documented_non_surface: documentedNonSurface,
    demote_to_advanced: demoteToAdvanced,
    grouping_notes: groupingNotes,
    conversion_paths: conversionPaths,
  };
}

// =============================================================================
// Markdown renderers
// =============================================================================

/**
 * @param {import('./types.mjs').DesignSurfaceInventory} inv
 * @returns {string}
 */
export function renderSurfaceInventoryMd(inv) {
  const lines = ['# UI Surface Inventory', ''];
  lines.push(`Generated: ${inv.generated_at}`);
  lines.push(`Total surfaces: ${inv.stats.total} (${inv.stats.unique} unique) | Destructive: ${inv.stats.destructive_count} | Routes: ${inv.stats.total_routes}`);
  lines.push('');

  /** @type {import('./types.mjs').LocationGroup[]} */
  const order = ['primary_nav', 'secondary_nav', 'toolbar', 'overflow', 'settings', 'modal', 'inline', 'footer'];

  for (const loc of order) {
    const entries = inv.groups[loc] || [];
    if (entries.length === 0) continue;

    const uniqueSuffix = (loc === 'primary_nav' || loc === 'secondary_nav')
      ? `, ${inv.stats.by_location_unique?.[loc] ?? entries.length} unique`
      : '';
    lines.push(`## ${formatLocationLabel(loc)} (${entries.length}${uniqueSuffix})`);
    lines.push('');
    lines.push('| Route | Label | Role | Safety | Effects |');
    lines.push('|-------|-------|------|--------|---------|');

    for (const e of entries) {
      const effects = e.linked_effects.length > 0 ? e.linked_effects.join(', ') : '—';
      lines.push(`| ${e.route} | ${e.label} | ${e.role} | ${e.safety} | ${effects} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * @param {import('./types.mjs').DesignFeatureMap} map
 * @returns {string}
 */
export function renderFeatureMapMd(map) {
  const lines = ['# UI Feature Map', ''];
  lines.push(`Total: ${map.stats.total} features (${map.stats.from_atlas} from docs, ${map.stats.auto_clustered} auto-discovered)`);
  lines.push(`Promote: ${map.stats.promote_count} | Demote: ${map.stats.demote_count} | Skipped: ${map.stats.ungrounded_count ?? 0}`);
  lines.push('');

  const atlasFeatures = map.features.filter(f => f.from_atlas);
  const autoFeatures = map.features.filter(f => !f.from_atlas);

  if (atlasFeatures.length > 0) {
    lines.push('## Features from Documentation');
    lines.push('');
    lines.push('| Feature | Entry Points | Depth | Discoverability | Confidence | Action |');
    lines.push('|---------|-------------|-------|-----------------|------------|--------|');

    for (const f of atlasFeatures) {
      const eps = f.entry_points.join(', ') || '—';
      const depth = Object.values(f.click_depth).join(', ') || '—';
      lines.push(`| ${f.feature_name} | ${eps} | ${depth} | ${f.discoverability.toFixed(2)} | ${f.runtime_confidence.toFixed(2)} | ${f.recommended_action} |`);
    }
    lines.push('');
  }

  if (autoFeatures.length > 0) {
    lines.push('## Auto-Discovered Features');
    lines.push('');
    lines.push('| Feature | Entry Points | Discoverability | Confidence | Action |');
    lines.push('|---------|-------------|-----------------|------------|--------|');

    for (const f of autoFeatures) {
      const eps = f.entry_points.join(', ') || '—';
      lines.push(`| ${f.feature_name} | ${eps} | ${f.discoverability.toFixed(2)} | ${f.runtime_confidence.toFixed(2)} | ${f.recommended_action} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * @param {import('./types.mjs').TaskFlow[]} flows
 * @returns {string}
 */
export function renderTaskFlowsMd(flows) {
  const lines = ['# UI Task Flows', ''];
  lines.push(`${flows.length} flow(s) inferred from navigation chains.`);
  lines.push('');

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    const tags = [];
    if (flow.has_dead_end) tags.push('DEAD END');
    if (flow.loop_type === 'browse_loop') tags.push('BROWSE LOOP');
    else if (flow.loop_type === 'nav_loop') tags.push('NAV LOOP');
    else if (flow.has_loop) tags.push('LOOP');
    if (flow.goal_reached) {
      if (flow.goals_reached?.length > 0) {
        const goalLabels = flow.goals_reached.map(g => g.rule_label).join(', ');
        const unknowns = flow.goals_reached.filter(g => g.confidence === 'unknown').length;
        const suffix = unknowns > 0 ? ` (${unknowns} unknown)` : '';
        tags.push(`GOALS: ${goalLabels}${suffix} [score: ${flow.goal_score_total}]`);
      } else {
        tags.push('GOAL REACHED');
      }
    }
    if (flow.has_destructive_step) tags.push('DESTRUCTIVE');
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

    lines.push(`## ${i + 1}. ${flow.task_name} (${flow.total_depth} steps)${tagStr}`);
    lines.push('');

    for (let j = 0; j < flow.steps.length; j++) {
      const step = flow.steps[j];
      const prefix = j === 0 ? 'Start' : '  →';
      const effects = step.effects.length > 0 ? ` (${step.effects.join(', ')})` : '';
      const destructive = step.is_destructive ? ' **[DESTRUCTIVE]**' : '';
      const deadEnd = step.step_type === 'dead_end' ? ' ⊘' : '';
      const goalHits = step.goals_hit?.length > 0
        ? ` **[${step.goals_hit.map(g => g.rule_label).join(', ')}]**`
        : '';
      lines.push(`${prefix}: ${step.route} > ${step.trigger_label}${effects}${destructive}${deadEnd}${goalHits}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * @param {import('./types.mjs').DesignIAProposal} proposal
 * @returns {string}
 */
export function renderIAProposalMd(proposal) {
  const lines = ['# IA Proposal', ''];

  lines.push(`## Primary Navigation (${proposal.primary_nav.length}, max 7)`);
  lines.push('');
  if (proposal.primary_nav.length === 0) {
    lines.push('_No candidates identified._');
  } else {
    for (const item of proposal.primary_nav) {
      lines.push(`- **${item.label}** (${item.route}) — ${item.reason}`);
    }
  }
  lines.push('');

  lines.push(`## Secondary / Settings (${proposal.secondary_nav.length})`);
  lines.push('');
  if (proposal.secondary_nav.length === 0) {
    lines.push('_No candidates identified._');
  } else {
    for (const item of proposal.secondary_nav) {
      lines.push(`- **${item.label}** (${item.route}) — ${item.reason}`);
    }
  }
  lines.push('');

  lines.push(`## Must-Surface (${proposal.must_surface.length})`);
  lines.push('');
  if (proposal.must_surface.length === 0) {
    lines.push('_All documented features are discoverable._');
  } else {
    for (const item of proposal.must_surface) {
      lines.push(`- **${item.label}** (${item.route}) — ${item.reason}`);
    }
  }
  lines.push('');

  const dns = proposal.documented_non_surface || [];
  lines.push(`## Documented Non-Surface (${dns.length})`);
  lines.push('');
  if (dns.length === 0) {
    lines.push('_No architectural capabilities identified._');
  } else {
    lines.push('_Architectural capabilities that are documented but intentionally have no direct UI trigger._');
    lines.push('');
    for (const item of dns) {
      lines.push(`- **${item.label}** (${item.route}) — ${item.reason}`);
    }
  }
  lines.push('');

  lines.push(`## Demote to Advanced (${proposal.demote_to_advanced.length})`);
  lines.push('');
  if (proposal.demote_to_advanced.length === 0) {
    lines.push('_No candidates for demotion._');
  } else {
    for (const item of proposal.demote_to_advanced) {
      lines.push(`- **${item.label}** (${item.route}) — ${item.reason}`);
    }
  }
  lines.push('');

  if (proposal.conversion_paths?.length > 0) {
    lines.push('## Conversion Paths');
    lines.push('');
    const hasGoalRules = proposal.conversion_paths.some(cp => cp.goals_hit?.length > 0);
    if (hasGoalRules) {
      lines.push('| Nav Item | Flows | Goals Reached | Goal Score | Goals | Sample Goal |');
      lines.push('|----------|-------|---------------|------------|-------|-------------|');
      for (const cp of proposal.conversion_paths) {
        const goal = cp.sample_goal || '—';
        const goalNames = cp.goals_hit?.map(g => g.rule_label).join(', ') || '—';
        const score = cp.goal_score ?? '—';
        lines.push(`| ${cp.nav_label} | ${cp.flow_count} | ${cp.goal_reached_count} | ${score} | ${goalNames} | ${goal} |`);
      }
    } else {
      lines.push('| Nav Item | Flows | Goals Reached | Sample Goal |');
      lines.push('|----------|-------|---------------|-------------|');
      for (const cp of proposal.conversion_paths) {
        const goal = cp.sample_goal || '—';
        lines.push(`| ${cp.nav_label} | ${cp.flow_count} | ${cp.goal_reached_count} | ${goal} |`);
      }
    }
    lines.push('');
  }

  if (proposal.grouping_notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of proposal.grouping_notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** @param {string} loc */
function formatLocationLabel(loc) {
  return loc.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, replay?: string, out?: string }} flags
 */
export async function runDesignMap(config, flags) {
  const cwd = process.cwd();
  const inputs = loadDesignMapInputs(config, cwd, flags);

  const inventory = buildSurfaceInventory(inputs.graph, inputs.diff, inputs.coverage);
  const featureMap = buildFeatureMap(inputs.graph, inputs.diff, inputs.coverage, inputs.atlas);
  const basePath = config.probe.basePath || detectBasePath(config.probe.baseUrl);
  const goalRoutes = config.probe.goalRoutes || [];
  const goalRules = config.goalRules || [];
  const taskFlows = inferTaskFlows(inputs.graph, inputs.coverage, basePath, goalRoutes, goalRules);
  const proposal = proposeIA(inventory, featureMap, taskFlows);

  // Write outputs
  const outDir = flags.out ? resolve(cwd, flags.out) : resolve(cwd, dirname(config.output.designSurfaceInventory));
  mkdirSync(outDir, { recursive: true });

  const invPath = flags.out ? resolve(outDir, 'ui-surface-inventory.json') : resolve(cwd, config.output.designSurfaceInventory);
  const invMdPath = flags.out ? resolve(outDir, 'ui-surface-inventory.md') : resolve(cwd, config.output.designSurfaceInventoryReport);
  const fmPath = flags.out ? resolve(outDir, 'ui-feature-map.json') : resolve(cwd, config.output.designFeatureMap);
  const fmMdPath = flags.out ? resolve(outDir, 'ui-feature-map.md') : resolve(cwd, config.output.designFeatureMapReport);
  const tfPath = flags.out ? resolve(outDir, 'ui-task-flows.md') : resolve(cwd, config.output.designTaskFlows);
  const iaPath = flags.out ? resolve(outDir, 'ui-ia-proposal.md') : resolve(cwd, config.output.designIAProposal);

  writeFileSync(invPath, JSON.stringify(inventory, null, 2));
  writeFileSync(invMdPath, renderSurfaceInventoryMd(inventory));
  writeFileSync(fmPath, JSON.stringify(featureMap, null, 2));
  writeFileSync(fmMdPath, renderFeatureMapMd(featureMap));
  writeFileSync(tfPath, renderTaskFlowsMd(taskFlows));
  writeFileSync(iaPath, renderIAProposalMd(proposal));

  console.log(`Design map: ${inventory.stats.total} surfaces, ${featureMap.stats.total} features, ${taskFlows.length} flows, ${proposal.primary_nav.length} nav proposals`);
  console.log(`  Wrote: ${invPath}`);
  console.log(`  Wrote: ${fmPath}`);
  console.log(`  Wrote: ${tfPath}`);
  console.log(`  Wrote: ${iaPath}`);
}
