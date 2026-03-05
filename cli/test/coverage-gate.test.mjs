// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildActionSummary } from '../src/runtime-coverage.mjs';
import {
  applyCoverageGate,
} from '../src/verify.mjs';
import {
  createCoverageBaselineSlice,
  computeSafeConfigHash,
  createBaseline,
} from '../src/baseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/coverage-gate-fixtures.json'), 'utf-8'));

// =============================================================================
// buildActionSummary
// =============================================================================

describe('buildActionSummary', () => {
  it('counts actions by type', () => {
    const summary = buildActionSummary(
      fixtures.actionReport_withActions.actions,
      fixtures.coverageReport.surprises_v2,
      25,
    );
    assert.equal(summary.by_action_type.probe_trigger, 1);
    assert.equal(summary.by_action_type.investigate_missing, 1);
    assert.equal(summary.by_action_type.review_new_effect, 1);
  });

  it('counts surprises by category', () => {
    const summary = buildActionSummary(
      fixtures.actionReport_withActions.actions,
      fixtures.coverageReport.surprises_v2,
      25,
    );
    assert.equal(summary.by_surprise_category.new_effect, 1);
    assert.equal(summary.by_surprise_category.risky_skipped, 1);
    assert.equal(summary.by_surprise_category.missing_expected, 1);
  });

  it('returns top 5 action IDs (first 5 by priority order)', () => {
    const summary = buildActionSummary(
      fixtures.actionReport_withActions.actions,
      [],
      25,
    );
    assert.equal(summary.top_action_ids.length, 3); // only 3 actions
    assert.equal(summary.top_action_ids[0], 'act:aaa00001');
  });

  it('handles empty inputs', () => {
    const summary = buildActionSummary([], [], 0);
    assert.equal(summary.total_actions, 0);
    assert.deepStrictEqual(summary.by_action_type, {});
    assert.deepStrictEqual(summary.by_surprise_category, {});
    assert.equal(summary.top_action_ids.length, 0);
    assert.equal(summary.coverage_percent, 0);
  });

  it('is deterministic across runs', () => {
    const a = buildActionSummary(fixtures.actionReport_withActions.actions, fixtures.coverageReport.surprises_v2, 25);
    const b = buildActionSummary(fixtures.actionReport_withActions.actions, fixtures.coverageReport.surprises_v2, 25);
    assert.deepStrictEqual(a, b);
  });
});

// =============================================================================
// applyCoverageGate — mode='none'
// =============================================================================

