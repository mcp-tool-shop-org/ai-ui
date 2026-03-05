// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';

// =============================================================================
// Load coverage artifacts
// =============================================================================

/**
 * Load all artifacts needed for coverage analysis.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {string} cwd
 * @returns {{ graph: import('./types.mjs').TriggerGraph|null, runtimeSummary: import('./types.mjs').RuntimeEffectsSummary|null, probeEntries: any[]|null, surfaces: import('./types.mjs').Surface[]|null }}
 */
export function loadCoverageArtifacts(config, cwd) {
  // Graph is required
  const graphPath = resolve(cwd, config.output.graph);
  let graph = null;
  if (existsSync(graphPath)) {
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }

  // Runtime summary (optional)
  const runtimePath = resolve(cwd, config.output.runtimeEffectsSummary);
  let runtimeSummary = null;
  if (existsSync(runtimePath)) {
    try {
      runtimeSummary = JSON.parse(readFileSync(runtimePath, 'utf-8'));
    } catch { /* ignore parse errors */ }
  }

  // Probe entries (optional)
  const probePath = resolve(cwd, config.output.probe);
  let probeEntries = null;
  if (existsSync(probePath)) {
    try {
      probeEntries = readFileSync(probePath, 'utf-8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
    } catch { /* ignore parse errors */ }
  }

  // Surfaces (optional)
  const surfacesPath = resolve(cwd, config.output.surfaces);
  let surfaces = null;
  if (existsSync(surfacesPath)) {
    try {
      const inv = JSON.parse(readFileSync(surfacesPath, 'utf-8'));
      surfaces = inv.surfaces || [];
    } catch { /* ignore parse errors */ }
  }

  return { graph, runtimeSummary, probeEntries, surfaces };
}

// =============================================================================
// Compute coverage
// =============================================================================

/**
 * Compute per-trigger coverage from pipeline artifacts.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').RuntimeEffectsSummary|null} runtimeSummary
 * @param {any[]|null} probeEntries
 * @returns {import('./types.mjs').CoverageReport}
 */
export function computeCoverage(graph, runtimeSummary, probeEntries) {
  // Build sets for lookup
  const probedLabels = new Set();
  if (probeEntries) {
    for (const entry of probeEntries) {
      if (entry.type === 'trigger') {
        probedLabels.add(`${entry.route}|${entry.label}`);
      }
    }
  }

  const observedTriggers = new Map();
  if (runtimeSummary) {
    for (const t of runtimeSummary.triggers) {
      observedTriggers.set(`${t.route}|${t.label}`, t.effects.map(e => e.kind));
    }
  }

  // Surface mapping: trigger → has maps_to edge
  const hasSurfaceMap = new Set();
  for (const edge of graph.edges) {
    if (edge.type === 'maps_to') {
      hasSurfaceMap.add(edge.from);
    }
  }

  /** @type {import('./types.mjs').TriggerCoverage[]} */
  const triggers = [];

  /** @type {import('./types.mjs').SurpriseEntry[]} */
  const surprises = [];

  // Process graph trigger nodes
  const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');

  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    const probed = probedLabels.has(key);
    const hasSurface = hasSurfaceMap.has(node.id);
    const observedEffects = observedTriggers.get(key) || [];
    const observed = observedEffects.length > 0;

    let status = classifyStatus(probed, hasSurface, observed);

    triggers.push({
      trigger_id: node.id,
      route: node.route || '/',
      label: node.label,
      probed,
      hasSurface,
      observed,
      status,
      effects: observedEffects,
    });
  }

  // Check for surprise triggers: observed in runtime but not in graph
  if (runtimeSummary) {
    const graphTriggerKeys = new Set(triggerNodes.map(n => `${n.route}|${n.label}`));
    for (const t of runtimeSummary.triggers) {
      const key = `${t.route}|${t.label}`;
      if (!graphTriggerKeys.has(key) && t.effects.length > 0) {
        triggers.push({
          trigger_id: `runtime:${t.route}|${t.label}`,
          route: t.route,
          label: t.label,
          probed: false,
          hasSurface: false,
          observed: true,
          status: 'surprise',
          effects: t.effects.map(e => e.kind),
        });
        surprises.push({
          trigger_id: `runtime:${t.route}|${t.label}`,
          label: t.label,
          route: t.route,
          reason: 'new_runtime_effect',
        });
      }
    }
  }

  // Check for risky skipped triggers (in graph with destructive style but not observed)
  for (const node of triggerNodes) {
    const key = `${node.route}|${node.label}`;
    const observed = observedTriggers.has(key);
    const meta = node.meta || {};
    if (!observed && meta.styleTokens && meta.styleTokens.some(
      /** @param {string} t */ t => ['destructive', 'danger', 'warning'].includes(t)
    )) {
      surprises.push({
        trigger_id: node.id,
        label: node.label,
        route: node.route || '/',
        reason: 'risky_skipped',
      });
    }
  }

  // Sort triggers deterministically
  triggers.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));
  surprises.sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));

  // Summary
  let fullyCovered = 0, partial = 0, untested = 0, surprise = 0;
  for (const t of triggers) {
    switch (t.status) {
      case 'fully_covered': fullyCovered++; break;
      case 'partial': partial++; break;
      case 'untested': untested++; break;
      case 'surprise': surprise++; break;
    }
  }

  const total = triggers.length;
  const coveragePercent = total > 0
    ? Math.round((fullyCovered / total) * 10000) / 100
    : 0;

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    triggers,
    summary: {
      total,
      fully_covered: fullyCovered,
      partial,
      untested,
      surprise,
      coverage_percent: coveragePercent,
    },
    surprises,
  };
}

