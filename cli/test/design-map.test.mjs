// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyLocation,
  classifySafety,
  computeDiscoverability,
  computeRuntimeConfidence,
  buildSurfaceInventory,
  buildFeatureMap,
  inferTaskFlows,
  proposeIA,
  renderSurfaceInventoryMd,
  renderFeatureMapMd,
  renderTaskFlowsMd,
  renderIAProposalMd,
  looksLikeSentence,
  isArchitecturalCapability,
  getObservedEffectDetails,
  hasRuntimeEvidence,
  evaluateGoalRules,
  deduplicateGoalHits,
} from '../src/design-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/design-map-fixtures.json'), 'utf-8'));

// =============================================================================
// classifyLocation
// =============================================================================

describe('classifyLocation', () => {
  it('classifies primary_nav (parent_nav=true, depth=0)', () => {
    const node = fixtures.graph.nodes.find(n => n.id === 'trigger:/|Docs');
    assert.equal(classifyLocation(node, fixtures.graph.edges), 'primary_nav');
  });

  it('classifies secondary_nav (parent_nav=true, depth>0)', () => {
    const node = { id: 'trigger:/docs|Sub', type: 'trigger', label: 'Sub', route: '/docs', meta: { element: 'a', parent_nav: true, depth: 2 } };
    assert.equal(classifyLocation(node, []), 'secondary_nav');
  });

  it('classifies settings (route contains settings)', () => {
    const node = fixtures.graph.nodes.find(n => n.id === 'trigger:/settings|Delete Account');
    assert.equal(classifyLocation(node, fixtures.graph.edges), 'settings');
  });

  it('classifies overflow (label matches overflow pattern)', () => {
    const node = fixtures.graph.nodes.find(n => n.id === 'trigger:/|More...');
    assert.equal(classifyLocation(node, fixtures.graph.edges), 'overflow');
  });

  it('classifies toolbar (depth=0, button, not nav)', () => {
    const node = { id: 'trigger:/|Action', type: 'trigger', label: 'Action', route: '/', meta: { element: 'button', parent_nav: false, depth: 0 } };
    assert.equal(classifyLocation(node, []), 'toolbar');
  });

  it('falls back to inline', () => {
    const node = { id: 'trigger:/page|Link', type: 'trigger', label: 'Link', route: '/page', meta: { element: 'a', parent_nav: false, depth: 3 } };
    assert.equal(classifyLocation(node, []), 'inline');
  });
});

// =============================================================================
// classifySafety
// =============================================================================

describe('classifySafety', () => {
  it('returns destructive for destructive label', () => {
    const node = fixtures.graph.nodes.find(n => n.id === 'trigger:/settings|Delete Account');
    assert.equal(classifySafety(node, fixtures.graph.edges, fixtures.graph.nodes), 'destructive');
  });

  it('returns destructive for surface with destructive styleToken', () => {
    // Create a trigger with non-destructive label but linked to destructive surface
    const node = { id: 'trigger:/|Safe Label', type: 'trigger', label: 'Safe Label', route: '/', meta: {} };
    const surface = { id: 'surface:danger-btn', type: 'surface', label: 'x', meta: { role: 'BUTTON', styleTokens: ['destructive'] } };
    const edges = [{ from: 'trigger:/|Safe Label', to: 'surface:danger-btn', type: 'maps_to' }];
    assert.equal(classifySafety(node, edges, [node, surface]), 'destructive');
  });

  it('returns safe for navigate-only effects', () => {
    const node = fixtures.graph.nodes.find(n => n.id === 'trigger:/|Docs');
    assert.equal(classifySafety(node, fixtures.graph.edges, fixtures.graph.nodes), 'safe');
  });

  it('returns unknown when no links', () => {
    const node = { id: 'trigger:/|Mystery', type: 'trigger', label: 'Mystery', route: '/', meta: {} };
    assert.equal(classifySafety(node, [], [node]), 'unknown');
  });
});

// =============================================================================
// computeDiscoverability
// =============================================================================

describe('computeDiscoverability', () => {
  it('returns 0.0 for depth=0, in_primary_nav, no overflow', () => {
    assert.equal(computeDiscoverability({ depth: 0, in_primary_nav: true, behind_overflow: false }), 0.0);
  });

  it('returns mid-range for depth=3, not in nav', () => {
    const result = computeDiscoverability({ depth: 3, in_primary_nav: false, behind_overflow: false });
    assert.ok(result > 0.4 && result < 0.7);
  });

  it('caps at 1.0 for maximum burial', () => {
    const result = computeDiscoverability({ depth: 10, in_primary_nav: false, behind_overflow: true });
    assert.equal(result, 1.0);
  });
});

// =============================================================================
// computeRuntimeConfidence
// =============================================================================

describe('computeRuntimeConfidence', () => {
  it('returns 0 when no coverage data', () => {
    assert.equal(computeRuntimeConfidence('trigger:/|Docs', null), 0);
  });

  it('returns 1.0 for fully_covered', () => {
    assert.equal(computeRuntimeConfidence('trigger:/|Docs', fixtures.coverage), 1.0);
  });

  it('returns 0.5 for partial', () => {
    assert.equal(computeRuntimeConfidence('trigger:/docs|Search', fixtures.coverage), 0.5);
  });

  it('returns 0.0 for untested', () => {
    assert.equal(computeRuntimeConfidence('trigger:/settings|Delete Account', fixtures.coverage), 0.0);
  });
});

// =============================================================================
// buildSurfaceInventory
// =============================================================================

describe('buildSurfaceInventory', () => {
  it('groups triggers into correct locations', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    assert.equal(inv.groups.primary_nav.length, 2); // Docs, Get Started
    assert.equal(inv.groups.overflow.length, 1); // More...
    assert.equal(inv.groups.settings.length, 1); // Delete Account
  });

  it('counts total correctly', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    assert.equal(inv.stats.total, 5);
  });

  it('detects destructive triggers', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    assert.equal(inv.stats.destructive_count, 1);
    const delEntry = inv.groups.settings.find(e => e.label === 'Delete Account');
    assert.ok(delEntry);
    assert.equal(delEntry.safety, 'destructive');
  });

  it('handles empty graph', () => {
    const inv = buildSurfaceInventory(fixtures.graph_empty, fixtures.diff_empty, null);
    assert.equal(inv.stats.total, 0);
    assert.equal(inv.groups.primary_nav.length, 0);
  });
});

