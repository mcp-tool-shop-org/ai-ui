// @ts-check
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { loadReplayPack, stableStringify } from './replay-pack.mjs';

// =============================================================================
// diffManifests — compare two pack manifests
// =============================================================================

/**
 * Compare two replay manifests.
 * @param {import('./types.mjs').ReplayManifest} a
 * @param {import('./types.mjs').ReplayManifest} b
 * @returns {import('./types.mjs').ManifestDiff}
 */
export function diffManifests(a, b) {
  return {
    tool_version: {
      a: a.tool.version,
      b: b.tool.version,
      match: a.tool.version === b.tool.version,
    },
    verify_config_hash: {
      a: a.config_snapshot.verify_config_hash,
      b: b.config_snapshot.verify_config_hash,
      match: a.config_snapshot.verify_config_hash === b.config_snapshot.verify_config_hash,
    },
    safe_config_hash: {
      a: a.config_snapshot.safe_config_hash,
      b: b.config_snapshot.safe_config_hash,
      match: a.config_snapshot.safe_config_hash === b.config_snapshot.safe_config_hash,
    },
    coverage_gate: {
      a: a.config_snapshot.coverage_gate,
      b: b.config_snapshot.coverage_gate,
      match: stableStringify(a.config_snapshot.coverage_gate) === stableStringify(b.config_snapshot.coverage_gate),
    },
    created_at: {
      a: a.created_at,
      b: b.created_at,
    },
  };
}

// =============================================================================
// diffCoverage — compare coverage reports
// =============================================================================

/**
 * @param {number} a
 * @param {number} b
 * @returns {import('./types.mjs').ScalarDelta}
 */
function scalar(a, b) {
  return { a, b, change: b - a };
}

/**
 * Compare two coverage reports from replay packs.
 * @param {any} covA - runtimeCoverage artifact from pack A
 * @param {any} covB - runtimeCoverage artifact from pack B
 * @returns {import('./types.mjs').CoverageDelta}
 */
export function diffCoverage(covA, covB) {
  const sumA = covA?.summary || {};
  const sumB = covB?.summary || {};

  // Build trigger maps
  /** @type {Map<string, any>} */
  const triggersA = new Map();
  for (const t of (covA?.triggers || [])) triggersA.set(t.trigger_id, t);
  /** @type {Map<string, any>} */
  const triggersB = new Map();
  for (const t of (covB?.triggers || [])) triggersB.set(t.trigger_id, t);

  // Find status transitions
  const allIds = new Set([...triggersA.keys(), ...triggersB.keys()]);
  /** @type {import('./types.mjs').TriggerStatusTransition[]} */
  const transitions = [];
  for (const id of allIds) {
    const tA = triggersA.get(id);
    const tB = triggersB.get(id);
    const statusA = tA?.status || null;
    const statusB = tB?.status || null;
    if (statusA !== statusB) {
      transitions.push({
        trigger_id: id,
        label: tB?.label || tA?.label || '',
        route: tB?.route || tA?.route || '',
        status_a: statusA,
        status_b: statusB,
      });
    }
  }
  transitions.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));

  return {
    coverage_percent: scalar(sumA.coverage_percent || 0, sumB.coverage_percent || 0),
    fully_covered: scalar(sumA.fully_covered || 0, sumB.fully_covered || 0),
    partial: scalar(sumA.partial || 0, sumB.partial || 0),
    untested: scalar(sumA.untested || 0, sumB.untested || 0),
    surprise: scalar(sumA.surprise || 0, sumB.surprise || 0),
    transitions,
  };
}

// =============================================================================
// diffActions — set diff by stable actionId
// =============================================================================

/**
 * Set diff of actions between two packs by stable actionId.
 * @param {any} actionsA - runtimeCoverageActions artifact from pack A
 * @param {any} actionsB - runtimeCoverageActions artifact from pack B
 * @returns {import('./types.mjs').ActionsDelta}
 */
export function diffActions(actionsA, actionsB) {
  const arrA = actionsA?.actions || [];
  const arrB = actionsB?.actions || [];

  /** @type {Map<string, any>} */
  const mapA = new Map();
  for (const a of arrA) mapA.set(a.actionId, a);
  /** @type {Map<string, any>} */
  const mapB = new Map();
  for (const b of arrB) mapB.set(b.actionId, b);

  const added = arrB.filter(b => !mapA.has(b.actionId)).sort((a, b) => a.actionId.localeCompare(b.actionId));
  const removed = arrA.filter(a => !mapB.has(a.actionId)).sort((a, b) => a.actionId.localeCompare(b.actionId));

  const sumA = actionsA?.summary || {};
  const sumB = actionsB?.summary || {};

  return {
    added,
    removed,
    total_actions: scalar(sumA.total_actions || 0, sumB.total_actions || 0),
    by_type: {
      a: sumA.by_type || {},
      b: sumB.by_type || {},
    },
  };
}

