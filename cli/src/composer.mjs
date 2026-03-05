// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';
import { normalize, matchScore } from './normalize.mjs';
import { ONBOARDING_WORDS, ADVANCED_WORDS, DATA_WORDS } from './diagnostics.mjs';
import { generateSuggestions } from './diagnostics.mjs';
import { buildGraph, computeSurfacingValues } from './trigger-graph.mjs';

// =============================================================================
// Intent classification keywords
// =============================================================================

/** @type {Record<import('./types.mjs').IntentClass, string[]>} */
export const INTENT_CLASSES = {
  navigate:    ['view', 'open', 'go', 'visit', 'start', 'started', 'navigate', 'begin', 'docs', 'page', 'section'],
  submit:      ['create', 'submit', 'send', 'apply', 'save', 'invite', 'add'],
  change:      ['enable', 'disable', 'switch', 'toggle', 'configure', 'set'],
  destructive: ['delete', 'remove', 'reset', 'destroy', 'clear'],
  data:        ['export', 'download', 'import', 'list', 'filter', 'sort', 'manage'],
  display:     ['show', 'display', 'preview', 'render', 'composable', 'layout'],
  config:      ['settings', 'preferences', 'config', 'tokens', 'scale', 'spacing', 'color', 'theme', 'dark', 'roles'],
};

/** Rule name → priority rank (lower = higher priority) */
const RULE_PRIORITY = {
  nav_menu_available: 1,
  hero_cta: 2,
  table_action: 3,
  overflow_advanced: 4,
  generic_cta: 5,
};

/** Intent class → default trigger event */
const INTENT_EVENT = {
  navigate: 'click',
  submit: 'click',
  change: 'change',
  destructive: 'click',
  data: 'click',
  display: 'click',
  config: 'click',
};

/** Intent class → default effect intent */
const INTENT_EFFECT = {
  navigate: 'navigate',
  submit: 'submit_form',
  change: 'change',
  destructive: 'delete',
  data: 'navigate',
  display: 'navigate',
  config: 'navigate',
};

/** Rule → pattern_kind for controls */
const RULE_PATTERN = {
  nav_menu_available: 'nav_item',
  hero_cta: 'cta_button',
  table_action: 'table_action',
  overflow_advanced: 'menu_item',
  generic_cta: 'cta_button',
};

// =============================================================================
// Step A — Classify feature intent
// =============================================================================

/**
 * Classify the primary intent of a feature.
 * @param {import('./types.mjs').Feature} feature
 * @returns {import('./types.mjs').IntentClass}
 */
export function classifyIntent(feature) {
  const allNames = [feature.name, ...feature.synonyms];
  const words = allNames.flatMap(n => normalize(n).split(' ').filter(Boolean));
  const unique = [...new Set(words)];

  for (const [intentClass, keywords] of Object.entries(INTENT_CLASSES)) {
    for (const word of unique) {
      if (keywords.includes(word)) {
        return /** @type {import('./types.mjs').IntentClass} */ (intentClass);
      }
    }
  }

  return 'display';
}

// =============================================================================
// Step B — Rank placement rules
// =============================================================================

/**
 * Rank fix suggestions and pick the best placement rule.
 * @param {import('./types.mjs').Feature} feature
 * @param {import('./types.mjs').FixSuggestion[]} suggestions
 * @param {import('./types.mjs').IntentClass} intent
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').SurfacingValue[]} surfacingValues
 * @returns {import('./types.mjs').FixSuggestion}
 */
export function rankRules(feature, suggestions, intent, graph, surfacingValues) {
  if (suggestions.length === 0) {
    // Generate a generic fallback
    return {
      action: `Add a CTA on / labeled '${feature.name}'`,
      rule: 'generic_cta',
      tag_hint: `data-aiui='feature.${feature.id}'`,
    };
  }

  // Build a route→value map for tiebreaking
  const routeValueMap = new Map();
  for (const sv of surfacingValues) {
    const current = routeValueMap.get(sv.route) || 0;
    routeValueMap.set(sv.route, current + sv.value);
  }

  // Filter suggestions by intent compatibility
  const coreIntents = new Set(['navigate', 'submit']);
  const ranked = suggestions.map(s => {
    const priority = RULE_PRIORITY[s.rule] || 99;
    let boost = 0;

    // Core intents boost nav/hero rules
    if (coreIntents.has(intent) && (s.rule === 'nav_menu_available' || s.rule === 'hero_cta')) {
      boost = -2;
    }

    // Config/advanced intents boost overflow
    if ((intent === 'config' || intent === 'change') && s.rule === 'overflow_advanced') {
      boost = -2;
    }

    // Data intents boost table_action
    if (intent === 'data' && s.rule === 'table_action') {
      boost = -2;
    }

    // Route value tiebreak: extract route from action string
    const routeMatch = s.action.match(/on (\/\S*)/);
    const route = routeMatch ? routeMatch[1] : '/';
    const routeValue = routeValueMap.get(route) || 0;

    return { suggestion: s, score: priority + boost, routeValue };
  });

  // Sort by priority score (lower is better), then by route value (higher is better)
  ranked.sort((a, b) => a.score - b.score || b.routeValue - a.routeValue);
  return ranked[0].suggestion;
}

