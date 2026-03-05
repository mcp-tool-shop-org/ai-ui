#!/usr/bin/env node
// @ts-check
import { loadConfig, fail } from '../src/config.mjs';

const VERSION = '1.0.0';

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
  init-memory  Create empty memory files (mappings/decisions/exceptions)
  stage0       Run atlas → probe → diff in sequence

Options:
  --config <path>   Path to ai-ui.config.json (default: ./ai-ui.config.json)
  --from <path>     Source capture file (for surfaces command)
  --out <path>      Override output path
  --verbose         Print extra output
  --run-pipeline    (verify) Run full pipeline before judging
  --strict          (verify) Zero-tolerance thresholds
  --json            (verify) Print verdict JSON to stdout, no file writes
  --no-memory       Disable memory loading for this run
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
    case 'init-memory': {
      const { runInitMemory } = await import('../src/memory.mjs');
      runInitMemory(config);
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
 * @returns {{ config?: string, from?: string, out?: string, verbose: boolean, help: boolean, version: boolean, runPipeline: boolean, strict: boolean, json: boolean, noMemory: boolean, memoryStrict: boolean }}
 */
function parseFlags(args) {
  const flags = { config: undefined, from: undefined, out: undefined, verbose: false, help: false, version: false, runPipeline: false, strict: false, json: false, noMemory: false, memoryStrict: false };
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
    } else if (a === '--no-memory') {
      flags.noMemory = true;
    } else if (a === '--memory-strict') {
      flags.memoryStrict = true;
    }
  }
  return flags;
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
