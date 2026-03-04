// @ts-check
import { runAtlas } from './atlas.mjs';
import { runProbe } from './probe.mjs';
import { runDiff } from './diff.mjs';

/**
 * Run the full Stage 0 pipeline: atlas → probe → diff.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean }} flags
 */
export async function runStage0(config, flags) {
  console.log('Stage 0: starting pipeline...\n');
  const start = Date.now();

  // Step 1: Atlas
  const t1 = Date.now();
  await runAtlas(config, flags);
  console.log(`  (${Date.now() - t1}ms)\n`);

  // Step 2: Probe
  const t2 = Date.now();
  await runProbe(config, flags);
  console.log(`  (${Date.now() - t2}ms)\n`);

  // Step 3: Diff
  const t3 = Date.now();
  await runDiff(config, flags);
  console.log(`  (${Date.now() - t3}ms)\n`);

  console.log(`Stage 0: complete in ${Date.now() - start}ms`);
}
