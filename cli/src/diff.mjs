// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';
import {
  scoreCandidate,
  classifyFailure,
  formatFailureReason,
  generateSuggestions,
  detectAmbiguous,
  enrichDiscoverable,
} from './diagnostics.mjs';
import { loadMemory, mergeMemoryMappings, suggestMemoryEntries } from './memory.mjs';

/**
 * Run the Diff command: atlas.json ↔ probe.jsonl (+ surfaces) → diff.json + diff.md.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, noMemory?: boolean, memoryStrict?: boolean }} flags
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

  // Load memory + merge mappings
  const memory = flags.noMemory ? null : loadMemory(resolve(cwd, config.memory.dir), flags.memoryStrict);
  const manualMapping = memory
    ? mergeMemoryMappings(config.mapping || {}, memory.mappings)
    : (config.mapping || {});

  const memoryMappingCount = memory ? Object.keys(memory.mappings).length : 0;

  if (flags.verbose) {
    console.log(`Diff: ${features.length} features × ${triggers.length} triggers` +
      (surfaces.length > 0 ? ` + ${surfaces.length} surfaces` : '') +
      (memoryMappingCount > 0 ? ` + ${memoryMappingCount} memory mapping(s)` : ''));
  }

  // --- Matching with full candidate collection ---
  /** @type {{ feature_id: string, feature_name: string, trigger_label: string, trigger_route: string, match_type: string, confidence: number }[]} */
  const matched = [];
  /** @type {Set<string>} */
  const matchedFeatureIds = new Set();
  /** @type {Set<string>} */
  const matchedTriggerKeys = new Set();
  /** @type {Map<string, import('./types.mjs').CandidateAttempt[]>} */
  const candidateMap = new Map();
  /** @type {import('./types.mjs').AmbiguousMatch[]} */
  const ambiguousMatches = [];

  // Manual mappings first (no change)
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

  // Automatic matching: collect ALL candidates per feature
  for (const feature of features) {
    if (matchedFeatureIds.has(feature.id)) continue;

    const aliases = (config.featureAliases || {})[feature.id] || [];
    const namesToTry = [feature.name, ...feature.synonyms, ...aliases];
    /** @type {import('./types.mjs').CandidateAttempt[]} */
    const allCandidates = [];

    // Score against probe triggers
    for (const trigger of triggers) {
      if (matchedTriggerKeys.has(triggerKey(trigger))) continue;
      const enrichedLabels = [trigger.aria_label, trigger.title_attr].filter(Boolean);
      allCandidates.push(scoreCandidate(namesToTry, {
        source_type: 'trigger',
        source_id: triggerKey(trigger),
        source_label: trigger.label,
        source_route: trigger.route,
        pattern: null,
        handlers: [],
        styleTokens: [],
        enriched_labels: enrichedLabels,
      }));
    }

    // Score against surfaces
    for (const surface of surfaces) {
      allCandidates.push(scoreCandidate(namesToTry, {
        source_type: 'surface',
        source_id: surface.nodeId,
        source_label: surface.label || surface.pattern || surface.nodeId,
        source_route: surface.route,
        pattern: surface.pattern,
        handlers: surface.handlers,
        styleTokens: surface.styleTokens,
      }));
    }

    // Deterministic sort: composite desc, then source_id asc for ties
    allCandidates.sort((a, b) =>
      b.composite_score - a.composite_score ||
      a.source_id.localeCompare(b.source_id)
    );

    candidateMap.set(feature.id, allCandidates);

    const best = allCandidates[0];
    if (best && best.composite_score >= 0.4) {
      const matchType = best.source_type === 'surface'
        ? (best.match_dimension === 'pattern' ? 'surface-pattern' :
           best.match_dimension === 'intent' ? 'surface-intent' :
           best.label_score === 1.0 ? 'surface-exact' : 'surface-fuzzy')
        : (best.label_score === 1.0 ? 'exact' : best.label_score >= 0.8 ? 'substring' : 'fuzzy');

      matched.push({
        feature_id: feature.id,
        feature_name: feature.name,
        trigger_label: best.source_label,
        trigger_route: best.source_route,
        match_type: matchType,
        confidence: best.composite_score,
      });
      matchedFeatureIds.add(feature.id);
      if (best.source_type === 'trigger') {
        matchedTriggerKeys.add(best.source_id);
      }

      // Check ambiguity
      const ambig = detectAmbiguous(feature, allCandidates);
      if (ambig) ambiguousMatches.push(ambig);
    }
  }

  // --- Enriched unmatched (with evidence) ---
  const documentedNotDiscoverable = features
    .filter(f => !matchedFeatureIds.has(f.id))
    .map(f => {
      const candidates = candidateMap.get(f.id) || [];
      const top3 = candidates.slice(0, 3);
      const failureReason = classifyFailure(f, top3, surfaces);
      return {
        feature_id: f.id,
        feature_name: f.name,
        sources: f.sources.map(s => `${s.file}:${s.line}`),
        failure_reason: failureReason,
        top_candidates: top3,
        suggestions: generateSuggestions(f, surfaces, triggers),
        reason: formatFailureReason(failureReason),
      };
    })
    .sort((a, b) => a.feature_id.localeCompare(b.feature_id));

  // --- Enriched discoverable-not-documented ---
  const discoverableNotDocumented = triggers
    .filter(t => !matchedTriggerKeys.has(triggerKey(t)))
    .reduce((acc, t) => {
      const key = t.label;
      if (!acc.some(x => x.trigger_label === key)) {
        const enrichment = enrichDiscoverable(t, surfaces);
        acc.push({
          trigger_label: t.label,
          trigger_route: t.route,
          trigger_selector: t.selector,
          ...enrichment,
          reason: 'No matching feature in atlas',
        });
      }
      return acc;
    }, /** @type {any[]} */ ([]))
    .sort((a, b) => a.trigger_label.localeCompare(b.trigger_label));

  // --- Burial index (unchanged) ---
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
      if (!acc.some(x => x.trigger_label === t.trigger_label)) acc.push(t);
      return acc;
    }, /** @type {any[]} */ ([]))
    .sort((a, b) => b.burial_score - a.burial_score);

  // --- Stats ---
  const coveragePct = features.length > 0
    ? Math.round((matched.length / features.length) * 1000) / 10
    : 0;

  // Aggregate failure reasons + suggestion rules
  /** @type {Record<string, number>} */
  const topFailureReasons = {};
  /** @type {Record<string, number>} */
  const topSuggestedRules = {};
  for (const item of documentedNotDiscoverable) {
    topFailureReasons[item.failure_reason] = (topFailureReasons[item.failure_reason] || 0) + 1;
    for (const s of item.suggestions) {
      topSuggestedRules[s.rule] = (topSuggestedRules[s.rule] || 0) + 1;
    }
  }

  const stats = {
    total_features: features.length,
    total_triggers: triggers.length,
    total_surfaces: surfaces.length,
    matched: matched.length,
    documented_not_discoverable: documentedNotDiscoverable.length,
    discoverable_not_documented: discoverableNotDocumented.length,
    ambiguous_matches: ambiguousMatches.length,
    coverage_percent: coveragePct,
    top_failure_reasons: topFailureReasons,
    top_suggested_rules: topSuggestedRules,
  };

  // --- Suggested memory entries ---
  const suggested = suggestMemoryEntries({
    ambiguous_matches: ambiguousMatches,
    documented_not_discoverable: documentedNotDiscoverable,
  });

  // --- Write diff.json ---
  const diffJson = {
    version: '1.1.0',
    generated_at: new Date().toISOString(),
    documented_not_discoverable: documentedNotDiscoverable,
    discoverable_not_documented: discoverableNotDocumented,
    ambiguous_matches: ambiguousMatches,
    matched: matched.sort((a, b) => a.feature_id.localeCompare(b.feature_id)),
    burial_index: burialIndex,
    suggested_memory: suggested.mappings.length > 0 ? suggested : undefined,
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

// =============================================================================
// Enhanced markdown report generator
// =============================================================================

/**
 * Generate an evidence-rich markdown report.
 * @param {object} diff
 * @returns {string}
 */
function generateReport(diff) {
  const lines = [];

  // --- Summary ---
  lines.push('# AI-UI Diff Report');
  lines.push('');
  lines.push(`Generated: ${diff.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Features documented | ${diff.stats.total_features} |`);
  lines.push(`| Triggers discovered | ${diff.stats.total_triggers} |`);
  lines.push(`| Surfaces extracted | ${diff.stats.total_surfaces} |`);
  lines.push(`| **Coverage** | **${diff.stats.coverage_percent}% (${diff.stats.matched}/${diff.stats.total_features})** |`);
  lines.push(`| Ambiguous matches | ${diff.stats.ambiguous_matches} |`);
  lines.push('');

  // Top failure reasons
  const failureEntries = Object.entries(diff.stats.top_failure_reasons || {});
  if (failureEntries.length > 0) {
    lines.push(`**Top failure reasons:** ${failureEntries.map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }

  // Top suggestion rules
  const suggEntries = Object.entries(diff.stats.top_suggested_rules || {});
  if (suggEntries.length > 0) {
    lines.push(`**Top fix suggestions:** ${suggEntries.map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Documented but NOT Discoverable ---
  lines.push(`## Documented but NOT Discoverable (${diff.documented_not_discoverable.length})`);
  lines.push('');

  if (diff.documented_not_discoverable.length === 0) {
    lines.push('None — all documented features have UI triggers.');
  } else {
    for (const item of diff.documented_not_discoverable) {
      lines.push(`### ${item.feature_name}`);
      lines.push('');
      lines.push(`- **Source:** ${item.sources.join(', ')}`);
      lines.push(`- **Failure reason:** \`${item.failure_reason}\``);

      // Candidate evidence table
      if (item.top_candidates && item.top_candidates.length > 0) {
        lines.push('- **Top candidates tried:**');
        lines.push('');
        lines.push('  | # | Candidate | Source | Label | Pattern | Intent | Style | Composite |');
        lines.push('  |---|-----------|--------|-------|---------|--------|-------|-----------|');
        for (let i = 0; i < item.top_candidates.length; i++) {
          const c = item.top_candidates[i];
          lines.push(`  | ${i + 1} | ${c.source_label} | ${c.source_type} ${c.source_route} | ${c.label_score.toFixed(2)} | ${c.pattern_score.toFixed(2)} | ${c.intent_score.toFixed(2)} | ${c.style_score.toFixed(2)} | ${c.composite_score.toFixed(2)} |`);
        }
        lines.push('');
      } else {
        lines.push('- **Top candidates tried:** none');
        lines.push('');
      }

      // Fix suggestions
      if (item.suggestions && item.suggestions.length > 0) {
        lines.push('- **Fix suggestions:**');
        for (const s of item.suggestions) {
          lines.push(`  - ${s.action} _(rule: ${s.rule})_`);
        }
        lines.push(`  - Tag: \`${item.suggestions[0].tag_hint}\``);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');

  // --- Discoverable but NOT Documented ---
  lines.push(`## Discoverable but NOT Documented (${diff.discoverable_not_documented.length})`);
  lines.push('');

  if (diff.discoverable_not_documented.length === 0) {
    lines.push('None — all UI triggers are documented.');
  } else {
    lines.push('| Trigger | Route | Selector | Surface | Pattern | Style | Suggestion |');
    lines.push('|---------|-------|----------|---------|---------|-------|------------|');
    for (const item of diff.discoverable_not_documented) {
      const se = item.surface_evidence || {};
      const hasSurf = se.has_surface ? 'yes' : 'no';
      const pattern = se.surface_pattern || '-';
      const style = (se.surface_styleTokens || []).join(', ') || '-';
      lines.push(`| ${item.trigger_label} | ${item.trigger_route} | \`${item.trigger_selector}\` | ${hasSurf} | ${pattern} | ${style} | ${item.doc_suggestion || '-'} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Ambiguous Matches ---
  lines.push(`## Ambiguous Matches (${diff.ambiguous_matches.length})`);
  lines.push('');

  if (diff.ambiguous_matches.length === 0) {
    lines.push('No ambiguous matches found.');
  } else {
    for (const item of diff.ambiguous_matches) {
      lines.push(`### ${item.feature_name}`);
      lines.push('');
      lines.push(`- **Confidence gap:** ${item.confidence_gap.toFixed(2)}`);
      lines.push('- **Tied candidates:**');
      lines.push('');
      lines.push('  | Candidate | Source | Composite |');
      lines.push('  |-----------|--------|-----------|');
      for (const c of item.tied_candidates) {
        lines.push(`  | ${c.source_label} | ${c.source_type} ${c.source_route} | ${c.composite_score.toFixed(2)} |`);
      }
      lines.push('');
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Matched ---
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
  lines.push('---');
  lines.push('');

  // --- Burial Index ---
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

  // --- Suggested Memory Updates ---
  const suggested = diff.suggested_memory;
  if (suggested && suggested.mappings && suggested.mappings.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Suggested Memory Updates');
    lines.push('');

    const ambigSuggestions = suggested.mappings.filter(m => m.source === 'ambiguous');
    if (ambigSuggestions.length > 0) {
      lines.push('### Mappings (from ambiguous matches)');
      lines.push('');
      for (const s of ambigSuggestions) {
        lines.push(`- \`${s.feature_id}\` → "${s.trigger_label}" (confidence ${s.confidence.toFixed(2)}) — ${s.hint}`);
      }
      lines.push('');
    }

    const nearMissSuggestions = suggested.mappings.filter(m => m.source === 'near_miss');
    if (nearMissSuggestions.length > 0) {
      lines.push('### Mappings (from near-miss candidates)');
      lines.push('');
      for (const s of nearMissSuggestions) {
        lines.push(`- \`${s.feature_id}\` ↔ "${s.trigger_label}" (score ${s.confidence.toFixed(2)}) — ${s.hint}`);
      }
      lines.push('');
    }
  }

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
