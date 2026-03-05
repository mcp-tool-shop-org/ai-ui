// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractMetrics,
  applyRules,
  generateVerdict,
  generateVerifyReport,
} from '../src/verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/verify-fixtures.json'), 'utf-8'));

// =============================================================================
// extractMetrics
// =============================================================================

describe('extractMetrics', () => {
  it('extracts correct metrics from passing scenario', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    assert.equal(m.total_features, 4);
    assert.equal(m.orphan_features, 1);
    assert.equal(m.orphan_ratio, 0.25);
    assert.equal(m.coverage_percent, 75);
    assert.equal(m.p0_count, 0);
    assert.equal(m.p1_count, 0);
    assert.equal(m.p2_count, 1);
    assert.equal(m.undocumented_surfaces, 1);
    assert.equal(m.ambiguous_matches, 0);
    assert.equal(m.high_burial_triggers, 0);
  });

  it('extracts correct metrics from failing scenario', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    assert.equal(m.total_features, 4);
    assert.equal(m.orphan_features, 4);
    assert.equal(m.orphan_ratio, 1.0);
    assert.equal(m.coverage_percent, 0);
    assert.equal(m.p0_count, 2);
    assert.equal(m.p1_count, 1);
    assert.equal(m.p2_count, 1);
    assert.equal(m.undocumented_surfaces, 11);
    assert.equal(m.ambiguous_matches, 1);
    assert.equal(m.high_burial_triggers, 2);
  });

  it('handles zero total features without NaN', () => {
    const emptyGraph = { ...fixtures.passing.graph, stats: { ...fixtures.passing.graph.stats, by_type: { feature: 0 }, orphan_features: 0 } };
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, emptyGraph);
    assert.equal(m.orphan_ratio, 0);
    assert.equal(Number.isNaN(m.orphan_ratio), false);
  });

  it('handles missing stats gracefully', () => {
    const diffNoStats = { ...fixtures.passing.diff, stats: undefined };
    const m = extractMetrics(diffNoStats, fixtures.passing.plan, fixtures.passing.graph);
    assert.equal(m.coverage_percent, 0);
  });

  it('handles missing burial_index gracefully', () => {
    const diffNoBurial = { ...fixtures.passing.diff, burial_index: undefined };
    const m = extractMetrics(diffNoBurial, fixtures.passing.plan, fixtures.passing.graph);
    assert.equal(m.high_burial_triggers, 0);
  });
});

// =============================================================================
// applyRules
// =============================================================================

describe('applyRules', () => {
  it('returns no blockers for passing scenario', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    assert.equal(blockers.length, 0);
  });

  it('returns blockers for failing scenario', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    assert.ok(blockers.length > 0);
  });

  it('fires max_orphan_ratio blocker when ratio exceeds threshold', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    const orphanBlocker = blockers.find(b => b.rule === 'max_orphan_ratio');
    assert.ok(orphanBlocker);
    assert.equal(orphanBlocker.threshold, 0.25);
    assert.equal(orphanBlocker.actual, 1.0);
  });

  it('fires p0_orphans blocker when P0 features exist', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    const p0Blocker = blockers.find(b => b.rule === 'p0_orphans');
    assert.ok(p0Blocker);
    assert.equal(p0Blocker.actual, 2);
  });

  it('fires max_undocumented_surfaces blocker when threshold exceeded', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    const undocBlocker = blockers.find(b => b.rule === 'max_undocumented_surfaces');
    assert.ok(undocBlocker);
    assert.equal(undocBlocker.actual, 11);
  });

  it('does not fire p0 blocker when failOnP0Orphans is false', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const config = { ...fixtures.defaultConfig, failOnP0Orphans: false };
    const { blockers } = applyRules(m, config);
    const p0Blocker = blockers.find(b => b.rule === 'p0_orphans');
    assert.equal(p0Blocker, undefined);
  });

  it('fires low_coverage warning when below 50%', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { warnings } = applyRules(m, fixtures.defaultConfig);
    const coverageWarn = warnings.find(w => w.rule === 'low_coverage');
    assert.ok(coverageWarn);
  });

  it('fires ambiguous_matches warning when present', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { warnings } = applyRules(m, fixtures.defaultConfig);
    const ambigWarn = warnings.find(w => w.rule === 'ambiguous_matches');
    assert.ok(ambigWarn);
  });

  it('fires high_burial warning when burial >= 5', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { warnings } = applyRules(m, fixtures.defaultConfig);
    const burialWarn = warnings.find(w => w.rule === 'high_burial');
    assert.ok(burialWarn);
    assert.ok(burialWarn.message.includes('2'));
  });

  it('does not fire low_coverage warning when coverage >= 50', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { warnings } = applyRules(m, fixtures.defaultConfig);
    const coverageWarn = warnings.find(w => w.rule === 'low_coverage');
    assert.equal(coverageWarn, undefined);
  });

  it('strict config: orphan ratio 0.25 triggers blocker at threshold 0', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { blockers } = applyRules(m, fixtures.strictConfig);
    const orphanBlocker = blockers.find(b => b.rule === 'max_orphan_ratio');
    assert.ok(orphanBlocker);
  });

  it('strict config: 1 undocumented surface triggers blocker at threshold 0', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { blockers } = applyRules(m, fixtures.strictConfig);
    const undocBlocker = blockers.find(b => b.rule === 'max_undocumented_surfaces');
    assert.ok(undocBlocker);
  });

  it('blockers are sorted by rule name', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    for (let i = 1; i < blockers.length; i++) {
      assert.ok(blockers[i].rule.localeCompare(blockers[i - 1].rule) >= 0);
    }
  });

  it('warnings are sorted by rule name', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { warnings } = applyRules(m, fixtures.defaultConfig);
    for (let i = 1; i < warnings.length; i++) {
      assert.ok(warnings[i].rule.localeCompare(warnings[i - 1].rule) >= 0);
    }
  });
});

