// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';

// =============================================================================
// Metric extraction — pure function
// =============================================================================

/**
 * Extract verification metrics from pipeline artifacts.
 * @param {any} diff - Parsed diff.json
 * @param {import('./types.mjs').SurfacingPlan} plan - Parsed surfacing-plan.json
 * @param {import('./types.mjs').TriggerGraph} graph - Parsed trigger-graph.json
 * @returns {import('./types.mjs').VerifyMetrics}
 */
export function extractMetrics(diff, plan, graph) {
  const totalFeatures = graph.stats.by_type.feature || 0;
  const orphanFeatures = graph.stats.orphan_features || 0;
  const orphanRatio = totalFeatures > 0
    ? Math.round((orphanFeatures / totalFeatures) * 100) / 100
    : 0;

  const coveragePercent = diff.stats?.coverage_percent ?? 0;
  const undocumentedSurfaces = (diff.discoverable_not_documented || []).length;
  const ambiguousMatches = (diff.ambiguous_matches || []).length;

  // Count priority distribution from surfacing plan
  const byPriority = plan.summary?.placements_by_priority || {};
  const p0Count = byPriority.P0 || 0;
  const p1Count = byPriority.P1 || 0;
  const p2Count = byPriority.P2 || 0;

  // Count high-burial triggers
  const burialIndex = diff.burial_index || [];
  const highBurialTriggers = burialIndex.filter(b => b.burial_score >= 5).length;

  return {
    total_features: totalFeatures,
    orphan_features: orphanFeatures,
    orphan_ratio: orphanRatio,
    coverage_percent: coveragePercent,
    p0_count: p0Count,
    p1_count: p1Count,
    p2_count: p2Count,
    undocumented_surfaces: undocumentedSurfaces,
    ambiguous_matches: ambiguousMatches,
    high_burial_triggers: highBurialTriggers,
  };
}

// =============================================================================
// Rule application — pure function
// =============================================================================

/**
 * Apply threshold rules to metrics.
 * @param {import('./types.mjs').VerifyMetrics} metrics
 * @param {import('./types.mjs').VerifyConfig} config
 * @returns {{ blockers: import('./types.mjs').VerifyBlocker[], warnings: import('./types.mjs').VerifyWarning[] }}
 */
export function applyRules(metrics, config) {
  /** @type {import('./types.mjs').VerifyBlocker[]} */
  const blockers = [];
  /** @type {import('./types.mjs').VerifyWarning[]} */
  const warnings = [];

  // Rule 1: P0 orphans
  if (config.failOnP0Orphans && metrics.p0_count > 0) {
    blockers.push({
      rule: 'p0_orphans',
      message: `${metrics.p0_count} P0 orphan feature(s) in surfacing plan`,
      threshold: 0,
      actual: metrics.p0_count,
    });
  }

  // Rule 2: Orphan ratio
  if (metrics.orphan_ratio > config.maxOrphanRatio) {
    blockers.push({
      rule: 'max_orphan_ratio',
      message: `Orphan ratio ${(metrics.orphan_ratio * 100).toFixed(0)}% exceeds threshold ${(config.maxOrphanRatio * 100).toFixed(0)}% (${metrics.orphan_features}/${metrics.total_features} features)`,
      threshold: config.maxOrphanRatio,
      actual: metrics.orphan_ratio,
    });
  }

  // Rule 3: Undocumented surfaces
  if (metrics.undocumented_surfaces > config.maxUndocumentedSurfaces) {
    blockers.push({
      rule: 'max_undocumented_surfaces',
      message: `${metrics.undocumented_surfaces} undocumented surfaces exceed threshold ${config.maxUndocumentedSurfaces}`,
      threshold: config.maxUndocumentedSurfaces,
      actual: metrics.undocumented_surfaces,
    });
  }

  // Warning: ambiguous matches
  if (metrics.ambiguous_matches > 0) {
    warnings.push({
      rule: 'ambiguous_matches',
      message: `${metrics.ambiguous_matches} ambiguous match(es) detected`,
    });
  }

  // Warning: low coverage
  if (metrics.coverage_percent < 50) {
    warnings.push({
      rule: 'low_coverage',
      message: `Coverage ${metrics.coverage_percent}% is below 50%`,
    });
  }

  // Warning: high burial triggers
  if (metrics.high_burial_triggers > 0) {
    warnings.push({
      rule: 'high_burial',
      message: `${metrics.high_burial_triggers} trigger(s) with burial score >= 5`,
    });
  }

  // Deterministic sort
  blockers.sort((a, b) => a.rule.localeCompare(b.rule));
  warnings.sort((a, b) => a.rule.localeCompare(b.rule));

  return { blockers, warnings };
}

// =============================================================================
// Verdict assembly — pure function
// =============================================================================

