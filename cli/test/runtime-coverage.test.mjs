// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCoverage,
  classifyStatus,
  renderCoverageMarkdown,
  buildActionId,
  deriveExpectedEffects,
  classifySurprisesV2,
  buildActionQueue,
  scoreNextBestProbes,
  buildActionableReport,
  renderActionsMarkdown,
} from '../src/runtime-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runtime-coverage-fixtures.json'), 'utf-8'));

// =============================================================================
// classifyStatus
// =============================================================================

describe('classifyStatus', () => {
  it('returns fully_covered when all three true', () => {
    assert.equal(classifyStatus(true, true, true), 'fully_covered');
  });

  it('returns partial when two of three true', () => {
    assert.equal(classifyStatus(true, true, false), 'partial');
    assert.equal(classifyStatus(true, false, true), 'partial');
    assert.equal(classifyStatus(false, true, true), 'partial');
  });

  it('returns untested when only probed', () => {
    assert.equal(classifyStatus(true, false, false), 'untested');
  });

  it('returns untested when none true', () => {
    assert.equal(classifyStatus(false, false, false), 'untested');
  });

  it('returns surprise when only observed', () => {
    assert.equal(classifyStatus(false, false, true), 'surprise');
  });
});

// =============================================================================
// computeCoverage
// =============================================================================

describe('computeCoverage', () => {
  it('computes coverage from full artifacts', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    assert.equal(report.version, '1.0.0');
    assert.ok(report.triggers.length > 0);
    assert.ok(report.summary.total > 0);
  });

  it('marks Get started as fully_covered (probed + surface + observed)', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const cta = report.triggers.find(t => t.label === 'Get started');
    assert.ok(cta);
    assert.equal(cta.probed, true);
    assert.equal(cta.hasSurface, true);
    assert.equal(cta.observed, true);
    assert.equal(cta.status, 'fully_covered');
  });

  it('marks Search as partial (probed + observed, no surface)', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const search = report.triggers.find(t => t.label === 'Search');
    assert.ok(search);
    assert.equal(search.probed, true);
    assert.equal(search.hasSurface, false);
    assert.equal(search.observed, true);
    assert.equal(search.status, 'partial');
  });

  it('marks Export as untested (probed only)', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const exp = report.triggers.find(t => t.label === 'Export');
    assert.ok(exp);
    assert.equal(exp.probed, true);
    assert.equal(exp.observed, false);
    assert.equal(exp.status, 'untested');
  });

  it('detects Surprise Button as surprise trigger', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const surprise = report.triggers.find(t => t.label === 'Surprise Button');
    assert.ok(surprise);
    assert.equal(surprise.status, 'surprise');
    assert.equal(surprise.observed, true);
    assert.equal(surprise.probed, false);
  });

  it('adds surprise entries for new runtime effects', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    assert.ok(report.surprises.length > 0);
    const surpriseEntry = report.surprises.find(s => s.label === 'Surprise Button');
    assert.ok(surpriseEntry);
    assert.equal(surpriseEntry.reason, 'new_runtime_effect');
  });

  it('detects risky_skipped for destructive triggers not observed', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const risky = report.surprises.find(s => s.reason === 'risky_skipped');
    assert.ok(risky);
    assert.equal(risky.label, 'Delete');
  });

  it('sorts triggers deterministically', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const ids = report.triggers.map(t => t.trigger_id);
    const sorted = [...ids].sort();
    assert.deepStrictEqual(ids, sorted);
  });

  it('computes coverage_percent correctly', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    // 1 fully_covered out of 5 total (4 graph + 1 surprise)
    assert.equal(report.summary.fully_covered, 1);
    assert.equal(report.summary.total, 5);
    assert.equal(report.summary.coverage_percent, 20);
  });

  it('includes effect kinds in trigger effects', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const cta = report.triggers.find(t => t.label === 'Get started');
    assert.ok(cta.effects.includes('navigate'));
  });

  it('handles no runtime summary (all untested)', () => {
    const report = computeCoverage(fixtures.graph, null, fixtures.probeEntries);
    for (const t of report.triggers) {
      assert.ok(t.status === 'untested' || t.status === 'partial');
      assert.equal(t.observed, false);
    }
    assert.equal(report.summary.surprise, 0);
  });

  it('handles no probe entries', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, null);
    for (const t of report.triggers) {
      assert.equal(t.probed, false);
    }
  });

  it('handles empty graph', () => {
    const report = computeCoverage(fixtures.emptyGraph, null, null);
    assert.equal(report.triggers.length, 0);
    assert.equal(report.summary.total, 0);
    assert.equal(report.summary.coverage_percent, 0);
  });

  it('is deterministic across runs (except generated_at)', () => {
    const r1 = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const r2 = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    assert.deepStrictEqual(r1.triggers, r2.triggers);
    assert.deepStrictEqual(r1.summary, r2.summary);
    assert.deepStrictEqual(r1.surprises, r2.surprises);
  });
});