// =============================================================================
// diffSurprises — by category set diff
// =============================================================================

/**
 * Build a stable key for a surprise entry.
 * @param {import('./types.mjs').SurpriseEntryV2} s
 * @returns {string}
 */
function surpriseKey(s) {
  return `${s.category}|${s.trigger_id}|${s.expected_id || ''}|${s.observed_id || ''}`;
}

/**
 * Compare surprise entries between two packs.
 * @param {import('./types.mjs').SurpriseEntryV2[]} surprisesA
 * @param {import('./types.mjs').SurpriseEntryV2[]} surprisesB
 * @returns {import('./types.mjs').SurprisesDelta}
 */
export function diffSurprises(surprisesA, surprisesB) {
  const a = surprisesA || [];
  const b = surprisesB || [];

  const keysA = new Set(a.map(surpriseKey));
  const keysB = new Set(b.map(surpriseKey));

  const added = b.filter(s => !keysA.has(surpriseKey(s))).sort((x, y) => surpriseKey(x).localeCompare(surpriseKey(y)));
  const removed = a.filter(s => !keysB.has(surpriseKey(s))).sort((x, y) => surpriseKey(x).localeCompare(surpriseKey(y)));

  // Aggregate by category
  /** @type {Record<string, number>} */
  const catA = {};
  for (const s of a) catA[s.category] = (catA[s.category] || 0) + 1;
  /** @type {Record<string, number>} */
  const catB = {};
  for (const s of b) catB[s.category] = (catB[s.category] || 0) + 1;

  const allCategories = new Set([...Object.keys(catA), ...Object.keys(catB)]);
  /** @type {Record<string, number>} */
  const change = {};
  for (const cat of allCategories) {
    change[cat] = (catB[cat] || 0) - (catA[cat] || 0);
  }

  return {
    by_category: { a: catA, b: catB, change },
    added,
    removed,
  };
}

// =============================================================================
// buildDriftDiagnostics — identity_drift detail
// =============================================================================

/**
 * Extract identity_drift diagnostics showing expected->observed mappings.
 * @param {import('./types.mjs').SurpriseEntryV2[]} surprisesA
 * @param {import('./types.mjs').SurpriseEntryV2[]} surprisesB
 * @returns {import('./types.mjs').DriftDiagnostic[]}
 */
export function buildDriftDiagnostics(surprisesA, surprisesB) {
  const a = (surprisesA || []).filter(s => s.category === 'identity_drift');
  const b = (surprisesB || []).filter(s => s.category === 'identity_drift');

  /** @param {import('./types.mjs').SurpriseEntryV2} s */
  const driftKey = (s) => `${s.trigger_id}|${s.expected_id || ''}|${s.observed_id || ''}`;

  const keysA = new Set(a.map(driftKey));
  const keysB = new Set(b.map(driftKey));

  /** @type {import('./types.mjs').DriftDiagnostic[]} */
  const diagnostics = [];

  // All entries from both sides
  const allEntries = new Map();
  for (const s of a) allEntries.set(driftKey(s), s);
  for (const s of b) allEntries.set(driftKey(s), s);

  for (const [key, entry] of allEntries) {
    const inA = keysA.has(key);
    const inB = keysB.has(key);
    diagnostics.push({
      trigger_id: entry.trigger_id,
      label: entry.label,
      route: entry.route,
      expected_id: entry.expected_id || '',
      observed_id: entry.observed_id || '',
      status: inA && inB ? 'unchanged' : inB ? 'added' : 'removed',
    });
  }

  diagnostics.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));
  return diagnostics;
}

// =============================================================================
// buildReplayDiff — orchestrator
// =============================================================================

/**
 * Build the full replay diff from two loaded packs.
 * @param {import('./types.mjs').ReplayPack} packA
 * @param {import('./types.mjs').ReplayPack} packB
 * @param {{ pathA: string, pathB: string, top?: number }} opts
 * @returns {import('./types.mjs').ReplayDiff}
 */
