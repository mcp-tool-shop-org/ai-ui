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
  },
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
  },
  verify: {
    maxOrphanRatio: 0.25,
    maxUndocumentedSurfaces: 10,
    failOnP0Orphans: true,
  },
  memory: {
    dir: 'ai-ui-memory',
    strict: false,
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
