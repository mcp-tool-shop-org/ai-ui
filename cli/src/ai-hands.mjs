// @ts-check
/**
 * ai-hands — Hands v0: PR-Ready Patch Generator
 *
 * Uses qwen2.5-coder (local Ollama) to generate find/replace edits that
 * improve surfacing, add data-aiui hooks, and fix copy gaps.
 *
 * Outputs:
 *   - hands.plan.md      (human-readable plan)
 *   - hands.patch.diff   (unified diff)
 *   - hands.files.json   (manifest of files touched)
 *   - hands.verify.md    (verification checklist)
 *
 * AI outputs proposals only. Never applies changes automatically.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fail } from './config.mjs';
import { loadDesignMapInputs, buildSurfaceInventory, buildFeatureMap } from './design-map.mjs';
import { checkOllamaAvailable, checkModelAvailable, OllamaError } from './ollama.mjs';
import { scanRepo, filterRelevantFiles, findNearLine, extractContextWindow } from './repo-scan.mjs';
import { buildUnifiedDiff, buildFilesManifest, validateEdit } from './git-diff.mjs';
import { buildCoderPrompt, parseCoderResponse, queryCoderForEdits, CoderParseError } from './ollama-coder.mjs';
import { rankEdits, rankSummary, filterByMinRank } from './edit-rank.mjs';

const VERSION = '1.0.0';

/** @typedef {import('./types.mjs').HandsTaskType} HandsTaskType */
/** @typedef {import('./types.mjs').HandsEdit} HandsEdit */
/** @typedef {import('./types.mjs').HandsPlan} HandsPlan */
/** @typedef {import('./types.mjs').HandsReport} HandsReport */

// =============================================================================
// Task Builders — each task type has its own context builder
// =============================================================================

/**
 * Build context for "add-aiui-hooks" task.
 * Identifies surfaces without data-aiui-safe attributes.
 * When Eyes annotations are available, uses them to locate specific elements in specific files.
 *
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @param {import('./types.mjs').EyesAnnotation[]} [eyesAnnotations]
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[], targets: { surfaceId: string, label: string, file: string, nearLine?: string }[] } | null}
 */
function buildHooksTaskContext(inventory, repoFiles, eyesAnnotations) {
  // Find surfaces that could benefit from data-aiui-safe hooks
  const safeSurfaces = [];
  const unsafeSurfaces = [];

  for (const [group, entries] of Object.entries(inventory.groups)) {
    for (const entry of entries) {
      if (entry.safety === 'safe') {
        safeSurfaces.push({ ...entry, location_group: group });
      } else {
        unsafeSurfaces.push({ ...entry, location_group: group });
      }
    }
  }

  if (unsafeSurfaces.length === 0 && safeSurfaces.length === 0) return null;

  // Build search keywords from surfaces — including Eyes icon guesses
  const surfaceKeywords = [];
  for (const s of [...unsafeSurfaces, ...safeSurfaces]) {
    if (s.label) surfaceKeywords.push(s.label);
    if (s.role) surfaceKeywords.push(s.role);
  }

  // Enrich with Eyes data: use icon_guess and nearby_context as search terms
  if (eyesAnnotations && eyesAnnotations.length > 0) {
    for (const ann of eyesAnnotations) {
      if (ann.icon_guess && ann.icon_guess !== 'none') surfaceKeywords.push(ann.icon_guess);
      if (ann.nearby_context) surfaceKeywords.push(ann.nearby_context);
      if (ann.visible_text) surfaceKeywords.push(ann.visible_text);
    }
  }

  // Add standard element keywords
  surfaceKeywords.push('button', 'onClick', 'href', 'data-aiui', '<a ', '<button');

  const relevant = filterRelevantFiles(repoFiles, surfaceKeywords, 10);
  if (relevant.length === 0) return null;

  // Build targeted "where-rendered" mapping: surface → file + nearLine
  /** @type {{ surfaceId: string, label: string, file: string, nearLine?: string }[]} */
  const targets = [];
  const allSurfaces = [...unsafeSurfaces.slice(0, 20)];

  for (const surface of allSurfaces) {
    // Search each relevant file for this surface's label or Eyes annotation
    const searchTerms = [surface.label];

    // Add Eyes-derived search terms for this surface
    if (eyesAnnotations) {
      const surfaceId = surface.linked_triggers?.[0] || `surface:${surface.route}|${surface.label}`;
      const ann = eyesAnnotations.find(a => a.surface_id === surfaceId);
      if (ann) {
        if (ann.icon_guess && ann.icon_guess !== 'none') searchTerms.push(ann.icon_guess);
        if (ann.visible_text) searchTerms.push(ann.visible_text);
      }
    }

    for (const term of searchTerms) {
      if (!term || term.length < 2) continue;
      for (const file of relevant) {
        const nearLine = findNearLine(file.content, term);
        if (nearLine) {
          targets.push({
            surfaceId: surface.linked_triggers?.[0] || `surface:${surface.route}|${surface.label}`,
            label: surface.label || term,
            file: file.path,
            nearLine,
          });
          break; // found the file for this surface, move on
        }
      }
      if (targets.some(t => t.label === (surface.label || term))) break; // already found
    }
  }

  // Window file contents around targets to reduce prompt size
  const windowedFiles = relevant.map(f => {
    const fileTargets = targets.filter(t => t.file === f.path);
    if (fileTargets.length > 0 && f.size > 2000) {
      // Window around the first target for this file
      const { windowed } = extractContextWindow(f.content, fileTargets[0].nearLine || fileTargets[0].label, 12);
      return { ...f, content: windowed };
    }
    return f;
  });

  const surfaceList = unsafeSurfaces.slice(0, 15).map(s => {
    const target = targets.find(t => t.label === s.label);
    const fileHint = target ? ` → found in \`${target.file}\`` : '';
    return `- "${s.label}" (${s.role}, ${s.location_group}, safety: ${s.safety})${fileHint}`;
  }).join('\n');

  return {
    description: `Add data-aiui-safe="true" attributes to interactive elements that are safe for automated testing. ` +
      `Found ${unsafeSurfaces.length} surface(s) without the safe attribute.` +
      (targets.length > 0 ? ` Located ${targets.length} target(s) in source files.` : ''),
    artifactContext: `## Surfaces needing hooks\n${surfaceList}\n\n` +
      `The data-aiui-safe attribute tells AI-UI's probe that this element is safe to click during automated crawling. ` +
      `Only add it to elements that perform non-destructive actions (navigation, toggling UI, opening dialogs).`,
    relevantFiles: windowedFiles,
    constraints: [
      'Only add data-aiui-safe="true" to elements that perform NON-DESTRUCTIVE actions',
      'Never add data-aiui-safe to delete, remove, reset, logout, or billing buttons',
      'Preserve existing attributes — add the new attribute alongside them',
      'If the element has dynamic behavior (e.g., conditional delete), do NOT add the attribute',
      'Use the exact line from "Edit Targets" as your anchor — copy it precisely',
    ],
    targets,
  };
}

