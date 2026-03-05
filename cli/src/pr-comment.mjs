// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

// =============================================================================
// Load artifacts from disk
// =============================================================================

/**
 * Load required artifacts for PR comment assembly.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {string} cwd
 * @returns {{ verification: import('./types.mjs').VerifyVerdict, plan: import('./types.mjs').SurfacingPlan | null, diff: any | null } | null}
 */
export function loadPrCommentArtifacts(config, cwd) {
  const verifyPath = resolve(cwd, config.output.verify);
  if (!existsSync(verifyPath)) return null;

  let verification;
  try {
    verification = JSON.parse(readFileSync(verifyPath, 'utf-8'));
  } catch {
    return null;
  }

  let plan = null;
  const planPath = resolve(cwd, config.output.composePlan);
  if (existsSync(planPath)) {
    try { plan = JSON.parse(readFileSync(planPath, 'utf-8')); } catch { /* skip */ }
  }

  let diff = null;
  const diffPath = resolve(cwd, config.output.diff);
  if (existsSync(diffPath)) {
    try { diff = JSON.parse(readFileSync(diffPath, 'utf-8')); } catch { /* skip */ }
  }

  return { verification, plan, diff };
}

// =============================================================================
// Assemble model — pure function
// =============================================================================

/**
 * Assemble PR comment model from raw artifacts.
 * @param {import('./types.mjs').VerifyVerdict} verification
 * @param {import('./types.mjs').SurfacingPlan | null} plan
 * @param {any | null} diff
 * @param {import('./types.mjs').PrCommentConfig} prConfig
 * @returns {import('./types.mjs').PrCommentModel}
 */
export function assemblePrCommentModel(verification, plan, diff, prConfig) {
  // Blockers — slice + truncation count
  const allBlockers = verification.blockers || [];
  const blockers = allBlockers.slice(0, prConfig.maxBlockers);
  const blockers_truncated = Math.max(0, allBlockers.length - prConfig.maxBlockers);

  // Fixes — flatten PlanEntry → PrCommentFix
  const allPlans = (plan && plan.plans) || [];
  const allFixes = allPlans.map(p => ({
    feature_id: p.feature_id,
    feature_name: p.feature_name,
    priority: p.priority,
    pattern_kind: p.control.pattern_kind,
    route: p.placement.route,
    label: p.control.label,
    acceptance_criteria: p.acceptance_criteria || [],
  }));
  const fixes = allFixes.slice(0, prConfig.maxFixes);
  const fixes_truncated = Math.max(0, allFixes.length - prConfig.maxFixes);

  // Memory suggestions — from diff orphans
  const orphans = (diff && diff.documented_not_discoverable) || [];
  const memory_suggestions = orphans.map(o => {
    const topCandidate = (o.top_candidates && o.top_candidates.length > 0)
      ? o.top_candidates[0]
      : null;
    const suggested_trigger = topCandidate ? topCandidate.source_label : 'manual';
    const hint = topCandidate
      ? `Nearest candidate: "${topCandidate.source_label}" (score ${topCandidate.composite_score})`
      : 'No close candidates, needs manual mapping';
    return {
      feature_id: o.feature_id,
      feature_name: o.feature_name,
      suggested_trigger,
      hint,
    };
  });

  // Warnings — slice + truncation count
  const allWarnings = verification.warnings || [];
  const warnings = allWarnings.slice(0, prConfig.maxWarnings);
  const warnings_truncated = Math.max(0, allWarnings.length - prConfig.maxWarnings);

  /** @type {import('./types.mjs').PrCommentModel} */
  const model = {
    pass: verification.pass,
    exit_code: verification.exit_code,
    metrics: verification.metrics,
    blockers,
    blockers_truncated,
    fixes,
    fixes_truncated,
    memory_suggestions,
    warnings,
    warnings_truncated,
  };

  if (verification.baseline_deltas) {
    model.baseline_deltas = verification.baseline_deltas;
    model.baseline_id = verification.baseline_id;
  }

  if (verification.must_surface_results) {
    model.must_surface_results = verification.must_surface_results;
  }

  return model;
}