// =============================================================================
// Step C — Materialize plan entry
// =============================================================================

/**
 * Materialize a concrete plan entry from a feature + selected rule.
 * @param {import('./types.mjs').Feature} feature
 * @param {import('./types.mjs').FixSuggestion} rule
 * @param {import('./types.mjs').IntentClass} intent
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').Surface[]} surfaces
 * @param {string} diffReason
 * @param {string[]} evidence
 * @returns {import('./types.mjs').PlanEntry}
 */
export function materializePlan(feature, rule, intent, graph, surfaces, diffReason, evidence) {
  // Determine route
  const routeNodes = graph.nodes.filter(n => n.type === 'route');
  let targetRoute = '/';

  if (rule.rule === 'nav_menu_available') {
    // Use route with most triggers (most-connected)
    let bestCount = -1;
    for (const r of routeNodes) {
      const count = graph.edges.filter(e => e.from === r.id && e.type === 'contains').length;
      if (count > bestCount) {
        bestCount = count;
        targetRoute = r.route || r.label;
      }
    }
  } else if (rule.rule === 'hero_cta') {
    // Use route with custom/SECTION surface
    for (const s of surfaces) {
      if (s.pattern === 'custom' || s.role === 'SECTION') {
        targetRoute = s.route;
        break;
      }
    }
  } else if (rule.rule === 'table_action') {
    // Use route with data_table surface
    for (const s of surfaces) {
      if (s.pattern === 'data_table') {
        targetRoute = s.route;
        break;
      }
    }
  } else {
    // Extract route from action string or default to /
    const routeMatch = rule.action.match(/on (\/\S*)/);
    if (routeMatch) targetRoute = routeMatch[1];
  }

  // Find matching surface on the target route
  let surfaceId = null;
  for (const s of surfaces) {
    if (s.route !== targetRoute) continue;
    if (rule.rule === 'table_action' && s.pattern === 'data_table') { surfaceId = s.nodeId; break; }
    if (rule.rule === 'hero_cta' && (s.pattern === 'custom' || s.role === 'SECTION')) { surfaceId = s.nodeId; break; }
    if (rule.rule === 'nav_menu_available' && s.pattern === 'nav_menu') { surfaceId = s.nodeId; break; }
  }

  // Style tokens from feature words
  const words = normalize(feature.name).split(' ').filter(Boolean);
  /** @type {string[]} */
  const styleTokens = [];
  const STYLE_AFFINITY = {
    primary: ['primary'], main: ['primary'], action: ['primary'], cta: ['primary'],
    danger: ['destructive'], destructive: ['destructive'], delete: ['destructive'], remove: ['destructive'],
    warning: ['warning'], warn: ['warning'],
    success: ['success'], confirm: ['success'],
  };
  for (const w of words) {
    const aff = STYLE_AFFINITY[w];
    if (aff) {
      for (const t of aff) {
        if (!styleTokens.includes(t)) styleTokens.push(t);
      }
    }
  }

  // Add 'primary' for nav/hero CTA rules
  if ((rule.rule === 'nav_menu_available' || rule.rule === 'hero_cta') && !styleTokens.length) {
    styleTokens.push('primary');
  }

  // Priority assignment
  const priority = assignPriority(intent, rule.rule);

  // Effect target: kebab-case feature ID as route path
  const effectTarget = `/${feature.id}`;

  // Pattern slot
  const patternSlot = rule.rule === 'overflow_advanced' ? 'overflow_menu'
    : rule.rule === 'nav_menu_available' ? 'primary_nav'
    : rule.rule === 'hero_cta' ? 'hero_section'
    : rule.rule === 'table_action' ? 'data_table'
    : 'page_body';

  // Acceptance criteria
  const clicks = rule.rule === 'nav_menu_available' || rule.rule === 'hero_cta' ? 1 : 2;
  const visibility = (rule.rule === 'nav_menu_available' || rule.rule === 'hero_cta')
    ? `${RULE_PATTERN[rule.rule] === 'nav_item' ? 'Nav item' : 'CTA'} visible without overflow on desktop`
    : `${RULE_PATTERN[rule.rule] === 'menu_item' ? 'Menu item' : 'Control'} accessible via overflow menu on desktop`;

  return {
    feature_id: feature.id,
    feature_name: feature.name,
    priority,
    intent_class: intent,
    why: {
      diff_reason: diffReason,
      evidence,
    },
    placement: {
      rule: rule.rule,
      route: targetRoute,
      surface_id: surfaceId,
      pattern_slot: patternSlot,
    },
    control: {
      label: feature.name,
      pattern_kind: RULE_PATTERN[rule.rule] || 'cta_button',
      style_tokens: styleTokens,
      data_aiui: `feature.${feature.id}`,
    },
    trigger: { event: INTENT_EVENT[intent] || 'click' },
    effect: { intent: INTENT_EFFECT[intent] || 'navigate', target: effectTarget },
    acceptance_criteria: [
      `From ${targetRoute}, user can reach '${feature.name}' in <= ${clicks} click(s)`,
      visibility,
      'Feature appears in AI-UI Probe surfaces on next run',
    ],
  };
}

