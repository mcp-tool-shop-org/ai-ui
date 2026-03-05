// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createBaseline,
  computeMemoryHash,
  computeConfigHash,
  compareBaseline,
  applyBaselineRules,
} from '../src/baseline.mjs';

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/baseline-fixtures.json'), 'utf-8')
);

// =============================================================================
// createBaseline
// =============================================================================

describe('createBaseline', () => {
  it('creates a snapshot with correct structure', () => {
    const snap = createBaseline(fixtures.verdict, 'memhash', 'cfghash');
    assert.equal(snap.version, '1.0.0');
    assert.equal(typeof snap.created_at, 'string');
    assert.deepStrictEqual(snap.metrics, fixtures.verdict.metrics);
    assert.deepStrictEqual(snap.artifact_versions, fixtures.verdict.artifact_versions);
    assert.equal(snap.memory_hash, 'memhash');
    assert.equal(snap.verify_config_hash, 'cfghash');
  });

  it('creates a deep copy of metrics (not a reference)', () => {
    const snap = createBaseline(fixtures.verdict, 'a', 'b');
    snap.metrics.total_features = 999;
    assert.notEqual(fixtures.verdict.metrics.total_features, 999);
  });
});

// =============================================================================
// computeMemoryHash
// =============================================================================

describe('computeMemoryHash', () => {
  it('returns "none" for nonexistent directory', () => {
    assert.equal(computeMemoryHash('/nonexistent/path/to/memory'), 'none');
  });

  it('returns a hex hash for existing memory directory', () => {
    const memDir = resolve(import.meta.dirname, '../../ai-ui-memory');
    const hash = computeMemoryHash(memDir);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('is deterministic (same input → same hash)', () => {
    const memDir = resolve(import.meta.dirname, '../../ai-ui-memory');
    const hash1 = computeMemoryHash(memDir);
    const hash2 = computeMemoryHash(memDir);
    assert.equal(hash1, hash2);
  });
});

// =============================================================================
// computeConfigHash
// =============================================================================

describe('computeConfigHash', () => {
  it('returns a 64-char hex hash', () => {
    const hash = computeConfigHash(fixtures.baselineConfig_default);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const h1 = computeConfigHash(fixtures.baselineConfig_default);
    const h2 = computeConfigHash(fixtures.baselineConfig_default);
    assert.equal(h1, h2);
  });

  it('different configs produce different hashes', () => {
    const h1 = computeConfigHash(fixtures.baselineConfig_default);
    const h2 = computeConfigHash(fixtures.baselineConfig_permissive);
    assert.notEqual(h1, h2);
  });
});

// =============================================================================
// compareBaseline
// =============================================================================

describe('compareBaseline', () => {
  it('detects improvements across all metrics', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_improved);
    const orphanDelta = deltas.find(d => d.metric === 'orphan_features');
    assert.equal(orphanDelta.direction, 'improved');
    assert.equal(orphanDelta.change, -2); // 4 → 2

    const covDelta = deltas.find(d => d.metric === 'coverage_percent');
    assert.equal(covDelta.direction, 'improved');
    assert.equal(covDelta.change, 20); // 40 → 60

    const undocDelta = deltas.find(d => d.metric === 'undocumented_surfaces');
    assert.equal(undocDelta.direction, 'improved');
    assert.equal(undocDelta.change, -2); // 6 → 4
  });

  it('detects regressions across all metrics', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const orphanDelta = deltas.find(d => d.metric === 'orphan_features');
    assert.equal(orphanDelta.direction, 'regressed');
    assert.equal(orphanDelta.change, 3); // 4 → 7

    const covDelta = deltas.find(d => d.metric === 'coverage_percent');
    assert.equal(covDelta.direction, 'regressed');
    assert.equal(covDelta.change, -15); // 40 → 25

    const undocDelta = deltas.find(d => d.metric === 'undocumented_surfaces');
    assert.equal(undocDelta.direction, 'regressed');
    assert.equal(undocDelta.change, 9); // 6 → 15
  });

  it('detects unchanged metrics', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_unchanged);
    for (const d of deltas) {
      assert.equal(d.direction, 'unchanged', `${d.metric} should be unchanged`);
      assert.equal(d.change, 0, `${d.metric} change should be 0`);
    }
  });

  it('compares exactly 7 metrics', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_improved);
    assert.equal(deltas.length, 7);
    const metrics = deltas.map(d => d.metric);
    assert.ok(metrics.includes('orphan_features'));
    assert.ok(metrics.includes('orphan_ratio'));
    assert.ok(metrics.includes('coverage_percent'));
    assert.ok(metrics.includes('undocumented_surfaces'));
    assert.ok(metrics.includes('p0_count'));
    assert.ok(metrics.includes('ambiguous_matches'));
    assert.ok(metrics.includes('high_burial_triggers'));
  });

  it('handles missing baseline metrics gracefully (defaults to 0)', () => {
    const sparseBaseline = {
      ...fixtures.baselineSnapshot,
      metrics: { total_features: 5 }, // sparse
    };
    const deltas = compareBaseline(sparseBaseline, fixtures.currentMetrics_improved);
    const orphanDelta = deltas.find(d => d.metric === 'orphan_features');
    assert.equal(orphanDelta.baseline_value, 0);
    assert.equal(orphanDelta.current_value, 2);
  });
});