// =============================================================================
// buildFeatureMap
// =============================================================================

describe('buildFeatureMap', () => {
  it('includes atlas features with from_atlas=true', () => {
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const doc = fm.features.find(f => f.feature_id === 'documentation');
    assert.ok(doc);
    assert.equal(doc.from_atlas, true);
  });

  it('marks ungrounded documented-not-discoverable as skip', () => {
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const apiKeys = fm.features.find(f => f.feature_id === 'api-keys');
    assert.ok(apiKeys);
    assert.equal(apiKeys.recommended_action, 'skip');
    assert.equal(apiKeys.discoverability, 1.0);
    assert.ok(fm.stats.ungrounded_count >= 1);
  });

  it('auto-clusters unmatched triggers with from_atlas=false', () => {
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const autoFeatures = fm.features.filter(f => !f.from_atlas);
    assert.ok(autoFeatures.length >= 1);
  });

  it('discoverability consistent with burial index', () => {
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const doc = fm.features.find(f => f.feature_id === 'documentation');
    assert.ok(doc);
    // Docs: depth=0, in_primary_nav, no overflow → disc = 0.0
    assert.equal(doc.discoverability, 0.0);
  });
});

// =============================================================================
// inferTaskFlows
// =============================================================================

describe('inferTaskFlows', () => {
  it('creates flows from navigation chains', () => {
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    assert.ok(flows.length >= 1);
    // Docs trigger navigates to /docs, which has Search (dead end)
    const docsFlow = flows.find(f => f.task_name === 'Docs flow');
    assert.ok(docsFlow);
    assert.ok(docsFlow.steps.length >= 2);
  });

  it('detects dead ends', () => {
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const docsFlow = flows.find(f => f.task_name === 'Docs flow');
    assert.ok(docsFlow);
    assert.equal(docsFlow.has_dead_end, true);
  });

  it('detects loops', () => {
    const flows = inferTaskFlows(fixtures.graph_loop, null);
    const loopFlow = flows.find(f => f.has_loop);
    assert.ok(loopFlow);
  });

  it('flags destructive steps', () => {
    // Create a graph with a destructive trigger in a flow
    const graph = {
      ...fixtures.graph,
      nodes: [
        ...fixtures.graph.nodes,
        { id: 'route:/danger', type: 'route', label: '/danger', route: '/danger', meta: {} },
        { id: 'trigger:/danger|Destroy', type: 'trigger', label: 'Destroy', route: '/danger', meta: { element: 'button', parent_nav: false, depth: 2 } },
      ],
      edges: [
        ...fixtures.graph.edges,
        { from: 'trigger:/|Docs', to: 'route:/danger', type: 'navigates_to' },
        { from: 'route:/danger', to: 'trigger:/danger|Destroy', type: 'contains' },
      ],
    };
    // Override the Docs navigates_to edge
    graph.edges = graph.edges.filter(e => !(e.from === 'trigger:/|Docs' && e.to === 'route:/docs' && e.type === 'navigates_to'));
    const flows = inferTaskFlows(graph, null);
    const destructiveFlow = flows.find(f => f.has_destructive_step);
    assert.ok(destructiveFlow);
  });
});

// =============================================================================
// proposeIA
// =============================================================================

describe('proposeIA', () => {
  it('primary nav capped at 7', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const proposal = proposeIA(inv, fm, flows);
    assert.ok(proposal.primary_nav.length <= 7);
  });

  it('skipped features excluded from must-surface', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const proposal = proposeIA(inv, fm, flows);
    // API Keys is ungrounded (skip), should NOT appear in must-surface
    assert.ok(!proposal.must_surface.some(m => m.label === 'API Keys'));
  });

  it('settings-classified items appear in demote_to_advanced', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const proposal = proposeIA(inv, fm, flows);
    assert.ok(proposal.demote_to_advanced.some(d => d.label === 'Delete Account'));
  });
});

// =============================================================================
// Markdown renderers
// =============================================================================

describe('renderSurfaceInventoryMd', () => {
  it('contains heading and location group sections', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    const md = renderSurfaceInventoryMd(inv);
    assert.ok(md.includes('# UI Surface Inventory'));
    assert.ok(md.includes('## Primary Nav'));
    assert.ok(md.includes('| Route | Label | Role | Safety | Effects |'));
  });
});

describe('renderFeatureMapMd', () => {
  it('contains both documentation and auto-discovered sections', () => {
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const md = renderFeatureMapMd(fm);
    assert.ok(md.includes('# UI Feature Map'));
    assert.ok(md.includes('## Features from Documentation'));
    assert.ok(md.includes('## Auto-Discovered Features'));
  });
});

describe('renderTaskFlowsMd', () => {
  it('contains heading and flow entries', () => {
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const md = renderTaskFlowsMd(flows);
    assert.ok(md.includes('# UI Task Flows'));
    assert.ok(md.includes('flow(s) inferred'));
  });
});

describe('renderIAProposalMd', () => {
  it('contains all sections', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const proposal = proposeIA(inv, fm, flows);
    const md = renderIAProposalMd(proposal);
    assert.ok(md.includes('# IA Proposal'));
    assert.ok(md.includes('## Primary Navigation'));
    assert.ok(md.includes('## Must-Surface'));
    assert.ok(md.includes('## Demote to Advanced'));
  });
});

// =============================================================================
// Round-trip
// =============================================================================

describe('round-trip', () => {
  it('empty graph produces empty artifacts', () => {
    const inv = buildSurfaceInventory(fixtures.graph_empty, fixtures.diff_empty, null);
    const fm = buildFeatureMap(fixtures.graph_empty, fixtures.diff_empty, null, null);
    const flows = inferTaskFlows(fixtures.graph_empty, null);
    const proposal = proposeIA(inv, fm, flows);

    assert.equal(inv.stats.total, 0);
    assert.equal(fm.stats.total, 0);
    assert.equal(flows.length, 0);
    assert.equal(proposal.primary_nav.length, 0);
    assert.equal(proposal.must_surface.length, 0);
  });
});

// =============================================================================
// Fix 1: Nav Deduplication
// =============================================================================

