// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { computeConfigHash, computeSafeConfigHash } from './baseline.mjs';

// =============================================================================
// Constants
// =============================================================================

export const PACK_VERSION = '1.0.0';
export const TOOL_NAME = 'ai-ui';
export const TOOL_VERSION = '1.0.0';

/** @type {Record<string, { configKey: string, required: boolean }>} */
export const ARTIFACT_KEYS = {
  runtimeCoverage:        { configKey: 'runtimeCoverage',        required: true },
  runtimeCoverageActions: { configKey: 'runtimeCoverage',        required: true },   // derived path (.actions.json)
  runtimeEffectsSummary:  { configKey: 'runtimeEffectsSummary',  required: false },
  graph:                  { configKey: 'graph',                  required: false },
  verify:                 { configKey: 'verify',                 required: false },
  baseline:               { configKey: 'baseline',               required: false },
  actionSummary:          { configKey: 'actionSummary',          required: false },
};

// =============================================================================
// stableStringify — canonical JSON with sorted keys
// =============================================================================

/**
 * Produce a canonical JSON string with recursively sorted keys.
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(v => stableStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k]));
  return '{' + pairs.join(',') + '}';
}

// =============================================================================
// hashArtifact — SHA-256 of canonical content
// =============================================================================

/**
 * Compute SHA-256 of a canonical JSON representation.
 * @param {any} artifact
 * @returns {string} Hex digest
 */
export function hashArtifact(artifact) {
  return createHash('sha256').update(stableStringify(artifact)).digest('hex');
}

// =============================================================================
// canonicalizeArtifacts — sort arrays for deterministic diffs
// =============================================================================

/**
 * Sort internal arrays of known artifact shapes for deterministic comparison.
 * Returns a new object (does not mutate input).
 * @param {Record<string, any>} artifacts
 * @returns {Record<string, any>}
 */
export function canonicalizeArtifacts(artifacts) {
  const out = JSON.parse(JSON.stringify(artifacts)); // deep clone

  // runtimeCoverage: sort triggers by trigger_id, surprises_v2 by (category, trigger_id, expected_id)
  if (out.runtimeCoverage) {
    if (Array.isArray(out.runtimeCoverage.triggers)) {
      out.runtimeCoverage.triggers.sort((a, b) => (a.trigger_id || '').localeCompare(b.trigger_id || ''));
    }
    if (Array.isArray(out.runtimeCoverage.surprises_v2)) {
      out.runtimeCoverage.surprises_v2.sort((a, b) => {
        return (a.category || '').localeCompare(b.category || '')
          || (a.trigger_id || '').localeCompare(b.trigger_id || '')
          || (a.expected_id || '').localeCompare(b.expected_id || '');
      });
    }
  }

  // runtimeCoverageActions: sort actions by actionId
  if (out.runtimeCoverageActions && Array.isArray(out.runtimeCoverageActions.actions)) {
    out.runtimeCoverageActions.actions.sort((a, b) => (a.actionId || '').localeCompare(b.actionId || ''));
  }

  // graph: sort nodes by id, edges by from+to+type
  if (out.graph) {
    if (Array.isArray(out.graph.nodes)) {
      out.graph.nodes.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
    }
    if (Array.isArray(out.graph.edges)) {
      out.graph.edges.sort((a, b) => {
        return (a.from || '').localeCompare(b.from || '')
          || (a.to || '').localeCompare(b.to || '')
          || (a.type || '').localeCompare(b.type || '');
      });
    }
  }

  return out;
}

// =============================================================================
// redactUrl — strip query params + fragment
// =============================================================================

/**
 * Strip query parameters and fragment from a URL. Preserves origin + path.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    // Not a full URL — strip ?... and #...
    return url.replace(/[?#].*$/, '');
  }
}

// =============================================================================
// redactArtifacts — strip PII from effect URLs
// =============================================================================

/**
 * Strip query params from URLs in runtime effects summary.
 * Preserves trigger labels, routes, action IDs (stable identifiers, not PII).
 * Returns a new object (does not mutate input).
 * @param {Record<string, any>} artifacts
 * @returns {Record<string, any>}
 */
export function redactArtifacts(artifacts) {
  const out = JSON.parse(JSON.stringify(artifacts)); // deep clone

  if (out.runtimeEffectsSummary && Array.isArray(out.runtimeEffectsSummary.triggers)) {
    for (const trigger of out.runtimeEffectsSummary.triggers) {
      if (Array.isArray(trigger.effects)) {
        for (const effect of trigger.effects) {
          if (effect.url) effect.url = redactUrl(effect.url);
          if (effect.to) effect.to = redactUrl(effect.to);
          if (effect.from) effect.from = redactUrl(effect.from);
        }
      }
    }
  }

  return out;
}