// =============================================================================
// Step D — Priority assignment
// =============================================================================

/**
 * Assign priority based on intent class + placement rule.
 * @param {import('./types.mjs').IntentClass} intent
 * @param {string} ruleName
 * @returns {'P0'|'P1'|'P2'}
 */
export function assignPriority(intent, ruleName) {
  const coreIntents = new Set(['navigate', 'submit']);
  const coreRules = new Set(['nav_menu_available', 'hero_cta']);
  const functionalIntents = new Set(['data', 'change', 'destructive']);
  const functionalRules = new Set(['table_action', 'overflow_advanced']);

  if (coreIntents.has(intent) && coreRules.has(ruleName)) return 'P0';
  if (functionalIntents.has(intent) && functionalRules.has(ruleName)) return 'P1';
  if (coreIntents.has(intent)) return 'P1'; // core intent but non-core placement
  return 'P2';
}

// =============================================================================
// Orchestrator — composeSurfacingPlan
// =============================================================================

/**
 * Compose a full surfacing plan from pipeline outputs.
 * Pure function — no I/O.
 * @param {any} diff - Parsed diff.json
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {{ features: import('./types.mjs').Feature[] }} atlas
 * @param {import('./types.mjs').Surface[]} surfaces
 * @param {any[]} triggers - Probe trigger entries
 * @returns {import('./types.mjs').SurfacingPlan}
 */
export function composeSurfacingPlan(diff, graph, atlas, surfaces, triggers) {
  const surfacingValues = computeSurfacingValues(graph, diff.burial_index || []);
  const orphans = diff.documented_not_discoverable || [];
  const featureMap = new Map(atlas.features.map(f => [f.id, f]));

  /** @type {import('./types.mjs').PlanEntry[]} */
  const plans = [];

  for (const orphan of orphans) {
    const feature = featureMap.get(orphan.feature_id);
    if (!feature) continue;

    // Step A: classify intent
    const intent = classifyIntent(feature);

    // Step B: generate suggestions + rank
    const suggestions = generateSuggestions(feature, surfaces, triggers);
    const bestRule = rankRules(feature, suggestions, intent, graph, surfacingValues);

    // Step C: materialize
    const evidence = orphan.sources || feature.sources.map(s => `${s.file}:${s.line}`);
    const diffReason = orphan.failure_reason || 'missing_surface';
    const entry = materializePlan(feature, bestRule, intent, graph, surfaces, diffReason, evidence);

    plans.push(entry);
  }

  // Deterministic sort: P0 → P1 → P2, then by feature_id
  const priorityOrder = { P0: 0, P1: 1, P2: 2 };
  plans.sort((a, b) =>
    (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9)
    || a.feature_id.localeCompare(b.feature_id)
  );

  // Summary stats
  const routesTouched = [...new Set(plans.map(p => p.placement.route))].sort();
  /** @type {Record<string, number>} */
  const placementsByRule = {};
  /** @type {Record<string, number>} */
  const placementsByPriority = {};
  for (const p of plans) {
    placementsByRule[p.placement.rule] = (placementsByRule[p.placement.rule] || 0) + 1;
    placementsByPriority[p.priority] = (placementsByPriority[p.priority] || 0) + 1;
  }

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    summary: {
      features_total: atlas.features.length,
      features_planned: plans.length,
      routes_touched: routesTouched,
      placements_by_rule: placementsByRule,
      placements_by_priority: placementsByPriority,
    },
    plans,
  };
}