describe('nav deduplication', () => {
  it('unique count is less than raw count for duplicate nav items', () => {
    const inv = buildSurfaceInventory(fixtures.graph_multipage, fixtures.diff_multipage, null);
    // 6 raw primary_nav entries (Tools + About × 3 routes)
    assert.equal(inv.groups.primary_nav.length, 6);
    // 2 unique entries after dedup
    assert.equal(inv.deduplicated.primary_nav.length, 2);
    assert.equal(inv.stats.unique, 2);
  });

  it('route_coverage reflects number of routes the item appears on', () => {
    const inv = buildSurfaceInventory(fixtures.graph_multipage, fixtures.diff_multipage, null);
    const tools = inv.deduplicated.primary_nav.find(e => e.label === 'Tools');
    assert.ok(tools);
    assert.equal(tools.route_coverage, 3);
  });

  it('coverage_percent equals route_coverage / total_routes', () => {
    const inv = buildSurfaceInventory(fixtures.graph_multipage, fixtures.diff_multipage, null);
    const tools = inv.deduplicated.primary_nav.find(e => e.label === 'Tools');
    assert.ok(tools);
    assert.equal(tools.coverage_percent, 3 / 3); // 3 routes out of 3
    assert.equal(inv.stats.total_routes, 3);
  });
});

// =============================================================================
// Fix 2: Browse Loop Classification
// =============================================================================

describe('browse loop classification', () => {
  it('hub route → browse_loop type', () => {
    const flows = inferTaskFlows(fixtures.graph_hub, null);
    // Go Hub → Link A → Back Hub creates a loop through /hub (a hub with 5+ outgoing)
    const browseFlow = flows.find(f => f.loop_type === 'browse_loop');
    assert.ok(browseFlow, 'Expected a browse_loop flow through the hub');
  });

  it('nav-only loop in graph_loop → nav_loop type', () => {
    const flows = inferTaskFlows(fixtures.graph_loop, null);
    // graph_loop: /a → /b → /a, both triggers are parent_nav
    const navFlow = flows.find(f => f.loop_type === 'nav_loop');
    assert.ok(navFlow, 'Expected a nav_loop since both triggers are parent_nav');
  });

  it('non-nav loop → circular type', () => {
    // Create inline graph with non-nav triggers to test circular detection
    const circularGraph = {
      ...fixtures.graph_loop,
      nodes: fixtures.graph_loop.nodes.map(n =>
        n.type === 'trigger' ? { ...n, meta: { ...n.meta, parent_nav: false } } : n
      ),
    };
    const flows = inferTaskFlows(circularGraph, null);
    const circularFlow = flows.find(f => f.loop_type === 'circular');
    assert.ok(circularFlow, 'Expected a circular flow with non-nav triggers');
  });

  it('goal_reached for slug route', () => {
    const flows = inferTaskFlows(fixtures.graph_goal, null);
    const goalFlow = flows.find(f => f.goal_reached);
    assert.ok(goalFlow, 'Expected a flow reaching /tools/my-tool');
  });

  it('no goal for simple index loops', () => {
    const flows = inferTaskFlows(fixtures.graph_loop, null);
    // /a and /b are not slug routes, no docs/install/etc.
    assert.ok(flows.every(f => !f.goal_reached));
  });
});

// =============================================================================
// Fix 2b: Hub detection ignores nav, nav_loop type
// =============================================================================

describe('hub detection with nav triggers', () => {
  it('route with only nav triggers is NOT a hub', () => {
    // graph_nav_hub: / has 5 nav triggers + 1 content trigger
    // After skipping nav, only 1 content outgoing → NOT a hub
    const flows = inferTaskFlows(fixtures.graph_nav_hub, null);
    // No flow should be a browse_loop (/ is not a hub)
    assert.ok(flows.every(f => f.loop_type !== 'browse_loop'),
      'Expected no browse_loop since nav triggers should be excluded from hub detection');
  });

  it('nav-only loop → nav_loop type', () => {
    const flows = inferTaskFlows(fixtures.graph_nav_loop, null);
    const navLoop = flows.find(f => f.loop_type === 'nav_loop');
    assert.ok(navLoop, 'Expected a nav_loop when all steps use parent_nav triggers');
  });

  it('proposeIA reports nav loops in grouping notes', () => {
    const inv = buildSurfaceInventory(fixtures.graph_nav_loop, fixtures.diff_empty, null);
    const fm = buildFeatureMap(fixtures.graph_nav_loop, fixtures.diff_empty, null, null);
    const flows = inferTaskFlows(fixtures.graph_nav_loop, null);
    const proposal = proposeIA(inv, fm, flows);
    const hasNavNote = proposal.grouping_notes.some(n => n.includes('nav loop'));
    assert.ok(hasNavNote, 'Expected grouping note about nav loops');
  });
});

// =============================================================================
// Fix 3b: GOAL_RE with basePath + goalRoutes
// =============================================================================

describe('goal detection with basePath', () => {
  it('basePath-prefixed single-segment route is NOT a goal', () => {
    // /LoKey-Typer/competitive with basePath → strips to /competitive (single segment, not a slug)
    const graph = {
      ...fixtures.graph_loop,
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'route:/LoKey-Typer/competitive', type: 'route', label: '/LoKey-Typer/competitive', route: '/LoKey-Typer/competitive', meta: {} },
        { id: 'trigger:/|Competitive', type: 'trigger', label: 'Competitive', route: '/', meta: { element: 'a', parent_nav: false, depth: 0, href: '/LoKey-Typer/competitive' } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|Competitive', type: 'contains' },
        { from: 'trigger:/|Competitive', to: 'route:/LoKey-Typer/competitive', type: 'navigates_to' },
      ],
    };
    const flows = inferTaskFlows(graph, null, '/LoKey-Typer');
    assert.ok(flows.every(f => !f.goal_reached),
      'Single-segment route after basePath strip should not be a goal');
  });

  it('slug route without basePath is still a goal', () => {
    // /tools/my-tool → two segments → goal (existing behavior)
    const flows = inferTaskFlows(fixtures.graph_goal, null, '');
    const goalFlow = flows.find(f => f.goal_reached);
    assert.ok(goalFlow, 'Existing slug detection must still work');
  });

  it('goalRoutes config overrides GOAL_RE', () => {
    // /competitive is NOT a slug, but if configured as goalRoute, it should be a goal
    const graph = {
      ...fixtures.graph_loop,
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'route:/competitive', type: 'route', label: '/competitive', route: '/competitive', meta: {} },
        { id: 'trigger:/|Play', type: 'trigger', label: 'Play', route: '/', meta: { element: 'a', parent_nav: false, depth: 0, href: '/competitive' } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|Play', type: 'contains' },
        { from: 'trigger:/|Play', to: 'route:/competitive', type: 'navigates_to' },
      ],
    };
    const flows = inferTaskFlows(graph, null, '', ['/competitive']);
    const goalFlow = flows.find(f => f.goal_reached);
    assert.ok(goalFlow, 'goalRoutes config should force goal_reached=true');
  });
});