// =============================================================================
// applyBaselineRules
// =============================================================================

describe('applyBaselineRules', () => {
  it('produces orphan blocker when orphans regressed', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const { blockers, warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot
    );
    const orphanBlocker = blockers.find(b => b.rule === 'baseline_orphan_increase');
    assert.ok(orphanBlocker, 'should have orphan increase blocker');
    assert.equal(orphanBlocker.actual, 7);
    assert.equal(orphanBlocker.threshold, 4);
  });

  it('produces undocumented blocker when increase exceeds max', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const { blockers } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot
    );
    const undocBlocker = blockers.find(b => b.rule === 'baseline_undocumented_increase');
    assert.ok(undocBlocker, 'should have undocumented increase blocker');
    // regression: 6 → 15, change = 9, max = 5
    assert.equal(undocBlocker.actual, 9);
  });

  it('produces coverage warning when coverage regressed', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const { warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot
    );
    const covWarn = warnings.find(w => w.rule === 'baseline_coverage_decrease');
    assert.ok(covWarn, 'should have coverage decrease warning');
  });

  it('produces no blockers/warnings when metrics improved', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_improved);
    const { blockers, warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot
    );
    assert.equal(blockers.length, 0);
    // No coverage decrease, no orphan increase, no undoc increase
    const baselineWarnings = warnings.filter(w => w.rule.startsWith('baseline_'));
    assert.equal(baselineWarnings.length, 0);
  });

  it('produces no blockers/warnings when metrics unchanged', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_unchanged);
    const { blockers, warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot
    );
    assert.equal(blockers.length, 0);
    const baselineWarnings = warnings.filter(w => w.rule.startsWith('baseline_'));
    assert.equal(baselineWarnings.length, 0);
  });

  it('respects permissive config (no blockers even on regression)', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const { blockers, warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_permissive, fixtures.baselineSnapshot
    );
    assert.equal(blockers.length, 0);
    const baselineWarnings = warnings.filter(w => w.rule.startsWith('baseline_'));
    assert.equal(baselineWarnings.length, 0);
  });

  it('detects memory hash drift', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_unchanged);
    const { warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot,
      'different_memory_hash', undefined
    );
    const driftWarn = warnings.find(w => w.rule === 'baseline_memory_drift');
    assert.ok(driftWarn, 'should warn about memory drift');
  });

  it('detects config hash drift', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_unchanged);
    const { warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot,
      undefined, 'different_config_hash'
    );
    const driftWarn = warnings.find(w => w.rule === 'baseline_config_drift');
    assert.ok(driftWarn, 'should warn about config drift');
  });

  it('no drift warning when hashes match', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_unchanged);
    const { warnings } = applyBaselineRules(
      deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot,
      fixtures.baselineSnapshot.memory_hash,
      fixtures.baselineSnapshot.verify_config_hash
    );
    const driftWarns = warnings.filter(w => w.rule.includes('drift'));
    assert.equal(driftWarns.length, 0);
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('baseline determinism', () => {
  it('compareBaseline returns identical results on repeated calls', () => {
    const d1 = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const d2 = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    assert.deepStrictEqual(d1, d2);
  });

  it('applyBaselineRules returns identical results on repeated calls', () => {
    const deltas = compareBaseline(fixtures.baselineSnapshot, fixtures.currentMetrics_regressed);
    const r1 = applyBaselineRules(deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot);
    const r2 = applyBaselineRules(deltas, fixtures.baselineConfig_default, fixtures.baselineSnapshot);
    assert.deepStrictEqual(r1, r2);
  });
});
