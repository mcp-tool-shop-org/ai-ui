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
