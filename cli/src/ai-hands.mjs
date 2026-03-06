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
import { scanRepo, filterRelevantFiles } from './repo-scan.mjs';
import { buildUnifiedDiff, buildFilesManifest, validateEdit } from './git-diff.mjs';
import { buildCoderPrompt, parseCoderResponse, queryCoderForEdits, CoderParseError } from './ollama-coder.mjs';

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
 *
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[] } | null}
 */
function buildHooksTaskContext(inventory, repoFiles) {
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

  // Find files that contain button/link elements
  const keywords = ['button', 'onClick', 'href', 'data-aiui', '<a ', '<button'];
  const relevant = filterRelevantFiles(repoFiles, keywords, 10);
  if (relevant.length === 0) return null;

  const surfaceList = unsafeSurfaces.slice(0, 15).map(s =>
    `- "${s.label}" (${s.role}, ${s.location_group}, safety: ${s.safety})`
  ).join('\n');

  return {
    description: `Add data-aiui-safe="true" attributes to interactive elements that are safe for automated testing. ` +
      `Found ${unsafeSurfaces.length} surface(s) without the safe attribute.`,
    artifactContext: `## Surfaces needing hooks\n${surfaceList}\n\n` +
      `The data-aiui-safe attribute tells AI-UI's probe that this element is safe to click during automated crawling. ` +
      `Only add it to elements that perform non-destructive actions (navigation, toggling UI, opening dialogs).`,
    relevantFiles: relevant,
    constraints: [
      'Only add data-aiui-safe="true" to elements that perform NON-DESTRUCTIVE actions',
      'Never add data-aiui-safe to delete, remove, reset, logout, or billing buttons',
      'Preserve existing attributes — add the new attribute alongside them',
      'If the element has dynamic behavior (e.g., conditional delete), do NOT add the attribute',
    ],
  };
}

/**
 * Build context for "surface-settings" task.
 * Identifies features that are documented but hard to find in the UI.
 *
 * @param {import('./types.mjs').DesignFeatureMap} featureMap
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[] } | null}
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

  const featureList = needsSurfacing.slice(0, 10).map(f =>
    `- "${f.feature_name}" (action: ${f.recommended_action}, entry points: ${f.entry_points.length}, discoverability: ${f.discoverability.toFixed(2)})`
  ).join('\n');

  // Gather keywords from feature names
  const keywords = needsSurfacing.flatMap(f =>
    f.feature_name.toLowerCase().split(/[\s\-_,.()/]+/).filter(w => w.length > 3)
  );

  const relevant = filterRelevantFiles(repoFiles, keywords, 10);
  if (relevant.length === 0) return null;

  return {
    description: `Improve UI surfacing for ${needsSurfacing.length} feature(s) that are documented but hard to find. ` +
      `These features exist in the docs but lack prominent UI entry points.`,
    artifactContext: `## Features needing better surfacing\n${featureList}\n\n` +
      `Each feature above is documented in the project README or docs, but users can't easily find it in the UI. ` +
      `Possible improvements: add aria-label, tooltip, or heading text that matches the documentation.`,
    relevantFiles: relevant,
    constraints: [
      'Do NOT create new components or pages — only improve existing elements',
      'Add aria-label or title attributes to help discoverability',
      'Add data-aiui-goal attributes where a feature completion can be detected',
      'Keep changes minimal — one attribute addition per element at most',
      'Match the existing code style (indentation, quotes, semicolons)',
    ],
  };
}

/**
 * Build context for "goal-hooks" task.
 * Adds data-aiui-goal attributes to elements that represent task completion.
 *
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[] } | null}
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

  return {
    description: `Add data-aiui-goal attributes to elements that represent task completion for ${goalRules.length} configured goal rule(s).`,
    artifactContext: `## Goal Rules\n${ruleList}\n\n` +
      `The data-aiui-goal attribute marks DOM elements that represent successful task completion. ` +
      `When AI-UI's probe sees this attribute, it can verify that a user workflow reached its intended goal.`,
    relevantFiles: relevant,
    constraints: [
      'Add data-aiui-goal="<rule-id>" to elements that appear when the goal is achieved',
      'Common placements: success dialogs, confirmation panels, result displays',
      'Only add to elements that are shown AFTER the action completes, not to the trigger itself',
      'Preserve all existing attributes',
    ],
  };
}

/**
 * Build context for "copy-fix" task.
 * Identifies UI labels that don't match documentation terminology.
 *
 * @param {import('./types.mjs').DesignFeatureMap} featureMap
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {import('./types.mjs').ScannedFile[]} repoFiles
 * @returns {{ description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[] } | null}
 */