// =============================================================================
// Render markdown — pure function
// =============================================================================

/**
 * Render PR comment model to markdown.
 * Deterministic: no timestamps in the body.
 * @param {import('./types.mjs').PrCommentModel} model
 * @param {'github'|'gitlab'|'markdown'} format
 * @returns {string}
 */
export function renderPrComment(model, format) {
  const lines = [];
  const useDetails = format === 'github' || format === 'gitlab';

  // Header
  const status = model.pass ? 'PASS' : 'FAIL';
  lines.push(`## AI-UI Verify: ${status}`);
  lines.push('');

  // Metrics summary table
  const m = model.metrics;
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Coverage | ${m.coverage_percent}% |`);
  lines.push(`| Orphan ratio | ${(m.orphan_ratio * 100).toFixed(0)}% (${m.orphan_features}/${m.total_features}) |`);
  lines.push(`| P0 orphans | ${m.p0_count} |`);
  lines.push(`| Undocumented surfaces | ${m.undocumented_surfaces} |`);
  if (m.must_surface_violations > 0) {
    lines.push(`| Must-surface violations | ${m.must_surface_violations} |`);
  }
  lines.push('');

  // Blockers
  if (model.blockers.length > 0) {
    lines.push('### Blockers');
    lines.push('');
    for (const b of model.blockers) {
      lines.push(`- **${b.rule}**: ${b.message}`);
    }
    if (model.blockers_truncated > 0) {
      lines.push('');
      lines.push(`*...and ${model.blockers_truncated} more. Run with \`--max-blockers ${model.blockers.length + model.blockers_truncated}\` to see all.*`);
    }
    lines.push('');
  }

  // Top Fixes
  if (model.fixes.length > 0) {
    lines.push('### Top Fixes');
    lines.push('');
    for (let i = 0; i < model.fixes.length; i++) {
      const f = model.fixes[i];
      lines.push(`${i + 1}. **${f.feature_name}** \`[${f.priority}]\` — ${f.pattern_kind} on ${f.route}`);
      if (f.acceptance_criteria.length > 0) {
        if (useDetails) {
          lines.push(`   <details><summary>Acceptance criteria</summary>`);
          lines.push('');
          for (const c of f.acceptance_criteria) {
            lines.push(`   - ${c}`);
          }
          lines.push('');
          lines.push(`   </details>`);
        } else {
          for (const c of f.acceptance_criteria) {
            lines.push(`   - ${c}`);
          }
        }
      }
    }
    if (model.fixes_truncated > 0) {
      lines.push('');
      lines.push(`*...and ${model.fixes_truncated} more. Run with \`--max-fixes ${model.fixes.length + model.fixes_truncated}\` to see all.*`);
    }
    lines.push('');
  }

  // Suggested Memory Updates
  if (model.memory_suggestions.length > 0) {
    lines.push('### Suggested Memory Updates');
    lines.push('');
    for (const s of model.memory_suggestions) {
      lines.push(`- \`${s.feature_id}\` — ${s.hint}`);
    }
    lines.push('');
  }

  // Warnings
  if (model.warnings.length > 0) {
    lines.push('### Warnings');
    lines.push('');
    for (const w of model.warnings) {
      lines.push(`- ${w.message}`);
    }
    if (model.warnings_truncated > 0) {
      lines.push('');
      lines.push(`*...and ${model.warnings_truncated} more. Run with \`--max-warnings ${model.warnings.length + model.warnings_truncated}\` to see all.*`);
    }
    lines.push('');
  }

  // Baseline
  if (model.baseline_deltas && model.baseline_deltas.length > 0) {
    lines.push('### Baseline');
    lines.push('');
    lines.push('| Metric | Baseline | Current | Change |');
    lines.push('|--------|----------|---------|--------|');
    for (const d of model.baseline_deltas) {
      const sign = d.change > 0 ? '+' : '';
      const changeStr = d.metric === 'orphan_ratio'
        ? `${sign}${(d.change * 100).toFixed(0)}%`
        : d.metric === 'coverage_percent'
          ? `${sign}${d.change}%`
          : `${sign}${d.change}`;
      const baseStr = formatMetricValue(d.metric, d.baseline_value);
      const currStr = formatMetricValue(d.metric, d.current_value);
      lines.push(`| ${formatMetricName(d.metric)} | ${baseStr} | ${currStr} | ${changeStr} |`);
    }
    lines.push('');
  }

  // Must-Surface Contract
  if (model.must_surface_results && model.must_surface_results.length > 0) {
    lines.push('### Must-Surface Contract');
    lines.push('');
    lines.push('| Feature | Severity | Status |');
    lines.push('|---------|----------|--------|');
    for (const r of model.must_surface_results) {
      const statusLabel = r.status === 'ok' ? 'OK'
        : r.status === 'orphaned' ? 'FAIL (orphaned)'
        : 'WARN (missing)';
      lines.push(`| ${r.feature_id} | ${r.severity} | ${statusLabel} |`);
    }
    lines.push('');
  }

  // Reproduce
  lines.push('### Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('ai-ui verify --run-pipeline --verbose');
  lines.push('ai-ui pr-comment');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

/**
 * @param {string} metric
 * @param {number} value
 * @returns {string}
 */
function formatMetricValue(metric, value) {
  if (metric === 'orphan_ratio') return `${(value * 100).toFixed(0)}%`;
  if (metric === 'coverage_percent') return `${value}%`;
  return String(value);
}

/**
 * @param {string} metric
 * @returns {string}
 */
function formatMetricName(metric) {
  return metric.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the pr-comment command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, runPipeline?: boolean, json?: boolean, noMemory?: boolean, noMustSurface?: boolean, format?: string, maxFixes?: number, maxBlockers?: number, maxWarnings?: number }} flags
 */