export function buildReplayDiff(packA, packB, opts) {
  const top = opts.top || 0; // 0 = unlimited

  const manifest = diffManifests(packA.manifest, packB.manifest);
  const coverage = diffCoverage(
    packA.artifacts.runtimeCoverage,
    packB.artifacts.runtimeCoverage,
  );
  const actions = diffActions(
    packA.artifacts.runtimeCoverageActions,
    packB.artifacts.runtimeCoverageActions,
  );
  const surprises = diffSurprises(
    packA.artifacts.runtimeCoverage?.surprises_v2 || [],
    packB.artifacts.runtimeCoverage?.surprises_v2 || [],
  );
  const drift_diagnostics = buildDriftDiagnostics(
    packA.artifacts.runtimeCoverage?.surprises_v2 || [],
    packB.artifacts.runtimeCoverage?.surprises_v2 || [],
  );

  // Apply --top limits
  if (top > 0) {
    coverage.transitions.splice(top);
    actions.added.splice(top);
    actions.removed.splice(top);
    surprises.added.splice(top);
    surprises.removed.splice(top);
    drift_diagnostics.splice(top);
  }

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    pack_paths: { a: opts.pathA, b: opts.pathB },
    manifest,
    coverage,
    actions,
    surprises,
    drift_diagnostics,
  };
}

// =============================================================================
// buildReplayDiffSummary — compact for CI
// =============================================================================

/**
 * Build compact summary suitable for CI log printers.
 * @param {import('./types.mjs').ReplayDiff} diff
 * @returns {import('./types.mjs').ReplayDiffSummary}
 */
export function buildReplayDiffSummary(diff) {
  return {
    version: '1.0.0',
    pack_paths: diff.pack_paths,
    coverage_change: diff.coverage.coverage_percent.change,
    actions_added: diff.actions.added.length,
    actions_removed: diff.actions.removed.length,
    transitions_count: diff.coverage.transitions.length,
    drift_count: diff.drift_diagnostics.length,
    surprises_change: diff.surprises.by_category.change,
    config_match: diff.manifest.verify_config_hash.match
      && diff.manifest.safe_config_hash.match
      && diff.manifest.coverage_gate.match,
  };
}

// =============================================================================
// renderReplayDiffMarkdown — narrative report
// =============================================================================

/**
 * Render replay diff as a narrative markdown report.
 * @param {import('./types.mjs').ReplayDiff} diff
 * @returns {string}
 */