// =============================================================================
// buildManifest — assemble the pack manifest
// =============================================================================

/**
 * Build a replay pack manifest from canonicalized artifacts.
 * @param {Record<string, any>} artifacts - Canonicalized (and optionally redacted) artifacts
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {import('./types.mjs').CoverageBaselineSlice|null} [baselineSlice]
 * @returns {import('./types.mjs').ReplayManifest}
 */
export function buildManifest(artifacts, config, baselineSlice) {
  // Build inputs list with SHA-256 hashes
  /** @type {import('./types.mjs').ReplayInputEntry[]} */
  const inputs = [];
  for (const key of Object.keys(ARTIFACT_KEYS)) {
    const present = artifacts[key] != null;
    inputs.push({
      key,
      sha256: present ? hashArtifact(artifacts[key]) : '',
      present,
    });
  }

  // Config snapshot
  const configSnapshot = {
    verify_config_hash: computeConfigHash(config.verify),
    safe_config_hash: computeSafeConfigHash(config.runtimeEffects.safe),
    coverage_gate: { ...config.coverageGate },
  };

  // Summary from coverage data
  const coverageReport = artifacts.runtimeCoverage;
  const actionReport = artifacts.runtimeCoverageActions;
  const coveragePercent = coverageReport?.summary?.coverage_percent ?? 0;
  const totalActions = actionReport?.summary?.total_actions ?? 0;

  /** @type {Record<string, number>} */
  const actionsByType = actionReport?.summary?.by_type
    ? { ...actionReport.summary.by_type }
    : {};

  /** @type {Record<string, number>} */
  const surprisesByCategory = {};
  if (coverageReport?.surprises_v2) {
    for (const s of coverageReport.surprises_v2) {
      surprisesByCategory[s.category] = (surprisesByCategory[s.category] || 0) + 1;
    }
  }

  const summary = {
    coverage_percent: coveragePercent,
    total_actions: totalActions,
    gate_mode: /** @type {import('./types.mjs').GateMode} */ ('none'),
    gate_pass: true,
    actions_by_type: actionsByType,
    surprises_by_category: surprisesByCategory,
  };

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    created_at: new Date().toISOString(),
    config_snapshot: configSnapshot,
    inputs,
    summary,
    baseline_slice: baselineSlice || null,
  };
}

// =============================================================================
// buildReplayPack — orchestrator
// =============================================================================

/**
 * Build a complete replay pack from artifacts.
 * @param {Record<string, any>} artifacts - Raw loaded artifacts
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {import('./types.mjs').CoverageBaselineSlice|null} [baselineSlice]
 * @param {{ redact?: boolean }} [opts]
 * @returns {import('./types.mjs').ReplayPack}
 */
export function buildReplayPack(artifacts, config, baselineSlice, opts) {
  const doRedact = opts?.redact !== false; // default: redact on
  let processed = canonicalizeArtifacts(artifacts);
  if (doRedact) {
    processed = redactArtifacts(processed);
  }
  const manifest = buildManifest(processed, config, baselineSlice);
  return {
    version: PACK_VERSION,
    manifest,
    artifacts: processed,
  };
}

// =============================================================================
// loadReplayPack — load + validate
// =============================================================================

/**
 * Load and validate a replay pack from a file path.
 * @param {string} packPath
 * @returns {import('./types.mjs').ReplayPack}
 */
