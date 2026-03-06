// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffManifests,
  diffCoverage,
  diffActions,
  diffSurprises,
  buildDriftDiagnostics,
  buildReplayDiff,
  buildReplayDiffSummary,
  renderReplayDiffMarkdown,
  applyDiffGate,
} from '../src/replay-diff.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/replay-diff-fixtures.json'), 'utf-8'));

// =============================================================================
// diffManifests
// =============================================================================

describe('diffManifests', () => {
  it('detects all-match when packs have same config', () => {
    const result = diffManifests(fixtures.packA.manifest, fixtures.packB.manifest);
    assert.equal(result.tool_version.match, true);
    assert.equal(result.verify_config_hash.match, true);
    assert.equal(result.safe_config_hash.match, true);
    assert.equal(result.coverage_gate.match, true);
  });

  it('detects tool version and config hash mismatches', () => {
    const result = diffManifests(fixtures.packA.manifest, fixtures.packB_configMismatch.manifest);
    assert.equal(result.tool_version.match, false);
    assert.equal(result.tool_version.a, '1.0.0');
    assert.equal(result.tool_version.b, '1.1.0');
    assert.equal(result.verify_config_hash.match, false);
    assert.equal(result.safe_config_hash.match, false);
  });

  it('detects coverage_gate config delta', () => {
    const result = diffManifests(fixtures.packA.manifest, fixtures.packB_configMismatch.manifest);
    assert.equal(result.coverage_gate.match, false);
    assert.equal(result.coverage_gate.a.minCoveragePercent, 0);
    assert.equal(result.coverage_gate.b.minCoveragePercent, 50);
  });
});

// =============================================================================
// diffCoverage
// =============================================================================

describe('diffCoverage', () => {
  it('computes coverage deltas correctly', () => {
    const result = diffCoverage(
      fixtures.packA.artifacts.runtimeCoverage,
      fixtures.packB.artifacts.runtimeCoverage,
    );
    assert.equal(result.coverage_percent.a, 33);
    assert.equal(result.coverage_percent.b, 50);
    assert.equal(result.coverage_percent.change, 17);
    assert.equal(result.fully_covered.change, 1); // 1 → 2
    assert.equal(result.untested.change, -1); // 1 → 0
    assert.equal(result.surprise.change, 1); // 0 → 1
  });

  it('detects trigger status transitions', () => {
    const result = diffCoverage(
      fixtures.packA.artifacts.runtimeCoverage,
      fixtures.packB.artifacts.runtimeCoverage,
    );
    // B: partial → fully_covered, C: untested → partial, D: absent → surprise
    assert.ok(result.transitions.length >= 2);
    const transB = result.transitions.find(t => t.trigger_id === 'trigger:/|B');
    assert.ok(transB);
    assert.equal(transB.status_a, 'partial');
    assert.equal(transB.status_b, 'fully_covered');
    const transC = result.transitions.find(t => t.trigger_id === 'trigger:/|C');
    assert.ok(transC);
    assert.equal(transC.status_a, 'untested');
    assert.equal(transC.status_b, 'partial');
  });

  it('handles new trigger in B (absent in A)', () => {
    const result = diffCoverage(
      fixtures.packA.artifacts.runtimeCoverage,
      fixtures.packB.artifacts.runtimeCoverage,
    );
    const transD = result.transitions.find(t => t.trigger_id === 'trigger:/|D');
    assert.ok(transD);
    assert.equal(transD.status_a, null);
    assert.equal(transD.status_b, 'surprise');
  });

  it('transitions are sorted by trigger_id', () => {
    const result = diffCoverage(
      fixtures.packA.artifacts.runtimeCoverage,
      fixtures.packB.artifacts.runtimeCoverage,
    );
    for (let i = 1; i < result.transitions.length; i++) {
      assert.ok(result.transitions[i].trigger_id >= result.transitions[i - 1].trigger_id);
    }
  });
});

// =============================================================================
// diffActions
// =============================================================================