// =============================================================================
// Fix 3: Feature Grounding
// =============================================================================

describe('feature grounding', () => {
  it('sentence-like names get skip action', () => {
    const fm = buildFeatureMap(fixtures.graph_empty, fixtures.diff_noisy, null, fixtures.atlas_noisy);
    const doNotAbbreviate = fm.features.find(f => f.feature_id === 'do-not-abbreviate-to-mcts');
    assert.ok(doNotAbbreviate);
    assert.equal(doNotAbbreviate.recommended_action, 'skip');
  });

  it('real feature names with trigger match get promote', () => {
    // "Tool Compass" in atlas_noisy — need a graph with matching trigger label
    const graphWithCompass = {
      ...fixtures.graph_empty,
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'trigger:/|Tool Compass', type: 'trigger', label: 'Tool Compass', route: '/', meta: { element: 'a', parent_nav: true, depth: 0, href: '/compass' } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|Tool Compass', type: 'contains' },
      ],
    };
    const fm = buildFeatureMap(graphWithCompass, fixtures.diff_noisy, null, fixtures.atlas_noisy);
    const compass = fm.features.find(f => f.feature_id === 'tool-compass');
    assert.ok(compass);
    assert.notEqual(compass.recommended_action, 'skip');
  });

  it('ungrounded_count is tracked in stats', () => {
    const fm = buildFeatureMap(fixtures.graph_empty, fixtures.diff_noisy, null, fixtures.atlas_noisy);
    // At least 2 sentence-like features should be ungrounded: "Do not abbreviate..." and "Use the logo..."
    assert.ok(fm.stats.ungrounded_count >= 2);
  });

  it('skipped features excluded from IA must_surface', () => {
    const inv = buildSurfaceInventory(fixtures.graph_empty, fixtures.diff_noisy, null);
    const fm = buildFeatureMap(fixtures.graph_empty, fixtures.diff_noisy, null, fixtures.atlas_noisy);
    const flows = inferTaskFlows(fixtures.graph_empty, null);
    const proposal = proposeIA(inv, fm, flows);
    // Sentence-like features should NOT appear in must_surface
    assert.ok(!proposal.must_surface.some(m => m.label.startsWith('Do not')));
    assert.ok(!proposal.must_surface.some(m => m.label.startsWith('Use the logo')));
  });
});

// =============================================================================
// Fix 3 helper: looksLikeSentence
// =============================================================================

describe('looksLikeSentence', () => {
  it('returns true for "do not" starters', () => {
    assert.equal(looksLikeSentence('Do not abbreviate to MCTS'), true);
  });

  it('returns true for long names (>8 words)', () => {
    assert.equal(looksLikeSentence('Use the logo at its original aspect ratio three two'), true);
  });

  it('returns false for short feature names', () => {
    assert.equal(looksLikeSentence('Tool Compass'), false);
  });

  it('returns false for short nouns', () => {
    assert.equal(looksLikeSentence('API Keys'), false);
  });
});

// =============================================================================
// Fix 4: Structure-Based IA Fallback
// =============================================================================

describe('IA fallback', () => {
  it('falls back to inventory when 0 atlas candidates', () => {
    const inv = buildSurfaceInventory(fixtures.graph_multipage, fixtures.diff_multipage, null);
    const fm = buildFeatureMap(fixtures.graph_multipage, fixtures.diff_multipage, null, null);
    const flows = inferTaskFlows(fixtures.graph_multipage, null);
    const proposal = proposeIA(inv, fm, flows);
    // No atlas → 0 feature candidates, fallback to deduplicated primary_nav
    assert.ok(proposal.primary_nav.length > 0);
    assert.ok(proposal.primary_nav[0].reason.includes('Site structure'));
  });

  it('does not fall back when atlas candidates exist', () => {
    const inv = buildSurfaceInventory(fixtures.graph, fixtures.diff, fixtures.coverage);
    const fm = buildFeatureMap(fixtures.graph, fixtures.diff, fixtures.coverage, fixtures.atlas);
    const flows = inferTaskFlows(fixtures.graph, fixtures.coverage);
    const proposal = proposeIA(inv, fm, flows);
    // Atlas has "Documentation" at disc=0.0 — should be picked as primary
    if (proposal.primary_nav.length > 0) {
      assert.ok(!proposal.primary_nav[0].reason.includes('Site structure'));
    }
  });

  it('conversion_paths populated for primary nav items', () => {
    const inv = buildSurfaceInventory(fixtures.graph_goal, fixtures.diff_empty, null);
    const fm = buildFeatureMap(fixtures.graph_goal, fixtures.diff_empty, null, null);
    const flows = inferTaskFlows(fixtures.graph_goal, null);
    const proposal = proposeIA(inv, fm, flows);
    assert.ok(proposal.conversion_paths);
    assert.ok(Array.isArray(proposal.conversion_paths));
  });

  it('conversion_paths empty when no primary nav', () => {
    const inv = buildSurfaceInventory(fixtures.graph_empty, fixtures.diff_empty, null);
    const fm = buildFeatureMap(fixtures.graph_empty, fixtures.diff_empty, null, null);
    const flows = inferTaskFlows(fixtures.graph_empty, null);
    const proposal = proposeIA(inv, fm, flows);
    assert.equal(proposal.conversion_paths.length, 0);
  });
});

// =============================================================================
// isArchitecturalCapability
// =============================================================================

describe('isArchitecturalCapability', () => {
  it('detects "Full offline support" as architectural', () => {
    assert.equal(isArchitecturalCapability('Full offline support'), true);
  });

  it('detects "Local-only persistence" as architectural', () => {
    assert.equal(isArchitecturalCapability('Local-only persistence'), true);
  });

  it('detects "Accessible" as architectural', () => {
    assert.equal(isArchitecturalCapability('Accessible'), true);
  });

  it('does not flag "Mechanical typewriter keystroke audio"', () => {
    assert.equal(isArchitecturalCapability('Mechanical typewriter keystroke audio'), false);
  });

  it('does not flag "Four practice modes"', () => {
    assert.equal(isArchitecturalCapability('Four practice modes'), false);
  });

  it('detects "Full offline support via service worker"', () => {
    assert.equal(isArchitecturalCapability('Full offline support via service worker'), true);
  });
});