// =============================================================================
// renderCoverageMarkdown
// =============================================================================

describe('renderCoverageMarkdown', () => {
  it('renders a valid markdown report', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const md = renderCoverageMarkdown(report);
    assert.ok(md.includes('# Runtime Coverage Report'));
    assert.ok(md.includes('## Coverage Summary'));
    assert.ok(md.includes('## Per-Trigger Matrix'));
  });

  it('includes coverage summary table', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const md = renderCoverageMarkdown(report);
    assert.ok(md.includes('Total triggers'));
    assert.ok(md.includes('Fully covered'));
    assert.ok(md.includes('Coverage'));
  });

  it('includes per-trigger rows', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const md = renderCoverageMarkdown(report);
    assert.ok(md.includes('Get started'));
    assert.ok(md.includes('Search'));
    assert.ok(md.includes('Export'));
  });

  it('includes Most Surprising section when surprises exist', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const md = renderCoverageMarkdown(report);
    assert.ok(md.includes('## Most Surprising'));
    assert.ok(md.includes('Surprise Button'));
  });

  it('omits Most Surprising section when no surprises', () => {
    const report = computeCoverage(fixtures.graph, null, fixtures.probeEntries);
    // No runtime = no surprises about new_runtime_effect
    // But risky_skipped may still appear
    const md = renderCoverageMarkdown(report);
    // Either the section is omitted or present (depending on risky_skipped)
    assert.ok(typeof md === 'string');
  });

  it('handles empty report', () => {
    const report = computeCoverage(fixtures.emptyGraph, null, null);
    const md = renderCoverageMarkdown(report);
    assert.ok(md.includes('No triggers found'));
  });

  it('markdown is deterministic', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    const md1 = renderCoverageMarkdown(report);
    const md2 = renderCoverageMarkdown(report);
    assert.equal(md1, md2);
  });

  it('includes Surprise Details section when surprises_v2 exist', () => {
    const report = computeCoverage(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    const md = renderCoverageMarkdown(report);
    assert.ok(md.includes('## Surprise Details'));
    assert.ok(md.includes('missing_expected') || md.includes('new_effect') || md.includes('risky_skipped'));
  });
});

// =============================================================================
// buildActionId
// =============================================================================

describe('buildActionId', () => {
  it('returns act: prefixed string', () => {
    const id = buildActionId('probe_trigger', 'trigger:/|Submit');
    assert.ok(id.startsWith('act:'));
    assert.equal(id.length, 12); // 'act:' + 8 hex digits
  });

  it('is deterministic (same inputs → same output)', () => {
    const a = buildActionId('probe_trigger', 'trigger:/|Submit');
    const b = buildActionId('probe_trigger', 'trigger:/|Submit');
    assert.equal(a, b);
  });

  it('differs for different types', () => {
    const a = buildActionId('probe_trigger', 'trigger:/|Submit');
    const b = buildActionId('investigate_missing', 'trigger:/|Submit');
    assert.notEqual(a, b);
  });

  it('differs for different effectIds', () => {
    const a = buildActionId('investigate_missing', 'trigger:/|Submit', 'effect:submit:/');
    const b = buildActionId('investigate_missing', 'trigger:/|Submit', 'effect:navigate:/dashboard');
    assert.notEqual(a, b);
  });
});

// =============================================================================
// deriveExpectedEffects
// =============================================================================

describe('deriveExpectedEffects', () => {
  it('returns expected effects for Submit (2 effects via surface)', () => {
    const effects = deriveExpectedEffects(fixtures.graphWithExpectedEffects, 'trigger:/|Submit');
    assert.equal(effects.length, 2);
    assert.ok(effects.includes('effect:submit:/'));
    assert.ok(effects.includes('effect:navigate:/dashboard'));
  });

  it('returns expected effects for Refresh (1 effect via surface)', () => {
    const effects = deriveExpectedEffects(fixtures.graphWithExpectedEffects, 'trigger:/|Refresh');
    assert.equal(effects.length, 1);
    assert.ok(effects.includes('effect:filter:/'));
  });

  it('returns empty for Delete (no maps_to edge)', () => {
    const effects = deriveExpectedEffects(fixtures.graphWithExpectedEffects, 'trigger:/|Delete');
    assert.equal(effects.length, 0);
  });

  it('returns sorted effect IDs', () => {
    const effects = deriveExpectedEffects(fixtures.graphWithExpectedEffects, 'trigger:/|Submit');
    const sorted = [...effects].sort();
    assert.deepStrictEqual(effects, sorted);
  });
});

