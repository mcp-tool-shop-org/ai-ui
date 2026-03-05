// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGraph,
  computeSurfacingValues,
  findOrphanFeatures,
  findOrphanTriggers,
  generateGraphReport,
  generateDot,
  augmentWithRuntime,
} from '../src/trigger-graph.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/trigger-graph-fixtures.json'), 'utf-8'));

/** Helper to build graph from fixtures */
function build() {
  return buildGraph(
    fixtures.triggers,
    fixtures.routeChanges,
    fixtures.surfaces,
    fixtures.features,
    fixtures.diff,
  );
}

// =============================================================================
// buildGraph — node creation
// =============================================================================

describe('buildGraph — nodes', () => {
  const graph = build();

  it('creates trigger nodes from probe triggers', () => {
    const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');
    assert.equal(triggerNodes.length, 4);
    assert.ok(triggerNodes.some(n => n.id === 'trigger:/|Docs'));
    assert.ok(triggerNodes.some(n => n.id === 'trigger:/|Get started'));
    assert.ok(triggerNodes.some(n => n.id === 'trigger:/|Privacy'));
    assert.ok(triggerNodes.some(n => n.id === 'trigger:/docs|Search'));
  });

  it('creates surface nodes from surfaces inventory', () => {
    const surfaceNodes = graph.nodes.filter(n => n.type === 'surface');
    assert.equal(surfaceNodes.length, 4);
    assert.ok(surfaceNodes.some(n => n.id === 'surface:link-docs'));
    assert.ok(surfaceNodes.some(n => n.id === 'surface:search-bar'));
    assert.ok(surfaceNodes.some(n => n.id === 'surface:btn-delete'));
  });

  it('creates effect nodes from surface handlers', () => {
    const effectNodes = graph.nodes.filter(n => n.type === 'effect');
    // navigate effects from link-docs, btn-get-started; filter + search from search-bar; delete from btn-delete
    // Plus stateWrite:search.query from search-bar state
    assert.ok(effectNodes.length >= 4, `expected >= 4 effect nodes, got ${effectNodes.length}`);
    assert.ok(effectNodes.some(n => n.id.includes('stateWrite:search.query')));
  });

  it('creates route nodes from route_changes and triggers', () => {
    const routeNodes = graph.nodes.filter(n => n.type === 'route');
    assert.ok(routeNodes.some(n => n.id === 'route:/'));
    assert.ok(routeNodes.some(n => n.id === 'route:/docs'));
    assert.ok(routeNodes.some(n => n.id === 'route:/get-started'));
    assert.ok(routeNodes.some(n => n.id === 'route:/privacy'));
  });

  it('creates feature nodes from atlas features', () => {
    const featureNodes = graph.nodes.filter(n => n.type === 'feature');
    assert.equal(featureNodes.length, 3);
    assert.ok(featureNodes.some(n => n.id === 'feature:search'));
    assert.ok(featureNodes.some(n => n.id === 'feature:documentation'));
    assert.ok(featureNodes.some(n => n.id === 'feature:color-roles'));
  });

  it('stores metadata on trigger nodes', () => {
    const docs = graph.nodes.find(n => n.id === 'trigger:/|Docs');
    assert.equal(docs.meta.parent_nav, true);
    assert.equal(docs.meta.depth, 0);
    assert.equal(docs.meta.element, 'a');
  });

  it('stores metadata on surface nodes', () => {
    const sb = graph.nodes.find(n => n.id === 'surface:search-bar');
    assert.equal(sb.meta.pattern, 'search_bar');
    assert.equal(sb.meta.role, 'INPUT');
  });

  it('deduplicates nodes by ID', () => {
    const ids = graph.nodes.map(n => n.id);
    assert.equal(ids.length, new Set(ids).size);
  });
});

// =============================================================================
// buildGraph — edges
// =============================================================================

