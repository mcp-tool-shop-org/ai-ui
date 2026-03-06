// @ts-check
/**
 * ai-suggest — Brain v0: Semantic Match + Alias Patch
 *
 * Uses Ollama (local) to match doc features → UI surfaces and emit:
 *   - ai-suggest.json     (structured suggestions)
 *   - ai-suggest.patch.json (featureAliases patch)
 *   - ai-suggest.md       (human summary)
 *
 * AI outputs suggestions only. Never edits graph, coverage, gates, or artifacts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fail } from './config.mjs';
import { loadDesignMapInputs, buildSurfaceInventory, buildFeatureMap } from './design-map.mjs';
import { checkOllamaAvailable, checkModelAvailable, queryOllama, OllamaError } from './ollama.mjs';
import { buildSuggestPrompt, parseBrainResponse, BrainParseError } from './ai-suggest-prompt.mjs';

const VERSION = '1.0.0';

/**
 * Gather all flat surfaces from a DesignSurfaceInventory.
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @returns {{ surface_id: string, label: string, route: string, location_group: string, safety: string, role: string }[]}
 */
function flattenSurfaces(inventory) {
  const all = [];
  for (const [group, entries] of Object.entries(inventory.groups)) {
    for (const entry of entries) {
      const surfaceId = entry.linked_triggers[0] || `surface:${entry.route}|${entry.label}`;
      all.push({
        surface_id: surfaceId,
        label: entry.label,
        route: entry.route,
        location_group: group,
        safety: entry.safety,
        role: entry.role,
      });
    }
  }
  return all;
}

/**
 * Pre-rank candidates for a feature using simple string similarity.
 * Returns top N candidates sorted by naive relevance.
 *
 * @param {string} featureText
 * @param {{ surface_id: string, label: string, route: string, location_group: string, safety: string, role: string }[]} surfaces
 * @param {number} topN
 * @returns {{ surface_id: string, label: string, route: string, location_group: string, safety: string, role: string }[]}
 */