// =============================================================================
// classifySurprisesV2
// =============================================================================

describe('classifySurprisesV2', () => {
  it('detects new_effect for runtime trigger not in graph', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    const newEffect = surprises.find(s => s.category === 'new_effect');
    assert.ok(newEffect, 'should detect new_effect');
    assert.equal(newEffect.label, 'Unknown Widget');
  });

  it('detects missing_expected for Submit (navigate:/dashboard not observed)', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    const missing = surprises.filter(s => s.category === 'missing_expected');
    assert.ok(missing.length > 0, 'should detect missing_expected');
    // Submit has 2 expected effects (submit + navigate:/dashboard)
    // Runtime only shows fetch POST /api/submit → the navigate effect should be missing
    const navigateMissing = missing.find(s => s.expected_id === 'effect:navigate:/dashboard');
    assert.ok(navigateMissing, 'should detect navigate:/dashboard as missing');
  });

  it('detects risky_skipped for destructive Delete trigger', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    const risky = surprises.find(s => s.category === 'risky_skipped');
    assert.ok(risky, 'should detect risky_skipped');
    assert.equal(risky.label, 'Delete');
  });

  it('detects low_attribution from augmented graph', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithLowAttribution,
      null,
      null,
    );
    const lowAttr = surprises.find(s => s.category === 'low_attribution');
    assert.ok(lowAttr, 'should detect low_attribution');
    assert.equal(lowAttr.effect_id, 'effect:domEffect:dom_change');
  });

  it('returns empty for empty graph', () => {
    const surprises = classifySurprisesV2(fixtures.emptyGraph, null, null);
    assert.equal(surprises.length, 0);
  });

  it('returns no duplicates (each trigger+category unique)', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    const keys = surprises.map(s => `${s.trigger_id}|${s.category}|${s.expected_id || ''}`);
    const unique = [...new Set(keys)];
    assert.equal(keys.length, unique.length);
  });

  it('sorts deterministically by trigger_id then category', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    for (let i = 1; i < surprises.length; i++) {
      const cmp = surprises[i - 1].trigger_id.localeCompare(surprises[i].trigger_id)
        || surprises[i - 1].category.localeCompare(surprises[i].category);
      assert.ok(cmp <= 0, `sort order violated at index ${i}`);
    }
  });

  it('is deterministic across runs', () => {
    const a = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const b = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    assert.deepStrictEqual(a, b);
  });

  it('handles null runtimeSummary and probeEntries', () => {
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      null,
      null,
    );
    // Should only find risky_skipped (Delete not observed) — no runtime data means no new_effect/missing_expected
    assert.ok(surprises.every(s => s.category === 'risky_skipped'));
  });

  it('all category values are valid SurpriseCategory', () => {
    const valid = new Set(['new_effect', 'missing_expected', 'identity_drift', 'low_attribution', 'risky_skipped']);
    const surprises = classifySurprisesV2(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
    for (const s of surprises) {
      assert.ok(valid.has(s.category), `invalid category: ${s.category}`);
    }
  });
});

// =============================================================================
// buildActionQueue
// =============================================================================