describe('buildGraph — edges', () => {
  const graph = build();

  it('creates contains edges (route → trigger)', () => {
    const containsEdges = graph.edges.filter(e => e.type === 'contains');
    assert.ok(containsEdges.length >= 4);
    assert.ok(containsEdges.some(e => e.from === 'route:/' && e.to === 'trigger:/|Docs'));
    assert.ok(containsEdges.some(e => e.from === 'route:/docs' && e.to === 'trigger:/docs|Search'));
  });

  it('creates navigates_to edges (trigger → route) from href', () => {
    const navEdges = graph.edges.filter(e => e.type === 'navigates_to');
    assert.ok(navEdges.some(e => e.from === 'trigger:/|Docs' && e.to === 'route:/docs'));
    assert.ok(navEdges.some(e => e.from === 'trigger:/|Get started' && e.to === 'route:/get-started'));
  });

  it('creates produces edges (surface → effect) from handlers', () => {
    const producesEdges = graph.edges.filter(e => e.type === 'produces');
    assert.ok(producesEdges.length >= 4);
    // search-bar has 2 handlers: input→filter, submit→search
    const searchBarEdges = producesEdges.filter(e => e.from === 'surface:search-bar');
    assert.equal(searchBarEdges.length, 2);
  });

  it('creates writes edges (surface → effect) from state', () => {
    const writesEdges = graph.edges.filter(e => e.type === 'writes');
    assert.ok(writesEdges.some(e =>
      e.from === 'surface:search-bar' && e.to === 'effect:stateWrite:search.query'
    ));
  });

  it('creates maps_to edges (trigger → surface) by label matching', () => {
    const mapsToEdges = graph.edges.filter(e => e.type === 'maps_to');
    // "Docs" trigger should map to "docs" surface (link-docs)
    assert.ok(mapsToEdges.some(e =>
      e.from === 'trigger:/|Docs' && e.to === 'surface:link-docs'
    ));
    // "Get started" trigger should map to "get-started" surface
    assert.ok(mapsToEdges.some(e =>
      e.from === 'trigger:/|Get started' && e.to === 'surface:btn-get-started'
    ));
    // "Search" trigger should map to "search" surface
    assert.ok(mapsToEdges.some(e =>
      e.from === 'trigger:/docs|Search' && e.to === 'surface:search-bar'
    ));
  });

  it('creates documents edges (feature → trigger/surface) from diff matched', () => {
    const docEdges = graph.edges.filter(e => e.type === 'documents');
    // "documentation" feature matched to "Docs" trigger
    assert.ok(docEdges.some(e =>
      e.from === 'feature:documentation' && e.to === 'trigger:/|Docs'
    ));
  });

  it('deduplicates edges', () => {
    const edgeKeys = graph.edges.map(e => `${e.from}→${e.to}→${e.type}`);
    assert.equal(edgeKeys.length, new Set(edgeKeys).size);
  });

  it('has no navigates_to edge for trigger without href', () => {
    // Search trigger has null href
    const navEdges = graph.edges.filter(e =>
      e.type === 'navigates_to' && e.from === 'trigger:/docs|Search'
    );
    assert.equal(navEdges.length, 0);
  });
});

// =============================================================================
// buildGraph — stats
// =============================================================================