/**
 * Build context for "surface-settings" task.
 * Identifies features that are documented but hard to find in the UI.
 *
 * @param {import('./types.mjs').DesignFeatureMap} featureMap
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[], targets: { surfaceId: string, label: string, file: string, nearLine?: string }[] } | null}
 */
function buildSurfaceSettingsContext(featureMap, repoFiles) {
  // Find features that are documented but poorly surfaced
  const needsSurfacing = featureMap.features.filter(f =>
    f.from_atlas && (
      f.recommended_action === 'promote' ||
      f.entry_points.length === 0 ||
      f.discoverability > 0.6
    )
  );

  if (needsSurfacing.length === 0) return null;

  // Gather keywords from feature names
  const keywords = needsSurfacing.flatMap(f =>
    f.feature_name.toLowerCase().split(/[\s\-_,.()/]+/).filter(w => w.length > 3)
  );

  const relevant = filterRelevantFiles(repoFiles, keywords, 10);
  if (relevant.length === 0) return null;

  // Build targets: locate features in source files
  /** @type {{ surfaceId: string, label: string, file: string, nearLine?: string }[]} */
  const targets = [];
  for (const feature of needsSurfacing.slice(0, 10)) {
    const searchTerms = [
      feature.feature_name,
      ...feature.entry_points.map(ep => ep.label),
    ].filter(Boolean);

    for (const term of searchTerms) {
      if (term.length < 3) continue;
      for (const file of relevant) {
        const nearLine = findNearLine(file.content, term);
        if (nearLine) {
          targets.push({
            surfaceId: feature.feature_id,
            label: term,
            file: file.path,
            nearLine,
          });
          break;
        }
      }
      if (targets.some(t => t.surfaceId === feature.feature_id)) break;
    }
  }

  // Window files around targets
  const windowedFiles = relevant.map(f => {
    const fileTargets = targets.filter(t => t.file === f.path);
    if (fileTargets.length > 0 && f.size > 2000) {
      const { windowed } = extractContextWindow(f.content, fileTargets[0].nearLine || fileTargets[0].label, 12);
      return { ...f, content: windowed };
    }
    return f;
  });

  const featureList = needsSurfacing.slice(0, 10).map(f => {
    const target = targets.find(t => t.surfaceId === f.feature_id);
    const fileHint = target ? ` → in \`${target.file}\`` : '';
    return `- "${f.feature_name}" (action: ${f.recommended_action}, entry points: ${f.entry_points.length}, discoverability: ${f.discoverability.toFixed(2)})${fileHint}`;
  }).join('\n');

  return {
    description: `Improve UI surfacing for ${needsSurfacing.length} feature(s) that are documented but hard to find. ` +
      `These features exist in the docs but lack prominent UI entry points.` +
      (targets.length > 0 ? ` Located ${targets.length} target(s) in source files.` : ''),
    artifactContext: `## Features needing better surfacing\n${featureList}\n\n` +
      `Each feature above is documented in the project README or docs, but users can't easily find it in the UI. ` +
      `Possible improvements: add aria-label, tooltip, or heading text that matches the documentation.`,
    relevantFiles: windowedFiles,
    constraints: [
      'Do NOT create new components or pages — only improve existing elements',
      'Add aria-label or title attributes to help discoverability',
      'Add data-aiui-goal attributes where a feature completion can be detected',
      'Keep changes minimal — one attribute addition per element at most',
      'Match the existing code style (indentation, quotes, semicolons)',
      'Use the exact line from "Edit Targets" as your anchor — copy it precisely',
    ],
    targets,
  };
}

