// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyIntent,
  rankRules,
  materializePlan,
  assignPriority,
  composeSurfacingPlan,
  generatePlanReport,
  generatePlanDot,
  INTENT_CLASSES,
} from '../src/composer.mjs';
import { buildGraph } from '../src/trigger-graph.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/composer-fixtures.json'), 'utf-8'));

// Helper: build graph from fixtures
function buildTestGraph() {
  return buildGraph(
    fixtures.triggers,
    fixtures.routeChanges,
    fixtures.surfaces,
    fixtures.features,
    fixtures.diff
  );
}

// =============================================================================
// classifyIntent
// =============================================================================

describe('classifyIntent', () => {
  it('classifies navigate intent for "View docs"', () => {
    const feature = fixtures.features.find(f => f.id === 'view-docs');
    assert.equal(classifyIntent(feature), 'navigate');
  });

  it('classifies navigate intent for "Get started"', () => {
    const feature = fixtures.features.find(f => f.id === 'get-started');
    assert.equal(classifyIntent(feature), 'navigate');
  });

  it('classifies config intent for "Color roles"', () => {
    const feature = fixtures.features.find(f => f.id === 'color-roles');
    assert.equal(classifyIntent(feature), 'config');
  });

  it('classifies config intent for "Type scale"', () => {
    const feature = fixtures.features.find(f => f.id === 'type-scale');
    assert.equal(classifyIntent(feature), 'config');
  });

  it('classifies config intent for "Dark theme"', () => {
    const feature = fixtures.features.find(f => f.id === 'dark-theme');
    assert.equal(classifyIntent(feature), 'config');
  });

  it('classifies destructive intent for "Delete account"', () => {
    const feature = fixtures.features.find(f => f.id === 'delete-account');
    assert.equal(classifyIntent(feature), 'destructive');
  });

  it('classifies data intent for "Manage items"', () => {
    const feature = fixtures.features.find(f => f.id === 'manage-items');
    assert.equal(classifyIntent(feature), 'data');
  });

  it('classifies display intent for "Composable sections"', () => {
    const feature = fixtures.features.find(f => f.id === 'composable-sections');
    assert.equal(classifyIntent(feature), 'display');
  });

  it('falls back to display for unknown words', () => {
    const feature = { id: 'mystery', name: 'Foobar baz', synonyms: [], sources: [], expected_entrypoints: [] };
    assert.equal(classifyIntent(feature), 'display');
  });

  it('uses synonyms for classification', () => {
    const feature = { id: 'test', name: 'Something', synonyms: ['onboarding', 'begin'], sources: [], expected_entrypoints: [] };
    // 'begin' is in INTENT_CLASSES.navigate, so synonym matching finds it
    assert.equal(classifyIntent(feature), 'navigate');
  });

  it('scans all synonyms for matching intent', () => {
    const feature = { id: 'test', name: 'Something', synonyms: ['navigate'], sources: [], expected_entrypoints: [] };
    assert.equal(classifyIntent(feature), 'navigate');
  });
});

// =============================================================================
// INTENT_CLASSES constant
// =============================================================================

describe('INTENT_CLASSES', () => {
  it('has all 7 intent classes', () => {
    const keys = Object.keys(INTENT_CLASSES);
    assert.equal(keys.length, 7);
    assert.ok(keys.includes('navigate'));
    assert.ok(keys.includes('submit'));
    assert.ok(keys.includes('change'));
    assert.ok(keys.includes('destructive'));
    assert.ok(keys.includes('data'));
    assert.ok(keys.includes('display'));
    assert.ok(keys.includes('config'));
  });

  it('each class has at least one keyword', () => {
    for (const [cls, keywords] of Object.entries(INTENT_CLASSES)) {
      assert.ok(keywords.length > 0, `${cls} should have keywords`);
    }
  });
});

// =============================================================================
// assignPriority
// =============================================================================