// =============================================================================
// proposeIA — documented_non_surface
// =============================================================================

describe('proposeIA — documented_non_surface', () => {
  // Build a featureMap with a mix of architectural and UI promote features
  function makeFeatureMap(features) {
    return {
      version: '1.0.0',
      generated_at: new Date().toISOString(),
      features,
      stats: { total: features.length, from_atlas: features.length, auto_clustered: 0, promote_count: features.filter(f => f.recommended_action === 'promote').length, demote_count: 0, ungrounded_count: 0 },
    };
  }

  function makePromoteFeature(name) {
    return {
      feature_id: name.toLowerCase().replace(/\s+/g, '-'),
      feature_name: name,
      entry_points: [],
      click_depth: { '/': 0 },
      discoverability: 0.8,
      runtime_confidence: 0,
      recommended_action: 'promote',
      rationale: 'Documented in README.md:10 but has no UI surface',
      from_atlas: true,
    };
  }

  const emptyInv = {
    version: '1.0.0', generated_at: '', groups: {}, deduplicated: {},
    stats: { total: 0, unique: 0, destructive_count: 0, total_routes: 0 },
  };

  it('separates architectural capabilities into documented_non_surface', () => {
    const fm = makeFeatureMap([
      makePromoteFeature('Full offline support'),
      makePromoteFeature('Mechanical typewriter keystroke audio'),
    ]);
    const proposal = proposeIA(emptyInv, fm, []);
    assert.equal(proposal.documented_non_surface.length, 1);
    assert.equal(proposal.documented_non_surface[0].label, 'Full offline support');
    assert.equal(proposal.must_surface.length, 1);
    assert.equal(proposal.must_surface[0].label, 'Mechanical typewriter keystroke audio');
  });

  it('documented_non_surface is empty when no architectural features', () => {
    const fm = makeFeatureMap([
      makePromoteFeature('Mechanical typewriter keystroke audio'),
    ]);
    const proposal = proposeIA(emptyInv, fm, []);
    assert.equal(proposal.documented_non_surface.length, 0);
    assert.equal(proposal.must_surface.length, 1);
  });

  it('multiple architectural features all go to documented_non_surface', () => {
    const fm = makeFeatureMap([
      makePromoteFeature('Full offline support'),
      makePromoteFeature('Local-only persistence'),
      makePromoteFeature('Accessible'),
    ]);
    const proposal = proposeIA(emptyInv, fm, []);
    assert.equal(proposal.documented_non_surface.length, 3);
    assert.equal(proposal.must_surface.length, 0);
  });

  it('renders documented_non_surface section in markdown', () => {
    const fm = makeFeatureMap([makePromoteFeature('Full offline support')]);
    const proposal = proposeIA(emptyInv, fm, []);
    const md = renderIAProposalMd(proposal);
    assert.ok(md.includes('## Documented Non-Surface (1)'));
    assert.ok(md.includes('Full offline support'));
    assert.ok(md.includes('architectural capability'));
  });
});

// =============================================================================
// Effect-based goals
// =============================================================================

describe('effect-based goals', () => {
  // Helper: build a graph with a trigger that navigates and optionally has observed effects
  function makeEffectGraph({ effectKind, observed, edgeType = 'produces' }) {
    return {
      version: '1.0.0', generated_at: '', stats: { total_nodes: 0, by_type: {}, total_edges: 0, by_edge_type: {}, orphan_features: 0, orphan_triggers: 0 },
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'route:/play', type: 'route', label: '/play', route: '/play', meta: {} },
        { id: 'trigger:/|Start', type: 'trigger', label: 'Start', route: '/', meta: { element: 'button', parent_nav: false, depth: 0 } },
        { id: 'surface:play-btn', type: 'surface', label: 'Start', route: '/', meta: {} },
        { id: 'effect:storageWrite:score', type: 'effect', label: 'storageWrite', route: '/play', meta: { kind: effectKind, observed: observed } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|Start', type: 'contains' },
        { from: 'trigger:/|Start', to: 'route:/play', type: 'navigates_to' },
        { from: 'trigger:/|Start', to: 'surface:play-btn', type: 'maps_to' },
        { from: 'surface:play-btn', to: 'effect:storageWrite:score', type: edgeType },
      ],
    };
  }

  it('flow with observed storageWrite effect → goal_reached: true', () => {
    const graph = makeEffectGraph({ effectKind: 'storageWrite', observed: true });
    const flows = inferTaskFlows(graph, null);
    assert.ok(flows.length > 0);
    assert.ok(flows.some(f => f.goal_reached), 'Observed storageWrite should trigger effect-based goal');
  });

  it('flow with observed domEffect → goal_reached: true', () => {
    const graph = makeEffectGraph({ effectKind: 'domEffect', observed: true });
    const flows = inferTaskFlows(graph, null);
    assert.ok(flows.some(f => f.goal_reached), 'Observed domEffect should trigger effect-based goal');
  });

  it('flow with unobserved effect → goal_reached: false', () => {
    const graph = makeEffectGraph({ effectKind: 'storageWrite', observed: false });
    const flows = inferTaskFlows(graph, null);
    // /play is a single segment and not in GOAL_RE, so no route goal either
    if (flows.length > 0) {
      assert.ok(flows.every(f => !f.goal_reached), 'Unobserved effect should not be a goal');
    }
  });

  it('route-based goal still works (backward compat)', () => {
    const flows = inferTaskFlows(fixtures.graph_goal, null, '');
    const goalFlow = flows.find(f => f.goal_reached);
    assert.ok(goalFlow, 'Existing route-based goal detection must still work');
  });

  it('flow with both route goal and effect goal → goal_reached: true', () => {
    // Use graph_goal which has route-based goals, add an observed effect
    const graph = JSON.parse(JSON.stringify(fixtures.graph_goal));
    graph.nodes.push({ id: 'effect:test:write', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed: true } });
    const flows = inferTaskFlows(graph, null, '');
    const goalFlow = flows.find(f => f.goal_reached);
    assert.ok(goalFlow, 'Route goal should still work even with effects present');
  });

  it('observed effect via runtime_observed edge → goal_reached: true', () => {
    const graph = {
      version: '1.0.0', generated_at: '', stats: { total_nodes: 0, by_type: {}, total_edges: 0, by_edge_type: {}, orphan_features: 0, orphan_triggers: 0 },
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'route:/run', type: 'route', label: '/run', route: '/run', meta: {} },
        { id: 'trigger:/|Begin', type: 'trigger', label: 'Begin', route: '/', meta: { element: 'button', parent_nav: false, depth: 0 } },
        { id: 'effect:runtime:fetch', type: 'effect', label: 'fetch', route: '/', meta: { kind: 'fetch', observed: true } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|Begin', type: 'contains' },
        { from: 'trigger:/|Begin', to: 'route:/run', type: 'navigates_to' },
        { from: 'trigger:/|Begin', to: 'effect:runtime:fetch', type: 'runtime_observed' },
      ],
    };
    const flows = inferTaskFlows(graph, null);
    assert.ok(flows.some(f => f.goal_reached), 'runtime_observed edge should enable effect-based goal');
  });

  it('no effect nodes in graph → goal_reached: false (no crash)', () => {
    // Simple 2-route graph with no effects and no goal routes
    const graph = {
      version: '1.0.0', generated_at: '', stats: { total_nodes: 0, by_type: {}, total_edges: 0, by_edge_type: {}, orphan_features: 0, orphan_triggers: 0 },
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'route:/about', type: 'route', label: '/about', route: '/about', meta: {} },
        { id: 'trigger:/|About', type: 'trigger', label: 'About', route: '/', meta: { element: 'a', parent_nav: false, depth: 0 } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|About', type: 'contains' },
        { from: 'trigger:/|About', to: 'route:/about', type: 'navigates_to' },
      ],
    };
    const flows = inferTaskFlows(graph, null);
    if (flows.length > 0) {
      assert.ok(flows.every(f => !f.goal_reached), 'No effects means no effect-based goals');
    }
  });
});