// =============================================================================
// generateVerdict
// =============================================================================

describe('generateVerdict', () => {
  it('pass=true when no blockers', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, { diff: '1.1.0', graph: '1.0.0', plan: '1.0.0' });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.exit_code, 0);
  });

  it('pass=false when blockers exist', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, { diff: '1.1.0', graph: '1.0.0', plan: '1.0.0' });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.exit_code, 1);
  });

  it('has version 1.0.0', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], {});
    assert.equal(verdict.version, '1.0.0');
  });

  it('has generated_at timestamp', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], {});
    assert.ok(verdict.generated_at);
    assert.ok(new Date(verdict.generated_at).getTime() > 0);
  });

  it('includes artifact versions', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const versions = { diff: '1.1.0', graph: '1.0.0', plan: '1.0.0' };
    const verdict = generateVerdict(m, [], [], versions);
    assert.deepEqual(verdict.artifact_versions, versions);
  });

  it('includes metrics in verdict', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], {});
    assert.equal(verdict.metrics.total_features, 4);
    assert.equal(verdict.metrics.orphan_features, 1);
  });
});

// =============================================================================
// generateVerifyReport
// =============================================================================

describe('generateVerifyReport', () => {
  it('starts with # AI-UI Verify: PASS for passing verdict', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, { diff: '1.1.0', graph: '1.0.0', plan: '1.0.0' });
    const report = generateVerifyReport(verdict, fixtures.passing.plan.plans);
    assert.ok(report.startsWith('# AI-UI Verify: PASS'));
  });

  it('starts with # AI-UI Verify: FAIL for failing verdict', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, { diff: '1.1.0', graph: '1.0.0', plan: '1.0.0' });
    const report = generateVerifyReport(verdict, fixtures.failing.plan.plans);
    assert.ok(report.startsWith('# AI-UI Verify: FAIL'));
  });

  it('includes Metrics section with table', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], { diff: '1.1.0' });
    const report = generateVerifyReport(verdict, []);
    assert.ok(report.includes('## Metrics'));
    assert.ok(report.includes('| Metric |'));
  });

  it('includes Blockers section when blockers exist', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, {});
    const report = generateVerifyReport(verdict, []);
    assert.ok(report.includes('## Blockers'));
    assert.ok(report.includes('max_orphan_ratio'));
  });

  it('omits Blockers section when no blockers', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, {});
    const report = generateVerifyReport(verdict, []);
    assert.ok(!report.includes('## Blockers'));
  });

  it('includes Top Recommended Fixes from plan entries', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, {});
    const report = generateVerifyReport(verdict, fixtures.failing.plan.plans);
    assert.ok(report.includes('## Top Recommended Fixes'));
    assert.ok(report.includes('Search'));
    assert.ok(report.includes('Login'));
  });

  it('limits top fixes to 5', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], {});
    // Create 10 fake plan entries
    const manyPlans = Array.from({ length: 10 }, (_, i) => ({
      feature_name: `Feature ${i}`, priority: 'P2', intent_class: 'config',
      placement: { rule: 'generic_cta', route: '/' },
      control: { pattern_kind: 'cta_button' },
    }));
    const report = generateVerifyReport(verdict, manyPlans);
    const fixLines = report.split('\n').filter(l => /^\d+\./.test(l));
    assert.equal(fixLines.length, 5);
  });

  it('includes Warnings section when warnings exist', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const verdict = generateVerdict(m, blockers, warnings, {});
    const report = generateVerifyReport(verdict, []);
    assert.ok(report.includes('## Warnings'));
  });

  it('includes reproduce command', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], {});
    const report = generateVerifyReport(verdict, []);
    assert.ok(report.includes('ai-ui verify --verbose'));
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('determinism', () => {
  it('produces identical verdicts on repeated runs (ignoring timestamps)', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers: b1, warnings: w1 } = applyRules(m, fixtures.defaultConfig);
    const v1 = generateVerdict(m, b1, w1, { diff: '1.1.0' });

    const { blockers: b2, warnings: w2 } = applyRules(m, fixtures.defaultConfig);
    const v2 = generateVerdict(m, b2, w2, { diff: '1.1.0' });

    const strip = v => ({ ...v, generated_at: 'STRIPPED' });
    assert.deepEqual(strip(v1), strip(v2));
  });

  it('report content is stable (ignoring timestamps)', () => {
    const m = extractMetrics(fixtures.failing.diff, fixtures.failing.plan, fixtures.failing.graph);
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    const v1 = generateVerdict(m, blockers, warnings, {});
    const v2 = generateVerdict(m, blockers, warnings, {});

    const stripTs = s => s.replace(/Generated:.*/, 'Generated: STRIPPED');
    const r1 = stripTs(generateVerifyReport(v1, fixtures.failing.plan.plans));
    const r2 = stripTs(generateVerifyReport(v2, fixtures.failing.plan.plans));
    assert.equal(r1, r2);
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('empty diff produces zero metrics', () => {
    const emptyDiff = { version: '1.1.0', matched: [], documented_not_discoverable: [], discoverable_not_documented: [], ambiguous_matches: [], burial_index: [], stats: {} };
    const emptyPlan = { version: '1.0.0', summary: { placements_by_priority: {} }, plans: [] };
    const emptyGraph = { version: '1.0.0', stats: { by_type: { feature: 0 }, orphan_features: 0 } };
    const m = extractMetrics(emptyDiff, emptyPlan, emptyGraph);
    assert.equal(m.total_features, 0);
    assert.equal(m.orphan_features, 0);
    assert.equal(m.orphan_ratio, 0);
  });

  it('verdict with no blockers and no warnings passes cleanly', () => {
    const m = { total_features: 5, orphan_features: 0, orphan_ratio: 0, coverage_percent: 100, p0_count: 0, p1_count: 0, p2_count: 0, undocumented_surfaces: 0, ambiguous_matches: 0, high_burial_triggers: 0 };
    const { blockers, warnings } = applyRules(m, fixtures.defaultConfig);
    assert.equal(blockers.length, 0);
    assert.equal(warnings.length, 0);
    const verdict = generateVerdict(m, blockers, warnings, {});
    assert.equal(verdict.pass, true);
    assert.equal(verdict.exit_code, 0);
  });

  it('orphan ratio exactly at threshold does not trigger blocker', () => {
    const m = { total_features: 4, orphan_features: 1, orphan_ratio: 0.25, coverage_percent: 75, p0_count: 0, p1_count: 0, p2_count: 0, undocumented_surfaces: 0, ambiguous_matches: 0, high_burial_triggers: 0 };
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    const orphanBlocker = blockers.find(b => b.rule === 'max_orphan_ratio');
    assert.equal(orphanBlocker, undefined);
  });

  it('orphan ratio just above threshold triggers blocker', () => {
    const m = { total_features: 4, orphan_features: 2, orphan_ratio: 0.5, coverage_percent: 50, p0_count: 0, p1_count: 0, p2_count: 0, undocumented_surfaces: 0, ambiguous_matches: 0, high_burial_triggers: 0 };
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    const orphanBlocker = blockers.find(b => b.rule === 'max_orphan_ratio');
    assert.ok(orphanBlocker);
  });

  it('undocumented exactly at threshold does not trigger', () => {
    const m = { total_features: 4, orphan_features: 0, orphan_ratio: 0, coverage_percent: 75, p0_count: 0, p1_count: 0, p2_count: 0, undocumented_surfaces: 10, ambiguous_matches: 0, high_burial_triggers: 0 };
    const { blockers } = applyRules(m, fixtures.defaultConfig);
    const undocBlocker = blockers.find(b => b.rule === 'max_undocumented_surfaces');
    assert.equal(undocBlocker, undefined);
  });

  it('report works with empty plan entries', () => {
    const m = extractMetrics(fixtures.passing.diff, fixtures.passing.plan, fixtures.passing.graph);
    const verdict = generateVerdict(m, [], [], {});
    const report = generateVerifyReport(verdict, []);
    assert.ok(report.includes('# AI-UI Verify: PASS'));
    assert.ok(!report.includes('## Top Recommended Fixes'));
  });
});
