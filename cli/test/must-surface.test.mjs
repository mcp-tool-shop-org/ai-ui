// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMustSurface, checkMustSurface } from '../src/must-surface.mjs';

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/must-surface-fixtures.json'), 'utf-8')
);

// =============================================================================
// loadMustSurface
// =============================================================================

describe('loadMustSurface', () => {
  it('returns null for nonexistent file', () => {
    assert.equal(loadMustSurface('/nonexistent/path.json'), null);
  });
});

// =============================================================================
// checkMustSurface — P0/P1 blockers
// =============================================================================

describe('checkMustSurface P0/P1 blockers', () => {
  it('P0 orphan produces blocker', () => {
    // color-roles is documented in graph_with_docs, fast-iteration is orphaned
    // But let's use graph_all_orphans where color-roles IS orphaned
    const { blockers } = checkMustSurface(fixtures.mustSurface_p0_p1, fixtures.graph_all_orphans);
    const p0Blocker = blockers.find(b => b.rule === 'must_surface_p0');
    assert.ok(p0Blocker, 'should have P0 blocker');
    assert.ok(p0Blocker.message.includes('color-roles'));
  });

  it('P1 orphan produces blocker', () => {
    const { blockers } = checkMustSurface(fixtures.mustSurface_p0_p1, fixtures.graph_all_orphans);
    const p1Blocker = blockers.find(b => b.rule === 'must_surface_p1');
    assert.ok(p1Blocker, 'should have P1 blocker');
    assert.ok(p1Blocker.message.includes('fast-iteration'));
  });

  it('documented P0 feature produces no blocker', () => {
    // color-roles IS documented in graph_with_docs
    const config = { version: '1.0.0', required: [{ feature_id: 'color-roles', severity: 'P0' }] };
    const { blockers } = checkMustSurface(config, fixtures.graph_with_docs);
    assert.equal(blockers.length, 0);
  });
});

// =============================================================================
// checkMustSurface — P2 warnings
// =============================================================================

describe('checkMustSurface P2 warnings', () => {
  it('P2 orphan produces warning (not blocker)', () => {
    const { blockers, warnings } = checkMustSurface(fixtures.mustSurface_p2_only, fixtures.graph_all_orphans);
    assert.equal(blockers.length, 0, 'P2 should not produce blocker');
    const p2Warn = warnings.find(w => w.rule === 'must_surface_p2');
    assert.ok(p2Warn, 'should have P2 warning');
    assert.ok(p2Warn.message.includes('fast-iteration'));
  });
});

// =============================================================================
// checkMustSurface — missing features
// =============================================================================

describe('checkMustSurface missing features', () => {
  it('missing feature produces warning', () => {
    const { blockers, warnings, results } = checkMustSurface(fixtures.mustSurface_missing, fixtures.graph_with_docs);
    assert.equal(blockers.length, 0);
    const missingWarn = warnings.find(w => w.rule === 'must_surface_missing');
    assert.ok(missingWarn, 'should warn about missing feature');
    assert.ok(missingWarn.message.includes('nonexistent-feature'));
    const result = results.find(r => r.feature_id === 'nonexistent-feature');
    assert.equal(result.status, 'missing');
  });
});

// =============================================================================
// checkMustSurface — mixed scenarios
// =============================================================================

describe('checkMustSurface mixed', () => {
  it('handles mix of documented, orphaned, and missing features', () => {
    const { blockers, warnings, results } = checkMustSurface(fixtures.mustSurface_mixed, fixtures.graph_with_docs);

    // color-roles: documented → ok (no blocker)
    const crResult = results.find(r => r.feature_id === 'color-roles');
    assert.equal(crResult.status, 'ok');

    // fast-iteration: orphaned P1 → blocker
    const fiResult = results.find(r => r.feature_id === 'fast-iteration');
    assert.equal(fiResult.status, 'orphaned');
    assert.ok(blockers.some(b => b.rule === 'must_surface_p1'));

    // type-scale: orphaned P2 → warning only
    const tsResult = results.find(r => r.feature_id === 'type-scale');
    assert.equal(tsResult.status, 'orphaned');
    assert.ok(warnings.some(w => w.rule === 'must_surface_p2'));

    // nonexistent: missing → warning
    const neResult = results.find(r => r.feature_id === 'nonexistent');
    assert.equal(neResult.status, 'missing');
    assert.ok(warnings.some(w => w.rule === 'must_surface_missing'));
  });

  it('empty required list produces no blockers or warnings', () => {
    const { blockers, warnings, results } = checkMustSurface(fixtures.mustSurface_empty, fixtures.graph_with_docs);
    assert.equal(blockers.length, 0);
    assert.equal(warnings.length, 0);
    assert.equal(results.length, 0);
  });
});

// =============================================================================
// checkMustSurface — results structure
// =============================================================================

describe('checkMustSurface results', () => {
  it('results contain all required features', () => {
    const { results } = checkMustSurface(fixtures.mustSurface_mixed, fixtures.graph_with_docs);
    assert.equal(results.length, 4);
    assert.ok(results.every(r => r.feature_id && r.severity && r.status));
  });

  it('results are sorted by feature_id', () => {
    const { results } = checkMustSurface(fixtures.mustSurface_mixed, fixtures.graph_with_docs);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i].feature_id >= results[i - 1].feature_id,
        `${results[i].feature_id} should come after ${results[i - 1].feature_id}`);
    }
  });

  it('reason is preserved from config', () => {
    const { results } = checkMustSurface(fixtures.mustSurface_p0_p1, fixtures.graph_all_orphans);
    const cr = results.find(r => r.feature_id === 'color-roles');
    assert.equal(cr.reason, 'Core differentiator');
  });

  it('blocker message includes reason when present', () => {
    const { blockers } = checkMustSurface(fixtures.mustSurface_p0_p1, fixtures.graph_all_orphans);
    const p0 = blockers.find(b => b.rule === 'must_surface_p0');
    assert.ok(p0.message.includes('Core differentiator'));
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('must-surface determinism', () => {
  it('checkMustSurface returns identical results on repeated calls', () => {
    const r1 = checkMustSurface(fixtures.mustSurface_mixed, fixtures.graph_with_docs);
    const r2 = checkMustSurface(fixtures.mustSurface_mixed, fixtures.graph_with_docs);
    assert.deepStrictEqual(r1, r2);
  });
});