describe('assignPriority', () => {
  it('P0 for navigate + nav_menu_available', () => {
    assert.equal(assignPriority('navigate', 'nav_menu_available'), 'P0');
  });

  it('P0 for submit + hero_cta', () => {
    assert.equal(assignPriority('submit', 'hero_cta'), 'P0');
  });

  it('P1 for data + table_action', () => {
    assert.equal(assignPriority('data', 'table_action'), 'P1');
  });

  it('P1 for change + overflow_advanced', () => {
    assert.equal(assignPriority('change', 'overflow_advanced'), 'P1');
  });

  it('P1 for destructive + overflow_advanced', () => {
    assert.equal(assignPriority('destructive', 'overflow_advanced'), 'P1');
  });

  it('P1 for navigate + generic_cta (core intent, non-core rule)', () => {
    assert.equal(assignPriority('navigate', 'generic_cta'), 'P1');
  });

  it('P2 for config + overflow_advanced', () => {
    assert.equal(assignPriority('config', 'overflow_advanced'), 'P2');
  });

  it('P2 for display + generic_cta', () => {
    assert.equal(assignPriority('display', 'generic_cta'), 'P2');
  });
});

// =============================================================================
// rankRules
// =============================================================================

describe('rankRules', () => {
  it('returns a suggestion with rule property', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'color-roles');
    const suggestions = [
      { action: "Add 'Color roles' to overflow menu", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' },
      { action: "Add a CTA on / labeled 'Color roles'", rule: 'generic_cta', tag_hint: 'data-aiui=...' },
    ];
    const result = rankRules(feature, suggestions, 'config', graph, []);
    assert.ok(result.rule);
  });

  it('prefers overflow for config intent', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'color-roles');
    const suggestions = [
      { action: "Add 'Color roles' to overflow menu", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' },
      { action: "Add a CTA on / labeled 'Color roles'", rule: 'generic_cta', tag_hint: 'data-aiui=...' },
    ];
    const result = rankRules(feature, suggestions, 'config', graph, []);
    assert.equal(result.rule, 'overflow_advanced');
  });

  it('prefers nav for navigate intent when nav suggestion exists', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'view-docs');
    const suggestions = [
      { action: "Add 'View docs' to primary navigation", rule: 'nav_menu_available', tag_hint: 'data-aiui=...' },
      { action: "Add a CTA on / labeled 'View docs'", rule: 'generic_cta', tag_hint: 'data-aiui=...' },
    ];
    const result = rankRules(feature, suggestions, 'navigate', graph, []);
    assert.equal(result.rule, 'nav_menu_available');
  });

  it('returns generic_cta fallback when no suggestions', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'color-roles');
    const result = rankRules(feature, [], 'config', graph, []);
    assert.equal(result.rule, 'generic_cta');
  });

  it('prefers table_action for data intent', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'manage-items');
    const suggestions = [
      { action: "Add row action for 'Manage items' in data table", rule: 'table_action', tag_hint: 'data-aiui=...' },
      { action: "Add 'Manage items' to overflow menu", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' },
      { action: "Add a CTA on / labeled 'Manage items'", rule: 'generic_cta', tag_hint: 'data-aiui=...' },
    ];
    const result = rankRules(feature, suggestions, 'data', graph, []);
    assert.equal(result.rule, 'table_action');
  });
});

// =============================================================================
// materializePlan
// =============================================================================