describe('buildGraph — stats', () => {
  const graph = build();

  it('computes total_nodes correctly', () => {
    assert.equal(graph.stats.total_nodes, graph.nodes.length);
  });

  it('computes by_type correctly', () => {
    for (const type of ['trigger', 'surface', 'effect', 'route', 'feature']) {
      const count = graph.nodes.filter(n => n.type === type).length;
      assert.equal(graph.stats.by_type[type], count, `by_type.${type} mismatch`);
    }
  });

  it('computes total_edges correctly', () => {
    assert.equal(graph.stats.total_edges, graph.edges.length);
  });

  it('computes by_edge_type correctly', () => {
    for (const type of ['maps_to', 'produces', 'writes', 'navigates_to', 'contains', 'documents']) {
      const count = graph.edges.filter(e => e.type === type).length;
      assert.equal(graph.stats.by_edge_type[type], count, `by_edge_type.${type} mismatch`);
    }
  });

  it('has version 1.0.0', () => {
    assert.equal(graph.version, '1.0.0');
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('determinism', () => {
  it('produces identical graphs on consecutive runs', () => {
    const g1 = build();
    const g2 = build();
    // Compare without generated_at
    const strip = (g) => ({ ...g, generated_at: 'X' });
    assert.deepEqual(strip(g1), strip(g2));
  });

  it('sorts nodes by id', () => {
    const graph = build();
    for (let i = 1; i < graph.nodes.length; i++) {
      assert.ok(
        graph.nodes[i].id.localeCompare(graph.nodes[i - 1].id) >= 0,
        `nodes not sorted: ${graph.nodes[i - 1].id} > ${graph.nodes[i].id}`
      );
    }
  });

  it('sorts edges by from, to, type', () => {
    const graph = build();
    for (let i = 1; i < graph.edges.length; i++) {
      const a = graph.edges[i - 1];
      const b = graph.edges[i];
      const cmp = a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type);
      assert.ok(cmp <= 0, `edges not sorted at index ${i}`);
    }
  });
});

// =============================================================================
// Surfacing Value
// =============================================================================

describe('computeSurfacingValues', () => {
  const graph = build();
  const values = computeSurfacingValues(graph, fixtures.diff.burial_index);

  it('returns one entry per trigger node', () => {
    const triggerCount = graph.nodes.filter(n => n.type === 'trigger').length;
    assert.equal(values.length, triggerCount);
  });

  it('sorts by value descending', () => {
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i].value <= values[i - 1].value,
        `not sorted: ${values[i - 1].label}=${values[i - 1].value} < ${values[i].label}=${values[i].value}`);
    }
  });

  it('gives higher value to triggers with feature connections', () => {
    const docs = values.find(v => v.label === 'Docs');
    const privacy = values.find(v => v.label === 'Privacy');
    assert.ok(docs, 'Docs trigger should exist');
    assert.ok(privacy, 'Privacy trigger should exist');
    // Docs has a feature connection (documentation), Privacy does not
    assert.ok(docs.value > privacy.value, `Docs (${docs.value}) should have higher value than Privacy (${privacy.value})`);
  });

  it('penalizes buried triggers', () => {
    const privacy = values.find(v => v.label === 'Privacy');
    // Privacy has burial_score 3 → penalty of 1.5
    assert.ok(privacy);
    // Privacy: no feature edges, has_surface=false, parent_nav=false, depth=0
    // value = 0 + 0 + 0 + 0 + 1 - 1.5 = max(0, -0.5) = 0
    assert.equal(privacy.value, 0);
  });

  it('rewards primary nav triggers', () => {
    const getStarted = values.find(v => v.label === 'Get started');
    assert.ok(getStarted);
    assert.equal(getStarted.parent_nav, true);
    // Get started: no feature edges, has effects via surface, has_surface=true, parent_nav=true, depth=0
    // value = 0 + effects*2 + 2 + 2 + 1 - 0 = 5+
    assert.ok(getStarted.value >= 5);
  });
});

// =============================================================================
// Orphan detection
// =============================================================================

describe('findOrphanFeatures', () => {
  const graph = build();
  const orphans = findOrphanFeatures(graph.nodes, graph.edges);

  it('returns features with no documents edge', () => {
    // "documentation" is matched (has documents edge), "search" and "color-roles" are not
    assert.ok(orphans.some(o => o.id === 'feature:color-roles'));
    assert.ok(orphans.some(o => o.id === 'feature:search'));
  });

  it('does not include matched features', () => {
    assert.ok(!orphans.some(o => o.id === 'feature:documentation'));
  });

  it('includes source info', () => {
    const colorRoles = orphans.find(o => o.id === 'feature:color-roles');
    assert.ok(colorRoles);
    assert.equal(colorRoles.source, 'README.md:60');
  });

  it('sorts by id', () => {
    for (let i = 1; i < orphans.length; i++) {
      assert.ok(orphans[i].id >= orphans[i - 1].id);
    }
  });
});

describe('findOrphanTriggers', () => {
  const graph = build();
  const orphans = findOrphanTriggers(graph.nodes, graph.edges);

  it('returns triggers with no maps_to edge', () => {
    // "Privacy" has no matching surface
    assert.ok(orphans.some(o => o.id === 'trigger:/|Privacy'));
  });

  it('does not include triggers with surface matches', () => {
    assert.ok(!orphans.some(o => o.id === 'trigger:/|Docs'));
    assert.ok(!orphans.some(o => o.id === 'trigger:/|Get started'));
  });
});

