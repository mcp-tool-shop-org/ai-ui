#!/usr/bin/env node
// @ts-check
import { loadConfig, fail } from '../src/config.mjs';

const VERSION = '1.0.1';

const HELP = `
ai-ui — Docs↔UI Diff + Trigger Graph + Surfacing Composer + Verify + Memory

Usage:
  ai-ui <command> [options]

Commands:
  atlas        Parse docs into a feature catalog (atlas.json)
  probe        Crawl the UI and record triggers (probe.jsonl)
  surfaces     Extract interactive surfaces from a WebSketch capture
  diff         Match atlas features against probe triggers (diff.json + diff.md)
  graph        Build trigger graph from probe + surfaces + diff (trigger-graph.json/.md/.dot)
  compose      Generate surfacing plan from diff + graph (surfacing-plan.json/.md/.dot)
  verify       Judge pipeline artifacts and produce pass/fail verdict (verification.json/.md)
  baseline     Manage verification baselines (--write to save, default: show)
  pr-comment   Generate a PR-ready markdown comment from pipeline artifacts
  init-memory  Create empty memory files (mappings/decisions/exceptions)
  runtime-effects  Click triggers and capture observed effects (runtime-effects.jsonl)
  runtime-coverage Per-trigger coverage matrix (probed/surface/observed)
  replay-pack  Bundle pipeline artifacts into a reproducible replay pack
  replay-diff  Compare two replay packs (replay-diff.json/.md/.summary.json)
  design-map   Generate design artifacts (surface inventory, feature map, task flows, IA proposal)
  ai-suggest   Use Ollama to match doc features → UI surfaces and emit alias patches
  ai-eyes      Use LLaVA to visually identify icon-only and text-poor surfaces
  ai-hands     Use qwen2.5-coder to generate PR-ready patches for surfacing gaps
  stage0       Run atlas → probe → diff in sequence

Options:
  --config <path>   Path to ai-ui.config.json (default: ./ai-ui.config.json)
  --from <path>     Source capture file (for surfaces command)
  --out <path>      Override output path
  --verbose         Print extra output
  --run-pipeline    (verify) Run full pipeline before judging
  --strict          (verify) Zero-tolerance thresholds
  --json            (verify) Print verdict JSON to stdout, no file writes
  --write           (baseline) Save current verification as the new baseline
  --force           (baseline) Overwrite existing baseline without warning
  --no-memory       Disable memory loading for this run
  --no-must-surface Skip must-surface contract checks (verify)
  --format <fmt>    (pr-comment) Output format: github|gitlab|markdown (default: github)
  --max-fixes <n>   (pr-comment) Max fixes to show (default: 5)
  --max-blockers <n> (pr-comment) Max blockers to show (default: 10)
  --max-warnings <n> (pr-comment) Max warnings to show (default: 10)
  --url <url>       (runtime-effects) Override base URL
  --dry-run         (runtime-effects) Hover instead of click, tag entries as dry_run
  --with-runtime    (graph) Augment graph with runtime-effects data
  --actions         (runtime-coverage) Generate actionable work queue
  --actions-top <n> (runtime-coverage) Max actions to include (default: 20)
  --gate <mode>     (verify) Coverage CI gate: none|minimum|regressions (default: none)
  --min-coverage <n> (verify) Override min coverage % for minimum gate mode
  --replay <path>   (verify) Replay from a .replay.json pack instead of live artifacts
  --no-redact       (replay-pack) Disable URL/storage redaction
  --top <n>         (replay-diff) Limit displayed items per section (default: 10)
  --model <name>    (ai-suggest/ai-eyes/ai-hands) Ollama model name
  --min-confidence <n> (ai-suggest) Minimum confidence threshold 0.0-1.0 (default: 0.55)
  --eyes <path>     (ai-suggest) Path to eyes.json for visual enrichment
  --repo <path>     (ai-hands) Path to target repo root (default: CWD)
  --tasks <list>    (ai-hands) Comma-separated task types (default: all)
  --min-rank <n>    (ai-hands) Minimum rank score 0.0-1.0, suppress lower edits
  --memory-strict   Fail if memory files don't parse
  --help            Show this help
  --version         Show version
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args.find(a => !a.startsWith('-'));
  const flags = parseFlags(args);

  if (flags.help || command === 'help') {
    console.log(HELP);
    process.exit(0);
  }

  if (flags.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (!command) {
    console.log(HELP);
    process.exit(1);
  }

  const config = loadConfig(flags.config);

  switch (command) {
    case 'atlas': {
      const { runAtlas } = await import('../src/atlas.mjs');
      await runAtlas(config, flags);
      break;
    }
    case 'probe': {
      const { runProbe } = await import('../src/probe.mjs');
      await runProbe(config, flags);
      break;
    }
    case 'surfaces': {
      const { runSurfaces } = await import('../src/surfaces.mjs');
      await runSurfaces(config, flags);
      break;
    }
    case 'diff': {
      const { runDiff } = await import('../src/diff.mjs');
      await runDiff(config, flags);
      break;
    }
    case 'graph': {
      const { runGraph } = await import('../src/trigger-graph.mjs');
      await runGraph(config, flags);
      break;
    }
    case 'compose': {
      const { runCompose } = await import('../src/composer.mjs');
      await runCompose(config, flags);
      break;
    }
    case 'verify': {
      const { runVerify } = await import('../src/verify.mjs');
      await runVerify(config, flags);
      break;
    }
    case 'baseline': {
      const { runBaseline } = await import('../src/baseline.mjs');
      await runBaseline(config, flags);
      break;
    }
    case 'pr-comment': {
      const { runPrComment } = await import('../src/pr-comment.mjs');
      await runPrComment(config, flags);
      break;
    }
    case 'init-memory': {
      const { runInitMemory } = await import('../src/memory.mjs');
      runInitMemory(config);
      break;
    }
    case 'runtime-effects': {
      const { runRuntimeEffects } = await import('../src/runtime-effects.mjs');
      await runRuntimeEffects(config, flags);
      break;
    }
    case 'runtime-coverage': {
      const { runRuntimeCoverage } = await import('../src/runtime-coverage.mjs');
      await runRuntimeCoverage(config, flags);
      break;
    }
    case 'replay-pack': {
      const { runReplayPack } = await import('../src/replay-pack.mjs');
      await runReplayPack(config, flags);
      break;
    }
    case 'replay-diff': {
      const pos = collectPositionalArgs(args);
      if (pos.length < 3) {
        console.error('Usage: ai-ui replay-diff <a.replay.json> <b.replay.json>');
        process.exit(1);
      }
      const { runReplayDiff } = await import('../src/replay-diff.mjs');
      await runReplayDiff(config, flags, pos[1], pos[2]);
      break;
    }
    case 'design-map': {
      const { runDesignMap } = await import('../src/design-map.mjs');
      await runDesignMap(config, flags);
      break;
    }
    case 'ai-suggest': {
      const { runAiSuggest } = await import('../src/ai-suggest.mjs');
      await runAiSuggest(config, flags);
      break;
    }
    case 'ai-eyes': {
      const { runAiEyes } = await import('../src/ai-eyes.mjs');
      await runAiEyes(config, flags);
      break;
    }
    case 'ai-hands': {
      const { runAiHands } = await import('../src/ai-hands.mjs');
      await runAiHands(config, flags);
      break;
    }
    case 'stage0': {
      const { runStage0 } = await import('../src/stage0.mjs');
      await runStage0(config, flags);
      break;
    }
    default:
      fail('UNKNOWN_CMD', `Unknown command: ${command}`, `Run "ai-ui --help" to see available commands.`);
  }
}

/**
 * Parse CLI flags from args.
 * @param {string[]} args
 * @returns {{ config?: string, from?: string, out?: string, verbose: boolean, help: boolean, version: boolean, runPipeline: boolean, strict: boolean, json: boolean, write: boolean, force: boolean, noMemory: boolean, memoryStrict: boolean }}
 */
function parseFlags(args) {
  const flags = { config: undefined, from: undefined, out: undefined, verbose: false, help: false, version: false, runPipeline: false, strict: false, json: false, write: false, force: false, noMemory: false, noMustSurface: false, format: undefined, maxFixes: undefined, maxBlockers: undefined, maxWarnings: undefined, memoryStrict: false, url: undefined, withRuntime: false, dryRun: false, actions: false, actionsTop: undefined, gate: undefined, minCoverage: undefined, replay: undefined, noRedact: false, top: undefined, model: undefined, minConfidence: undefined, eyes: undefined, repo: undefined, tasks: undefined, minRank: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config' && args[i + 1]) {
      flags.config = args[++i];
    } else if (a === '--from' && args[i + 1]) {
      flags.from = args[++i];
    } else if (a === '--out' && args[i + 1]) {
      flags.out = args[++i];
    } else if (a === '--verbose') {
      flags.verbose = true;
    } else if (a === '--help' || a === '-h') {
      flags.help = true;
    } else if (a === '--version' || a === '-v') {
      flags.version = true;
    } else if (a === '--run-pipeline') {
      flags.runPipeline = true;
    } else if (a === '--strict') {
      flags.strict = true;
    } else if (a === '--json') {
      flags.json = true;
    } else if (a === '--write') {
      flags.write = true;
    } else if (a === '--force') {
      flags.force = true;
    } else if (a === '--no-memory') {
      flags.noMemory = true;
    } else if (a === '--no-must-surface') {
      flags.noMustSurface = true;
    } else if (a === '--format' && args[i + 1]) {
      flags.format = args[++i];
    } else if (a === '--max-fixes' && args[i + 1]) {
      flags.maxFixes = parseInt(args[++i], 10);
    } else if (a === '--max-blockers' && args[i + 1]) {
      flags.maxBlockers = parseInt(args[++i], 10);
    } else if (a === '--max-warnings' && args[i + 1]) {
      flags.maxWarnings = parseInt(args[++i], 10);
    } else if (a === '--memory-strict') {
      flags.memoryStrict = true;
    } else if (a === '--url' && args[i + 1]) {
      flags.url = args[++i];
    } else if (a === '--with-runtime') {
      flags.withRuntime = true;
    } else if (a === '--dry-run') {
      flags.dryRun = true;
    } else if (a === '--actions') {
      flags.actions = true;
    } else if (a === '--actions-top' && args[i + 1]) {
      flags.actionsTop = parseInt(args[++i], 10);
    } else if (a === '--gate' && args[i + 1]) {
      const mode = args[++i];
      if (!['none', 'minimum', 'regressions'].includes(mode)) {
        console.error(`Error: --gate must be none, minimum, or regressions (got: ${mode})`);
        process.exit(1);
      }
      flags.gate = mode;
    } else if (a === '--min-coverage' && args[i + 1]) {
      flags.minCoverage = parseInt(args[++i], 10);
    } else if (a === '--replay' && args[i + 1]) {
      flags.replay = args[++i];
    } else if (a === '--no-redact') {
      flags.noRedact = true;
    } else if (a === '--top' && args[i + 1]) {
      flags.top = parseInt(args[++i], 10);
    } else if (a === '--model' && args[i + 1]) {
      flags.model = args[++i];
    } else if (a === '--min-confidence' && args[i + 1]) {
      flags.minConfidence = parseFloat(args[++i]);
    } else if (a === '--eyes' && args[i + 1]) {
      flags.eyes = args[++i];
    } else if (a === '--repo' && args[i + 1]) {
      flags.repo = args[++i];
    } else if (a === '--tasks' && args[i + 1]) {
      flags.tasks = args[++i];
    } else if (a === '--min-rank' && args[i + 1]) {
      flags.minRank = parseFloat(args[++i]);
    }
  }
  return flags;
}

/**
 * Collect positional (non-flag) arguments, skipping known value-flags.
 * @param {string[]} args
 * @returns {string[]} [command, ...positionals]
 */
function collectPositionalArgs(args) {
  const valueFlags = new Set(['--config', '--from', '--out', '--format', '--max-fixes',
    '--max-blockers', '--max-warnings', '--url', '--actions-top', '--gate',
    '--min-coverage', '--replay', '--top', '--model', '--min-confidence', '--eyes',
    '--repo', '--tasks', '--min-rank']);
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (valueFlags.has(args[i])) i++;
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