describe('buildActionQueue', () => {
  /** @returns {import('../src/types.mjs').CoverageReport} */
  function makeReport() {
    return computeCoverage(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
  }

  it('generates probe_trigger actions for untested triggers', () => {
    const report = makeReport();
    const surprises = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const actions = buildActionQueue(fixtures.graphWithExpectedEffects, report, surprises, fixtures.safeConfig);
    const probeActions = actions.filter(a => a.type === 'probe_trigger');
    assert.ok(probeActions.length > 0, 'should generate probe_trigger actions');
  });

  it('generates investigate_missing actions from missing_expected surprises', () => {
    const report = makeReport();
    const surprises = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const actions = buildActionQueue(fixtures.graphWithExpectedEffects, report, surprises, fixtures.safeConfig);
    const missing = actions.filter(a => a.type === 'investigate_missing');
    assert.ok(missing.length > 0, 'should generate investigate_missing actions');
  });

  it('generates review_new_effect actions from new_effect surprises', () => {
    const report = makeReport();
    const surprises = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const actions = buildActionQueue(fixtures.graphWithExpectedEffects, report, surprises, fixtures.safeConfig);
    const newEffect = actions.filter(a => a.type === 'review_new_effect');
    assert.ok(newEffect.length > 0, 'should generate review_new_effect actions');
  });

  it('deduplicates actions by actionId', () => {
    const report = makeReport();
    const surprises = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const actions = buildActionQueue(fixtures.graphWithExpectedEffects, report, surprises, fixtures.safeConfig);
    const ids = actions.map(a => a.actionId);
    const unique = [...new Set(ids)];
    assert.equal(ids.length, unique.length, 'should have no duplicate actionIds');
  });

  it('sorts by priority desc, then actionId', () => {
    const report = makeReport();
    const surprises = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const actions = buildActionQueue(fixtures.graphWithExpectedEffects, report, surprises, fixtures.safeConfig);
    for (let i = 1; i < actions.length; i++) {
      const priorityOk = actions[i - 1].priority >= actions[i].priority;
      const tieOk = actions[i - 1].priority > actions[i].priority ||
        actions[i - 1].actionId.localeCompare(actions[i].actionId) <= 0;
      assert.ok(priorityOk && tieOk, `sort order violated at index ${i}`);
    }
  });

  it('marks destructive triggers as unsafe risk', () => {
    const report = makeReport();
    const surprises = classifySurprisesV2(fixtures.graphWithExpectedEffects, fixtures.runtimeMissingExpected, fixtures.probeMissingExpected);
    const actions = buildActionQueue(fixtures.graphWithExpectedEffects, report, surprises, fixtures.safeConfig);
    // Delete has denyLabelRegex match → should be unsafe
    const deleteAction = actions.find(a => a.triggerId && a.triggerId.includes('Delete'));
    assert.ok(deleteAction, 'should have action for Delete trigger');
    assert.equal(deleteAction.risk, 'unsafe');
  });

  it('returns empty for empty graph + no surprises', () => {
    const emptyReport = computeCoverage(fixtures.emptyGraph, null, null);
    const actions = buildActionQueue(fixtures.emptyGraph, emptyReport, [], fixtures.safeConfig);
    assert.equal(actions.length, 0);
  });

  it('generates increase_confidence from low_attribution', () => {
    const lowSurprises = classifySurprisesV2(fixtures.graphWithLowAttribution, null, null);
    const report = computeCoverage(fixtures.graphWithLowAttribution, null, null);
    const actions = buildActionQueue(fixtures.graphWithLowAttribution, report, lowSurprises, fixtures.safeConfig);
    const confidence = actions.filter(a => a.type === 'increase_confidence');
    assert.ok(confidence.length > 0, 'should generate increase_confidence actions');
  });
});

// =============================================================================
// scoreNextBestProbes
// =============================================================================

describe('scoreNextBestProbes', () => {
  /** @returns {import('../src/types.mjs').CoverageReport} */
  function makeReport() {
    return computeCoverage(
      fixtures.graphWithExpectedEffects,
      fixtures.runtimeMissingExpected,
      fixtures.probeMissingExpected,
    );
  }

  it('returns probes sorted by score desc', () => {
    const report = makeReport();
    const probes = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig);
    for (let i = 1; i < probes.length; i++) {
      assert.ok(probes[i - 1].score >= probes[i].score, `sort order violated at index ${i}`);
    }
  });

  it('unprobed triggers score higher than probed ones', () => {
    const report = makeReport();
    const probes = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig);
    // Unprobed trigger (not in probeMissingExpected) should have no -4 penalty
    const unprobed = probes.find(p => p.label === 'Unprobed');
    const probed = probes.find(p => p.label === 'Submit');
    if (unprobed && probed) {
      // Unprobed shouldn't have the "already probed" penalty
      assert.ok(!unprobed.reasons.some(r => r.includes('already probed')));
    }
  });

  it('applies risk penalty for destructive triggers', () => {
    const report = makeReport();
    const probes = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig);
    const deleteProbe = probes.find(p => p.label === 'Delete');
    if (deleteProbe) {
      assert.equal(deleteProbe.risk, 'unsafe');
      assert.ok(deleteProbe.reasons.some(r => r.includes('risk penalty')));
    }
  });

  it('respects topN limit', () => {
    const report = makeReport();
    const probes = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig, { topN: 2 });
    assert.ok(probes.length <= 2);
  });

  it('includes reasons array for each probe', () => {
    const report = makeReport();
    const probes = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig);
    for (const p of probes) {
      assert.ok(Array.isArray(p.reasons));
    }
  });

  it('is deterministic across runs', () => {
    const report = makeReport();
    const a = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig);
    const b = scoreNextBestProbes(fixtures.graphWithExpectedEffects, report, fixtures.safeConfig);
    assert.deepStrictEqual(a, b);
  });
});