describe('diffActions', () => {
  it('identifies added and removed actions', () => {
    const result = diffActions(
      fixtures.packA.artifacts.runtimeCoverageActions,
      fixtures.packB.artifacts.runtimeCoverageActions,
    );
    // Added: ddd00004 (in B, not A)
    assert.equal(result.added.length, 1);
    assert.equal(result.added[0].actionId, 'act:ddd00004');
    // Removed: bbb00002, ccc00003 (in A, not B)
    assert.equal(result.removed.length, 2);
    assert.equal(result.removed[0].actionId, 'act:bbb00002');
    assert.equal(result.removed[1].actionId, 'act:ccc00003');
  });

  it('unchanged actions appear in neither added nor removed', () => {
    const result = diffActions(
      fixtures.packA.artifacts.runtimeCoverageActions,
      fixtures.packB.artifacts.runtimeCoverageActions,
    );
    // act:aaa00001 is in both — should not appear in added or removed
    assert.ok(!result.added.find(a => a.actionId === 'act:aaa00001'));
    assert.ok(!result.removed.find(a => a.actionId === 'act:aaa00001'));
  });

  it('computes total_actions delta', () => {
    const result = diffActions(
      fixtures.packA.artifacts.runtimeCoverageActions,
      fixtures.packB.artifacts.runtimeCoverageActions,
    );
    assert.equal(result.total_actions.a, 3);
    assert.equal(result.total_actions.b, 2);
    assert.equal(result.total_actions.change, -1);
  });

  it('handles empty action arrays', () => {
    const result = diffActions(
      { actions: [], summary: { total_actions: 0, by_type: {} } },
      { actions: [], summary: { total_actions: 0, by_type: {} } },
    );
    assert.equal(result.added.length, 0);
    assert.equal(result.removed.length, 0);
    assert.equal(result.total_actions.change, 0);
  });
});

// =============================================================================
// diffSurprises
// =============================================================================

describe('diffSurprises', () => {
  it('computes by_category change correctly', () => {
    const result = diffSurprises(
      fixtures.packA.artifacts.runtimeCoverage.surprises_v2,
      fixtures.packB.artifacts.runtimeCoverage.surprises_v2,
    );
    // A: new_effect=1, missing_expected=1, risky_skipped=1
    // B: identity_drift=1, risky_skipped=1
    assert.equal(result.by_category.change.new_effect, -1);
    assert.equal(result.by_category.change.missing_expected, -1);
    assert.equal(result.by_category.change.risky_skipped, 0);
    assert.equal(result.by_category.change.identity_drift, 1);
  });

  it('identifies added and removed surprises', () => {
    const result = diffSurprises(
      fixtures.packA.artifacts.runtimeCoverage.surprises_v2,
      fixtures.packB.artifacts.runtimeCoverage.surprises_v2,
    );
    // Added: identity_drift entry
    assert.ok(result.added.some(s => s.category === 'identity_drift'));
    // Removed: new_effect entry, missing_expected entry
    assert.ok(result.removed.some(s => s.category === 'new_effect'));
    assert.ok(result.removed.some(s => s.category === 'missing_expected'));
  });

  it('handles empty surprise arrays', () => {
    const result = diffSurprises([], []);
    assert.equal(result.added.length, 0);
    assert.equal(result.removed.length, 0);
    assert.deepEqual(result.by_category.change, {});
  });
});

// =============================================================================
// buildDriftDiagnostics
// =============================================================================

describe('buildDriftDiagnostics', () => {
  it('marks drift entries new in B as added', () => {
    const result = buildDriftDiagnostics(
      fixtures.packA.artifacts.runtimeCoverage.surprises_v2,
      fixtures.packB.artifacts.runtimeCoverage.surprises_v2,
    );
    // A has no identity_drift, B has one → should be 'added'
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'added');
    assert.equal(result[0].trigger_id, 'trigger:/|D');
    assert.equal(result[0].expected_id, 'effect:fetch:/old');
    assert.equal(result[0].observed_id, 'effect:fetch:/new');
  });

  it('filters only identity_drift category', () => {
    // A has 3 surprises (none identity_drift), B has 2 (1 identity_drift, 1 risky_skipped)
    const result = buildDriftDiagnostics(
      fixtures.packA.artifacts.runtimeCoverage.surprises_v2,
      fixtures.packB.artifacts.runtimeCoverage.surprises_v2,
    );
    for (const d of result) {
      // All entries should derive from identity_drift surprises
      assert.ok(d.expected_id || d.observed_id);
    }
  });

  it('returns empty array when no drift', () => {
    const result = buildDriftDiagnostics(
      fixtures.packA.artifacts.runtimeCoverage.surprises_v2,
      fixtures.packA.artifacts.runtimeCoverage.surprises_v2, // same → no new drift
    );
    assert.equal(result.length, 0);
  });
});

// =============================================================================
// buildReplayDiff
// =============================================================================

describe('buildReplayDiff', () => {
  it('produces correct structure', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json',
      pathB: 'b.replay.json',
    });
    assert.equal(diff.version, '1.0.0');
    assert.ok(diff.generated_at);
    assert.equal(diff.pack_paths.a, 'a.replay.json');
    assert.equal(diff.pack_paths.b, 'b.replay.json');
    assert.ok(diff.manifest);
    assert.ok(diff.coverage);
    assert.ok(diff.actions);
    assert.ok(diff.surprises);
    assert.ok(Array.isArray(diff.drift_diagnostics));
  });

  it('applies --top limit to arrays', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json',
      pathB: 'b.replay.json',
      top: 1,
    });
    assert.ok(diff.coverage.transitions.length <= 1);
    assert.ok(diff.actions.added.length <= 1);
    assert.ok(diff.actions.removed.length <= 1);
  });

  it('is deterministic (except generated_at)', () => {
    const diff1 = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    const diff2 = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    // Compare everything except generated_at
    diff1.generated_at = diff2.generated_at = '';
    assert.deepEqual(diff1, diff2);
  });
});