describe('materializePlan', () => {
  it('returns a valid PlanEntry', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'color-roles');
    const rule = { action: "Add to overflow", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'config', graph, fixtures.surfaces, 'missing_surface', ['README.md:60']);

    assert.equal(entry.feature_id, 'color-roles');
    assert.equal(entry.feature_name, 'Color roles');
    assert.equal(entry.intent_class, 'config');
    assert.ok(['P0', 'P1', 'P2'].includes(entry.priority));
    assert.ok(entry.placement.route);
    assert.equal(entry.placement.rule, 'overflow_advanced');
    assert.ok(entry.control.label);
    assert.ok(entry.control.data_aiui);
    assert.ok(entry.trigger.event);
    assert.ok(entry.effect.intent);
    assert.ok(entry.effect.target);
    assert.equal(entry.acceptance_criteria.length, 3);
  });

  it('sets data_aiui correctly', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'dark-theme');
    const rule = { action: "Add to overflow", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'config', graph, fixtures.surfaces, 'missing_surface', ['README.md:61']);
    assert.equal(entry.control.data_aiui, 'feature.dark-theme');
  });

  it('picks hero route for hero_cta rule', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'get-started');
    const rule = { action: "Add CTA in Hero section", rule: 'hero_cta', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'navigate', graph, fixtures.surfaces, 'missing_surface', ['README.md:5']);
    // hero-section surface is on '/'
    assert.equal(entry.placement.route, '/');
    assert.equal(entry.placement.pattern_slot, 'hero_section');
  });

  it('picks table route for table_action rule', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'manage-items');
    const rule = { action: "Add row action", rule: 'table_action', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'data', graph, fixtures.surfaces, 'missing_surface', ['README.md:40']);
    // data-table-items surface is on '/items'
    assert.equal(entry.placement.route, '/items');
    assert.equal(entry.placement.surface_id, 'data-table-items');
  });

  it('finds nav_menu surface for nav_menu_available rule', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'view-docs');
    const rule = { action: "Add to nav", rule: 'nav_menu_available', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'navigate', graph, fixtures.surfaces, 'missing_surface', ['README.md:15']);
    assert.equal(entry.placement.surface_id, 'nav-menu');
    assert.equal(entry.placement.pattern_slot, 'primary_nav');
  });

  it('adds primary style token for nav/hero rules', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'view-docs');
    const rule = { action: "Add to nav", rule: 'nav_menu_available', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'navigate', graph, fixtures.surfaces, 'missing_surface', ['README.md:15']);
    assert.ok(entry.control.style_tokens.includes('primary'));
  });

  it('adds destructive style for delete features', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'delete-account');
    const rule = { action: "Add to overflow", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'destructive', graph, fixtures.surfaces, 'missing_surface', ['README.md:45']);
    assert.ok(entry.control.style_tokens.includes('destructive'));
  });

  it('sets acceptance criteria clicks based on rule', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'view-docs');
    const ruleNav = { action: "Add to nav", rule: 'nav_menu_available', tag_hint: 'data-aiui=...' };
    const entryNav = materializePlan(feature, ruleNav, 'navigate', graph, fixtures.surfaces, 'missing_surface', []);
    assert.ok(entryNav.acceptance_criteria[0].includes('<= 1 click'));

    const ruleGeneric = { action: "Add CTA", rule: 'generic_cta', tag_hint: 'data-aiui=...' };
    const entryGeneric = materializePlan(feature, ruleGeneric, 'navigate', graph, fixtures.surfaces, 'missing_surface', []);
    assert.ok(entryGeneric.acceptance_criteria[0].includes('<= 2 click'));
  });

  it('preserves evidence from diff', () => {
    const graph = buildTestGraph();
    const feature = fixtures.features.find(f => f.id === 'color-roles');
    const rule = { action: "Add to overflow", rule: 'overflow_advanced', tag_hint: 'data-aiui=...' };
    const entry = materializePlan(feature, rule, 'config', graph, fixtures.surfaces, 'missing_surface', ['README.md:60']);
    assert.deepEqual(entry.why.evidence, ['README.md:60']);
    assert.equal(entry.why.diff_reason, 'missing_surface');
  });
});

// =============================================================================
// composeSurfacingPlan
// =============================================================================