// =============================================================================
// Markdown report
// =============================================================================

/**
 * Generate a PR-ready markdown surfacing plan report.
 * @param {import('./types.mjs').SurfacingPlan} plan
 * @returns {string}
 */
export function generatePlanReport(plan) {
  const lines = [];

  lines.push('# Surfacing Plan');
  lines.push('');
  lines.push(`Generated: ${plan.generated_at}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`- ${plan.summary.features_planned} features planned across ${plan.summary.routes_touched.length} route(s)`);
  const ruleEntries = Object.entries(plan.summary.placements_by_rule).sort((a, b) => a[0].localeCompare(b[0]));
  lines.push(`- Placements: ${ruleEntries.map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const priEntries = Object.entries(plan.summary.placements_by_priority).sort((a, b) => a[0].localeCompare(b[0]));
  lines.push(`- Priority: ${priEntries.map(([k, v]) => `${k} (${v})`).join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group by priority
  const groups = { P0: 'Core Journey', P1: 'Functional', P2: 'Polish' };
  for (const [pri, heading] of Object.entries(groups)) {
    const groupPlans = plan.plans.filter(p => p.priority === pri);
    if (groupPlans.length === 0) continue;

    lines.push(`## ${pri} — ${heading}`);
    lines.push('');

    for (const p of groupPlans) {
      lines.push(`### ${p.feature_name}`);
      lines.push('');
      lines.push(`- **Why:** ${p.why.diff_reason} (${p.why.evidence.join(', ')})`);
      lines.push(`- **Intent:** ${p.intent_class}`);
      lines.push(`- **Placement:** ${p.placement.rule} on ${p.placement.route}`);

      const styleStr = p.control.style_tokens.length > 0 ? ` [${p.control.style_tokens.join(', ')}]` : '';
      lines.push(`- **Control:** \`${p.control.pattern_kind}\` labeled "${p.control.label}"${styleStr} \`data-aiui="${p.control.data_aiui}"\``);
      lines.push(`- **Effect:** ${p.effect.intent} → ${p.effect.target}`);
      lines.push(`- **Acceptance:**`);
      for (const ac of p.acceptance_criteria) {
        lines.push(`  - [ ] ${ac}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// DOT export
// =============================================================================

/**
 * Generate a Graphviz DOT visualization of the surfacing plan.
 * Shows feature → planned surface → route wiring.
 * @param {import('./types.mjs').SurfacingPlan} plan
 * @returns {string}
 */
export function generatePlanDot(plan) {
  const lines = [];
  lines.push('digraph SurfacingPlan {');
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Helvetica" fontsize=10];');
  lines.push('  edge [fontname="Helvetica" fontsize=8];');
  lines.push('');

  const PRI_COLORS = { P0: '#FF4444', P1: '#FF8800', P2: '#4488FF' };

  // Feature nodes
  lines.push('  subgraph cluster_features {');
  lines.push('    label="Features";');
  lines.push('    style=dashed;');
  lines.push('    color="#9B59B6";');
  for (const p of plan.plans) {
    const color = PRI_COLORS[p.priority] || '#999999';
    const escaped = p.feature_name.replace(/"/g, '\\"');
    lines.push(`    "feature:${p.feature_id}" [label="${escaped}\\n[${p.priority}]" shape=note fillcolor="${color}" style=filled fontcolor=white];`);
  }
  lines.push('  }');
  lines.push('');

  // Control/surface nodes
  lines.push('  subgraph cluster_controls {');
  lines.push('    label="Planned Controls";');
  lines.push('    style=dashed;');
  lines.push('    color="#50C878";');
  for (const p of plan.plans) {
    const escaped = p.control.label.replace(/"/g, '\\"');
    lines.push(`    "control:${p.feature_id}" [label="${escaped}\\n(${p.control.pattern_kind})" shape=box fillcolor="#50C878" style=filled fontcolor=white];`);
  }
  lines.push('  }');
  lines.push('');

  // Route nodes
  const routes = [...new Set(plan.plans.map(p => p.placement.route))];
  lines.push('  subgraph cluster_routes {');
  lines.push('    label="Routes";');
  lines.push('    style=dashed;');
  lines.push('    color="#FFD700";');
  for (const r of routes) {
    lines.push(`    "route:${r}" [label="${r}" shape=hexagon fillcolor="#FFD700" style=filled];`);
  }
  lines.push('  }');
  lines.push('');

  // Edges: feature → control → route
  for (const p of plan.plans) {
    lines.push(`  "feature:${p.feature_id}" -> "control:${p.feature_id}" [label="${p.placement.rule}"];`);
    lines.push(`  "control:${p.feature_id}" -> "route:${p.placement.route}" [label="${p.effect.intent}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the Compose command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean }} flags
 */
export async function runCompose(config, flags) {
  const cwd = process.cwd();

  // Load atlas
  const atlasPath = resolve(cwd, config.output.atlas);
  if (!existsSync(atlasPath)) {
    fail('COMPOSE_NO_ATLAS', `Atlas file not found: ${atlasPath}`, 'Run "ai-ui atlas" first.');
  }
  const atlas = JSON.parse(readFileSync(atlasPath, 'utf-8'));

  // Load diff
  const diffPath = resolve(cwd, config.output.diff);
  if (!existsSync(diffPath)) {
    fail('COMPOSE_NO_DIFF', `Diff file not found: ${diffPath}`, 'Run "ai-ui diff" first.');
  }
  const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));

  // Load probe (for triggers)
  const probePath = resolve(cwd, config.output.probe);
  if (!existsSync(probePath)) {
    fail('COMPOSE_NO_PROBE', `Probe file not found: ${probePath}`, 'Run "ai-ui probe" first.');
  }
  const probeLines = readFileSync(probePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
  const triggers = probeLines.filter(l => l.type === 'trigger');
  const routeChanges = probeLines.filter(l => l.type === 'route_change');

  // Load surfaces (optional)
  const surfacesPath = resolve(cwd, config.output.surfaces);
  /** @type {import('./types.mjs').Surface[]} */
  let surfaces = [];
  if (existsSync(surfacesPath)) {
    try {
      const inv = JSON.parse(readFileSync(surfacesPath, 'utf-8'));
      surfaces = inv.surfaces || [];
      if (flags.verbose) {
        console.log(`Compose: loaded ${surfaces.length} surfaces from ${relative(cwd, surfacesPath)}`);
      }
    } catch { /* optional */ }
  }

  // Load or build graph
  const graphPath = resolve(cwd, config.output.graph);
  let graph;
  if (existsSync(graphPath)) {
    graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    if (flags.verbose) {
      console.log(`Compose: loaded graph from ${relative(cwd, graphPath)}`);
    }
  } else {
    if (flags.verbose) {
      console.log('Compose: no graph file found, building inline...');
    }
    graph = buildGraph(triggers, routeChanges, surfaces, atlas.features || [], diff);
  }

  if (flags.verbose) {
    const orphanCount = (diff.documented_not_discoverable || []).length;
    console.log(`Compose: ${orphanCount} orphan features to plan for`);
  }

  // Compose
  const plan = composeSurfacingPlan(diff, graph, atlas, surfaces, triggers);

  // Write surfacing-plan.json
  const planPath = resolve(cwd, config.output.composePlan);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf-8');

  // Write surfacing-plan.md
  const reportPath = resolve(cwd, config.output.composeReport);
  writeFileSync(reportPath, generatePlanReport(plan), 'utf-8');

  // Write surfacing-plan.dot
  const dotPath = resolve(cwd, config.output.composeDot);
  writeFileSync(dotPath, generatePlanDot(plan), 'utf-8');

  console.log(`Compose: ${plan.summary.features_planned} features planned → ${relative(cwd, planPath)}`);
  if (flags.verbose) {
    const pri = plan.summary.placements_by_priority;
    console.log(`  Priority: P0=${pri.P0 || 0}, P1=${pri.P1 || 0}, P2=${pri.P2 || 0}`);
    console.log(`  Routes: ${plan.summary.routes_touched.join(', ')}`);
    const rules = Object.entries(plan.summary.placements_by_rule).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`  Rules: ${rules}`);
  }
}