function buildCopyFixContext(featureMap, inventory, repoFiles) {
  // Find features where the label doesn't match the doc name
  const mismatches = featureMap.features.filter(f =>
    f.from_atlas && f.recommended_action === 'rename' && f.entry_points.length > 0
  );

  if (mismatches.length === 0) return null;

  const mismatchList = mismatches.slice(0, 10).map(f => {
    const entryLabel = f.entry_points[0]?.label || '(unknown)';
    return `- Doc name: "${f.feature_name}" → UI label: "${entryLabel}" (action: rename)`;
  }).join('\n');

  // Get keywords from mismatched labels
  const keywords = mismatches.flatMap(f => [
    ...f.entry_points.map(ep => ep.label),
    f.feature_name,
  ].filter(Boolean));

  const relevant = filterRelevantFiles(repoFiles, keywords, 10);
  if (relevant.length === 0) return null;

  return {
    description: `Fix ${mismatches.length} UI label(s) that don't match the documented feature names. ` +
      `Consistent terminology improves discoverability.`,
    artifactContext: `## Label mismatches\n${mismatchList}\n\n` +
      `The documentation uses specific names for features, but the UI uses different labels. ` +
      `Aligning UI labels with documentation helps users find features mentioned in docs.`,
    relevantFiles: relevant,
    constraints: [
      'Only rename labels where the doc name is clearly better for the user',
      'Preserve meaning — if the current label is more descriptive, skip it',
      'Update aria-label and title attributes if they exist',
      'Do NOT rename variables or function names — only user-facing text',
      'Match the existing quote style (single vs double) in the file',
    ],
  };
}

// =============================================================================
// Plan and Report Builders
// =============================================================================

/**
 * Render the plan as markdown.
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
    ``,
  ];

  for (const plan of report.plans) {
    lines.push(`## Task: ${plan.task}`);
    lines.push(``);
    lines.push(plan.description);
    lines.push(``);

    if (plan.edits.length > 0) {
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
// Main Command Handler
// =============================================================================

/**
 * Main command handler for ai-hands.
 *
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ from?: string, out?: string, replay?: string, verbose?: boolean, dryRun?: boolean, model?: string, repo?: string, tasks?: string }} flags
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

  // 4. Build task contexts
  /** @type {{ task: HandsTaskType, context: { description: string, artifactContext: string, relevantFiles: import('./types.mjs').ScannedFile[], constraints: string[] } }[]} */
  const taskContexts = [];

  for (const task of requestedTasks) {
    let context = null;
    switch (task) {
      case 'add-aiui-hooks':
        context = buildHooksTaskContext(inventory, repoFiles);
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

    plans.push({
      task,
      description: context.description,
      edits,
      risks,
      verify_commands: verifyCommands,
      expected_deltas: expectedDeltas,
    });
  }

  // 6. Assemble report
  const allEdits = plans.flatMap(p => p.edits);
  const filesManifest = buildFilesManifest(allEdits);
  const confidences = allEdits.filter(e => e.confidence > 0).map(e => e.confidence);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

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
    },
  };

  // 7. Write outputs
  const outDir = flags.out || dirname(resolve(cwd, config.output.aiHandsPlanMd));
  mkdirSync(outDir, { recursive: true });

  const planPath = flags.out ? join(flags.out, 'hands.plan.md') : resolve(cwd, config.output.aiHandsPlanMd);
  const diffPath = flags.out ? join(flags.out, 'hands.patch.diff') : resolve(cwd, config.output.aiHandsPatchDiff);
  const filesPath = flags.out ? join(flags.out, 'hands.files.json') : resolve(cwd, config.output.aiHandsFilesJson);
  const verifyPath = flags.out ? join(flags.out, 'hands.verify.md') : resolve(cwd, config.output.aiHandsVerifyMd);

  writeFileSync(planPath, renderPlanMd(report));
  writeFileSync(diffPath, buildUnifiedDiff(allEdits));
  writeFileSync(filesPath, JSON.stringify(filesManifest, null, 2));
  writeFileSync(verifyPath, renderVerifyMd(report));

  // 8. Summary
  console.error(`\n✓ AI Hands complete`);
  console.error(`  Model: ${model}`);
  console.error(`  Tasks: ${plans.length}`);
  console.error(`  Total edits: ${totalEdits}`);
  console.error(`  Files touched: ${filesManifest.length}`);
  console.error(`  Proposal-only: ${report.stats.proposal_only_count}`);
  console.error(`  Avg confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  console.error(`  Errors: ${totalErrors}`);
  console.error(`\n  Outputs:`);
  console.error(`    ${planPath}`);
  console.error(`    ${diffPath}`);
  console.error(`    ${filesPath}`);
  console.error(`    ${verifyPath}`);
  console.error(`\n  ⚠ Review the plan before applying: cat ${planPath}`);
  console.error(`  Apply with: git apply ${diffPath}`);
}