describe('composeSurfacingPlan', () => {
  it('produces a plan for each orphan feature', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.equal(plan.plans.length, fixtures.diff.documented_not_discoverable.length);
  });

  it('has version 1.0.0', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.equal(plan.version, '1.0.0');
  });

  it('has generated_at timestamp', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.ok(plan.generated_at);
    assert.ok(new Date(plan.generated_at).getTime() > 0);
  });

  it('summary features_total matches atlas', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.equal(plan.summary.features_total, fixtures.features.length);
  });

  it('summary features_planned matches orphans', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.equal(plan.summary.features_planned, fixtures.diff.documented_not_discoverable.length);
  });

  it('plans are sorted P0 → P1 → P2', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    const priorityOrder = { P0: 0, P1: 1, P2: 2 };
    for (let i = 1; i < plan.plans.length; i++) {
      const prev = priorityOrder[plan.plans[i - 1].priority];
      const curr = priorityOrder[plan.plans[i].priority];
      assert.ok(curr >= prev, `plan[${i}] (${plan.plans[i].priority}) should come after plan[${i - 1}] (${plan.plans[i - 1].priority})`);
    }
  });

  it('within same priority, sorted by feature_id', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    for (let i = 1; i < plan.plans.length; i++) {
      if (plan.plans[i].priority === plan.plans[i - 1].priority) {
        assert.ok(
          plan.plans[i].feature_id.localeCompare(plan.plans[i - 1].feature_id) >= 0,
          `${plan.plans[i].feature_id} should sort after ${plan.plans[i - 1].feature_id}`
        );
      }
    }
  });

  it('every entry has 3 acceptance criteria', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    for (const p of plan.plans) {
      assert.equal(p.acceptance_criteria.length, 3, `${p.feature_id} should have 3 acceptance criteria`);
    }
  });

  it('every entry has data_aiui', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    for (const p of plan.plans) {
      assert.ok(p.control.data_aiui.startsWith('feature.'), `${p.feature_id} data_aiui should start with "feature."`);
    }
  });

  it('routes_touched is populated', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.ok(plan.summary.routes_touched.length > 0);
  });

  it('placements_by_rule totals match plan count', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    const total = Object.values(plan.summary.placements_by_rule).reduce((a, b) => a + b, 0);
    assert.equal(total, plan.plans.length);
  });

  it('placements_by_priority totals match plan count', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    const total = Object.values(plan.summary.placements_by_priority).reduce((a, b) => a + b, 0);
    assert.equal(total, plan.plans.length);
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('determinism', () => {
  it('produces identical plans on repeated runs (ignoring timestamps)', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };

    const plan1 = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const plan2 = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    // Compare everything except generated_at
    const strip = p => ({ ...p, generated_at: 'STRIPPED' });
    assert.deepEqual(strip(plan1), strip(plan2));
  });

  it('plan entry order is stable', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };

    const plan1 = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const plan2 = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    const ids1 = plan1.plans.map(p => p.feature_id);
    const ids2 = plan2.plans.map(p => p.feature_id);
    assert.deepEqual(ids1, ids2);
  });
});

// =============================================================================
// generatePlanReport
// =============================================================================

describe('generatePlanReport', () => {
  it('starts with # Surfacing Plan', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const report = generatePlanReport(plan);

    assert.ok(report.startsWith('# Surfacing Plan'));
  });

  it('includes Summary section', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const report = generatePlanReport(plan);

    assert.ok(report.includes('## Summary'));
  });

  it('includes priority headers for non-empty groups', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const report = generatePlanReport(plan);

    const priorities = new Set(plan.plans.map(p => p.priority));
    if (priorities.has('P0')) assert.ok(report.includes('## P0 — Core Journey'));
    if (priorities.has('P1')) assert.ok(report.includes('## P1 — Functional'));
    if (priorities.has('P2')) assert.ok(report.includes('## P2 — Polish'));
  });

  it('includes checkboxes for acceptance criteria', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const report = generatePlanReport(plan);

    assert.ok(report.includes('- [ ] '));
  });

  it('includes data-aiui attribute', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const report = generatePlanReport(plan);

    assert.ok(report.includes('data-aiui='));
  });

  it('includes feature names as headings', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const report = generatePlanReport(plan);

    for (const p of plan.plans) {
      assert.ok(report.includes(`### ${p.feature_name}`), `Missing heading for ${p.feature_name}`);
    }
  });
});