/**
 * Assemble the full verification verdict.
 * @param {import('./types.mjs').VerifyMetrics} metrics
 * @param {import('./types.mjs').VerifyBlocker[]} blockers
 * @param {import('./types.mjs').VerifyWarning[]} warnings
 * @param {Record<string, string>} artifactVersions
 * @returns {import('./types.mjs').VerifyVerdict}
 */
export function generateVerdict(metrics, blockers, warnings, artifactVersions) {
  const pass = blockers.length === 0;
  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    pass,
    exit_code: pass ? 0 : 1,
    metrics,
    blockers,
    warnings,
    artifact_versions: artifactVersions,
  };
}

// =============================================================================
// Markdown report
// =============================================================================

/**
 * Generate a PR-comment-ready verification report.
 * @param {import('./types.mjs').VerifyVerdict} verdict
 * @param {import('./types.mjs').PlanEntry[]} planEntries - Top fixes from surfacing plan
 * @returns {string}
 */
export function generateVerifyReport(verdict, planEntries) {
  const lines = [];
  const status = verdict.pass ? 'PASS' : 'FAIL';

  lines.push(`# AI-UI Verify: ${status}`);
  lines.push('');
  lines.push(`Generated: ${verdict.generated_at}`);
  lines.push('');

  // Metrics table
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | Value | Threshold | Status |');
  lines.push('|--------|-------|-----------|--------|');

  const m = verdict.metrics;
  const orphanStatus = verdict.blockers.some(b => b.rule === 'max_orphan_ratio') ? 'FAIL' : 'OK';
  lines.push(`| Orphan ratio | ${(m.orphan_ratio * 100).toFixed(0)}% (${m.orphan_features}/${m.total_features}) | <= ${findThreshold(verdict, 'max_orphan_ratio')} | ${orphanStatus} |`);

  const p0Status = verdict.blockers.some(b => b.rule === 'p0_orphans') ? 'FAIL' : 'OK';
  lines.push(`| P0 orphans | ${m.p0_count} | 0 | ${p0Status} |`);

  const undocStatus = verdict.blockers.some(b => b.rule === 'max_undocumented_surfaces') ? 'FAIL' : 'OK';
  lines.push(`| Undocumented surfaces | ${m.undocumented_surfaces} | <= ${findThreshold(verdict, 'max_undocumented_surfaces')} | ${undocStatus} |`);

  const coverageStatus = verdict.warnings.some(w => w.rule === 'low_coverage') ? 'WARN' : 'OK';
  lines.push(`| Coverage | ${m.coverage_percent}% | - | ${coverageStatus} |`);

  const ambigStatus = verdict.warnings.some(w => w.rule === 'ambiguous_matches') ? 'WARN' : 'OK';
  lines.push(`| Ambiguous matches | ${m.ambiguous_matches} | - | ${ambigStatus} |`);

  const versions = Object.entries(verdict.artifact_versions).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`| Artifacts | ${versions} | - | OK |`);
  lines.push('');

  // Blockers
  if (verdict.blockers.length > 0) {
    lines.push('## Blockers');
    lines.push('');
    for (const b of verdict.blockers) {
      lines.push(`- **${b.rule}**: ${b.message}`);
    }
    lines.push('');
  }

  // Top recommended fixes
  if (planEntries.length > 0) {
    lines.push('## Top Recommended Fixes');
    lines.push('');
    const top5 = planEntries.slice(0, 5);
    for (let i = 0; i < top5.length; i++) {
      const p = top5[i];
      lines.push(`${i + 1}. ${p.feature_name} → ${p.control.pattern_kind} on ${p.placement.route} [${p.priority}]`);
    }
    lines.push('');
  }

  // Warnings
  if (verdict.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of verdict.warnings) {
      lines.push(`- ${w.message}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('To reproduce: `ai-ui verify --verbose`');
  lines.push('');

  return lines.join('\n');
}

/**
 * Find the threshold value for a blocker rule from the verdict.
 * @param {import('./types.mjs').VerifyVerdict} verdict
 * @param {string} rule
 * @returns {string}
 */
function findThreshold(verdict, rule) {
  const blocker = verdict.blockers.find(b => b.rule === rule);
  if (blocker && blocker.threshold !== undefined) {
    if (rule === 'max_orphan_ratio') return `${(blocker.threshold * 100).toFixed(0)}%`;
    return String(blocker.threshold);
  }
  // Default display values when rule didn't fire
  if (rule === 'max_orphan_ratio') return '25%';
  if (rule === 'max_undocumented_surfaces') return '10';
  return '-';
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the Verify command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, runPipeline?: boolean, strict?: boolean, json?: boolean }} flags
 */
export async function runVerify(config, flags) {
  const cwd = process.cwd();

  // --run-pipeline: execute the full pipeline first
  if (flags.runPipeline) {
    if (flags.verbose) console.log('Verify: running pipeline...\n');
    const { runStage0 } = await import('./stage0.mjs');
    await runStage0(config, flags);
    const { runGraph } = await import('./trigger-graph.mjs');
    await runGraph(config, flags);
    const { runCompose } = await import('./composer.mjs');
    await runCompose(config, flags);
    if (flags.verbose) console.log('\nVerify: pipeline complete, judging...\n');
  }

  // Load artifacts
  const diffPath = resolve(cwd, config.output.diff);
  const planPath = resolve(cwd, config.output.composePlan);
  const graphPath = resolve(cwd, config.output.graph);

  // Check required artifacts exist
  const missing = [];
  if (!existsSync(diffPath)) missing.push('diff.json');
  if (!existsSync(planPath)) missing.push('surfacing-plan.json');
  if (!existsSync(graphPath)) missing.push('trigger-graph.json');

  if (missing.length > 0) {
    if (flags.json) {
      const errorVerdict = {
        version: '1.0.0', generated_at: new Date().toISOString(),
        pass: false, exit_code: 2,
        metrics: null, blockers: [{ rule: 'missing_artifacts', message: `Missing: ${missing.join(', ')}` }],
        warnings: [], artifact_versions: {},
      };
      console.log(JSON.stringify(errorVerdict, null, 2));
    } else {
      console.error(`Verify: missing artifacts: ${missing.join(', ')}`);
      console.error('  Hint: Run "ai-ui verify --run-pipeline" or run each stage first.');
    }
    process.exitCode = 2;
    return;
  }

  let diff, plan, graph;
  try {
    diff = JSON.parse(readFileSync(diffPath, 'utf-8'));
    plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
  } catch (e) {
    if (flags.json) {
      const errorVerdict = {
        version: '1.0.0', generated_at: new Date().toISOString(),
        pass: false, exit_code: 2,
        metrics: null, blockers: [{ rule: 'parse_error', message: `Failed to parse artifacts: ${e.message}` }],
        warnings: [], artifact_versions: {},
      };
      console.log(JSON.stringify(errorVerdict, null, 2));
    } else {
      console.error(`Verify: failed to parse artifacts: ${e.message}`);
    }
    process.exitCode = 2;
    return;
  }

  // Check artifact versions
  const artifactVersions = {
    diff: diff.version || 'unknown',
    graph: graph.version || 'unknown',
    plan: plan.version || 'unknown',
  };

  // Apply --strict overrides
  const verifyConfig = { ...config.verify };
  if (flags.strict) {
    verifyConfig.maxOrphanRatio = 0;
    verifyConfig.maxUndocumentedSurfaces = 0;
    verifyConfig.failOnP0Orphans = true;
  }

  // Extract → Apply → Verdict
  const metrics = extractMetrics(diff, plan, graph);
  const { blockers, warnings } = applyRules(metrics, verifyConfig);
  const verdict = generateVerdict(metrics, blockers, warnings, artifactVersions);

  // Output
  if (flags.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    // Write files
    const verifyPath = resolve(cwd, config.output.verify);
    mkdirSync(dirname(verifyPath), { recursive: true });
    writeFileSync(verifyPath, JSON.stringify(verdict, null, 2) + '\n', 'utf-8');

    const reportPath = resolve(cwd, config.output.verifyReport);
    const report = generateVerifyReport(verdict, plan.plans || []);
    writeFileSync(reportPath, report, 'utf-8');

    // Console output
    const icon = verdict.pass ? 'PASS' : 'FAIL';
    console.log(`Verify: ${icon} → ${relative(cwd, verifyPath)}`);

    if (flags.verbose) {
      console.log(`  Features: ${metrics.total_features} total, ${metrics.orphan_features} orphaned (${(metrics.orphan_ratio * 100).toFixed(0)}%)`);
      console.log(`  Priority: P0=${metrics.p0_count}, P1=${metrics.p1_count}, P2=${metrics.p2_count}`);
      console.log(`  Coverage: ${metrics.coverage_percent}%`);
      console.log(`  Undocumented surfaces: ${metrics.undocumented_surfaces}`);
      console.log(`  Ambiguous matches: ${metrics.ambiguous_matches}`);
      console.log(`  High burial triggers: ${metrics.high_burial_triggers}`);
      console.log(`  Artifacts: ${Object.entries(artifactVersions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      if (blockers.length > 0) {
        console.log('  Blockers:');
        for (const b of blockers) console.log(`    - [${b.rule}] ${b.message}`);
      }
      if (warnings.length > 0) {
        console.log('  Warnings:');
        for (const w of warnings) console.log(`    - [${w.rule}] ${w.message}`);
      }
    }
  }

  process.exitCode = verdict.exit_code;
}