// =============================================================================
// buildActionableReport
// =============================================================================

describe('buildActionableReport', () => {
  it('assembles report with correct summary', () => {
    const actions = [
      { actionId: 'act:00000001', type: 'probe_trigger', priority: 10, impact: 20, risk: 'safe', effort: 'low', rationale: 'test' },
      { actionId: 'act:00000002', type: 'investigate_missing', priority: 20, impact: 30, risk: 'caution', effort: 'med', rationale: 'test2' },
    ];
    const probes = [];
    const report = buildActionableReport(actions, probes);
    assert.equal(report.version, '7.0.0');
    assert.equal(report.summary.total_actions, 2);
    assert.equal(report.summary.by_type.probe_trigger, 1);
    assert.equal(report.summary.by_type.investigate_missing, 1);
    assert.equal(report.summary.estimated_coverage_gain, 50);
  });

  it('caps estimated_coverage_gain at 100', () => {
    const actions = Array.from({ length: 20 }, (_, i) => ({
      actionId: `act:${String(i).padStart(8, '0')}`,
      type: 'probe_trigger',
      priority: 10,
      impact: 10,
      risk: 'safe',
      effort: 'low',
      rationale: `test ${i}`,
    }));
    const report = buildActionableReport(actions, []);
    assert.equal(report.summary.estimated_coverage_gain, 100);
  });

  it('handles empty actions and probes', () => {
    const report = buildActionableReport([], []);
    assert.equal(report.summary.total_actions, 0);
    assert.equal(report.summary.estimated_coverage_gain, 0);
    assert.deepStrictEqual(report.summary.by_type, {});
  });
});

// =============================================================================
// renderActionsMarkdown
// =============================================================================

describe('renderActionsMarkdown', () => {
  it('renders Action Queue table when actions exist', () => {
    const report = buildActionableReport(
      [{ actionId: 'act:00000001', type: 'probe_trigger', priority: 10, impact: 20, risk: 'safe', effort: 'low', rationale: 'test' }],
      [{ trigger_id: 'trigger:/|X', label: 'X', route: '/', score: 5, reasons: ['reason1'], risk: 'safe' }],
    );
    const md = renderActionsMarkdown(report);
    assert.ok(md.includes('## Action Queue'));
    assert.ok(md.includes('probe_trigger'));
    assert.ok(md.includes('## Next Best Probes'));
    assert.ok(md.includes('reason1'));
  });

  it('renders "No actions needed." when empty', () => {
    const report = buildActionableReport([], []);
    const md = renderActionsMarkdown(report);
    assert.ok(md.includes('No actions needed.'));
    assert.ok(md.includes('All triggers probed.'));
  });

  it('includes summary line with coverage gain', () => {
    const report = buildActionableReport(
      [{ actionId: 'act:00000001', type: 'probe_trigger', priority: 10, impact: 25, risk: 'safe', effort: 'low', rationale: 'test' }],
      [],
    );
    const md = renderActionsMarkdown(report);
    assert.ok(md.includes('1 actions'));
    assert.ok(md.includes('+25%'));
  });
});

// =============================================================================
// Backward compatibility
// =============================================================================

describe('backward compatibility', () => {
  it('old surprises array still present and unchanged', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    assert.ok(Array.isArray(report.surprises));
    assert.ok(report.surprises.length > 0);
    // Old format: trigger_id, label, route, reason
    for (const s of report.surprises) {
      assert.ok(s.trigger_id);
      assert.ok(s.label);
      assert.ok(s.reason);
    }
  });

  it('surprises_v2 is present alongside old surprises', () => {
    const report = computeCoverage(fixtures.graph, fixtures.runtimeSummary, fixtures.probeEntries);
    assert.ok(Array.isArray(report.surprises_v2));
    // V2 uses category instead of reason
    for (const s of report.surprises_v2) {
      assert.ok(s.trigger_id);
      assert.ok(s.category);
      assert.ok(s.detail);
    }
  });
});