// =============================================================================
// generatePlanDot
// =============================================================================

describe('generatePlanDot', () => {
  it('starts with digraph', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const dot = generatePlanDot(plan);

    assert.ok(dot.startsWith('digraph SurfacingPlan'));
  });

  it('ends with closing brace', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const dot = generatePlanDot(plan);

    assert.ok(dot.trimEnd().endsWith('}'));
  });

  it('includes feature nodes', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const dot = generatePlanDot(plan);

    for (const p of plan.plans) {
      assert.ok(dot.includes(`"feature:${p.feature_id}"`), `Missing node for ${p.feature_id}`);
    }
  });

  it('includes control nodes', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const dot = generatePlanDot(plan);

    for (const p of plan.plans) {
      assert.ok(dot.includes(`"control:${p.feature_id}"`), `Missing control for ${p.feature_id}`);
    }
  });

  it('includes route nodes', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const dot = generatePlanDot(plan);

    for (const route of plan.summary.routes_touched) {
      assert.ok(dot.includes(`"route:${route}"`), `Missing route node for ${route}`);
    }
  });

  it('includes edges from feature to control to route', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, fixtures.triggers);
    const dot = generatePlanDot(plan);

    for (const p of plan.plans) {
      assert.ok(dot.includes(`"feature:${p.feature_id}" -> "control:${p.feature_id}"`));
      assert.ok(dot.includes(`"control:${p.feature_id}" -> "route:${p.placement.route}"`));
    }
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('handles empty orphan list', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const emptyDiff = { ...fixtures.diff, documented_not_discoverable: [] };
    const plan = composeSurfacingPlan(emptyDiff, graph, atlas, fixtures.surfaces, fixtures.triggers);

    assert.equal(plan.plans.length, 0);
    assert.equal(plan.summary.features_planned, 0);
  });

  it('handles orphan with missing feature in atlas', () => {
    const graph = buildTestGraph();
    const atlas = { features: fixtures.features };
    const diffWithGhost = {
      ...fixtures.diff,
      documented_not_discoverable: [
        { feature_id: 'nonexistent', feature_name: 'Ghost', sources: [], failure_reason: 'missing_surface' },
      ],
    };
    const plan = composeSurfacingPlan(diffWithGhost, graph, atlas, fixtures.surfaces, fixtures.triggers);
    // Skipped because feature not in atlas
    assert.equal(plan.plans.length, 0);
  });

  it('handles empty surfaces array', () => {
    const graph = buildGraph(fixtures.triggers, fixtures.routeChanges, [], fixtures.features, fixtures.diff);
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, [], fixtures.triggers);

    assert.ok(plan.plans.length > 0);
    // All placements should still work (generic fallbacks)
    for (const p of plan.plans) {
      assert.ok(p.placement.route);
    }
  });

  it('handles empty triggers array', () => {
    const graph = buildGraph([], [], fixtures.surfaces, fixtures.features, fixtures.diff);
    const atlas = { features: fixtures.features };
    const plan = composeSurfacingPlan(fixtures.diff, graph, atlas, fixtures.surfaces, []);

    assert.ok(plan.plans.length > 0);
  });

  it('report and dot work with empty plan', () => {
    const emptyPlan = {
      version: '1.0.0',
      generated_at: new Date().toISOString(),
      summary: { features_total: 0, features_planned: 0, routes_touched: [], placements_by_rule: {}, placements_by_priority: {} },
      plans: [],
    };

    const report = generatePlanReport(emptyPlan);
    assert.ok(report.includes('# Surfacing Plan'));
    assert.ok(report.includes('0 features planned'));

    const dot = generatePlanDot(emptyPlan);
    assert.ok(dot.includes('digraph'));
    assert.ok(dot.trimEnd().endsWith('}'));
  });
});
