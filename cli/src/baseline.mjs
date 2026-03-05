// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// =============================================================================
// Hash helpers — pure functions
// =============================================================================

/**
 * Compute a SHA-256 hash of all memory files for constitution tracking.
 * @param {string} memoryDir - Absolute path to memory directory
 * @returns {string} Hex hash or 'none' if no memory dir
 */
export function computeMemoryHash(memoryDir) {
  if (!existsSync(memoryDir)) return 'none';

  const files = ['decisions.json', 'exceptions.json', 'mappings.json']; // sorted
  const hash = createHash('sha256');

  for (const file of files) {
    const filePath = join(memoryDir, file);
    if (existsSync(filePath)) {
      hash.update(file + ':');
      hash.update(readFileSync(filePath, 'utf-8'));
      hash.update('\n');
    }
  }

  return hash.digest('hex');
}

/**
 * Compute a SHA-256 hash of the verify config for drift detection.
 * @param {import('./types.mjs').VerifyConfig} verifyConfig
 * @returns {string} Hex hash
 */
export function computeConfigHash(verifyConfig) {
  const sorted = JSON.stringify(verifyConfig, Object.keys(verifyConfig).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

// =============================================================================
// Baseline creation — pure function
// =============================================================================

/**
 * Create a baseline snapshot from a verification verdict.
 * @param {import('./types.mjs').VerifyVerdict} verdict
 * @param {string} memoryHash
 * @param {string} verifyConfigHash
 * @returns {import('./types.mjs').BaselineSnapshot}
 */
export function createBaseline(verdict, memoryHash, verifyConfigHash) {
  return {
    version: '1.0.0',
    created_at: new Date().toISOString(),
    metrics: { ...verdict.metrics },
    artifact_versions: { ...verdict.artifact_versions },
    memory_hash: memoryHash,
    verify_config_hash: verifyConfigHash,
  };
}

// =============================================================================
// Baseline comparison — pure functions
// =============================================================================

/**
 * Metrics where lower values are better (regressions = increase).
 * @type {Set<string>}
 */
const LOWER_IS_BETTER = new Set([
  'orphan_features', 'orphan_ratio', 'undocumented_surfaces',
  'p0_count', 'ambiguous_matches', 'high_burial_triggers',
]);

/**
 * Metrics where higher values are better (regressions = decrease).
 * @type {Set<string>}
 */
const HIGHER_IS_BETTER = new Set([
  'coverage_percent',
]);

/**
 * Metrics to compare (excludes total_features, p1/p2 counts, memory_excluded as they're informational).
 * @type {string[]}
 */
const COMPARED_METRICS = [
  'orphan_features', 'orphan_ratio', 'coverage_percent',
  'undocumented_surfaces', 'p0_count', 'ambiguous_matches',
  'high_burial_triggers',
];

/**
 * Compare current metrics against a baseline snapshot.
 * @param {import('./types.mjs').BaselineSnapshot} baseline
 * @param {import('./types.mjs').VerifyMetrics} currentMetrics
 * @returns {import('./types.mjs').BaselineDelta[]}
 */
export function compareBaseline(baseline, currentMetrics) {
  /** @type {import('./types.mjs').BaselineDelta[]} */
  const deltas = [];

  for (const metric of COMPARED_METRICS) {
    const baselineValue = baseline.metrics[metric] ?? 0;
    const currentValue = currentMetrics[metric] ?? 0;
    const change = currentValue - baselineValue;

    let direction = /** @type {'improved'|'regressed'|'unchanged'} */ ('unchanged');
    if (change !== 0) {
      if (LOWER_IS_BETTER.has(metric)) {
        direction = change < 0 ? 'improved' : 'regressed';
      } else if (HIGHER_IS_BETTER.has(metric)) {
        direction = change > 0 ? 'improved' : 'regressed';
      }
    }

    deltas.push({ metric, baseline_value: baselineValue, current_value: currentValue, change, direction });
  }

  return deltas;
}

/**
 * Apply baseline-specific rules to produce blockers and warnings.
 * @param {import('./types.mjs').BaselineDelta[]} deltas
 * @param {import('./types.mjs').BaselineConfig} baselineConfig
 * @param {import('./types.mjs').BaselineSnapshot} baseline
 * @param {string} [currentMemoryHash] - Current memory hash for drift detection
 * @param {string} [currentConfigHash] - Current config hash for drift detection
 * @returns {{ blockers: import('./types.mjs').VerifyBlocker[], warnings: import('./types.mjs').VerifyWarning[] }}
 */
export function applyBaselineRules(deltas, baselineConfig, baseline, currentMemoryHash, currentConfigHash) {
  /** @type {import('./types.mjs').VerifyBlocker[]} */
  const blockers = [];
  /** @type {import('./types.mjs').VerifyWarning[]} */
  const warnings = [];

  // Rule: fail if orphan_features increased
  if (baselineConfig.failOnOrphanIncrease) {
    const orphanDelta = deltas.find(d => d.metric === 'orphan_features');
    if (orphanDelta && orphanDelta.direction === 'regressed') {
      blockers.push({
        rule: 'baseline_orphan_increase',
        message: `Orphan features increased from ${orphanDelta.baseline_value} to ${orphanDelta.current_value} (+${orphanDelta.change}) vs baseline`,
        threshold: orphanDelta.baseline_value,
        actual: orphanDelta.current_value,
      });
    }
  }

  // Rule: fail if undocumented surfaces increased by more than N
  const undocDelta = deltas.find(d => d.metric === 'undocumented_surfaces');
  if (undocDelta && undocDelta.change > baselineConfig.maxUndocumentedIncrease) {
    blockers.push({
      rule: 'baseline_undocumented_increase',
      message: `Undocumented surfaces increased by ${undocDelta.change} (max allowed: +${baselineConfig.maxUndocumentedIncrease}) vs baseline`,
      threshold: baselineConfig.maxUndocumentedIncrease,
      actual: undocDelta.change,
    });
  }

  // Rule: warn if coverage decreased
  if (baselineConfig.warnOnCoverageDecrease) {
    const covDelta = deltas.find(d => d.metric === 'coverage_percent');
    if (covDelta && covDelta.direction === 'regressed') {
      warnings.push({
        rule: 'baseline_coverage_decrease',
        message: `Coverage decreased from ${covDelta.baseline_value}% to ${covDelta.current_value}% vs baseline`,
      });
    }
  }

  // Warning: constitution drift (memory changed since baseline)
  if (currentMemoryHash && baseline.memory_hash && currentMemoryHash !== baseline.memory_hash) {
    warnings.push({
      rule: 'baseline_memory_drift',
      message: 'Memory files changed since baseline was set — consider updating baseline',
    });
  }

  // Warning: config drift (verify config changed since baseline)
  if (currentConfigHash && baseline.verify_config_hash && currentConfigHash !== baseline.verify_config_hash) {
    warnings.push({
      rule: 'baseline_config_drift',
      message: 'Verify config changed since baseline was set — consider updating baseline',
    });
  }

  return { blockers, warnings };
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the Baseline command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, write?: boolean, force?: boolean }} flags
 */
export async function runBaseline(config, flags) {
  const cwd = process.cwd();
  const baselinePath = resolve(cwd, config.output.baseline);
  const verifyPath = resolve(cwd, config.output.verify);

  if (flags.write) {
    // Write mode: snapshot current verification → baseline
    if (!existsSync(verifyPath)) {
      console.error('Baseline: verification.json not found.');
      console.error('  Hint: Run "ai-ui verify" first to generate verification artifacts.');
      process.exitCode = 2;
      return;
    }

    if (existsSync(baselinePath) && !flags.force) {
      console.error('Baseline: baseline.json already exists.');
      console.error('  Hint: Use --force to overwrite, or delete the file manually.');
      process.exitCode = 1;
      return;
    }

    let verdict;
    try {
      verdict = JSON.parse(readFileSync(verifyPath, 'utf-8'));
    } catch (e) {
      console.error(`Baseline: failed to parse verification.json: ${e.message}`);
      process.exitCode = 2;
      return;
    }

    const memoryHash = computeMemoryHash(resolve(cwd, config.memory.dir));
    const configHash = computeConfigHash(config.verify);
    const snapshot = createBaseline(verdict, memoryHash, configHash);

    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');

    console.log(`Baseline: written → ${relative(cwd, baselinePath)}`);
    if (flags.verbose) {
      const m = snapshot.metrics;
      console.log(`  Orphans: ${m.orphan_features}/${m.total_features} (${(m.orphan_ratio * 100).toFixed(0)}%)`);
      console.log(`  Coverage: ${m.coverage_percent}%`);
      console.log(`  Undocumented: ${m.undocumented_surfaces}`);
      console.log(`  Memory hash: ${snapshot.memory_hash.slice(0, 12)}...`);
      console.log(`  Config hash: ${snapshot.verify_config_hash.slice(0, 12)}...`);
    }
  } else {
    // Show mode (default): display current baseline info
    if (!existsSync(baselinePath)) {
      console.log('Baseline: no baseline set.');
      console.log('  Hint: Run "ai-ui baseline --write" after verifying to set one.');
      return;
    }

    let baseline;
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    } catch (e) {
      console.error(`Baseline: failed to parse baseline.json: ${e.message}`);
      process.exitCode = 2;
      return;
    }

    const m = baseline.metrics;
    console.log(`Baseline: set at ${baseline.created_at}`);
    console.log(`  Orphans: ${m.orphan_features}/${m.total_features} (${(m.orphan_ratio * 100).toFixed(0)}%)`);
    console.log(`  Coverage: ${m.coverage_percent}%`);
    console.log(`  Undocumented: ${m.undocumented_surfaces}`);
    console.log(`  P0: ${m.p0_count}, Ambiguous: ${m.ambiguous_matches}, High burial: ${m.high_burial_triggers}`);
    console.log(`  Memory hash: ${baseline.memory_hash === 'none' ? 'none' : baseline.memory_hash.slice(0, 12) + '...'}`);
    console.log(`  Config hash: ${baseline.verify_config_hash.slice(0, 12)}...`);
    console.log(`  Artifacts: ${Object.entries(baseline.artifact_versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}
