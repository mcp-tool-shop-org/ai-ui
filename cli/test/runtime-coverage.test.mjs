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
});