export function loadReplayPack(packPath) {
  if (!existsSync(packPath)) {
    throw new Error(`Replay pack not found: ${packPath}`);
  }

  let pack;
  try {
    pack = JSON.parse(readFileSync(packPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse replay pack: ${e.message}`);
  }

  // Validate structure
  if (!pack.version) {
    throw new Error('Replay pack missing "version" field');
  }
  if (!pack.manifest) {
    throw new Error('Replay pack missing "manifest" field');
  }
  if (!pack.artifacts || typeof pack.artifacts !== 'object') {
    throw new Error('Replay pack missing "artifacts" field');
  }

  // Major version compatibility
  const majorVersion = parseInt(pack.version.split('.')[0], 10);
  const expectedMajor = parseInt(PACK_VERSION.split('.')[0], 10);
  if (majorVersion !== expectedMajor) {
    throw new Error(`Replay pack version ${pack.version} incompatible with tool version ${PACK_VERSION} (major version mismatch)`);
  }

  return pack;
}

// =============================================================================
// extractArtifactsFromPack — map pack to verify.mjs shapes
// =============================================================================

/**
 * Extract artifacts from a replay pack into the shapes verify.mjs expects.
 * @param {import('./types.mjs').ReplayPack} pack
 * @returns {{ coverageReport: any, actionReport: any, runtimeSummary: any, graph: any, verify: any, baselineCoverage: import('./types.mjs').CoverageBaselineSlice|null }}
 */
export function extractArtifactsFromPack(pack) {
  return {
    coverageReport: pack.artifacts.runtimeCoverage || null,
    actionReport: pack.artifacts.runtimeCoverageActions || null,
    runtimeSummary: pack.artifacts.runtimeEffectsSummary || null,
    graph: pack.artifacts.graph || null,
    verify: pack.artifacts.verify || null,
    baselineCoverage: pack.manifest.baseline_slice || null,
  };
}

// =============================================================================
// CLI handler — runReplayPack
// =============================================================================

/**
 * Run the replay-pack command: gather artifacts and write a .replay.json pack.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, out?: string, noRedact?: boolean }} flags
 */
export async function runReplayPack(config, flags) {
  const cwd = process.cwd();

  // Load artifacts from standard output paths
  /** @type {Record<string, any>} */
  const artifacts = {};

  // runtimeCoverage
  const coveragePath = resolve(cwd, config.output.runtimeCoverage);
  if (!existsSync(coveragePath)) {
    console.error('Replay pack: runtime-coverage.json not found.');
    console.error('  Hint: Run "ai-ui runtime-coverage" first.');
    process.exitCode = 2;
    return;
  }
  artifacts.runtimeCoverage = JSON.parse(readFileSync(coveragePath, 'utf-8'));

  // runtimeCoverageActions (derived path)
  const actionsPath = coveragePath.replace('.json', '.actions.json');
  if (!existsSync(actionsPath)) {
    console.error('Replay pack: runtime-coverage.actions.json not found.');
    console.error('  Hint: Run "ai-ui runtime-coverage --actions" first.');
    process.exitCode = 2;
    return;
  }
  artifacts.runtimeCoverageActions = JSON.parse(readFileSync(actionsPath, 'utf-8'));

  // Optional artifacts
  const optionals = {
    runtimeEffectsSummary: resolve(cwd, config.output.runtimeEffectsSummary),
    graph: resolve(cwd, config.output.graph),
    verify: resolve(cwd, config.output.verify),
    baseline: resolve(cwd, config.output.baseline),
    actionSummary: resolve(cwd, config.output.actionSummary),
  };

  for (const [key, path] of Object.entries(optionals)) {
    if (existsSync(path)) {
      try {
        artifacts[key] = JSON.parse(readFileSync(path, 'utf-8'));
      } catch (e) {
        if (flags.verbose) {
          console.log(`  Skipping ${key}: parse error (${e.message})`);
        }
      }
    }
  }

  // Load baseline coverage slice if baseline exists
  let baselineSlice = null;
  if (artifacts.baseline?.coverage) {
    baselineSlice = artifacts.baseline.coverage;
  }

  // Build the pack
  const pack = buildReplayPack(artifacts, config, baselineSlice, {
    redact: !flags.noRedact,
  });

  // Write output
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(cwd, config.output.replayPack || 'ai-ui-output');
  const outPath = flags.out
    ? resolve(cwd, flags.out)
    : join(outDir, `replay-${timestamp}.replay.json`);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(pack, null, 2) + '\n', 'utf-8');

  console.log(`Replay pack: written → ${relative(cwd, outPath)}`);
  if (flags.verbose) {
    const presentCount = pack.manifest.inputs.filter(i => i.present).length;
    const totalCount = pack.manifest.inputs.length;
    console.log(`  Artifacts: ${presentCount}/${totalCount} present`);
    console.log(`  Coverage: ${pack.manifest.summary.coverage_percent}%`);
    console.log(`  Actions: ${pack.manifest.summary.total_actions}`);
    console.log(`  Baseline slice: ${baselineSlice ? 'yes' : 'no'}`);
    console.log(`  Redacted: ${!flags.noRedact}`);
    for (const input of pack.manifest.inputs) {
      const status = input.present ? input.sha256.slice(0, 12) + '...' : 'absent';
      console.log(`    ${input.key}: ${status}`);
    }
  }
}