/**
 * Build context for "goal-hooks" task.
 * Adds data-aiui-goal attributes to elements that represent task completion.
 *
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[], targets: { surfaceId: string, label: string, file: string, nearLine?: string }[] } | null}
 */
function buildGoalHooksContext(inventory, config, repoFiles) {
  const goalRules = config.goalRules || [];
  if (goalRules.length === 0) return null;

  const ruleList = goalRules.map(r =>
    `- id="${r.id}" label="${r.label}" kind=${r.kind}` +
    (r.dom?.textRegex ? ` textRegex="${r.dom.textRegex}"` : '') +
    (r.storage?.keyRegex ? ` keyRegex="${r.storage.keyRegex}"` : '')
  ).join('\n');

  // Find files likely to contain goal-related elements
  const keywords = goalRules.flatMap(r => [
    r.label,
    r.dom?.textRegex,
    r.id,
  ].filter(Boolean));

  const relevant = filterRelevantFiles(repoFiles, keywords, 10);
  if (relevant.length === 0) return null;

  // Build targets: locate goal-related elements
  /** @type {{ surfaceId: string, label: string, file: string, nearLine?: string }[]} */
  const targets = [];
  for (const rule of goalRules) {
    const searchTerms = [rule.label, rule.dom?.textRegex, rule.id].filter(Boolean);
    for (const term of searchTerms) {
      if (term.length < 2) continue;
      for (const file of relevant) {
        const nearLine = findNearLine(file.content, term);
        if (nearLine) {
          targets.push({
            surfaceId: `goal:${rule.id}`,
            label: rule.label,
            file: file.path,
            nearLine,
          });
          break;
        }
      }
      if (targets.some(t => t.surfaceId === `goal:${rule.id}`)) break;
    }
  }

  // Window files around targets
  const windowedFiles = relevant.map(f => {
    const fileTargets = targets.filter(t => t.file === f.path);
    if (fileTargets.length > 0 && f.size > 2000) {
      const { windowed } = extractContextWindow(f.content, fileTargets[0].nearLine || fileTargets[0].label, 12);
      return { ...f, content: windowed };
    }
    return f;
  });

  return {
    description: `Add data-aiui-goal attributes to elements that represent task completion for ${goalRules.length} configured goal rule(s).` +
      (targets.length > 0 ? ` Located ${targets.length} target(s) in source files.` : ''),
    artifactContext: `## Goal Rules\n${ruleList}\n\n` +
      `The data-aiui-goal attribute marks DOM elements that represent successful task completion. ` +
      `When AI-UI's probe sees this attribute, it can verify that a user workflow reached its intended goal.`,
    relevantFiles: windowedFiles,
    constraints: [
      'Add data-aiui-goal="<rule-id>" to elements that appear when the goal is achieved',
      'Common placements: success dialogs, confirmation panels, result displays',
      'Only add to elements that are shown AFTER the action completes, not to the trigger itself',
      'Preserve all existing attributes',
      'Use the exact line from "Edit Targets" as your anchor — copy it precisely',
    ],
    targets,
  };
}

/**
 * Build context for "copy-fix" task.
 * Identifies UI labels that don't match documentation terminology.
 *
 * @param {import('./types.mjs').DesignFeatureMap} featureMap
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[], targets: { surfaceId: string, label: string, file: string, nearLine?: string }[] } | null}
 */