describe('applyCoverageGate mode=none', () => {
  it('returns empty blockers and warnings', () => {
    const result = applyCoverageGate(
      'none',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_strict,
      fixtures.baselineCoverage_matching,
    );
    assert.equal(result.blockers.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('has null delta', () => {
    const result = applyCoverageGate(
      'none',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_strict,
      null,
    );
    assert.equal(result.delta, null);
    assert.equal(result.mode, 'none');
  });
});

// =============================================================================
// applyCoverageGate — mode='minimum'
// =============================================================================

describe('applyCoverageGate mode=minimum', () => {
  it('fires gate_min_coverage blocker when below floor', () => {
    const result = applyCoverageGate(
      'minimum',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,       // 25% coverage
      fixtures.gateConfig_strict,    // min 80%
      null,
    );
    const minCov = result.blockers.find(b => b.rule === 'gate_min_coverage');
    assert.ok(minCov, 'should fire gate_min_coverage');
    assert.equal(minCov.threshold, 80);
    assert.equal(minCov.actual, 25);
  });

  it('does not fire when at or above floor', () => {
    const result = applyCoverageGate(
      'minimum',
      fixtures.actionReport_empty,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,  // min 0%
      null,
    );
    const minCov = result.blockers.find(b => b.rule === 'gate_min_coverage');
    assert.equal(minCov, undefined);
  });

  it('fires gate_max_actions blocker when count exceeds cap', () => {
    const result = applyCoverageGate(
      'minimum',
      fixtures.actionReport_withActions,  // 3 actions
      fixtures.coverageReport,
      fixtures.gateConfig_strict,         // max 2
      null,
    );
    const maxAct = result.blockers.find(b => b.rule === 'gate_max_actions');
    assert.ok(maxAct, 'should fire gate_max_actions');
  });

  it('fires per-type cap blocker', () => {
    const result = applyCoverageGate(
      'minimum',
      fixtures.actionReport_withActions,  // 1 investigate_missing
      fixtures.coverageReport,
      fixtures.gateConfig_strict,         // investigate_missing capped at 0
      null,
    );
    const perType = result.blockers.find(b => b.rule === 'gate_max_investigate_missing');
    assert.ok(perType, 'should fire per-type cap');
  });

  it('multiple blockers fire simultaneously', () => {
    const result = applyCoverageGate(
      'minimum',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_strict,
      null,
    );
    // Should have min_coverage + max_actions + per-type
    assert.ok(result.blockers.length >= 3, `expected >=3 blockers, got ${result.blockers.length}`);
  });
});

// =============================================================================
// applyCoverageGate — mode='regressions'
// =============================================================================

describe('applyCoverageGate mode=regressions', () => {
  it('warns and skips when no baseline coverage', () => {
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,
      null,
    );
    assert.equal(result.blockers.length, 0);
    const noBaseline = result.warnings.find(w => w.rule === 'gate_no_baseline');
    assert.ok(noBaseline, 'should warn about missing baseline');
  });

  it('fires gate_new_actions blocker for new action IDs', () => {
    // baselineCoverage_better has only act:aaa00001
    // current has aaa00001 + bbb00002 + ccc00003 → 2 new
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,
      fixtures.baselineCoverage_better,
    );
    const newActions = result.blockers.find(b => b.rule === 'gate_new_actions');
    assert.ok(newActions, 'should fire gate_new_actions');
    assert.equal(newActions.actual, 2); // bbb00002 + ccc00003 are new
  });

  it('does not fire when all action IDs match baseline', () => {
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,
      fixtures.baselineCoverage_matching,  // same 3 IDs
    );
    const newActions = result.blockers.find(b => b.rule === 'gate_new_actions');
    assert.equal(newActions, undefined);
  });

  it('fires gate_coverage_regression when coverage dropped', () => {
    // baselineCoverage_better has 70%, current has 25%
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,              // 25%
      fixtures.gateConfig_permissive,
      fixtures.baselineCoverage_better,     // 70%
    );
    const covReg = result.blockers.find(b => b.rule === 'gate_coverage_regression');
    assert.ok(covReg, 'should fire gate_coverage_regression');
  });

  it('does not fire coverage regression when coverage unchanged', () => {
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,              // 25%
      fixtures.gateConfig_permissive,
      fixtures.baselineCoverage_matching,   // 25%
    );
    const covReg = result.blockers.find(b => b.rule === 'gate_coverage_regression');
    assert.equal(covReg, undefined);
  });

  it('delta identifies resolved actions', () => {
    // baselineCoverage_better has [act:aaa00001], current has [aaa00001, bbb00002, ccc00003]
    // resolved = in baseline but not current = empty (aaa00001 is still there)
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,
      fixtures.baselineCoverage_better,
    );
    assert.ok(result.delta);
    assert.equal(result.delta.resolved_action_ids.length, 0); // aaa00001 still present
    assert.equal(result.delta.new_action_ids.length, 2);
  });

  it('delta.new_by_type counts new actions by type', () => {
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,
      fixtures.baselineCoverage_better,
    );
    assert.ok(result.delta);
    // bbb00002 is investigate_missing, ccc00003 is review_new_effect
    assert.equal(result.delta.new_by_type.investigate_missing, 1);
    assert.equal(result.delta.new_by_type.review_new_effect, 1);
  });

  it('warns on tool version mismatch', () => {
    const baselineOldVersion = {
      ...fixtures.baselineCoverage_matching,
      tool_version: '0.9.0',
    };
    const result = applyCoverageGate(
      'regressions',
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      fixtures.gateConfig_permissive,
      baselineOldVersion,
    );
    const versionWarn = result.warnings.find(w => w.rule === 'gate_version_mismatch');
    assert.ok(versionWarn, 'should warn on version mismatch');
  });
});

