// @ts-check
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** @type {import('./types.mjs').AiUiConfig} */
const DEFAULTS = {
  docs: {
    globs: ['README.md', 'docs/**/*.md', 'HANDBOOK.md', 'CHANGELOG.md'],
    cliHelp: null,
  },
  probe: {
    baseUrl: 'http://localhost:4321',
    routes: ['/'],
    maxDepth: 3,
    timeout: 30000,
    skipLabels: ['Delete', 'Remove', 'Destroy', 'Reset', 'Unsubscribe'],
    safeOverride: 'data-aiui-safe',
    basePath: '',
    goalRoutes: [],
  },
  featureAliases: {},
  mapping: {},
  output: {
    atlas: 'ai-ui-output/atlas.json',
    probe: 'ai-ui-output/probe.jsonl',
    diff: 'ai-ui-output/diff.json',
    diffReport: 'ai-ui-output/diff.md',
    surfaces: 'ai-ui-output/probe.surfaces.json',
    graph: 'ai-ui-output/trigger-graph.json',
    graphReport: 'ai-ui-output/trigger-graph.md',
    graphDot: 'ai-ui-output/trigger-graph.dot',
    composePlan: 'ai-ui-output/surfacing-plan.json',
    composeReport: 'ai-ui-output/surfacing-plan.md',
    composeDot: 'ai-ui-output/surfacing-plan.dot',
    verify: 'ai-ui-output/verification.json',
    verifyReport: 'ai-ui-output/verification.md',
    baseline: 'ai-ui-output/baseline.json',
    mustSurface: 'ai-ui-output/must-surface.json',
    prComment: 'ai-ui-output/pr-comment.md',
    prCommentJson: 'ai-ui-output/pr-comment.json',
    runtimeEffects: 'ai-ui-output/runtime-effects.jsonl',
    runtimeEffectsSummary: 'ai-ui-output/runtime-effects.summary.json',
    runtimeCoverage: 'ai-ui-output/runtime-coverage.json',
    runtimeCoverageReport: 'ai-ui-output/runtime-coverage.md',
    actionSummary: 'ai-ui-output/action-summary.json',
    replayPack: 'ai-ui-output',
    replayDiff: 'ai-ui-output/replay-diff.json',
    replayDiffReport: 'ai-ui-output/replay-diff.md',
    replayDiffSummary: 'ai-ui-output/replay-diff.summary.json',
    designSurfaceInventory: 'ai-ui-output/ui-surface-inventory.json',
    designSurfaceInventoryReport: 'ai-ui-output/ui-surface-inventory.md',
    designFeatureMap: 'ai-ui-output/ui-feature-map.json',
    designFeatureMapReport: 'ai-ui-output/ui-feature-map.md',
    designTaskFlows: 'ai-ui-output/ui-task-flows.md',
    designIAProposal: 'ai-ui-output/ui-ia-proposal.md',
    aiSuggestJson: 'ai-ui-output/ai-suggest.json',
    aiSuggestPatchJson: 'ai-ui-output/ai-suggest.patch.json',
    aiSuggestMd: 'ai-ui-output/ai-suggest.md',
    aiEyesJson: 'ai-ui-output/eyes.json',
    aiEyesPatchJson: 'ai-ui-output/eyes.patch.json',
    aiEyesMd: 'ai-ui-output/eyes.md',
    aiEyesScreenshots: 'ai-ui-output/eyes-screenshots',
  },
  verify: {
    maxOrphanRatio: 0.25,
    maxUndocumentedSurfaces: 10,
    failOnP0Orphans: true,
  },
  baseline: {
    failOnOrphanIncrease: true,
    maxUndocumentedIncrease: 5,
    warnOnCoverageDecrease: true,
  },
  memory: {
    dir: 'ai-ui-memory',
    strict: false,
  },
  coverageGate: {
    minCoveragePercent: 0,
    maxTotalActions: Infinity,
    maxActionsByType: null,
  },
  runtimeEffects: {
    routes: ['/'],
    maxTriggersPerRoute: 20,
    windowMs: 2500,
    safe: {
      denyLabelRegex: 'delete|remove|destroy|reset|logout|revoke|disable|unsubscribe|billing',
      requireSafeAttrForDestructive: true,
      denyHrefRegex: null,
      denyMethodPatterns: [],
    },
  },
  goalRules: [],
  aiSuggest: {
    model: 'qwen2.5:14b',
    top: 5,
    minConfidence: 0.55,
    timeout: 60000,
  },
  aiEyes: {
    model: 'llava:13b',
    timeout: 90000,
    maxElements: 30,
    saveScreenshots: true,
  },
};

/**
 * Load config from file, merge with defaults.
 * @param {string} [configPath] - Explicit path, or auto-detect from CWD.
 * @returns {import('./types.mjs').AiUiConfig}
 */
export function loadConfig(configPath) {
  const filePath = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), 'ai-ui.config.json');

  if (!existsSync(filePath)) {
    if (configPath) {
      fail('CONFIG_NOT_FOUND', `Config file not found: ${filePath}`, 'Check the --config path.');
    }
    // No config file is fine — use defaults
    return structuredClone(DEFAULTS);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    fail('CONFIG_PARSE', `Failed to parse config: ${e.message}`, 'Ensure ai-ui.config.json is valid JSON.');
  }

  return merge(DEFAULTS, raw);
}

/**
 * Deep merge b into a (a is the base/defaults).
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {Record<string, any>}
 */
function merge(a, b) {
  const out = structuredClone(a);
  for (const key of Object.keys(b)) {
    if (b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = merge(out[key], b[key]);
    } else {
      out[key] = b[key];
    }
  }
  return out;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} hint
 * @param {number} [exitCode=1]
 */
export function fail(code, message, hint, exitCode = 1) {
  console.error(`Error [${code}]: ${message}`);
  if (hint) console.error(`  Hint: ${hint}`);
  process.exit(exitCode);
}