function buildCopyFixContext(featureMap, inventory, repoFiles) {
  // Find features where the label doesn't match the doc name
  const mismatches = featureMap.features.filter(f =>
    f.from_atlas && f.recommended_action === 'rename' && f.entry_points.length > 0
  );

  if (mismatches.length === 0) return null;

  // Get keywords from mismatched labels
  const keywords = mismatches.flatMap(f => [
    ...f.entry_points.map(ep => ep.label),
    f.feature_name,
  ].filter(Boolean));

  const relevant = filterRelevantFiles(repoFiles, keywords, 10);
  if (relevant.length === 0) return null;

  // Build targets
  /** @type {{ surfaceId: string, label: string, file: string, nearLine?: string }[]} */
  const targets = [];
  for (const feature of mismatches.slice(0, 10)) {
    const entryLabel = feature.entry_points[0]?.label;
    if (!entryLabel || entryLabel.length < 2) continue;
    for (const file of relevant) {
      const nearLine = findNearLine(file.content, entryLabel);
      if (nearLine) {
        targets.push({
          surfaceId: feature.feature_id,
          label: entryLabel,
          file: file.path,
          nearLine,
        });
        break;
      }
    }
  }

  // Window files around targets
  const windowedFiles = relevant.map(f => {
    const fileTargets = targets.filter(t => t.file === f.path);
    if (fileTargets.length > 0 && f.size > 2000) {
      const { windowed } = extractContextWindow(f.content, fileTargets[0].nearLine || fileTargets[0].label, 12);
      return { ...f, content: windowed };
    }
    return f;
  });

  const mismatchList = mismatches.slice(0, 10).map(f => {
    const entryLabel = f.entry_points[0]?.label || '(unknown)';
    const target = targets.find(t => t.surfaceId === f.feature_id);
    const fileHint = target ? ` → in \`${target.file}\`` : '';
    return `- Doc name: "${f.feature_name}" → UI label: "${entryLabel}" (action: rename)${fileHint}`;
  }).join('\n');

  return {
    description: `Fix ${mismatches.length} UI label(s) that don't match the documented feature names. ` +
      `Consistent terminology improves discoverability.` +
      (targets.length > 0 ? ` Located ${targets.length} target(s) in source files.` : ''),
    artifactContext: `## Label mismatches\n${mismatchList}\n\n` +
      `The documentation uses specific names for features, but the UI uses different labels. ` +
      `Aligning UI labels with documentation helps users find features mentioned in docs.`,
    relevantFiles: windowedFiles,
    constraints: [
      'Only rename labels where the doc name is clearly better for the user',
      'Preserve meaning — if the current label is more descriptive, skip it',
      'Update aria-label and title attributes if they exist',
      'Do NOT rename variables or function names — only user-facing text',
      'Match the existing quote style (single vs double) in the file',
      'Use the exact line from "Edit Targets" as your anchor — copy it precisely',
    ],
    targets,
  };
}

// =============================================================================
// Plan and Report Builders
// =============================================================================

/**
 * Render the plan as markdown with ranked edit groups.
 *
 * @param {HandsReport} report
 * @returns {string}
 */