// =============================================================================
// getObservedEffectDetails (unit)
// =============================================================================

describe('getObservedEffectDetails', () => {
  it('returns observed effect nodes through surface chain', () => {
    const graph = {
      version: '1.0.0', generated_at: '', stats: {},
      nodes: [
        { id: 'trigger:/|Click', type: 'trigger', label: 'Click', route: '/', meta: {} },
        { id: 'surface:btn', type: 'surface', label: 'Click', route: '/', meta: {} },
        { id: 'effect:write:key', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed: true } },
      ],
      edges: [
        { from: 'trigger:/|Click', to: 'surface:btn', type: 'maps_to' },
        { from: 'surface:btn', to: 'effect:write:key', type: 'produces' },
      ],
    };
    const result = getObservedEffectDetails('trigger:/|Click', graph);
    assert.equal(result.length, 1);
    assert.equal(result[0].meta.kind, 'storageWrite');
  });

  it('returns empty for unobserved effect nodes', () => {
    const graph = {
      version: '1.0.0', generated_at: '', stats: {},
      nodes: [
        { id: 'trigger:/|Click', type: 'trigger', label: 'Click', route: '/', meta: {} },
        { id: 'surface:btn', type: 'surface', label: 'Click', route: '/', meta: {} },
        { id: 'effect:write:key', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed: false } },
      ],
      edges: [
        { from: 'trigger:/|Click', to: 'surface:btn', type: 'maps_to' },
        { from: 'surface:btn', to: 'effect:write:key', type: 'produces' },
      ],
    };
    const result = getObservedEffectDetails('trigger:/|Click', graph);
    assert.equal(result.length, 0);
  });
});

// =============================================================================
// hasRuntimeEvidence (Stage 0E)
// =============================================================================

describe('hasRuntimeEvidence', () => {
  it('returns true when graph has observed effect nodes', () => {
    const graph = {
      nodes: [
        { id: 'trigger:/|Btn', type: 'trigger', label: 'Btn', route: '/', meta: {} },
        { id: 'effect:sw:key', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed: true } },
      ],
      edges: [],
    };
    assert.equal(hasRuntimeEvidence(graph), true);
  });

  it('returns false when no observed effect nodes exist', () => {
    const graph = {
      nodes: [
        { id: 'trigger:/|Btn', type: 'trigger', label: 'Btn', route: '/', meta: {} },
        { id: 'effect:sw:key', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed: false } },
      ],
      edges: [],
    };
    assert.equal(hasRuntimeEvidence(graph), false);
  });

  it('returns false for empty graph', () => {
    assert.equal(hasRuntimeEvidence({ nodes: [], edges: [] }), false);
  });
});

// =============================================================================
// evaluateGoalRules (Stage 0E)
// =============================================================================