// =============================================================================
// Report generators
// =============================================================================

describe('generateGraphReport', () => {
  const graph = build();
  const values = computeSurfacingValues(graph, fixtures.diff.burial_index);
  const orphans = findOrphanFeatures(graph.nodes, graph.edges);
  const report = generateGraphReport(graph, values, orphans);

  it('includes title', () => {
    assert.ok(report.includes('# Trigger Graph Report'));
  });

  it('includes summary section with node counts', () => {
    assert.ok(report.includes('## Summary'));
    assert.ok(report.includes('nodes'));
    assert.ok(report.includes('edges'));
  });

  it('includes top 20 triggers section', () => {
    assert.ok(report.includes('## Top 20 Triggers by Surfacing Value'));
    assert.ok(report.includes('Docs'));
  });

  it('includes unreachable features section', () => {
    assert.ok(report.includes('## Unreachable Features'));
    assert.ok(report.includes('Color roles'));
  });

  it('includes effect coverage section', () => {
    assert.ok(report.includes('## Effect Coverage'));
  });

  it('includes route connectivity section', () => {
    assert.ok(report.includes('## Route Connectivity'));
  });
});

describe('generateDot', () => {
  const graph = build();
  const dot = generateDot(graph);

  it('starts with digraph declaration', () => {
    assert.ok(dot.startsWith('digraph TriggerGraph {'));
  });

  it('ends with closing brace', () => {
    assert.ok(dot.trimEnd().endsWith('}'));
  });

  it('contains subgraphs for each node type', () => {
    assert.ok(dot.includes('subgraph cluster_trigger'));
    assert.ok(dot.includes('subgraph cluster_surface'));
    assert.ok(dot.includes('subgraph cluster_effect'));
    assert.ok(dot.includes('subgraph cluster_route'));
    assert.ok(dot.includes('subgraph cluster_feature'));
  });

  it('contains edge declarations', () => {
    assert.ok(dot.includes('->'));
    assert.ok(dot.includes('maps_to'));
    assert.ok(dot.includes('produces'));
    assert.ok(dot.includes('contains'));
  });

  it('uses rankdir=LR', () => {
    assert.ok(dot.includes('rankdir=LR'));
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('handles empty inputs', () => {
    const graph = buildGraph([], [], [], [], { matched: [], burial_index: [] });
    assert.equal(graph.nodes.length, 0);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.stats.total_nodes, 0);
    assert.equal(graph.stats.total_edges, 0);
  });

  it('handles triggers without href', () => {
    const graph = buildGraph(
      [{ type: 'trigger', route: '/', element: 'button', label: 'Click', href: null, selector: 'button', depth: 0, parent_nav: false }],
      [],
      [],
      [],
      { matched: [], burial_index: [] },
    );
    const navEdges = graph.edges.filter(e => e.type === 'navigates_to');
    assert.equal(navEdges.length, 0);
  });

  it('handles absolute URLs in href', () => {
    const graph = buildGraph(
      [{ type: 'trigger', route: '/', element: 'a', label: 'GitHub', href: 'https://github.com/org', selector: 'a', depth: 0, parent_nav: false }],
      [],
      [],
      [],
      { matched: [], burial_index: [] },
    );
    const navEdges = graph.edges.filter(e => e.type === 'navigates_to');
    assert.ok(navEdges.some(e => e.to === 'route:/org'));
  });

  it('handles surfaces with no label (uses nodeId as label)', () => {
    const graph = buildGraph(
      [],
      [],
      [{ nodeId: 'anon-1', route: '/', role: 'SECTION', label: null, pattern: 'custom', styleTokens: [], handlers: [], state: [] }],
      [],
      { matched: [], burial_index: [] },
    );
    const surfaceNode = graph.nodes.find(n => n.id === 'surface:anon-1');
    assert.ok(surfaceNode);
    assert.equal(surfaceNode.label, 'anon-1');
  });

  it('handles duplicate triggers (deduplicates)', () => {
    const trigger = { type: 'trigger', route: '/', element: 'a', label: 'Dup', href: '/dup', selector: 'a', depth: 0, parent_nav: false };
    const graph = buildGraph(
      [trigger, trigger],
      [],
      [],
      [],
      { matched: [], burial_index: [] },
    );
    const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');
    assert.equal(triggerNodes.length, 1);
  });
});

// =============================================================================
// augmentWithRuntime
// =============================================================================

describe('augmentWithRuntime', () => {
  /** @type {import('../src/trigger-graph.mjs').TriggerGraph} */
  let baseGraph;

  /** @type {import('../src/types.mjs').RuntimeEffectsSummary} */
  const runtimeSummary = {
    version: '1.0.0',
    generated_at: '2026-01-01T00:00:00.000Z',
    url: 'http://localhost:4321',
    triggers: [
      {
        trigger_id: 'click@get-started',
        route: '/',
        label: 'Get started',
        effects: [
          { kind: 'fetch', trigger_id: 'click@get-started', route: '/', window_ms: 150, method: 'POST', url: '/api/checkout', status: 302 },
          { kind: 'navigate', trigger_id: 'click@get-started', route: '/', window_ms: 200, from: '/', to: '/pricing' },
        ],
      },
      {
        trigger_id: 'click@theme-toggle',
        route: '/',
        label: 'Theme',
        effects: [
          { kind: 'storageWrite', trigger_id: 'click@theme-toggle', route: '/', window_ms: 50, scope: 'local', key: 'theme' },
        ],
      },
      {
        trigger_id: 'click@export',
        route: '/',
        label: 'Export',
        effects: [
          { kind: 'download', trigger_id: 'click@export', route: '/', window_ms: 500, filename: 'report.csv' },
        ],
      },
      {
        trigger_id: 'click@save',
        route: '/',
        label: 'Save',
        effects: [
          { kind: 'domEffect', trigger_id: 'click@save', route: '/', window_ms: 300, detail: 'modal_open' },
        ],
      },
    ],
    stats: { total_triggers: 4, triggers_fired: 4, triggers_skipped: 0, effects_captured: 5, by_kind: { fetch: 1, navigate: 1, storageWrite: 1, download: 1, domEffect: 1 } },
  };

  // Build a minimal graph that has some triggers + effects
  function buildTestGraph() {
    return buildGraph(
      [
        { type: 'trigger', route: '/', element: 'button', label: 'Get started', href: null, selector: 'button', depth: 0, parent_nav: false },
        { type: 'trigger', route: '/', element: 'button', label: 'Theme', href: null, selector: 'button', depth: 0, parent_nav: false },
        { type: 'trigger', route: '/', element: 'button', label: 'Export', href: null, selector: 'button', depth: 0, parent_nav: false },
        { type: 'trigger', route: '/', element: 'button', label: 'Save', href: null, selector: 'button', depth: 0, parent_nav: false },
      ],
      [],
      [
        {
          nodeId: 'surf-1', route: '/', role: 'BUTTON', label: 'Get started', pattern: null, styleTokens: [],
          handlers: [{ event: 'click', intent: 'navigate' }], state: [],
        },
        {
          nodeId: 'surf-theme', route: '/', role: 'BUTTON', label: 'Theme', pattern: null, styleTokens: [],
          handlers: [], state: [{ key: 'theme', access: 'write' }],
        },
      ],
      [],
      { matched: [], burial_index: [] },
    );
  }

  it('bumps version to 1.1.0', () => {
    const graph = buildTestGraph();
    assert.equal(graph.version, '1.0.0');
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.equal(augmented.version, '1.1.0');
  });

  it('does not mutate the original graph', () => {
    const graph = buildTestGraph();
    const originalNodeCount = graph.nodes.length;
    augmentWithRuntime(graph, runtimeSummary);
    assert.equal(graph.nodes.length, originalNodeCount);
    assert.equal(graph.version, '1.0.0');
  });

  it('marks existing effect as observed when runtime matches', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const navEffect = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    assert.ok(navEffect);
    assert.equal(navEffect.meta.observed, true);
    assert.ok(Array.isArray(navEffect.meta.evidence));
    assert.ok(navEffect.meta.evidence.length >= 1);
  });

  it('marks stateWrite effect as observed', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const stateNode = augmented.nodes.find(n => n.id === 'effect:stateWrite:theme');
    assert.ok(stateNode);
    assert.equal(stateNode.meta.observed, true);
  });

  it('creates new effect nodes for unmatched runtime effects', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);

    // fetch POST /api/checkout is new (no existing submit effect)
    const fetchNode = augmented.nodes.find(n => n.id === 'effect:fetch:POST /api/checkout');
    assert.ok(fetchNode, 'fetch effect node should be created');
    assert.equal(fetchNode.meta.observed, true);
    assert.equal(fetchNode.type, 'effect');
  });

  it('creates download effect node', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const dlNode = augmented.nodes.find(n => n.id === 'effect:download:report.csv');
    assert.ok(dlNode);
    assert.equal(dlNode.label, 'download → report.csv');
  });

  it('creates domEffect node', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const domNode = augmented.nodes.find(n => n.id === 'effect:domEffect:modal_open');
    assert.ok(domNode);
    assert.equal(domNode.label, 'dom → modal_open');
  });

  it('adds runtime_observed edges from trigger to new effect', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const runtimeEdges = augmented.edges.filter(e => e.type === 'runtime_observed');
    assert.ok(runtimeEdges.length >= 1);
    // Check that an edge exists from Export trigger to download effect
    const exportEdge = runtimeEdges.find(e =>
      e.from === 'trigger:/|Export' && e.to === 'effect:download:report.csv'
    );
    assert.ok(exportEdge, 'runtime_observed edge from Export to download should exist');
  });

  it('includes runtime_observed in edge type stats', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.ok(augmented.stats.by_edge_type.runtime_observed >= 1);
  });

  it('updates effect count in stats', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.ok(augmented.stats.by_type.effect > graph.stats.by_type.effect);
  });

  it('nodes are sorted deterministically', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const ids = augmented.nodes.map(n => n.id);
    const sorted = [...ids].sort();
    assert.deepStrictEqual(ids, sorted);
  });

  it('edges are deduplicated', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const edgeKeys = augmented.edges.map(e => `${e.from}→${e.to}→${e.type}`);
    const unique = new Set(edgeKeys);
    assert.equal(edgeKeys.length, unique.size);
  });

  it('is deterministic across repeated calls', () => {
    const graph = buildTestGraph();
    const a1 = augmentWithRuntime(graph, runtimeSummary);
    const a2 = augmentWithRuntime(graph, runtimeSummary);
    assert.deepStrictEqual(a1, a2);
  });

  it('handles empty runtime summary (no changes → version stays 1.0.0)', () => {
    const graph = buildTestGraph();
    const emptySummary = { version: '1.0.0', generated_at: '2026-01-01T00:00:00.000Z', url: '', triggers: [], stats: { total_triggers: 0, triggers_fired: 0, triggers_skipped: 0, effects_captured: 0, by_kind: {} } };
    const augmented = augmentWithRuntime(graph, emptySummary);
    assert.equal(augmented.version, '1.0.0');
    assert.equal(augmented.nodes.length, graph.nodes.length);
  });

  it('navigate effect matches existing navigate intent and marks observed', () => {
    const graph = buildTestGraph();
    const navOnlySummary = {
      version: '1.0.0', generated_at: '2026-01-01T00:00:00.000Z', url: '', triggers: [
        { trigger_id: 'click@nav', route: '/', label: 'Nav', effects: [
          { kind: 'navigate', trigger_id: 'click@nav', route: '/', window_ms: 100, from: '/', to: '/about' },
        ] },
      ], stats: { total_triggers: 1, triggers_fired: 1, triggers_skipped: 0, effects_captured: 1, by_kind: { navigate: 1 } },
    };
    const augmented = augmentWithRuntime(graph, navOnlySummary);
    // Existing effect:navigate:/ should be marked observed
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    assert.ok(navNode);
    assert.equal(navNode.meta.observed, true);
    assert.ok(navNode.meta.evidence.length >= 1);
    assert.equal(navNode.meta.evidence[0].kind, 'navigate');
  });

  it('navigate effect creates new node when no existing navigate intent', () => {
    // Graph with no surfaces (no existing effect nodes)
    const graph = buildGraph(
      [{ type: 'trigger', route: '/', element: 'a', label: 'About', href: null, selector: 'a', depth: 0, parent_nav: false }],
      [], [], [], { matched: [], burial_index: [] },
    );
    const navSummary = {
      version: '1.0.0', generated_at: '2026-01-01T00:00:00.000Z', url: '', triggers: [
        { trigger_id: 'click@about', route: '/', label: 'About', effects: [
          { kind: 'navigate', trigger_id: 'click@about', route: '/', window_ms: 100, from: '/', to: '/about' },
        ] },
      ], stats: { total_triggers: 1, triggers_fired: 1, triggers_skipped: 0, effects_captured: 1, by_kind: { navigate: 1 } },
    };
    const augmented = augmentWithRuntime(graph, navSummary);
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/about');
    assert.ok(navNode);
    assert.equal(navNode.label, 'navigate → /about');
  });

  // --- Phase 1: Evidence dedupe + confidence ---

  it('evidence entries have key field', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    assert.ok(navNode.meta.evidence[0].key);
    assert.equal(navNode.meta.evidence[0].key, 'navigate:/pricing');
  });

  it('deduplicates evidence entries with same key', () => {
    const graph = buildTestGraph();
    // Create a runtime summary with duplicate effects for same trigger
    const dupSummary = {
      ...runtimeSummary,
      triggers: [{
        trigger_id: 'click@get-started',
        route: '/',
        label: 'Get started',
        effects: [
          { kind: 'navigate', trigger_id: 'click@get-started', route: '/', window_ms: 200, from: '/', to: '/pricing' },
          { kind: 'navigate', trigger_id: 'click@get-started', route: '/', window_ms: 250, from: '/', to: '/pricing' },
        ],
      }],
    };
    const augmented = augmentWithRuntime(graph, dupSummary);
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    // Should be deduplicated to 1 entry
    assert.equal(navNode.meta.evidence.length, 1);
  });

  it('sets confidence level on observed effect nodes', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    assert.ok(['low', 'med', 'high'].includes(navNode.meta.confidence));
  });

  it('sets lastObservedAt from runtime summary', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    assert.equal(navNode.meta.lastObservedAt, '2026-01-01T00:00:00.000Z');
  });

  it('sets observedCount matching evidence length', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const navNode = augmented.nodes.find(n => n.id === 'effect:navigate:/');
    assert.equal(navNode.meta.observedCount, navNode.meta.evidence.length);
  });

  it('new effect nodes also get key, confidence, and counts', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    const dlNode = augmented.nodes.find(n => n.id === 'effect:download:report.csv');
    assert.ok(dlNode);
    assert.ok(dlNode.meta.evidence[0].key);
    assert.equal(dlNode.meta.evidence[0].key, 'download:report.csv');
    assert.ok(dlNode.meta.confidence);
    assert.ok(dlNode.meta.lastObservedAt);
    assert.equal(dlNode.meta.observedCount, 1);
  });

  // --- Phase 2: Normalized effect IDs ---

  it('similar URLs with different IDs collapse to one effect node', () => {
    const graph = buildGraph(
      [{ type: 'trigger', route: '/', element: 'button', label: 'Load', href: null, selector: 'button', depth: 0, parent_nav: false }],
      [], [], [], { matched: [], burial_index: [] },
    );
    const twoFetchSummary = {
      version: '1.0.0', generated_at: '2026-01-01T00:00:00.000Z', url: '', triggers: [
        { trigger_id: 'click@load', route: '/', label: 'Load', effects: [
          { kind: 'fetch', trigger_id: 'click@load', route: '/', window_ms: 100, method: 'GET', url: '/api/users/42?_t=111', status: 200 },
          { kind: 'fetch', trigger_id: 'click@load', route: '/', window_ms: 200, method: 'GET', url: '/api/users/99?_t=222', status: 200 },
        ] },
      ], stats: { total_triggers: 1, triggers_fired: 1, triggers_skipped: 0, effects_captured: 2, by_kind: { fetch: 2 } },
    };
    const augmented = augmentWithRuntime(graph, twoFetchSummary);
    // Both should collapse to effect:fetch:GET /api/users/:id
    const fetchNodes = augmented.nodes.filter(n => n.type === 'effect' && n.meta.kind === 'fetch');
    assert.equal(fetchNodes.length, 1);
    assert.equal(fetchNodes[0].id, 'effect:fetch:GET /api/users/:id');
  });

  it('normalized IDs are deterministic across runs', () => {
    const graph = buildTestGraph();
    const a1 = augmentWithRuntime(graph, runtimeSummary);
    const a2 = augmentWithRuntime(graph, runtimeSummary);
    const ids1 = a1.nodes.map(n => n.id);
    const ids2 = a2.nodes.map(n => n.id);
    assert.deepStrictEqual(ids1, ids2);
  });

  // --- Phase 5: graphDelta + version traceability ---

  it('includes graphDelta on augmented graph', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.ok(augmented.graphDelta);
    assert.equal(typeof augmented.graphDelta.nodesAdded, 'number');
    assert.equal(typeof augmented.graphDelta.nodesUpdated, 'number');
    assert.equal(typeof augmented.graphDelta.observedEffects, 'number');
    assert.equal(typeof augmented.graphDelta.newEdges, 'number');
    assert.equal(typeof augmented.graphDelta.reason, 'string');
  });

  it('graphDelta reports added nodes when runtime creates new effects', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    // runtimeSummary has download and domEffect that won't match existing nodes
    assert.ok(augmented.graphDelta.nodesAdded > 0);
  });

  it('graphDelta reports updated nodes when runtime matches existing effects', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    // navigate effect should match existing node
    assert.ok(augmented.graphDelta.nodesUpdated > 0 || augmented.graphDelta.observedEffects > 0);
  });

  it('graphDelta reports observed effects count', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.ok(augmented.graphDelta.observedEffects >= runtimeSummary.triggers[0].effects.length);
  });

  it('version is 1.1.0 when runtime changes are made', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.equal(augmented.version, '1.1.0');
  });

  it('version stays 1.0.0 when no runtime effects match', () => {
    const graph = buildTestGraph();
    const emptySummary = {
      version: '1.0.0',
      generated_at: '2026-01-01T00:00:00.000Z',
      url: '',
      triggers: [],
      stats: { total_triggers: 0, triggers_fired: 0, triggers_skipped: 0, effects_captured: 0, by_kind: {} },
    };
    const augmented = augmentWithRuntime(graph, emptySummary);
    assert.equal(augmented.version, '1.0.0');
    assert.equal(augmented.graphDelta.nodesAdded, 0);
    assert.equal(augmented.graphDelta.nodesUpdated, 0);
  });

  it('graphDelta reason describes changes when present', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.ok(augmented.graphDelta.reason.includes('augmented'));
  });

  it('graphDelta reason says no match when empty', () => {
    const graph = buildTestGraph();
    const emptySummary = {
      version: '1.0.0', generated_at: '2026-01-01T00:00:00.000Z', url: '',
      triggers: [], stats: { total_triggers: 0, triggers_fired: 0, triggers_skipped: 0, effects_captured: 0, by_kind: {} },
    };
    const augmented = augmentWithRuntime(graph, emptySummary);
    assert.ok(augmented.graphDelta.reason.includes('no runtime effects'));
  });

  it('graphDelta tracks newEdges', () => {
    const graph = buildTestGraph();
    const augmented = augmentWithRuntime(graph, runtimeSummary);
    assert.ok(augmented.graphDelta.newEdges >= 0);
  });

  it('graphDelta is deterministic across runs', () => {
    const graph = buildTestGraph();
    const a1 = augmentWithRuntime(graph, runtimeSummary);
    const a2 = augmentWithRuntime(graph, runtimeSummary);
    assert.deepStrictEqual(a1.graphDelta, a2.graphDelta);
  });
});
