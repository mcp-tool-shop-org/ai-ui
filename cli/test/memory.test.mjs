// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadMemory,
  mergeMemoryMappings,
  applyDecisions,
  applyExceptions,
  suggestMemoryEntries,
} from '../src/memory.mjs';

const FIX = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/memory-fixtures.json'), 'utf-8'));

// =============================================================================
// mergeMemoryMappings
// =============================================================================

describe('mergeMemoryMappings', () => {
  it('merges memory mappings into config format', () => {
    const result = mergeMemoryMappings({}, FIX.mappings);
    assert.equal(result['color-roles'], 'Color Roles');
    assert.equal(result['type-scale'], 'Typography Settings');
  });

  it('preserves existing config mappings', () => {
    const result = mergeMemoryMappings(FIX.configMapping, FIX.mappings);
    assert.equal(result['existing-feature'], 'Existing Button');
    assert.equal(result['color-roles'], 'Color Roles');
  });

  it('memory takes precedence over config on conflict', () => {
    const config = { 'color-roles': 'Old Label' };
    const result = mergeMemoryMappings(config, FIX.mappings);
    assert.equal(result['color-roles'], 'Color Roles');
  });

  it('handles empty memory mappings', () => {
    const result = mergeMemoryMappings(FIX.configMapping, {});
    assert.deepEqual(result, FIX.configMapping);
  });

  it('skips entries without trigger_label', () => {
    const bad = { 'bad-entry': { reason: 'no label' } };
    const result = mergeMemoryMappings({}, bad);
    assert.equal(result['bad-entry'], undefined);
  });
});

// =============================================================================
// applyDecisions
// =============================================================================

describe('applyDecisions', () => {
  it('splits orphans into decided and undecided', () => {
    const { decided, undecided } = applyDecisions(FIX.orphans, FIX.decisions);
    assert.equal(decided.length, 2); // fast-iteration, spacing
    assert.equal(undecided.length, 1); // color-roles
  });

  it('decided entries have correct decision data', () => {
    const { decided } = applyDecisions(FIX.orphans, FIX.decisions);
    const fast = decided.find(d => d.orphan.feature_id === 'fast-iteration');
    assert.ok(fast);
    assert.equal(fast.decision.priority, 'P1');
    assert.equal(fast.decision.rule, 'hero_cta');
    assert.equal(fast.decision.route, '/');
  });

  it('undecided entries are features without decisions', () => {
    const { undecided } = applyDecisions(FIX.orphans, FIX.decisions);
    assert.equal(undecided[0].feature_id, 'color-roles');
  });

  it('handles empty decisions', () => {
    const { decided, undecided } = applyDecisions(FIX.orphans, {});
    assert.equal(decided.length, 0);
    assert.equal(undecided.length, 3);
  });

  it('skips decisions missing required fields', () => {
    const partial = { 'fast-iteration': { priority: 'P1' } }; // missing rule + route
    const { decided, undecided } = applyDecisions(FIX.orphans, partial);
    assert.equal(decided.length, 0);
    assert.equal(undecided.length, 3);
  });
});

// =============================================================================
// applyExceptions
// =============================================================================

describe('applyExceptions', () => {
  it('reduces orphan count for excluded features', () => {
    const result = applyExceptions(FIX.metricsBase, FIX.exceptions, FIX.graph);
    // oauth-provider and admin-panel are orphans and excluded from orphan_count
    assert.equal(result.orphan_features, 1); // 3 - 2
    assert.equal(result.total_features, 2); // 4 - 2
    assert.equal(result.memory_excluded, 2);
  });

  it('recalculates orphan ratio after exclusion', () => {
    const result = applyExceptions(FIX.metricsBase, FIX.exceptions, FIX.graph);
    // 1 orphan / 2 total = 0.50
    assert.equal(result.orphan_ratio, 0.5);
  });

  it('handles empty exceptions', () => {
    const result = applyExceptions(FIX.metricsBase, {}, FIX.graph);
    assert.equal(result.total_features, 4);
    assert.equal(result.orphan_features, 3);
    assert.equal(result.memory_excluded, 0);
  });

  it('ignores exceptions for features not in graph', () => {
    const exc = { 'nonexistent': { reason: 'test', exclude_from: ['orphan_count'] } };
    const result = applyExceptions(FIX.metricsBase, exc, FIX.graph);
    assert.equal(result.total_features, 4);
    assert.equal(result.memory_excluded, 0);
  });

  it('ignores exceptions for features that are not orphans', () => {
    // visible-feature has a documents edge, so it's not an orphan
    const exc = { 'visible-feature': { reason: 'test', exclude_from: ['orphan_count'] } };
    const result = applyExceptions(FIX.metricsBase, exc, FIX.graph);
    assert.equal(result.orphan_features, 3); // unchanged
    assert.equal(result.memory_excluded, 0);
  });

  it('does not go below zero', () => {
    // Create many exceptions for a small set
    const manyExc = {};
    for (let i = 0; i < 20; i++) {
      manyExc[`fake-${i}`] = { reason: 'test', exclude_from: ['orphan_count'] };
    }
    const result = applyExceptions(FIX.metricsBase, manyExc, FIX.graph);
    assert.ok(result.total_features >= 0);
    assert.ok(result.orphan_features >= 0);
  });

  it('skips entries with invalid exclude_from', () => {
    const bad = { 'oauth-provider': { reason: 'test', exclude_from: 'orphan_count' } };
    const result = applyExceptions(FIX.metricsBase, bad, FIX.graph);
    assert.equal(result.memory_excluded, 0);
  });
});