/**
 * Classify trigger coverage status.
 * @param {boolean} probed
 * @param {boolean} hasSurface
 * @param {boolean} observed
 * @returns {import('./types.mjs').CoverageStatus}
 */
export function classifyStatus(probed, hasSurface, observed) {
  const count = (probed ? 1 : 0) + (hasSurface ? 1 : 0) + (observed ? 1 : 0);
  if (count === 3) return 'fully_covered';
  if (count >= 2) return 'partial';
  if (!probed && !hasSurface && observed) return 'surprise';
  return 'untested';
}

// =============================================================================
// Render markdown
// =============================================================================

/**
 * Render a coverage report as markdown.
 * @param {import('./types.mjs').CoverageReport} report
 * @returns {string}
 */
export function renderCoverageMarkdown(report) {
  const lines = [];
  const s = report.summary;

  lines.push('# Runtime Coverage Report');
  lines.push('');

  // --- Coverage Summary ---
  lines.push('## Coverage Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Total triggers | ${s.total} |`);
  lines.push(`| Fully covered | ${s.fully_covered} |`);
  lines.push(`| Partial | ${s.partial} |`);
  lines.push(`| Untested | ${s.untested} |`);
  lines.push(`| Surprise | ${s.surprise} |`);
  lines.push(`| Coverage | ${s.coverage_percent}% |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Per-trigger matrix ---
  lines.push('## Per-Trigger Matrix');
  lines.push('');
  if (report.triggers.length === 0) {
    lines.push('No triggers found.');
  } else {
    lines.push('| Trigger | Route | Probed | Surface | Observed | Status | Effects |');
    lines.push('|---------|-------|--------|---------|----------|--------|---------|');
    for (const t of report.triggers) {
      const check = (/** @type {boolean} */ v) => v ? 'yes' : 'no';
      const effectStr = t.effects.length > 0 ? t.effects.join(', ') : '-';
      lines.push(`| ${t.label} | ${t.route} | ${check(t.probed)} | ${check(t.hasSurface)} | ${check(t.observed)} | ${t.status} | ${effectStr} |`);
    }
  }
  lines.push('');

  // --- Most Surprising (conditional) ---
  if (report.surprises.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Most Surprising');
    lines.push('');
    lines.push('| Trigger | Route | Reason |');
    lines.push('|---------|-------|--------|');
    for (const s of report.surprises) {
      lines.push(`| ${s.label} | ${s.route} | ${s.reason} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the runtime-coverage command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, withRuntime?: boolean }} flags
 */
export async function runRuntimeCoverage(config, flags) {
  const cwd = process.cwd();

  const artifacts = loadCoverageArtifacts(config, cwd);

  if (!artifacts.graph) {
    fail('COVERAGE_NO_GRAPH', 'Trigger graph not found.', 'Run "ai-ui graph" first.');
  }

  if (flags.verbose) {
    console.log('Coverage: loaded artifacts');
    console.log(`  Graph: ${artifacts.graph.nodes.length} nodes, ${artifacts.graph.edges.length} edges`);
    if (artifacts.runtimeSummary) {
      console.log(`  Runtime: ${artifacts.runtimeSummary.triggers.length} triggers`);
    } else {
      console.log('  Runtime: not found (all triggers will show as untested)');
    }
    if (artifacts.probeEntries) {
      const probeTriggers = artifacts.probeEntries.filter(e => e.type === 'trigger').length;
      console.log(`  Probe: ${probeTriggers} triggers`);
    }
  }

  // If --with-runtime, re-augment graph first
  let graph = artifacts.graph;
  if (flags.withRuntime && artifacts.runtimeSummary) {
    const { augmentWithRuntime } = await import('./trigger-graph.mjs');
    graph = augmentWithRuntime(graph, artifacts.runtimeSummary);
    if (flags.verbose) {
      console.log(`  Augmented graph: v${graph.version}`);
    }
  }

  const report = computeCoverage(graph, artifacts.runtimeSummary, artifacts.probeEntries);

  // Write JSON
  const coveragePath = resolve(cwd, config.output.runtimeCoverage);
  mkdirSync(dirname(coveragePath), { recursive: true });
  writeFileSync(coveragePath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // Write markdown
  const reportPath = resolve(cwd, config.output.runtimeCoverageReport);
  writeFileSync(reportPath, renderCoverageMarkdown(report), 'utf-8');

  console.log(`Coverage: ${report.summary.total} triggers, ${report.summary.coverage_percent}% covered → ${relative(cwd, coveragePath)}`);
  if (flags.verbose) {
    console.log(`  Fully covered: ${report.summary.fully_covered}, Partial: ${report.summary.partial}, Untested: ${report.summary.untested}, Surprise: ${report.summary.surprise}`);
    console.log(`  Report: ${relative(cwd, reportPath)}`);
  }
}