function preRankCandidates(featureText, surfaces, topN) {
  const featureWords = new Set(
    featureText.toLowerCase().split(/[\s\-_,.()/]+/).filter(w => w.length > 2)
  );

  const scored = surfaces.map(s => {
    const labelWords = s.label.toLowerCase().split(/[\s\-_,.()/]+/).filter(w => w.length > 2);
    let overlap = 0;
    for (const w of labelWords) {
      if (featureWords.has(w)) overlap++;
      // partial match: feature word contains label word or vice versa
      for (const fw of featureWords) {
        if (fw.includes(w) || w.includes(fw)) {
          overlap += 0.5;
          break;
        }
      }
    }
    // Prefer surfaces in prominent locations
    const locationBonus = {
      primary_nav: 0.3,
      secondary_nav: 0.2,
      toolbar: 0.15,
      settings: 0.1,
      modal: 0.05,
      inline: 0,
      overflow: -0.1,
      footer: -0.1,
    };
    const score = overlap + (locationBonus[s.location_group] || 0);
    return { ...s, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, topN).map(({ _score, ...rest }) => rest);
}

/**
 * Build featureAliases patch from suggestions.
 * Append-only: never overwrites existing aliases.
 *
 * @param {import('./types.mjs').AiSuggestion[]} suggestions
 * @param {Record<string, string[]>} existingAliases
 * @param {string} model
 * @returns {import('./types.mjs').AiAliasPatch}
 */
function buildAliasPatch(suggestions, existingAliases, model) {
  /** @type {Record<string, string[]>} */
  const featureAliases = {};
  /** @type {Record<string, import('./types.mjs').AiAliasPatchProvenance>} */
  const provenance = {};

  for (const suggestion of suggestions) {
    if (suggestion.confidence < 0.3) continue;
    if (suggestion.recommended_aliases.length === 0 && !suggestion.recommended_anchor) continue;

    const existing = new Set((existingAliases[suggestion.feature_id] || []).map(a => a.toLowerCase()));
    const newTerms = [];

    // Add anchor label if it's not already present
    if (suggestion.recommended_anchor) {
      const anchorLower = suggestion.recommended_anchor.toLowerCase();
      if (!existing.has(anchorLower)) {
        newTerms.push(suggestion.recommended_anchor);
        existing.add(anchorLower);
      }
    }

    // Add alias terms that aren't already present
    for (const term of suggestion.recommended_aliases) {
      const termLower = term.toLowerCase();
      if (!existing.has(termLower)) {
        newTerms.push(term);
        existing.add(termLower);
      }
    }

    if (newTerms.length > 0) {
      featureAliases[suggestion.feature_id] = [
        ...(existingAliases[suggestion.feature_id] || []),
        ...newTerms,
      ];
      provenance[suggestion.feature_id] = {
        anchor_label: suggestion.recommended_anchor || '',
        confidence: suggestion.confidence,
        terms_added: newTerms,
        model,
      };
    }
  }

  return { featureAliases, provenance };
}

/**
 * Render a human-readable markdown summary.
 *
 * @param {import('./types.mjs').AiSuggestReport} report
 * @returns {string}
 */
function renderSuggestMd(report) {
  const lines = [
    `# AI Suggest Report`,
    ``,
    `**Model:** ${report.model}`,
    `**Generated:** ${report.generated_at}`,
    `**Features analyzed:** ${report.stats.features_analyzed} / ${report.stats.total_features}`,
    `**With suggestions:** ${report.stats.features_with_suggestions}`,
    `**Avg confidence:** ${(report.stats.avg_confidence * 100).toFixed(1)}%`,
    ``,
  ];

  // Top suggestions
  const topSuggestions = report.suggestions
    .filter(s => s.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  if (topSuggestions.length > 0) {
    lines.push(`## Top Matches`, ``);
    lines.push(`| Feature | Best Surface | Score | Aliases | Confidence |`);
    lines.push(`|---------|-------------|-------|---------|------------|`);
    for (const s of topSuggestions) {
      const bestLabel = s.candidates[0]?.label || '—';
      const bestScore = s.candidates[0]?.score ? (s.candidates[0].score * 100).toFixed(0) + '%' : '—';
      const aliases = s.recommended_aliases.slice(0, 3).join(', ') || '—';
      const conf = (s.confidence * 100).toFixed(0) + '%';
      lines.push(`| ${s.feature_text.slice(0, 50)} | ${bestLabel} | ${bestScore} | ${aliases} | ${conf} |`);
    }
    lines.push(``);
  }

  // Patch summary
  const patchKeys = Object.keys(report.patch.featureAliases);
  if (patchKeys.length > 0) {
    lines.push(`## Alias Patch`, ``);
    lines.push(`${patchKeys.length} feature(s) would gain new aliases:`, ``);
    for (const key of patchKeys.slice(0, 20)) {
      const prov = report.patch.provenance[key];
      const terms = prov?.terms_added?.join(', ') || '';
      lines.push(`- **${key}**: +${prov?.terms_added?.length || 0} aliases (${terms})`);
    }
    lines.push(``);
    lines.push(`Apply with: \`cp ai-suggest.patch.json ai-ui.config.patch.json\` then merge into your config.`);
  } else {
    lines.push(`## Alias Patch`, ``, `No new aliases suggested.`);
  }

  // Low-confidence / no-match features
  const noMatch = report.suggestions.filter(s => s.confidence < 0.3);
  if (noMatch.length > 0) {
    lines.push(``, `## No Match Found (${noMatch.length})`);
    for (const s of noMatch.slice(0, 10)) {
      lines.push(`- ${s.feature_text}${s.notes ? ` — ${s.notes}` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Main command handler for ai-suggest.
 *
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ from?: string, out?: string, replay?: string, verbose?: boolean, dryRun?: boolean, model?: string, top?: number, minConfidence?: number, format?: string, eyes?: string }} flags
 */
export async function runAiSuggest(config, flags) {
  const cwd = process.cwd();
  const aiConfig = config.aiSuggest || { model: 'qwen2.5:14b', top: 5, minConfidence: 0.55, timeout: 60000 };
  const model = flags.model || aiConfig.model;
  const topN = flags.top || aiConfig.top;
  const minConfidence = flags.minConfidence || aiConfig.minConfidence;
  const timeout = aiConfig.timeout;
  const outDir = flags.out || dirname(resolve(cwd, config.output.aiSuggestJson));

  // 1. Pre-flight: check Ollama
  if (!flags.dryRun) {
    console.error('Checking Ollama availability...');
    const available = await checkOllamaAvailable();
    if (!available) {
      fail('AI_NO_OLLAMA', 'Ollama is not running', 'Start Ollama with: ollama serve');
    }

    const modelReady = await checkModelAvailable(model);
    if (!modelReady) {
      fail('AI_NO_MODEL', `Model "${model}" is not available`, `Pull it with: ollama pull ${model}`);
    }
    console.error(`Ollama ready: model=${model}`);
  }

  // 2. Load design-map artifacts
  console.error('Loading design-map artifacts...');
  const inputs = loadDesignMapInputs(config, cwd, { replay: flags.replay, verbose: flags.verbose });
  const inventory = buildSurfaceInventory(inputs.graph, inputs.diff, inputs.coverage);
  const featureMap = buildFeatureMap(inputs.graph, inputs.diff, inputs.coverage, inputs.atlas);

  // 3. Identify features that need suggestions
  // Focus on unmatched, weakly-matched, or "promote" features
  const targetFeatures = featureMap.features.filter(f =>
    f.from_atlas && (
      f.recommended_action === 'promote' ||
      f.recommended_action === 'rename' ||
      f.entry_points.length === 0 ||
      f.discoverability > 0.5
    )
  );

  if (targetFeatures.length === 0) {
    console.error('All features are well-matched. Nothing to suggest.');
    return;
  }

  console.error(`Found ${targetFeatures.length} features to analyze (of ${featureMap.features.length} total).`);

  // 4. Flatten surface inventory for candidate matching
  const allSurfaces = flattenSurfaces(inventory);

  // 4b. Enrich surfaces with Eyes annotations if provided
  /** @type {Map<string, import('./types.mjs').EyesAnnotation>} */
  const eyesMap = new Map();
  if (flags.eyes) {
    const eyesPath = resolve(cwd, flags.eyes);
    if (existsSync(eyesPath)) {
      try {
        /** @type {import('./types.mjs').AiEyesReport} */
        const eyesReport = JSON.parse(readFileSync(eyesPath, 'utf-8'));
        for (const ann of eyesReport.annotations) {
          if (ann.confidence > 0) eyesMap.set(ann.surface_id, ann);
        }
        console.error(`Loaded ${eyesMap.size} Eyes annotations from ${flags.eyes}`);

        // Enrich surface labels with Eyes icon guesses
        for (const surface of allSurfaces) {
          const ann = eyesMap.get(surface.surface_id);
          if (ann) {
            // Append icon_guess and nearby_context to help Brain match
            if (ann.icon_guess && ann.icon_guess !== 'none') {
              surface.aria_label = [surface.aria_label, ann.icon_guess, ann.nearby_context]
                .filter(Boolean).join(' | ');
            }
          }
        }
      } catch (err) {
        console.error(`⚠ Failed to load Eyes data: ${err.message}`);
      }
    } else {
      console.error(`⚠ Eyes file not found: ${eyesPath}`);
    }
  }

  console.error(`${allSurfaces.length} surfaces available for matching.`);

  // 5. Query Brain for each feature
  /** @type {import('./types.mjs').AiSuggestion[]} */
  const suggestions = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < targetFeatures.length; i++) {
    const feature = targetFeatures[i];
    const featureText = feature.feature_name;
    const docSection = feature.rationale?.match(/Documented in (.+?) but/)?.[1] || null;

    console.error(`  [${i + 1}/${targetFeatures.length}] ${featureText.slice(0, 60)}...`);

    // Pre-rank candidates
    const candidates = preRankCandidates(featureText, allSurfaces, topN);

    if (flags.dryRun) {
      // Dry run: show what would be sent
      suggestions.push({
        feature_id: feature.feature_id,
        feature_text: featureText,
        doc_section: docSection,
        candidates: candidates.map(c => ({
          surface_id: c.surface_id,
          label: c.label,
          route: c.route,
          location_group: /** @type {import('./types.mjs').LocationGroup} */ (c.location_group),
          score: 0,
          rationale: '(dry run)',
        })),
        recommended_aliases: [],
        recommended_anchor: null,
        confidence: 0,
        notes: 'Dry run — no Ollama query made',
      });
      successCount++;
      continue;
    }

    // Build prompt and query Ollama
    const prompt = buildSuggestPrompt({
      featureText,
      docSection,
      candidates,
      existingAliases: config.featureAliases || {},
    });

    try {
      const rawResponse = await queryOllama(prompt, { model, timeout, verbose: flags.verbose });
      const parsed = parseBrainResponse(rawResponse, feature.feature_id);

      // Enrich with caller context
      parsed.feature_text = featureText;
      parsed.doc_section = docSection;

      // Enrich candidates with location_group from our inventory
      for (const candidate of parsed.candidates) {
        const match = allSurfaces.find(s => s.surface_id === candidate.surface_id);
        if (match) {
          candidate.location_group = /** @type {import('./types.mjs').LocationGroup} */ (match.location_group);
          candidate.route = match.route;
        }
      }

      // Remove the _raw field before storing
      const { _raw, ...clean } = parsed;
      suggestions.push(clean);
      successCount++;
    } catch (err) {
      if (err instanceof OllamaError || err instanceof BrainParseError) {
        console.error(`    ⚠ ${err.message}`);
        if (err instanceof OllamaError && err.hint) console.error(`      ${err.hint}`);
        errorCount++;

        // Store a zero-confidence entry so the feature shows up in reports
        suggestions.push({
          feature_id: feature.feature_id,
          feature_text: featureText,
          doc_section: docSection,
          candidates: [],
          recommended_aliases: [],
          recommended_anchor: null,
          confidence: 0,
          notes: `Error: ${err.message}`,
        });
      } else {
        throw err;
      }
    }
  }

  // 6. Build alias patch
  const patch = buildAliasPatch(suggestions, config.featureAliases || {}, model);

  // 7. Assemble report
  const confidences = suggestions.filter(s => s.confidence > 0).map(s => s.confidence);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  /** @type {import('./types.mjs').AiSuggestReport} */
  const report = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    model,
    suggestions,
    patch,
    stats: {
      total_features: featureMap.features.length,
      features_analyzed: targetFeatures.length,
      features_with_suggestions: suggestions.filter(s => s.candidates.length > 0 && s.confidence >= minConfidence).length,
      avg_confidence: avgConfidence,
    },
  };

  // 8. Write outputs
  mkdirSync(outDir, { recursive: true });

  const suggestPath = resolve(cwd, config.output.aiSuggestJson);
  const patchPath = resolve(cwd, config.output.aiSuggestPatchJson);
  const mdPath = resolve(cwd, config.output.aiSuggestMd);

  // Override with --out if specified
  const actualSuggestPath = flags.out ? resolve(flags.out, 'ai-suggest.json') : suggestPath;
  const actualPatchPath = flags.out ? resolve(flags.out, 'ai-suggest.patch.json') : patchPath;
  const actualMdPath = flags.out ? resolve(flags.out, 'ai-suggest.md') : mdPath;

  if (flags.out) mkdirSync(flags.out, { recursive: true });

  writeFileSync(actualSuggestPath, JSON.stringify(report, null, 2));
  writeFileSync(actualPatchPath, JSON.stringify(patch, null, 2));
  writeFileSync(actualMdPath, renderSuggestMd(report));

  // 9. Summary
  console.error(`\n✓ AI Suggest complete`);
  console.error(`  Model: ${model}`);
  console.error(`  Features analyzed: ${targetFeatures.length}`);
  console.error(`  Suggestions: ${report.stats.features_with_suggestions}`);
  console.error(`  Avg confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  console.error(`  Errors: ${errorCount}`);
  console.error(`  Alias patch: ${Object.keys(patch.featureAliases).length} features`);
  console.error(`\n  Outputs:`);
  console.error(`    ${actualSuggestPath}`);
  console.error(`    ${actualPatchPath}`);
  console.error(`    ${actualMdPath}`);
}