// =============================================================================
// suggestMemoryEntries
// =============================================================================

describe('suggestMemoryEntries', () => {
  it('suggests mappings from ambiguous matches', () => {
    const result = suggestMemoryEntries(FIX.diffWithAmbiguous);
    const ambig = result.mappings.filter(m => m.source === 'ambiguous');
    assert.equal(ambig.length, 1);
    assert.equal(ambig[0].feature_id, 'fast-iteration');
    assert.equal(ambig[0].trigger_label, 'Fast Mode');
  });

  it('suggests mappings from near-miss unmatched', () => {
    const result = suggestMemoryEntries(FIX.diffWithAmbiguous);
    const nearMiss = result.mappings.filter(m => m.source === 'near_miss');
    assert.equal(nearMiss.length, 1);
    assert.equal(nearMiss[0].feature_id, 'type-scale');
    assert.equal(nearMiss[0].trigger_label, 'Typography');
  });

  it('does not suggest near-miss below 0.30', () => {
    const result = suggestMemoryEntries(FIX.diffWithAmbiguous);
    // spacing has score 0.20, below 0.30 threshold
    const spacingSuggestion = result.mappings.find(m => m.feature_id === 'spacing');
    assert.equal(spacingSuggestion, undefined);
  });

  it('returns empty for clean diff', () => {
    const cleanDiff = { ambiguous_matches: [], documented_not_discoverable: [] };
    const result = suggestMemoryEntries(cleanDiff);
    assert.equal(result.mappings.length, 0);
  });

  it('results are sorted by feature_id', () => {
    const result = suggestMemoryEntries(FIX.diffWithAmbiguous);
    for (let i = 1; i < result.mappings.length; i++) {
      assert.ok(result.mappings[i].feature_id >= result.mappings[i - 1].feature_id);
    }
  });

  it('handles missing fields gracefully', () => {
    const result = suggestMemoryEntries({});
    assert.equal(result.mappings.length, 0);
  });
});

// =============================================================================
// loadMemory
// =============================================================================

describe('loadMemory', () => {
  it('returns null for nonexistent directory', () => {
    const result = loadMemory('/nonexistent/path/ai-ui-memory');
    assert.equal(result, null);
  });

  it('returns null for nonexistent directory in strict mode (with exitCode)', () => {
    const saved = process.exitCode;
    const result = loadMemory('/nonexistent/path/ai-ui-memory', true);
    assert.equal(result, null);
    process.exitCode = saved; // restore
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('memory determinism', () => {
  it('mergeMemoryMappings produces identical output on repeated calls', () => {
    const a = mergeMemoryMappings(FIX.configMapping, FIX.mappings);
    const b = mergeMemoryMappings(FIX.configMapping, FIX.mappings);
    assert.deepEqual(a, b);
  });

  it('applyExceptions produces identical metrics on repeated calls', () => {
    const a = applyExceptions(FIX.metricsBase, FIX.exceptions, FIX.graph);
    const b = applyExceptions(FIX.metricsBase, FIX.exceptions, FIX.graph);
    assert.deepEqual(a, b);
  });

  it('suggestMemoryEntries produces identical output on repeated calls', () => {
    const a = suggestMemoryEntries(FIX.diffWithAmbiguous);
    const b = suggestMemoryEntries(FIX.diffWithAmbiguous);
    assert.deepEqual(a, b);
  });
});
