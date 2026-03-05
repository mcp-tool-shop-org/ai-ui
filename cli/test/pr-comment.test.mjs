// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assemblePrCommentModel, renderPrComment } from '../src/pr-comment.mjs';

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/pr-comment-fixtures.json'), 'utf-8')
);

// =============================================================================
// assemblePrCommentModel
// =============================================================================

describe('assemblePrCommentModel', () => {
  it('assembles pass model with correct fields', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    assert.equal(model.pass, true);
    assert.equal(model.exit_code, 0);
    assert.equal(model.blockers.length, 0);
    assert.equal(model.blockers_truncated, 0);
    assert.equal(model.fixes.length, 0);
    assert.equal(model.fixes_truncated, 0);
    assert.equal(model.memory_suggestions.length, 0);
    assert.ok(model.metrics);
  });

  it('assembles fail model with blockers and warnings', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    assert.equal(model.pass, false);
    assert.equal(model.exit_code, 1);
    assert.equal(model.blockers.length, 3);
    assert.equal(model.warnings.length, 3);
  });

  it('truncates blockers to maxBlockers', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_tight);
    assert.equal(model.blockers.length, 1);
    assert.equal(model.blockers_truncated, 2);
  });

  it('truncates fixes to maxFixes', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_tight);
    assert.equal(model.fixes.length, 2);
    assert.equal(model.fixes_truncated, 4);
  });

  it('truncates warnings to maxWarnings', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_tight);
    assert.equal(model.warnings.length, 1);
    assert.equal(model.warnings_truncated, 2);
  });

  it('flattens PlanEntry into PrCommentFix', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const fix = model.fixes[0];
    assert.equal(fix.feature_id, 'search');
    assert.equal(fix.feature_name, 'Search');
    assert.equal(fix.priority, 'P0');
    assert.equal(fix.pattern_kind, 'nav_item');
    assert.equal(fix.route, '/');
    assert.equal(fix.label, 'Search');
    assert.ok(Array.isArray(fix.acceptance_criteria));
  });

  it('extracts memory suggestions from diff orphans', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    assert.equal(model.memory_suggestions.length, 3);
    const cr = model.memory_suggestions.find(s => s.feature_id === 'color-roles');
    assert.ok(cr);
    assert.equal(cr.suggested_trigger, 'Theme toggle');
    assert.ok(cr.hint.includes('Theme toggle'));
  });

  it('memory suggestions use "manual" when no candidates', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const fi = model.memory_suggestions.find(s => s.feature_id === 'fast-iteration');
    assert.ok(fi);
    assert.equal(fi.suggested_trigger, 'manual');
    assert.ok(fi.hint.includes('manual'));
  });

  it('memory suggestions empty when no orphans', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    assert.equal(model.memory_suggestions.length, 0);
  });

  it('includes baseline_deltas when present', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    assert.ok(model.baseline_deltas);
    assert.equal(model.baseline_deltas.length, 7);
    assert.equal(model.baseline_id, '2026-01-01T00:00:00.000Z');
  });

  it('omits baseline_deltas when absent', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    assert.equal(model.baseline_deltas, undefined);
    assert.equal(model.baseline_id, undefined);
  });

  it('includes must_surface_results when present', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    assert.ok(model.must_surface_results);
    assert.equal(model.must_surface_results.length, 4);
  });

  it('omits must_surface_results when absent', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    assert.equal(model.must_surface_results, undefined);
  });

  it('handles null plan and diff gracefully', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, null, null, fixtures.prConfig_default);
    assert.equal(model.fixes.length, 0);
    assert.equal(model.memory_suggestions.length, 0);
  });
});

// =============================================================================
// renderPrComment — github format
// =============================================================================