function renderPlanMd(report) {
  const lines = [
    `# AI Hands Plan`,
    ``,
    `**Model:** ${report.model}`,
    `**Generated:** ${report.generated_at}`,
    `**Repo:** ${report.repo_root}`,
    `**Total edits:** ${report.stats.total_edits}`,
    `**Files touched:** ${report.stats.files_touched}`,
    `**Proposal-only:** ${report.stats.proposal_only_count}`,
    `**Avg confidence:** ${(report.stats.avg_confidence * 100).toFixed(1)}%`,
  ];

  if (report.stats.rank_summary) {
    lines.push(`**Rank:** ${report.stats.rank_summary}`);
  }

  lines.push(``);

  for (const plan of report.plans) {
    lines.push(`## Task: ${plan.task}`);
    lines.push(``);
    lines.push(plan.description);
    lines.push(``);

    if (plan.edits.length > 0) {
      // Check if edits have rank metadata
      const hasRanks = plan.edits.some(e => /** @type {any} */ (e).rank);

      if (hasRanks) {
        // Group edits by rank bucket for display
        const ranked = /** @type {import('./edit-rank.mjs').RankedEdit[]} */ (plan.edits);
        const high = ranked.filter(e => e.rank.rank_bucket === 'high');
        const medium = ranked.filter(e => e.rank.rank_bucket === 'medium');
        const low = ranked.filter(e => e.rank.rank_bucket === 'low');

        if (plan.rank_summary) {
          lines.push(`**Rank:** ${plan.rank_summary}`);
          lines.push(``);
        }

        // Render each bucket — with risk indicator for high-risk edits
        for (const [bucket, label, items] of /** @type {[string, string, typeof ranked][]} */ ([
          ['high', 'High confidence', high],
          ['medium', 'Medium confidence', medium],
          ['low', 'Low confidence', low],
        ])) {
          if (items.length === 0) continue;
          lines.push(`### ${label} (${items.length})`);
          lines.push(``);
          for (const edit of items) {
            const reasons = edit.rank.rank_reasons.filter(r => !r.startsWith('validated') && !r.startsWith('proposal')).slice(0, 3).join(', ');
            const validTag = edit.proposal_only ? 'proposal' : 'validated';
            const riskTag = edit.rank.risk_level === 'high' ? ' ⚠️ high-risk' : edit.rank.risk_level === 'med' ? ' ⚠️ med-risk' : '';
            lines.push(`- **Edit #${ranked.indexOf(edit) + 1}** — \`${edit.file}\`: ${edit.rationale.slice(0, 60)} _(${validTag}, score=${edit.rank.rank_score.toFixed(2)}${riskTag}${reasons ? ', ' + reasons : ''})_`);
          }
          lines.push(``);
        }

        // Also render the full table for reference
        lines.push(`### All Edits (${plan.edits.length})`);
        lines.push(``);
        lines.push(`| # | File | Confidence | Rank | Bucket | Risk | Proposal Only | Rationale |`);
        lines.push(`|---|------|-----------|------|--------|------|---------------|-----------|`);
        for (let i = 0; i < ranked.length; i++) {
          const edit = ranked[i];
          const conf = (edit.confidence * 100).toFixed(0) + '%';
          const proposal = edit.proposal_only ? '⚠ yes' : '✓ no';
          const score = edit.rank.rank_score.toFixed(2);
          lines.push(`| ${i + 1} | ${edit.file} | ${conf} | ${score} | ${edit.rank.rank_bucket} | ${edit.rank.risk_level} | ${proposal} | ${edit.rationale.slice(0, 50)} |`);
        }
        lines.push(``);
      } else {
        // Fallback: no ranking (backward compat)
        lines.push(`### Edits (${plan.edits.length})`);
        lines.push(``);
        lines.push(`| File | Confidence | Proposal Only | Rationale |`);
        lines.push(`|------|-----------|---------------|-----------|`);
        for (const edit of plan.edits) {
          const conf = (edit.confidence * 100).toFixed(0) + '%';
          const proposal = edit.proposal_only ? '⚠ yes' : '✓ no';
          lines.push(`| ${edit.file} | ${conf} | ${proposal} | ${edit.rationale.slice(0, 60)} |`);
        }
        lines.push(``);
      }
    } else {
      lines.push(`_No edits generated for this task._`);
      lines.push(``);
    }

    if (plan.risks.length > 0) {
      lines.push(`### Risks`);
      lines.push(``);
      for (const risk of plan.risks) {
        lines.push(`- ⚠ ${risk}`);
      }
      lines.push(``);
    }

    if (plan.verify_commands.length > 0) {
      lines.push(`### Verification`);
      lines.push(``);
      for (const cmd of plan.verify_commands) {
        lines.push(`\`\`\`bash`);
        lines.push(cmd);
        lines.push(`\`\`\``);
      }
      lines.push(``);
    }

    if (plan.expected_deltas.length > 0) {
      lines.push(`### Expected improvements`);
      lines.push(``);
      for (const delta of plan.expected_deltas) {
        lines.push(`- ${delta}`);
      }
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`> **This plan was generated by AI and has NOT been applied.** Review each edit carefully before applying.`);
  lines.push(`> Apply the patch with: \`git apply hands.patch.diff\``);

  return lines.join('\n');
}

/**
 * Render a verification checklist.
 *
 * @param {HandsReport} report
 * @returns {string}
 */
function renderVerifyMd(report) {
  const lines = [
    `# AI Hands Verification Checklist`,
    ``,
    `Generated: ${report.generated_at}`,
    `Model: ${report.model}`,
    ``,
    `## Pre-apply checks`,
    ``,
    `- [ ] Read through \`hands.plan.md\` — every edit makes sense`,
    `- [ ] Review \`hands.patch.diff\` — no unintended changes`,
    `- [ ] \`hands.files.json\` — all listed files are expected`,
    ``,
    `## Apply`,
    ``,
    `\`\`\`bash`,
    `git apply hands.patch.diff`,
    `\`\`\``,
    ``,
    `## Post-apply checks`,
    ``,
  ];

  // Per-plan verification
  for (const plan of report.plans) {
    lines.push(`### ${plan.task}`);
    lines.push(``);
    for (const cmd of plan.verify_commands) {
      lines.push(`- [ ] Run: \`${cmd}\``);
    }
    for (const delta of plan.expected_deltas) {
      lines.push(`- [ ] Verify: ${delta}`);
    }
    if (plan.risks.length > 0) {
      lines.push(``);
      lines.push(`**Risks to watch for:**`);
      for (const risk of plan.risks) {
        lines.push(`- ${risk}`);
      }
    }
    lines.push(``);
  }

  // Proposal-only warnings
  const proposalEdits = report.plans.flatMap(p => p.edits).filter(e => e.proposal_only);
  if (proposalEdits.length > 0) {
    lines.push(`## ⚠ Proposal-only edits (need manual review)`);
    lines.push(``);
    lines.push(`The following edits have low confidence and contain TODO markers:`);
    lines.push(``);
    for (const edit of proposalEdits) {
      lines.push(`- [ ] **${edit.file}** — ${edit.rationale} (confidence: ${(edit.confidence * 100).toFixed(0)}%)`);
    }
    lines.push(``);
  }

  lines.push(`## Final`);
  lines.push(``);
  lines.push(`- [ ] All tests pass`);
  lines.push(`- [ ] Dev server runs without errors`);
  lines.push(`- [ ] Re-run \`ai-ui design-map\` to verify metric improvements`);

  return lines.join('\n');
}

// =============================================================================
// Ranked Manifest Builder
// =============================================================================

/**
 * Build files.json manifest enriched with rank data.
 * Falls back to basic manifest if edits have no rank metadata.
 *
 * @param {import('./types.mjs').HandsEdit[]} edits
 * @returns {{ path: string, edits: number, lines_added: number, lines_removed: number, proposal_only: boolean, rank_score?: number, rank_bucket?: string, rank_reasons?: string[] }[]}
 */
function buildRankedManifest(edits) {
  /** @type {Map<string, { edits: number, linesAdded: number, linesRemoved: number, proposalOnly: boolean, rankScores: number[], rankBuckets: string[], rankReasons: string[] }>} */
  const byFile = new Map();

  for (const edit of edits) {
    const existing = byFile.get(edit.file) || { edits: 0, linesAdded: 0, linesRemoved: 0, proposalOnly: true, rankScores: [], rankBuckets: [], rankReasons: [] };
    existing.edits++;
    existing.linesRemoved += edit.find.split('\n').length;
    existing.linesAdded += edit.replace.split('\n').length;
    if (!edit.proposal_only) existing.proposalOnly = false;

    // Add rank data if present
    const ranked = /** @type {any} */ (edit);
    if (ranked.rank) {
      existing.rankScores.push(ranked.rank.rank_score);
      existing.rankBuckets.push(ranked.rank.rank_bucket);
      existing.rankReasons.push(...ranked.rank.rank_reasons);
    }

    byFile.set(edit.file, existing);
  }

  return [...byFile.entries()].map(([path, data]) => {
    const base = {
      path,
      edits: data.edits,
      lines_added: data.linesAdded,
      lines_removed: data.linesRemoved,
      proposal_only: data.proposalOnly,
    };

    // Add rank metadata if we have scores
    if (data.rankScores.length > 0) {
      const avgScore = data.rankScores.reduce((a, b) => a + b, 0) / data.rankScores.length;
      // Best bucket from the file's edits
      const bestBucket = data.rankBuckets.includes('high') ? 'high' :
        data.rankBuckets.includes('medium') ? 'medium' : 'low';
      // Deduplicate reasons
      const uniqueReasons = [...new Set(data.rankReasons)];
      return { ...base, rank_score: Math.round(avgScore * 100) / 100, rank_bucket: bestBucket, rank_reasons: uniqueReasons };
    }

    return base;
  });
}

// =============================================================================
// Main Command Handler
// =============================================================================

/**
 * Main command handler for ai-hands.
 *
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ from?: string, out?: string, replay?: string, verbose?: boolean, dryRun?: boolean, model?: string, repo?: string, tasks?: string, minRank?: number }} flags
 */
export async function runAiHands(config, flags) {
  const cwd = process.cwd();
  const handsConfig = config.aiHands || {
    model: 'qwen2.5-coder:7b',
    timeout: 120000,
    maxFileSize: 50000,
    allowExtensions: ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.ts', '.js', '.css'],
  };
  const model = flags.model || handsConfig.model;
  const timeout = handsConfig.timeout;
  const repoRoot = flags.repo ? resolve(flags.repo) : cwd;

  // Parse task filter
  /** @type {HandsTaskType[]} */
  const ALL_TASKS = ['add-aiui-hooks', 'surface-settings', 'goal-hooks', 'copy-fix'];
  /** @type {HandsTaskType[]} */
  let requestedTasks = ALL_TASKS;
  if (flags.tasks) {
    requestedTasks = /** @type {HandsTaskType[]} */ (
      flags.tasks.split(',').map(t => t.trim()).filter(t => ALL_TASKS.includes(/** @type {any} */ (t)))
    );
    if (requestedTasks.length === 0) {
      fail('HANDS_BAD_TASKS', `No valid tasks in: ${flags.tasks}`, `Valid tasks: ${ALL_TASKS.join(', ')}`);
    }
  }

  // 1. Pre-flight: check Ollama
  if (!flags.dryRun) {
    console.error('Checking Ollama availability...');
    const available = await checkOllamaAvailable();
    if (!available) {
      fail('HANDS_NO_OLLAMA', 'Ollama is not running', 'Start Ollama with: ollama serve');
    }

    const modelReady = await checkModelAvailable(model);
    if (!modelReady) {
      fail('HANDS_NO_MODEL', `Model "${model}" is not available`, `Pull it with: ollama pull ${model}`);
    }
    console.error(`Ollama ready: model=${model}`);
  }

  // 2. Load design-map artifacts
  console.error('Loading design-map artifacts...');
  const inputs = loadDesignMapInputs(config, cwd, { replay: flags.replay, verbose: flags.verbose });
  const inventory = buildSurfaceInventory(inputs.graph, inputs.diff, inputs.coverage);
  const featureMap = buildFeatureMap(inputs.graph, inputs.diff, inputs.coverage, inputs.atlas);

  // 3. Scan repo for source files
  console.error(`Scanning repo at ${repoRoot}...`);
  const repoFiles = scanRepo(repoRoot, {
    allowExtensions: handsConfig.allowExtensions,
    maxFileSize: handsConfig.maxFileSize,
    verbose: flags.verbose,
  });

  if (repoFiles.length === 0) {
    console.error('No editable source files found in repo.');
    console.error(`  Extensions: ${handsConfig.allowExtensions.join(', ')}`);
    console.error(`  Max size: ${handsConfig.maxFileSize} bytes`);
    return;
  }
  console.error(`Found ${repoFiles.length} editable source file(s).`);

  // 3b. Load Eyes annotations if available (for targeted hooks)
  /** @type {import('./types.mjs').EyesAnnotation[]} */
  let eyesAnnotations = [];
  const eyesPath = resolve(cwd, config.output.aiEyesJson);
  if (existsSync(eyesPath)) {
    try {
      /** @type {import('./types.mjs').AiEyesReport} */
      const eyesReport = JSON.parse(readFileSync(eyesPath, 'utf-8'));
      eyesAnnotations = eyesReport.annotations.filter(a => a.confidence > 0);
      console.error(`Loaded ${eyesAnnotations.length} Eyes annotation(s) for targeting.`);
    } catch (err) {
      console.error(`  (Eyes data not loaded: ${err.message})`);
    }
  }

  // 4. Build task contexts
  /** @type {{ task: HandsTaskType, context: { description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[], targets?: { surfaceId: string, label: string, file: string, nearLine?: string }[] } }[]} */
  const taskContexts = [];

  for (const task of requestedTasks) {
    let context = null;
    switch (task) {
      case 'add-aiui-hooks':
        context = buildHooksTaskContext(inventory, repoFiles, eyesAnnotations);
        break;
      case 'surface-settings':
        context = buildSurfaceSettingsContext(featureMap, repoFiles);
        break;
      case 'goal-hooks':
        context = buildGoalHooksContext(inventory, config, repoFiles);
        break;
      case 'copy-fix':
        context = buildCopyFixContext(featureMap, inventory, repoFiles);
        break;
    }

    if (context) {
      taskContexts.push({ task, context });
      console.error(`  ✓ ${task}: ${context.relevantFiles.length} relevant file(s)`);
    } else {
      console.error(`  — ${task}: not applicable (no matching surfaces/features)`);
    }
  }

  if (taskContexts.length === 0) {
    console.error('\nNo applicable tasks found. The codebase may already be well-instrumented.');
    return;
  }

  // 5. Query coder model for each task
  /** @type {HandsPlan[]} */
  const plans = [];
  let totalEdits = 0;
  let totalErrors = 0;

  for (let i = 0; i < taskContexts.length; i++) {
    const { task, context } = taskContexts[i];
    console.error(`\n[${i + 1}/${taskContexts.length}] ${task}...`);

    /** @type {HandsEdit[]} */
    let edits = [];

    if (flags.dryRun) {
      console.error(`  (dry run — skipping Ollama query)`);
    } else {
      try {
        const fileContext = context.relevantFiles.map(f => ({
          path: f.path,
          language: f.language,
          content: f.content,
        }));

        const coderEdits = await queryCoderForEdits({
          task,
          description: context.description,
          fileContext,
          artifactContext: context.artifactContext,
          constraints: context.constraints,
          targets: context.targets,
        }, { model, timeout, verbose: flags.verbose });

        // Convert coder edits to HandsEdit format + validate
        for (const ce of coderEdits) {
          const sourceFile = context.relevantFiles.find(f => f.path === ce.file);
          if (!sourceFile) continue;

          const validation = validateEdit(sourceFile.content, ce.find);
          const isProposal = ce.confidence < 0.5 || !validation.valid;

          if (!validation.valid && flags.verbose) {
            console.error(`    ⚠ edit for ${ce.file}: find string has ${validation.occurrences} occurrences (expected 1)`);
          }

          edits.push({
            file: ce.file,
            find: ce.find,
            replace: ce.replace,
            rationale: ce.rationale,
            artifact_trigger: `${task}: ${context.description.slice(0, 80)}`,
            confidence: ce.confidence,
            proposal_only: isProposal,
          });
        }

        console.error(`  → ${edits.length} edit(s) generated`);
      } catch (err) {
        if (err instanceof OllamaError || err instanceof CoderParseError) {
          console.error(`  ⚠ ${err.message}`);
          if (err instanceof OllamaError && err.hint) console.error(`    ${err.hint}`);
          totalErrors++;
        } else {
          throw err;
        }
      }
    }

    totalEdits += edits.length;

    // Build verification commands and expected deltas based on task type
    const verifyCommands = [];
    const expectedDeltas = [];
    const risks = [];

    switch (task) {
      case 'add-aiui-hooks':
        verifyCommands.push('npx ai-ui probe', 'npx ai-ui runtime-coverage --actions');
        expectedDeltas.push('runtime-coverage: more surfaces marked as "safe"');
        risks.push('Over-marking destructive buttons as safe could allow probe to trigger harmful actions');
        break;
      case 'surface-settings':
        verifyCommands.push('npx ai-ui design-map', 'npx ai-ui diff');
        expectedDeltas.push('diff: fewer orphan features', 'feature-map: lower discoverability scores');
        risks.push('Changed labels may confuse existing users');
        break;
      case 'goal-hooks':
        verifyCommands.push('npx ai-ui design-map', 'npx ai-ui runtime-effects');
        expectedDeltas.push('task-flows: more goals detected', 'conversion-paths: higher goal_reached_count');
        risks.push('Incorrect goal placement may cause false positives in flow detection');
        break;
      case 'copy-fix':
        verifyCommands.push('npx ai-ui diff', 'npx ai-ui ai-suggest');
        expectedDeltas.push('diff: fewer rename recommendations', 'ai-suggest: higher match confidence');
        risks.push('Renaming labels may break existing tests or screenshots');
        break;
    }

    // 5b. Rank edits for this task
    /** @type {import('./edit-rank.mjs').RankedEdit[]} */
    let rankedEdits = [];
    if (edits.length > 0) {
      // Build file contents map from the relevant files
      const fileContentsMap = new Map(context.relevantFiles.map(f => [f.path, f.content]));

      // Build provenance for ranking
      /** @type {import('./edit-rank.mjs').RankProvenance} */
      const provenance = {
        fileContents: fileContentsMap,
        targets: context.targets || [],
        eyesAnnotations: task === 'add-aiui-hooks' ? eyesAnnotations : [],
        goalRuleIds: (config.goalRules || []).map(r => r.id),
      };

      rankedEdits = rankEdits(edits, fileContentsMap, provenance);

      if (flags.verbose) {
        const summary = rankSummary(rankedEdits);
        console.error(`    rank: ${summary}`);
      }

      // Apply --min-rank filter if specified
      if (typeof flags.minRank === 'number' && flags.minRank > 0) {
        const { kept, dropped } = filterByMinRank(rankedEdits, flags.minRank);
        if (dropped > 0) {
          console.error(`    --min-rank ${flags.minRank}: kept ${kept.length}, dropped ${dropped}`);
        }
        rankedEdits = kept;
        totalEdits -= dropped; // adjust total count
      }
    }

    const taskRankSummaryStr = rankedEdits.length > 0 ? rankSummary(rankedEdits) : undefined;

    plans.push({
      task,
      description: context.description,
      edits: rankedEdits.length > 0 ? rankedEdits : edits, // use ranked order
      risks,
      verify_commands: verifyCommands,
      expected_deltas: expectedDeltas,
      rank_summary: taskRankSummaryStr,
    });
  }

  // 6. Assemble report
  const allEdits = plans.flatMap(p => p.edits);
  const filesManifest = buildFilesManifest(allEdits);
  const confidences = allEdits.filter(e => e.confidence > 0).map(e => e.confidence);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  // Build overall rank summary
  const allRanked = /** @type {import('./edit-rank.mjs').RankedEdit[]} */ (
    allEdits.filter(e => /** @type {any} */ (e).rank)
  );
  const overallRankSummaryStr = allRanked.length > 0 ? rankSummary(allRanked) : undefined;

  /** @type {HandsReport} */
  const report = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    model,
    repo_root: repoRoot,
    plans,
    stats: {
      total_edits: totalEdits,
      files_touched: filesManifest.length,
      proposal_only_count: allEdits.filter(e => e.proposal_only).length,
      avg_confidence: avgConfidence,
      rank_summary: overallRankSummaryStr,
    },
  };

  // 7. Write outputs — build enriched manifest with rank data
  const outDir = flags.out || dirname(resolve(cwd, config.output.aiHandsPlanMd));
  mkdirSync(outDir, { recursive: true });

  const planPath = flags.out ? join(flags.out, 'hands.plan.md') : resolve(cwd, config.output.aiHandsPlanMd);
  const diffPath = flags.out ? join(flags.out, 'hands.patch.diff') : resolve(cwd, config.output.aiHandsPatchDiff);
  const filesPath = flags.out ? join(flags.out, 'hands.files.json') : resolve(cwd, config.output.aiHandsFilesJson);
  const verifyPath = flags.out ? join(flags.out, 'hands.verify.md') : resolve(cwd, config.output.aiHandsVerifyMd);

  writeFileSync(planPath, renderPlanMd(report));
  writeFileSync(diffPath, buildUnifiedDiff(allEdits)); // edits already in rank order
  writeFileSync(filesPath, JSON.stringify(buildRankedManifest(allEdits), null, 2));
  writeFileSync(verifyPath, renderVerifyMd(report));

  // 8. Summary
  console.error(`\n✓ AI Hands complete`);
  console.error(`  Model: ${model}`);
  console.error(`  Tasks: ${plans.length}`);
  console.error(`  Total edits: ${totalEdits}`);
  console.error(`  Files touched: ${filesManifest.length}`);
  console.error(`  Proposal-only: ${report.stats.proposal_only_count}`);
  console.error(`  Avg confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  if (overallRankSummaryStr) {
    console.error(`  Rank: ${overallRankSummaryStr}`);
  }
  console.error(`  Errors: ${totalErrors}`);
  console.error(`\n  Outputs:`);
  console.error(`    ${planPath}`);
  console.error(`    ${diffPath}`);
  console.error(`    ${filesPath}`);
  console.error(`    ${verifyPath}`);
  console.error(`\n  ⚠ Review the plan before applying: cat ${planPath}`);
  console.error(`  Apply with: git apply ${diffPath}`);
}
