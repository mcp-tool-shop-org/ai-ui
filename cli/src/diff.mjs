// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { matchScore } from './normalize.mjs';
import { fail } from './config.mjs';

/**
 * Run the Diff command: atlas.json ↔ probe.jsonl (+ surfaces) → diff.json + diff.md.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean }} flags
 */
export async function runDiff(config, flags) {
  const cwd = process.cwd();

  // Load atlas
  const atlasPath = resolve(cwd, config.output.atlas);
  if (!existsSync(atlasPath)) {
    fail('DIFF_NO_ATLAS', `Atlas file not found: ${atlasPath}`, 'Run "ai-ui atlas" first.');
  }
  const atlas = JSON.parse(readFileSync(atlasPath, 'utf-8'));

  // Load probe
  const probePath = resolve(cwd, config.output.probe);
  if (!existsSync(probePath)) {
    fail('DIFF_NO_PROBE', `Probe file not found: ${probePath}`, 'Run "ai-ui probe" first.');
  }
  const probeLines = readFileSync(probePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

  const triggers = probeLines.filter(l => l.type === 'trigger');
  const features = atlas.features || [];

  // Load surfaces (optional, enhances matching with pattern/intent signals)
  const surfacesPath = resolve(cwd, config.output.surfaces);
  /** @type {import('./types.mjs').Surface[]} */
  let surfaces = [];
  if (existsSync(surfacesPath)) {
    try {
      const inv = JSON.parse(readFileSync(surfacesPath, 'utf-8'));
      surfaces = inv.surfaces || [];
      if (flags.verbose) {
        console.log(`Diff: loaded ${surfaces.length} surfaces from ${relative(cwd, surfacesPath)}`);
      }
    } catch {
      // Surfaces file is optional — skip on parse error
    }
  }

  // Load manual mappings
  const manualMapping = config.mapping || {};

  if (flags.verbose) {
    console.log(`Diff: ${features.length} features × ${triggers.length} triggers` +
      (surfaces.length > 0 ? ` + ${surfaces.length} surfaces` : ''));
  }

  // --- Matching ---
  /** @type {{ feature_id: string, feature_name: string, trigger_label: string, trigger_route: string, match_type: string, confidence: number }[]} */
  const matched = [];
  /** @type {Set<string>} */
  const matchedFeatureIds = new Set();
  /** @type {Set<string>} */
  const matchedTriggerKeys = new Set();

  // Manual mappings first
  for (const [featureId, triggerLabel] of Object.entries(manualMapping)) {
    const feature = features.find(f => f.id === featureId);
    const trigger = triggers.find(t => t.label === triggerLabel);
    if (feature && trigger) {
      matched.push({
        feature_id: feature.id,
        feature_name: feature.name,
        trigger_label: trigger.label,
        trigger_route: trigger.route,
        match_type: 'manual',
        confidence: 1.0,
      });
      matchedFeatureIds.add(feature.id);
      matchedTriggerKeys.add(triggerKey(trigger));
    }
  }

  // Automatic matching: probe triggers first, then surfaces
  for (const feature of features) {
    if (matchedFeatureIds.has(feature.id)) continue;

    const namesToTry = [feature.name, ...feature.synonyms];
    let bestTrigger = null;
    let bestScore = 0;
    let bestMatchType = 'exact';

    // Match against probe trigger labels
    for (const name of namesToTry) {
      for (const trigger of triggers) {
        if (matchedTriggerKeys.has(triggerKey(trigger))) continue;

        const score = matchScore(name, trigger.label);
        if (score > bestScore) {
          bestScore = score;
          bestTrigger = trigger;
          bestMatchType = score === 1.0 ? 'exact' : score >= 0.8 ? 'substring' : 'fuzzy';
        }
      }
    }

    if (bestTrigger && bestScore >= 0.4) {
      matched.push({
        feature_id: feature.id,
        feature_name: feature.name,
        trigger_label: bestTrigger.label,
        trigger_route: bestTrigger.route,
        match_type: bestMatchType,
        confidence: Math.round(bestScore * 100) / 100,
      });
      matchedFeatureIds.add(feature.id);
      matchedTriggerKeys.add(triggerKey(bestTrigger));
      continue;
    }

    // If no trigger match, try matching against surface labels/patterns
    if (surfaces.length > 0) {
      let bestSurface = null;
      let bestSurfScore = 0;
      let bestSurfMatchType = 'surface';

      for (const name of namesToTry) {
        for (const surface of surfaces) {
          // Match against surface label (semantic hint)
          if (surface.label) {
            const score = matchScore(name, surface.label);
            if (score > bestSurfScore) {
              bestSurfScore = score;
              bestSurface = surface;
              bestSurfMatchType = score === 1.0 ? 'surface-exact' : 'surface-fuzzy';
            }
          }
          // Match against pattern name (e.g., "search_bar" → "search")
          if (surface.pattern) {
            const patternName = surface.pattern.replace(/_/g, ' ');
            const score = matchScore(name, patternName);
            if (score > bestSurfScore) {
              bestSurfScore = score;
              bestSurface = surface;
              bestSurfMatchType = 'surface-pattern';
            }
          }
          // Match against handler intents (e.g., "submit_form" → "submit")
          for (const h of surface.handlers) {
            const intentName = h.intent.replace(/_/g, ' ');
            const score = matchScore(name, intentName);
            if (score > bestSurfScore) {
              bestSurfScore = score;
              bestSurface = surface;
              bestSurfMatchType = 'surface-intent';
            }
          }
        }
      }

      if (bestSurface && bestSurfScore >= 0.4) {
        matched.push({
          feature_id: feature.id,
          feature_name: feature.name,
          trigger_label: bestSurface.label || bestSurface.pattern || bestSurface.nodeId,
          trigger_route: bestSurface.route,
          match_type: bestSurfMatchType,
          confidence: Math.round(bestSurfScore * 100) / 100,
        });
        matchedFeatureIds.add(feature.id);
      }
    }
  }

  // --- Classify unmatched ---
  const documentedNotDiscoverable = features
    .filter(f => !matchedFeatureIds.has(f.id))
    .map(f => ({
      feature_id: f.id,
      feature_name: f.name,
      sources: f.sources.map(s => `${s.file}:${s.line}`),
      reason: 'No matching trigger found in any crawled route',
    }))
    .sort((a, b) => a.feature_id.localeCompare(b.feature_id));

  const discoverableNotDocumented = triggers
    .filter(t => !matchedTriggerKeys.has(triggerKey(t)))
    .reduce((acc, t) => {
      // Deduplicate by label
      const key = t.label;
      if (!acc.some(x => x.trigger_label === key)) {
        acc.push({
          trigger_label: t.label,
          trigger_route: t.route,
          trigger_selector: t.selector,
          reason: 'No matching feature in atlas',
        });
      }
      return acc;
    }, /** @type {any[]} */ ([]))
    .sort((a, b) => a.trigger_label.localeCompare(b.trigger_label));

  // --- Burial index ---
  const burialIndex = triggers
    .map(t => {
      const depth = t.depth || 0;
      const inPrimaryNav = t.parent_nav || false;
      const behindOverflow = /more|\.{3}|…|overflow/i.test(t.label);
      const burialScore = depth * 2 + (inPrimaryNav ? 0 : 3) + (behindOverflow ? 5 : 0);

      return {
        trigger_label: t.label,
        route: t.route,
        depth,
        in_primary_nav: inPrimaryNav,
        behind_overflow: behindOverflow,
        burial_score: burialScore,
      };
    })
    .reduce((acc, t) => {
      // Deduplicate by label
      if (!acc.some(x => x.trigger_label === t.trigger_label)) acc.push(t);
      return acc;
    }, /** @type {any[]} */ ([]))
    .sort((a, b) => b.burial_score - a.burial_score);

  // --- Stats ---
  const coveragePct = features.length > 0
    ? Math.round((matched.length / features.length) * 1000) / 10
    : 0;

  const stats = {
    total_features: features.length,
    total_triggers: triggers.length,
    total_surfaces: surfaces.length,
    matched: matched.length,
    documented_not_discoverable: documentedNotDiscoverable.length,
    discoverable_not_documented: discoverableNotDocumented.length,
    coverage_percent: coveragePct,
  };

  // --- Write diff.json ---
  const diffJson = {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    documented_not_discoverable: documentedNotDiscoverable,
    discoverable_not_documented: discoverableNotDocumented,
    matched: matched.sort((a, b) => a.feature_id.localeCompare(b.feature_id)),
    burial_index: burialIndex,
    stats,
  };

  const diffPath = resolve(cwd, config.output.diff);
  mkdirSync(dirname(diffPath), { recursive: true });
  writeFileSync(diffPath, JSON.stringify(diffJson, null, 2) + '\n', 'utf-8');

  // --- Write diff.md ---
  const reportPath = resolve(cwd, config.output.diffReport);
  writeFileSync(reportPath, generateReport(diffJson), 'utf-8');

  console.log(`Diff: coverage ${coveragePct}% (${matched.length}/${features.length}) → ${relative(cwd, diffPath)}`);
}

/**
 * Generate a markdown report from the diff data.
 * @param {object} diff
 * @returns {string}
 */
function generateReport(diff) {
  const lines = [];

  lines.push('# AI-UI Stage 0 Diff Report');
  lines.push('');
  lines.push(`Generated: ${diff.generated_at}`);
  lines.push('');
  lines.push(`## Coverage: ${diff.stats.coverage_percent}% (${diff.stats.matched}/${diff.stats.total_features} features discoverable)`);
  lines.push('');

  // Documented but NOT Discoverable
  lines.push('## Documented but NOT Discoverable');
  lines.push('');
  if (diff.documented_not_discoverable.length === 0) {
    lines.push('None — all documented features have UI triggers.');
  } else {
    lines.push('| Feature | Source | Reason |');
    lines.push('|---------|--------|--------|');
    for (const item of diff.documented_not_discoverable) {
      lines.push(`| ${item.feature_name} | ${item.sources.join(', ')} | ${item.reason} |`);
    }
  }
  lines.push('');

  // Discoverable but NOT Documented
  lines.push('## Discoverable but NOT Documented');
  lines.push('');
  if (diff.discoverable_not_documented.length === 0) {
    lines.push('None — all UI triggers are documented.');
  } else {
    lines.push('| Trigger | Route | Selector |');
    lines.push('|---------|-------|----------|');
    for (const item of diff.discoverable_not_documented) {
      lines.push(`| ${item.trigger_label} | ${item.trigger_route} | \`${item.trigger_selector}\` |`);
    }
  }
  lines.push('');

  // Burial Index
  lines.push('## Burial Index');
  lines.push('');
  if (diff.burial_index.length === 0) {
    lines.push('No triggers found.');
  } else {
    lines.push('| Trigger | Route | Depth | Primary Nav | Overflow | Score |');
    lines.push('|---------|-------|-------|-------------|----------|-------|');
    for (const item of diff.burial_index) {
      lines.push(`| ${item.trigger_label} | ${item.route} | ${item.depth} | ${item.in_primary_nav ? 'yes' : 'no'} | ${item.behind_overflow ? 'yes' : 'no'} | ${item.burial_score} |`);
    }
  }
  lines.push('');

  // Matched
  lines.push(`## Matched (${diff.matched.length})`);
  lines.push('');
  if (diff.matched.length === 0) {
    lines.push('No matches found.');
  } else {
    lines.push('| Feature | Trigger | Match Type | Confidence |');
    lines.push('|---------|---------|------------|------------|');
    for (const item of diff.matched) {
      lines.push(`| ${item.feature_name} | ${item.trigger_label} | ${item.match_type} | ${item.confidence.toFixed(2)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Create a dedup key for a trigger.
 * @param {{ label: string, route: string }} trigger
 * @returns {string}
 */
function triggerKey(trigger) {
  return `${trigger.route}|${trigger.label}`;
}