export async function runPrComment(config, flags) {
  const cwd = process.cwd();

  // If --run-pipeline and verification.json doesn't exist, run verify first
  const verifyPath = resolve(cwd, config.output.verify);
  if (flags.runPipeline && !existsSync(verifyPath)) {
    if (flags.verbose) console.log('PR-comment: running pipeline...\n');
    const { runVerify } = await import('./verify.mjs');
    await runVerify(config, {
      runPipeline: true,
      verbose: flags.verbose,
      noMemory: flags.noMemory,
      noMustSurface: flags.noMustSurface,
    });
    if (flags.verbose) console.log('\nPR-comment: pipeline complete, assembling...\n');
  }

  const artifacts = loadPrCommentArtifacts(config, cwd);
  if (!artifacts) {
    console.error('PR-comment: verification.json not found.');
    console.error('  Hint: Run "ai-ui verify" first, or use "ai-ui pr-comment --run-pipeline".');
    process.exitCode = 2;
    return;
  }

  /** @type {import('./types.mjs').PrCommentConfig} */
  const prConfig = {
    maxFixes: flags.maxFixes ?? 5,
    maxBlockers: flags.maxBlockers ?? 10,
    maxWarnings: flags.maxWarnings ?? 10,
    format: /** @type {'github'|'gitlab'|'markdown'} */ (flags.format ?? 'github'),
  };

  const model = assemblePrCommentModel(artifacts.verification, artifacts.plan, artifacts.diff, prConfig);
  const markdown = renderPrComment(model, prConfig.format);

  if (flags.json) {
    const jsonPath = resolve(cwd, config.output.prCommentJson);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(model, null, 2) + '\n', 'utf-8');
    console.log(JSON.stringify(model, null, 2));
  } else {
    const mdPath = resolve(cwd, config.output.prComment);
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, markdown, 'utf-8');
    console.log(markdown);

    if (flags.verbose) {
      console.error(`PR-comment: written to ${relative(cwd, mdPath)}`);
    }
  }

  process.exitCode = model.exit_code;
}