export function renderReplayDiffMarkdown(diff) {
  const lines = [];

  // Header
  lines.push('# Replay Diff');
  lines.push('');
  lines.push(`Generated: ${diff.generated_at}`);
  lines.push(`Pack A: ${diff.pack_paths.a}`);
  lines.push(`Pack B: ${diff.pack_paths.b}`);
  lines.push('');

  // Manifest & Config
  lines.push('## Manifest & Config');
  lines.push('');
  lines.push('| Field | Pack A | Pack B | Match |');
  lines.push('|-------|--------|--------|-------|');
  lines.push(`| Tool version | ${diff.manifest.tool_version.a} | ${diff.manifest.tool_version.b} | ${diff.manifest.tool_version.match ? 'Yes' : '**NO**'} |`);
  lines.push(`| Verify config | ${diff.manifest.verify_config_hash.a.slice(0, 8)}... | ${diff.manifest.verify_config_hash.b.slice(0, 8)}... | ${diff.manifest.verify_config_hash.match ? 'Yes' : '**NO**'} |`);
  lines.push(`| Safe config | ${diff.manifest.safe_config_hash.a.slice(0, 8)}... | ${diff.manifest.safe_config_hash.b.slice(0, 8)}... | ${diff.manifest.safe_config_hash.match ? 'Yes' : '**NO**'} |`);
  lines.push(`| Coverage gate | - | - | ${diff.manifest.coverage_gate.match ? 'Yes' : '**NO**'} |`);
  lines.push('');

  // Coverage Deltas
  lines.push('## Coverage Deltas');
  lines.push('');
  lines.push('| Metric | Pack A | Pack B | Change |');
  lines.push('|--------|--------|--------|--------|');
  const cov = diff.coverage;
  lines.push(`| Coverage | ${cov.coverage_percent.a}% | ${cov.coverage_percent.b}% | ${fmtChange(cov.coverage_percent.change)}% |`);
  lines.push(`| Fully covered | ${cov.fully_covered.a} | ${cov.fully_covered.b} | ${fmtChange(cov.fully_covered.change)} |`);
  lines.push(`| Partial | ${cov.partial.a} | ${cov.partial.b} | ${fmtChange(cov.partial.change)} |`);
  lines.push(`| Untested | ${cov.untested.a} | ${cov.untested.b} | ${fmtChange(cov.untested.change)} |`);
  lines.push(`| Surprise | ${cov.surprise.a} | ${cov.surprise.b} | ${fmtChange(cov.surprise.change)} |`);
  lines.push('');

  if (cov.transitions.length > 0) {
    lines.push('### Trigger Transitions');
    lines.push('');
    lines.push('| Trigger | Route | A | B |');
    lines.push('|---------|-------|---|---|');
    for (const t of cov.transitions) {
      lines.push(`| ${t.label} (\`${t.trigger_id}\`) | ${t.route} | ${t.status_a || 'absent'} | ${t.status_b || 'absent'} |`);
    }
    lines.push('');
  }

  // Actions Delta
  lines.push('## Actions Delta');
  lines.push('');
  const act = diff.actions;
  lines.push(`Total: ${act.total_actions.a} → ${act.total_actions.b} (${fmtChange(act.total_actions.change)})`);
  lines.push(`Added: **${act.added.length}** | Removed: **${act.removed.length}**`);
  lines.push('');

  if (act.added.length > 0) {
    lines.push('### Added Actions');
    lines.push('');
    lines.push('| Action ID | Type | Priority | Rationale |');
    lines.push('|-----------|------|----------|-----------|');
    for (const a of act.added) {
      lines.push(`| \`${a.actionId}\` | ${a.type} | ${a.priority} | ${a.rationale} |`);
    }
    lines.push('');
  }

  if (act.removed.length > 0) {
    lines.push('### Removed Actions');
    lines.push('');
    lines.push('| Action ID | Type | Rationale |');
    lines.push('|-----------|------|-----------|');
    for (const a of act.removed) {
      lines.push(`| \`${a.actionId}\` | ${a.type} | ${a.rationale} |`);
    }
    lines.push('');
  }

  // Surprises Delta
  lines.push('## Surprises Delta');
  lines.push('');
  const sur = diff.surprises;
  const allCats = new Set([...Object.keys(sur.by_category.a), ...Object.keys(sur.by_category.b)]);
  if (allCats.size > 0) {
    lines.push('| Category | Pack A | Pack B | Change |');
    lines.push('|----------|--------|--------|--------|');
    for (const cat of [...allCats].sort()) {
      const va = sur.by_category.a[cat] || 0;
      const vb = sur.by_category.b[cat] || 0;
      const ch = sur.by_category.change[cat] || 0;
      lines.push(`| ${cat} | ${va} | ${vb} | ${fmtChange(ch)} |`);
    }
    lines.push('');
  } else {
    lines.push('No surprises in either pack.');
    lines.push('');
  }

  // Drift Diagnostics
  if (diff.drift_diagnostics.length > 0) {
    lines.push('## Identity Drift Diagnostics');
    lines.push('');
    lines.push('| Trigger | Expected | Observed | Status |');
    lines.push('|---------|----------|----------|--------|');
    for (const d of diff.drift_diagnostics) {
      lines.push(`| ${d.label} (\`${d.trigger_id}\`) | \`${d.expected_id}\` | \`${d.observed_id}\` | ${d.status} |`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push(`To reproduce: \`ai-ui replay-diff ${diff.pack_paths.a} ${diff.pack_paths.b}\``);
  lines.push('');

  return lines.join('\n');
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmtChange(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

// =============================================================================
// applyDiffGate — gate logic on the diff
// =============================================================================

/**
 * Apply gate logic to a replay diff. Returns exit code.
 * @param {import('./types.mjs').ReplayDiff} diff
 * @param {import('./types.mjs').GateMode} mode
 * @param {{ minCoverage?: number }} [opts]
 * @returns {{ pass: boolean, blockers: string[] }}
 */
export function applyDiffGate(diff, mode, opts) {
  if (mode === 'none') {
    return { pass: true, blockers: [] };
  }

  /** @type {string[]} */
  const blockers = [];

  if (mode === 'minimum') {
    const minCov = opts?.minCoverage ?? 0;
    if (diff.coverage.coverage_percent.b < minCov) {
      blockers.push(`Coverage ${diff.coverage.coverage_percent.b}% below minimum ${minCov}%`);
    }
  }

  if (mode === 'regressions') {
    if (diff.actions.added.length > 0) {
      blockers.push(`${diff.actions.added.length} new action(s) appeared: ${diff.actions.added.slice(0, 3).map(a => a.actionId).join(', ')}${diff.actions.added.length > 3 ? '...' : ''}`);
    }
    if (diff.coverage.coverage_percent.change < 0) {
      blockers.push(`Coverage regressed from ${diff.coverage.coverage_percent.a}% to ${diff.coverage.coverage_percent.b}% (${diff.coverage.coverage_percent.change}%)`);
    }
  }

  return { pass: blockers.length === 0, blockers };
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the replay-diff command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, out?: string, format?: string, gate?: string, minCoverage?: number, top?: number }} flags
 * @param {string} pathA
 * @param {string} pathB
 */
export async function runReplayDiff(config, flags, pathA, pathB) {
  const cwd = process.cwd();
  const resolvedA = resolve(cwd, pathA);
  const resolvedB = resolve(cwd, pathB);

  let packA, packB;
  try {
    packA = loadReplayPack(resolvedA);
  } catch (e) {
    console.error(`Replay diff: failed to load pack A: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  try {
    packB = loadReplayPack(resolvedB);
  } catch (e) {
    console.error(`Replay diff: failed to load pack B: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  // Validate required artifacts
  if (!packA.artifacts.runtimeCoverage || !packA.artifacts.runtimeCoverageActions) {
    console.error('Replay diff: pack A missing required coverage artifacts.');
    process.exitCode = 2;
    return;
  }
  if (!packB.artifacts.runtimeCoverage || !packB.artifacts.runtimeCoverageActions) {
    console.error('Replay diff: pack B missing required coverage artifacts.');
    process.exitCode = 2;
    return;
  }

  const diff = buildReplayDiff(packA, packB, {
    pathA: relative(cwd, resolvedA),
    pathB: relative(cwd, resolvedB),
    top: flags.top,
  });

  const summary = buildReplayDiffSummary(diff);

  // Write outputs
  if (flags.out) {
    const outPath = resolve(cwd, flags.out);
    mkdirSync(dirname(outPath), { recursive: true });
    if (flags.format === 'md') {
      writeFileSync(outPath, renderReplayDiffMarkdown(diff), 'utf-8');
    } else {
      writeFileSync(outPath, JSON.stringify(diff, null, 2) + '\n', 'utf-8');
    }
    console.log(`Replay diff: written → ${relative(cwd, outPath)}`);
  } else {
    // Write all three files to default paths
    const diffPath = resolve(cwd, config.output.replayDiff);
    const reportPath = resolve(cwd, config.output.replayDiffReport);
    const summaryPath = resolve(cwd, config.output.replayDiffSummary);

    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, JSON.stringify(diff, null, 2) + '\n', 'utf-8');
    writeFileSync(reportPath, renderReplayDiffMarkdown(diff), 'utf-8');
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

    console.log(`Replay diff: written → ${relative(cwd, diffPath)}`);
  }

  // Console summary
  const covChange = diff.coverage.coverage_percent.change;
  console.log(`  Coverage: ${diff.coverage.coverage_percent.a}% → ${diff.coverage.coverage_percent.b}% (${fmtChange(covChange)}%)`);
  console.log(`  Actions: ${fmtChange(diff.actions.added.length)} added, ${fmtChange(-diff.actions.removed.length)} removed`);
  if (diff.coverage.transitions.length > 0) {
    console.log(`  Transitions: ${diff.coverage.transitions.length} trigger(s) changed status`);
  }
  if (diff.drift_diagnostics.length > 0) {
    console.log(`  Drift: ${diff.drift_diagnostics.length} identity drift diagnostic(s)`);
  }
  if (!summary.config_match) {
    console.log('  WARNING: config mismatch between packs');
  }

  if (flags.verbose) {
    if (diff.actions.added.length > 0) {
      console.log('  Added actions:');
      for (const a of diff.actions.added) {
        console.log(`    - ${a.actionId} (${a.type}): ${a.rationale}`);
      }
    }
    if (diff.actions.removed.length > 0) {
      console.log('  Removed actions:');
      for (const a of diff.actions.removed) {
        console.log(`    - ${a.actionId} (${a.type}): ${a.rationale}`);
      }
    }
  }

  // Apply gate if requested
  if (flags.gate && flags.gate !== 'none') {
    const gateMode = /** @type {import('./types.mjs').GateMode} */ (flags.gate);
    const gateResult = applyDiffGate(diff, gateMode, { minCoverage: flags.minCoverage });
    if (!gateResult.pass) {
      console.log(`  Gate (${gateMode}): FAIL`);
      for (const b of gateResult.blockers) {
        console.log(`    - ${b}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`  Gate (${gateMode}): PASS`);
    }
  }
}