describe('evaluateGoalRules', () => {
  /** Helper: build a minimal graph with a trigger and connected effect node */
  function goalGraph(triggerId, effectNode, edgeType = 'runtime_observed') {
    return {
      nodes: [
        { id: triggerId, type: 'trigger', label: 'Btn', route: '/', meta: {} },
        effectNode,
      ],
      edges: [
        { from: triggerId, to: effectNode.id, type: edgeType },
      ],
    };
  }

  it('returns empty when goalRules is empty', () => {
    const graph = { nodes: [], edges: [] };
    assert.deepEqual(evaluateGoalRules('trigger:/|X', graph, [], true), []);
  });

  it('matches storageWrite rule with keyRegex', () => {
    const graph = goalGraph('trigger:/|Save', {
      id: 'effect:sw:audio.vol', type: 'effect', label: 'storageWrite', route: '/',
      meta: { kind: 'storageWrite', observed: true, key: 'lokey.audio.volume' },
    });
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: '^lokey\\.audio\\.' }, score: 5 }];
    const hits = evaluateGoalRules('trigger:/|Save', graph, rules, true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule_id, 'audio_change');
    assert.equal(hits[0].score, 5);
    assert.equal(hits[0].confidence, 'observed');
    assert.ok(hits[0].evidence_summary.includes('lokey.audio.volume'));
  });

  it('does not match storageWrite rule when keyRegex fails', () => {
    const graph = goalGraph('trigger:/|Save', {
      id: 'effect:sw:other', type: 'effect', label: 'storageWrite', route: '/',
      meta: { kind: 'storageWrite', observed: true, key: 'app.theme' },
    });
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: '^lokey\\.audio\\.' }, score: 5 }];
    const hits = evaluateGoalRules('trigger:/|Save', graph, rules, true);
    assert.equal(hits.length, 0);
  });

  it('matches fetch rule with method and urlRegex', () => {
    const graph = goalGraph('trigger:/|Submit', {
      id: 'effect:fetch:api', type: 'effect', label: 'fetch', route: '/',
      meta: { kind: 'fetch', observed: true, method: 'POST', url: '/api/save-score' },
    });
    const rules = [{ id: 'score_save', label: 'Save Score', kind: 'fetch', fetch: { method: ['POST'], urlRegex: '/api/save' }, score: 3 }];
    const hits = evaluateGoalRules('trigger:/|Submit', graph, rules, true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule_id, 'score_save');
    assert.equal(hits[0].confidence, 'observed');
  });

  it('matches domEffect rule with textRegex', () => {
    const graph = goalGraph('trigger:/|Settings', {
      id: 'effect:dom:modal', type: 'effect', label: 'domEffect', route: '/',
      meta: { kind: 'domEffect', observed: true, detail: 'modal_open' },
    });
    const rules = [{ id: 'settings_open', label: 'Open Settings', kind: 'domEffect', dom: { textRegex: 'modal_open' }, score: 2 }];
    const hits = evaluateGoalRules('trigger:/|Settings', graph, rules, true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule_id, 'settings_open');
    assert.ok(hits[0].evidence_summary.includes('modal_open'));
  });

  it('matches domEffect rule with goalId (data-aiui-goal convention)', () => {
    const graph = goalGraph('trigger:/|Settings', {
      id: 'effect:dom:goal', type: 'effect', label: 'domEffect', route: '/',
      meta: { kind: 'domEffect', observed: true, goalId: 'audio_settings_open', detail: 'modal_open' },
    });
    const rules = [{ id: 'audio_open', label: 'Open Audio Settings', kind: 'domEffect', dom: { goalId: 'audio_settings_open' }, score: 2 }];
    const hits = evaluateGoalRules('trigger:/|Settings', graph, rules, true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].evidence_summary, 'goalId: audio_settings_open');
  });

  it('matches composite rule when all sub-predicates match', () => {
    const graph = {
      nodes: [
        { id: 'trigger:/|Save', type: 'trigger', label: 'Save', route: '/', meta: {} },
        { id: 'effect:dom:modal', type: 'effect', label: 'domEffect', route: '/', meta: { kind: 'domEffect', observed: true, detail: 'modal_open' } },
        { id: 'effect:sw:pref', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed: true, key: 'lokey.audio.vol' } },
      ],
      edges: [
        { from: 'trigger:/|Save', to: 'effect:dom:modal', type: 'runtime_observed' },
        { from: 'trigger:/|Save', to: 'effect:sw:pref', type: 'runtime_observed' },
      ],
    };
    const rules = [{
      id: 'settings_saved', label: 'Settings Saved', kind: 'composite', score: 7,
      dom: { textRegex: 'modal' },
      storage: { keyRegex: 'lokey\\.audio' },
    }];
    const hits = evaluateGoalRules('trigger:/|Save', graph, rules, true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule_id, 'settings_saved');
    assert.equal(hits[0].score, 7);
    assert.equal(hits[0].confidence, 'observed');
    assert.ok(hits[0].evidence_summary.includes('+'));
  });

  it('rejects composite rule when one sub-predicate fails', () => {
    const graph = goalGraph('trigger:/|Save', {
      id: 'effect:dom:modal', type: 'effect', label: 'domEffect', route: '/',
      meta: { kind: 'domEffect', observed: true, detail: 'modal_open' },
    });
    // Composite requires storage + dom, but only dom is present
    const rules = [{
      id: 'settings_saved', label: 'Settings Saved', kind: 'composite', score: 7,
      dom: { textRegex: 'modal' },
      storage: { keyRegex: 'lokey\\.audio' },
    }];
    const hits = evaluateGoalRules('trigger:/|Save', graph, rules, true);
    assert.equal(hits.length, 0);
  });

  it('returns unknown confidence when no runtime evidence exists', () => {
    const graph = goalGraph('trigger:/|Save', {
      id: 'effect:sw:key', type: 'effect', label: 'storageWrite', route: '/',
      meta: { kind: 'storageWrite', observed: false, key: 'lokey.audio.vol' },
    });
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: 'lokey\\.audio' }, score: 5 }];
    // runtimePresent=false → should still match structurally with unknown confidence
    const hits = evaluateGoalRules('trigger:/|Save', graph, rules, false);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].confidence, 'unknown');
  });

  it('uses default score of 1 when not specified', () => {
    const graph = goalGraph('trigger:/|Btn', {
      id: 'effect:dom:toast', type: 'effect', label: 'domEffect', route: '/',
      meta: { kind: 'domEffect', observed: true, detail: 'toast' },
    });
    const rules = [{ id: 'notify', label: 'Show Toast', kind: 'domEffect', dom: { textRegex: 'toast' } }];
    const hits = evaluateGoalRules('trigger:/|Btn', graph, rules, true);
    assert.equal(hits[0].score, 1);
  });
});

// =============================================================================
// deduplicateGoalHits (Stage 0E)
// =============================================================================

describe('deduplicateGoalHits', () => {
  it('keeps highest-score hit per rule_id', () => {
    const hits = [
      { rule_id: 'a', rule_label: 'A', score: 3, evidence_summary: 'first', confidence: 'observed' },
      { rule_id: 'a', rule_label: 'A', score: 5, evidence_summary: 'second', confidence: 'observed' },
      { rule_id: 'b', rule_label: 'B', score: 1, evidence_summary: 'third', confidence: 'unknown' },
    ];
    const result = deduplicateGoalHits(hits);
    assert.equal(result.length, 2);
    assert.equal(result.find(h => h.rule_id === 'a').score, 5);
    assert.equal(result.find(h => h.rule_id === 'b').score, 1);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(deduplicateGoalHits([]), []);
  });
});

// =============================================================================
// inferTaskFlows + goalRules integration (Stage 0E Fix 3)
// =============================================================================