// =============================================================================
// buildReplayDiffSummary
// =============================================================================

describe('buildReplayDiffSummary', () => {
  it('extracts scalar values correctly', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    const summary = buildReplayDiffSummary(diff);
    assert.equal(summary.coverage_change, 17);
    assert.equal(summary.actions_added, 1);
    assert.equal(summary.actions_removed, 2);
    assert.ok(summary.transitions_count >= 2);
    assert.equal(summary.drift_count, 1);
  });

  it('config_match is true when all config hashes match', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    const summary = buildReplayDiffSummary(diff);
    assert.equal(summary.config_match, true); // packA and packB have same config
  });
});

// =============================================================================
// renderReplayDiffMarkdown
// =============================================================================

describe('renderReplayDiffMarkdown', () => {
  it('contains heading and all major sections', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    const md = renderReplayDiffMarkdown(diff);
    assert.ok(md.includes('# Replay Diff'));
    assert.ok(md.includes('## Manifest & Config'));
    assert.ok(md.includes('## Coverage Deltas'));
    assert.ok(md.includes('## Actions Delta'));
    assert.ok(md.includes('## Surprises Delta'));
  });

  it('shows Drift Diagnostics section when present', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    const md = renderReplayDiffMarkdown(diff);
    assert.ok(md.includes('## Identity Drift Diagnostics'));
    assert.ok(md.includes('effect:fetch:/old'));
    assert.ok(md.includes('effect:fetch:/new'));
  });

  it('omits Drift Diagnostics when empty', () => {
    // Compare pack A with itself → no drift
    const diff = buildReplayDiff(fixtures.packA, fixtures.packA, {
      pathA: 'a.replay.json', pathB: 'a.replay.json',
    });
    const md = renderReplayDiffMarkdown(diff);
    assert.ok(!md.includes('## Identity Drift Diagnostics'));
  });
});

// =============================================================================
// applyDiffGate
// =============================================================================

describe('applyDiffGate', () => {
  const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
    pathA: 'a.replay.json', pathB: 'b.replay.json',
  });

  it('mode=none always passes', () => {
    const result = applyDiffGate(diff, 'none');
    assert.equal(result.pass, true);
    assert.equal(result.blockers.length, 0);
  });

  it('mode=regressions fails when new actions exist', () => {
    const result = applyDiffGate(diff, 'regressions');
    assert.equal(result.pass, false);
    assert.ok(result.blockers.some(b => b.includes('new action')));
  });

  it('mode=regressions passes when no regressions', () => {
    // Compare pack A with itself → no new actions, no coverage drop
    const zeroDiff = buildReplayDiff(fixtures.packA, fixtures.packA, {
      pathA: 'a.replay.json', pathB: 'a.replay.json',
    });
    const result = applyDiffGate(zeroDiff, 'regressions');
    assert.equal(result.pass, true);
  });

  it('mode=minimum fails when coverage below threshold', () => {
    const result = applyDiffGate(diff, 'minimum', { minCoverage: 80 });
    assert.equal(result.pass, false);
    assert.ok(result.blockers.some(b => b.includes('below minimum')));
  });
});

// =============================================================================
// Round-trip
// =============================================================================

describe('round-trip', () => {
  it('identical packs produce zero-delta diff', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packA, {
      pathA: 'a.replay.json', pathB: 'a.replay.json',
    });
    assert.equal(diff.coverage.coverage_percent.change, 0);
    assert.equal(diff.actions.added.length, 0);
    assert.equal(diff.actions.removed.length, 0);
    assert.equal(diff.coverage.transitions.length, 0);
    assert.equal(diff.drift_diagnostics.length, 0);
  });

  it('summary is consistent with full diff', () => {
    const diff = buildReplayDiff(fixtures.packA, fixtures.packB, {
      pathA: 'a.replay.json', pathB: 'b.replay.json',
    });
    const summary = buildReplayDiffSummary(diff);
    assert.equal(summary.coverage_change, diff.coverage.coverage_percent.change);
    assert.equal(summary.actions_added, diff.actions.added.length);
    assert.equal(summary.actions_removed, diff.actions.removed.length);
    assert.equal(summary.transitions_count, diff.coverage.transitions.length);
    assert.equal(summary.drift_count, diff.drift_diagnostics.length);
  });
});