// =============================================================================
// createCoverageBaselineSlice
// =============================================================================

describe('createCoverageBaselineSlice', () => {
  it('creates slice with correct structure', () => {
    const slice = createCoverageBaselineSlice(
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      '1.0.0',
      'abc123',
    );
    assert.equal(slice.coverage_percent, 25);
    assert.equal(slice.total_actions, 3);
    assert.equal(slice.tool_version, '1.0.0');
    assert.equal(slice.config_hash, 'abc123');
    assert.ok(slice.actions_by_type.probe_trigger === 1);
  });

  it('action IDs are sorted', () => {
    const slice = createCoverageBaselineSlice(
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      '1.0.0',
      'abc123',
    );
    const sorted = [...slice.action_ids].sort();
    assert.deepStrictEqual(slice.action_ids, sorted);
  });

  it('deep copies (not references to input)', () => {
    const slice = createCoverageBaselineSlice(
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      '1.0.0',
      'abc123',
    );
    assert.notEqual(slice.actions_by_type, fixtures.actionReport_withActions.summary.by_type);
  });
});

// =============================================================================
// computeSafeConfigHash
// =============================================================================

describe('computeSafeConfigHash', () => {
  it('returns deterministic 64-char hex hash', () => {
    const hash1 = computeSafeConfigHash({ denyLabelRegex: 'delete', requireSafeAttrForDestructive: true });
    const hash2 = computeSafeConfigHash({ denyLabelRegex: 'delete', requireSafeAttrForDestructive: true });
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.ok(/^[a-f0-9]+$/.test(hash1));
  });

  it('different configs produce different hashes', () => {
    const hash1 = computeSafeConfigHash({ denyLabelRegex: 'delete', requireSafeAttrForDestructive: true });
    const hash2 = computeSafeConfigHash({ denyLabelRegex: 'remove', requireSafeAttrForDestructive: false });
    assert.notEqual(hash1, hash2);
  });
});

// =============================================================================
// createBaseline with coverage
// =============================================================================

describe('createBaseline with coverage', () => {
  const mockVerdict = {
    version: '1.0.0',
    generated_at: '2026-01-01T00:00:00.000Z',
    pass: true,
    exit_code: 0,
    metrics: { total_features: 5, orphan_features: 1, orphan_ratio: 0.2, coverage_percent: 60, p0_count: 0, p1_count: 0, p2_count: 0, undocumented_surfaces: 2, ambiguous_matches: 0, high_burial_triggers: 0, memory_excluded: 0, must_surface_violations: 0 },
    blockers: [],
    warnings: [],
    artifact_versions: { diff: '1.0.0', graph: '1.0.0', plan: '1.0.0' },
  };

  it('includes coverage slice when provided', () => {
    const slice = createCoverageBaselineSlice(
      fixtures.actionReport_withActions,
      fixtures.coverageReport,
      '1.0.0',
      'abc123',
    );
    const baseline = createBaseline(mockVerdict, 'memhash', 'cfghash', slice);
    assert.ok(baseline.coverage);
    assert.equal(baseline.coverage.coverage_percent, 25);
    assert.equal(baseline.version, '1.1.0');
  });

  it('omits coverage when not provided', () => {
    const baseline = createBaseline(mockVerdict, 'memhash', 'cfghash');
    assert.equal(baseline.coverage, undefined);
    assert.equal(baseline.version, '1.0.0');
  });

  it('old baseline without coverage loads fine (property is undefined)', () => {
    const baseline = createBaseline(mockVerdict, 'memhash', 'cfghash');
    // Simulate loading from JSON — coverage field doesn't exist
    const loaded = JSON.parse(JSON.stringify(baseline));
    assert.equal(loaded.coverage, undefined);
    // Can still access metrics normally
    assert.equal(loaded.metrics.total_features, 5);
  });
});