describe('inferTaskFlows with goalRules', () => {
  // Reusable graph: trigger navigates, trigger has an observed storageWrite effect
  function makeGoalRuleGraph({ key = 'lokey.audio.vol', observed = true } = {}) {
    return {
      version: '1.0.0', generated_at: '', stats: { total_nodes: 0, by_type: {}, total_edges: 0, by_edge_type: {}, orphan_features: 0, orphan_triggers: 0 },
      nodes: [
        { id: 'route:/', type: 'route', label: '/', route: '/', meta: {} },
        { id: 'route:/play', type: 'route', label: '/play', route: '/play', meta: {} },
        { id: 'trigger:/|Save', type: 'trigger', label: 'Save', route: '/', meta: { element: 'button', parent_nav: false, depth: 0 } },
        { id: 'surface:save-btn', type: 'surface', label: 'Save', route: '/', meta: {} },
        { id: 'effect:sw:key', type: 'effect', label: 'storageWrite', route: '/', meta: { kind: 'storageWrite', observed, key } },
      ],
      edges: [
        { from: 'route:/', to: 'trigger:/|Save', type: 'contains' },
        { from: 'trigger:/|Save', to: 'route:/play', type: 'navigates_to' },
        { from: 'trigger:/|Save', to: 'surface:save-btn', type: 'maps_to' },
        { from: 'surface:save-btn', to: 'effect:sw:key', type: 'produces' },
      ],
    };
  }

  it('step has goals_hit populated when goalRules match', () => {
    const graph = makeGoalRuleGraph();
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: 'lokey\\.audio' }, score: 5 }];
    const flows = inferTaskFlows(graph, null, '', [], rules);
    assert.ok(flows.length > 0);
    const flow = flows[0];
    const stepWithGoal = flow.steps.find(s => s.goals_hit?.length > 0);
    assert.ok(stepWithGoal, 'At least one step should have goals_hit');
    assert.equal(stepWithGoal.goals_hit[0].rule_id, 'audio_change');
  });

  it('flow has goals_reached and goal_score_total', () => {
    const graph = makeGoalRuleGraph();
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: 'lokey\\.audio' }, score: 5 }];
    const flows = inferTaskFlows(graph, null, '', [], rules);
    const flow = flows[0];
    assert.ok(flow.goal_reached, 'Flow should reach goal via rule');
    assert.ok(flow.goals_reached?.length > 0, 'goals_reached should be populated');
    assert.equal(flow.goals_reached[0].rule_id, 'audio_change');
    assert.equal(flow.goal_score_total, 5);
  });

  it('goal_reached is false when rules configured but no match', () => {
    const graph = makeGoalRuleGraph({ key: 'app.theme' });
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: '^lokey\\.audio\\.' }, score: 5 }];
    const flows = inferTaskFlows(graph, null, '', [], rules);
    const flow = flows[0];
    // With goalRules configured, legacy effect-based is disabled, and rule doesn't match
    assert.equal(flow.goal_reached, false);
    assert.equal(flow.goals_reached, undefined);
  });

  it('legacy effect-based goal preserved when no goalRules', () => {
    const graph = makeGoalRuleGraph();
    // No goalRules → falls back to legacy binary effect check
    const flows = inferTaskFlows(graph, null, '', [], []);
    const flow = flows[0];
    assert.ok(flow.goal_reached, 'Legacy effect-based goal should still work');
    assert.equal(flow.goals_reached, undefined, 'goals_reached should not be set without rules');
  });

  it('goals show unknown confidence when no runtime evidence', () => {
    const graph = makeGoalRuleGraph({ observed: false });
    const rules = [{ id: 'audio_change', label: 'Change Audio', kind: 'storageWrite', storage: { keyRegex: 'lokey\\.audio' }, score: 5 }];
    const flows = inferTaskFlows(graph, null, '', [], rules);
    const flow = flows[0];
    assert.ok(flow.goal_reached);
    assert.equal(flow.goals_reached[0].confidence, 'unknown');
  });

  it('route-based goals still work alongside goalRules', () => {
    const graph = makeGoalRuleGraph({ key: 'unrelated' });
    // Rule won't match, but goalRoutes includes /play
    const rules = [{ id: 'x', label: 'X', kind: 'storageWrite', storage: { keyRegex: '^nope$' }, score: 1 }];
    const flows = inferTaskFlows(graph, null, '', ['/play'], rules);
    const flow = flows[0];
    assert.ok(flow.goal_reached, 'Route-based goal should still work');
  });
});

// =============================================================================
// renderTaskFlowsMd with goal rules (Stage 0E Fix 3)
// =============================================================================

describe('renderTaskFlowsMd with goals', () => {
  it('renders goal labels in flow tags', () => {
    const flows = [{
      task_name: 'Save flow',
      steps: [{ trigger_label: 'Save', route: '/', step_type: 'navigate', effects: [], is_destructive: false, goals_hit: [{ rule_id: 'a', rule_label: 'Save Settings', score: 3, evidence_summary: 'storageWrite: prefs', confidence: 'observed' }] }],
      has_dead_end: false,
      has_loop: false,
      loop_type: null,
      goal_reached: true,
      has_destructive_step: false,
      total_depth: 1,
      goals_reached: [{ rule_id: 'a', rule_label: 'Save Settings', score: 3, evidence_summary: 'storageWrite: prefs', confidence: 'observed' }],
      goal_score_total: 3,
    }];
    const md = renderTaskFlowsMd(flows);
    assert.ok(md.includes('GOALS: Save Settings'), 'Should include goal label in tags');
    assert.ok(md.includes('[score: 3]'), 'Should include score');
    assert.ok(md.includes('**[Save Settings]**'), 'Should annotate step with goal hit');
  });

  it('renders legacy GOAL REACHED tag when no goals_reached', () => {
    const flows = [{
      task_name: 'Nav flow',
      steps: [{ trigger_label: 'Docs', route: '/', step_type: 'navigate', effects: ['navigate'], is_destructive: false }],
      has_dead_end: false,
      has_loop: false,
      loop_type: null,
      goal_reached: true,
      has_destructive_step: false,
      total_depth: 1,
    }];
    const md = renderTaskFlowsMd(flows);
    assert.ok(md.includes('GOAL REACHED'), 'Should show legacy tag');
    assert.ok(!md.includes('GOALS:'), 'Should not show GOALS: prefix');
  });
});