describe('renderPrComment github', () => {
  it('starts with ## AI-UI Verify: PASS for pass model', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.startsWith('## AI-UI Verify: PASS'));
  });

  it('starts with ## AI-UI Verify: FAIL for fail model', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.startsWith('## AI-UI Verify: FAIL'));
  });

  it('includes metrics table', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('| Coverage | 0% |'));
    assert.ok(md.includes('| Orphan ratio |'));
    assert.ok(md.includes('| P0 orphans | 2 |'));
  });

  it('includes must-surface violations in metrics when > 0', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('Must-surface violations'));
  });

  it('omits must-surface violations when 0', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(!md.includes('Must-surface violations'));
  });

  it('omits Blockers section when no blockers', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(!md.includes('### Blockers'));
  });

  it('includes Blockers section when blockers present', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Blockers'));
    assert.ok(md.includes('**max_orphan_ratio**'));
  });

  it('shows truncation note when blockers clipped', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_tight);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('and 2 more'));
    assert.ok(md.includes('--max-blockers'));
  });

  it('includes Top Fixes with numbered list', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Top Fixes'));
    assert.ok(md.includes('1. **Search** `[P0]`'));
  });

  it('uses <details> for acceptance criteria in github format', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('<details><summary>Acceptance criteria</summary>'));
    assert.ok(md.includes('</details>'));
  });

  it('omits Top Fixes when no fixes', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(!md.includes('### Top Fixes'));
  });

  it('shows truncation note when fixes clipped', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_tight);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('and 4 more'));
    assert.ok(md.includes('--max-fixes'));
  });

  it('includes Suggested Memory Updates when orphans exist', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Suggested Memory Updates'));
    assert.ok(md.includes('`color-roles`'));
  });

  it('omits Suggested Memory Updates when no orphans', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(!md.includes('### Suggested Memory Updates'));
  });

  it('includes Warnings section when warnings present', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Warnings'));
  });

  it('shows truncation note when warnings clipped', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_tight);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('and 2 more'));
    assert.ok(md.includes('--max-warnings'));
  });

  it('includes Baseline section when deltas present', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Baseline'));
    assert.ok(md.includes('| Orphan Features |'));
  });

  it('omits Baseline section when no deltas', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(!md.includes('### Baseline'));
  });

  it('includes Must-Surface Contract when present', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Must-Surface Contract'));
    assert.ok(md.includes('| color-roles | P0 | FAIL (orphaned) |'));
    assert.ok(md.includes('| fast-iteration | P1 | OK |'));
  });

  it('omits Must-Surface Contract when absent', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(!md.includes('### Must-Surface Contract'));
  });

  it('includes Reproduce section with code block', () => {
    const model = assemblePrCommentModel(fixtures.verification_pass, fixtures.plan_empty, fixtures.diff_clean, fixtures.prConfig_default);
    const md = renderPrComment(model, 'github');
    assert.ok(md.includes('### Reproduce'));
    assert.ok(md.includes('ai-ui verify --run-pipeline --verbose'));
    assert.ok(md.includes('ai-ui pr-comment'));
  });
});

// =============================================================================
// renderPrComment — markdown format
// =============================================================================

describe('renderPrComment markdown format', () => {
  it('does not use <details> tags', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'markdown');
    assert.ok(!md.includes('<details>'));
    assert.ok(!md.includes('</details>'));
  });

  it('still includes acceptance criteria as indented list', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md = renderPrComment(model, 'markdown');
    assert.ok(md.includes("   - From /, user can reach 'Search'"));
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('pr-comment determinism', () => {
  it('assemblePrCommentModel returns identical results on repeated calls', () => {
    const m1 = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const m2 = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    assert.deepStrictEqual(m1, m2);
  });

  it('renderPrComment returns identical output on repeated calls', () => {
    const model = assemblePrCommentModel(fixtures.verification_fail, fixtures.plan_with_fixes, fixtures.diff_with_orphans, fixtures.prConfig_default);
    const md1 = renderPrComment(model, 'github');
    const md2 = renderPrComment(model, 'github');
    assert.strictEqual(md1, md2);
  });
});
