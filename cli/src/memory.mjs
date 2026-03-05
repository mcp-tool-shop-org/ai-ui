// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// =============================================================================
// Memory loading — pure functions (except file reads)
// =============================================================================

/**
 * Load all memory files from the memory directory.
 * Returns null if directory doesn't exist (unless strict).
 * @param {string} memoryDir - Absolute path to memory directory
 * @param {boolean} [strict=false] - Fail on parse errors
 * @returns {import('./types.mjs').LoadedMemory | null}
 */
export function loadMemory(memoryDir, strict = false) {
  if (!existsSync(memoryDir)) {
    if (strict) {
      console.error(`Memory: directory not found: ${memoryDir}`);
      console.error('  Hint: Run "ai-ui init-memory" to create it.');
      process.exitCode = 2;
      return null;
    }
    return null;
  }

  const mappings = loadJsonFile(join(memoryDir, 'mappings.json'), 'mappings', strict);
  const decisions = loadJsonFile(join(memoryDir, 'decisions.json'), 'decisions', strict);
  const exceptions = loadJsonFile(join(memoryDir, 'exceptions.json'), 'exceptions', strict);

  return { mappings, decisions, exceptions };
}

/**
 * Load and parse a single JSON memory file.
 * @param {string} filePath
 * @param {string} label
 * @param {boolean} strict
 * @returns {Record<string, any>}
 */
function loadJsonFile(filePath, label, strict) {
  if (!existsSync(filePath)) return {};

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      if (strict) {
        console.error(`Memory: ${label} must be a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
        process.exitCode = 2;
      } else {
        console.warn(`Memory: skipping ${label} (not a JSON object)`);
      }
      return {};
    }
    return raw;
  } catch (e) {
    if (strict) {
      console.error(`Memory: failed to parse ${label}: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.warn(`Memory: skipping ${label} (parse error: ${e.message})`);
    }
    return {};
  }
}

// =============================================================================
// Merge helpers — pure functions
// =============================================================================

/**
 * Merge memory mappings with config mappings.
 * Memory takes precedence over config on conflict.
 * Returns a flat feature_id → trigger_label mapping for diff.mjs compatibility.
 * @param {Record<string, string>} configMapping - From config.mapping (feature_id → trigger_label)
 * @param {Record<string, import('./types.mjs').MemoryMapping>} memoryMappings
 * @returns {Record<string, string>}
 */
export function mergeMemoryMappings(configMapping, memoryMappings) {
  const merged = { ...configMapping };
  for (const [featureId, mapping] of Object.entries(memoryMappings)) {
    if (mapping && mapping.trigger_label) {
      merged[featureId] = mapping.trigger_label;
    }
  }
  return merged;
}

/**
 * Split orphans into decided (has memory decision) and undecided.
 * @param {any[]} orphans - documented_not_discoverable entries from diff.json
 * @param {Record<string, import('./types.mjs').MemoryDecision>} decisions
 * @returns {{ decided: Array<{ orphan: any, decision: import('./types.mjs').MemoryDecision }>, undecided: any[] }}
 */
export function applyDecisions(orphans, decisions) {
  /** @type {Array<{ orphan: any, decision: import('./types.mjs').MemoryDecision }>} */
  const decided = [];
  /** @type {any[]} */
  const undecided = [];

  for (const orphan of orphans) {
    const decision = decisions[orphan.feature_id];
    if (decision && decision.priority && decision.rule && decision.route) {
      decided.push({ orphan, decision });
    } else {
      undecided.push(orphan);
    }
  }

  return { decided, undecided };
}

/**
 * Apply memory exceptions to verify metrics.
 * Returns adjusted metrics with excluded features subtracted.
 * @param {import('./types.mjs').VerifyMetrics} metrics
 * @param {Record<string, import('./types.mjs').MemoryException>} exceptions
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {import('./types.mjs').VerifyMetrics}
 */
export function applyExceptions(metrics, exceptions, graph) {
  let totalAdjust = 0;
  let orphanAdjust = 0;
  let p0Adjust = 0;

  for (const [featureId, exc] of Object.entries(exceptions)) {
    if (!exc || !Array.isArray(exc.exclude_from)) continue;

    // Check if this feature actually exists as an orphan in the graph
    const featureNodeId = `feature:${featureId}`;
    const hasDocumentsEdge = graph.edges.some(
      e => e.to === featureNodeId && e.type === 'documents'
    );
    const featureExists = graph.nodes.some(n => n.id === featureNodeId);

    if (!featureExists) continue;

    if (exc.exclude_from.includes('orphan_count') && !hasDocumentsEdge) {
      orphanAdjust++;
      totalAdjust++;
    }

    if (exc.exclude_from.includes('coverage') && !exc.exclude_from.includes('orphan_count')) {
      // If excluded from coverage but not orphan_count, still reduce total for ratio
      totalAdjust++;
    }
  }

  const adjustedTotal = Math.max(0, metrics.total_features - totalAdjust);
  const adjustedOrphans = Math.max(0, metrics.orphan_features - orphanAdjust);
  const adjustedRatio = adjustedTotal > 0
    ? Math.round((adjustedOrphans / adjustedTotal) * 100) / 100
    : 0;

  return {
    ...metrics,
    total_features: adjustedTotal,
    orphan_features: adjustedOrphans,
    orphan_ratio: adjustedRatio,
    memory_excluded: totalAdjust,
  };
}

// =============================================================================
// Suggested memory entries — pure function
// =============================================================================

/**
 * Scan diff artifacts for entries that could benefit from memory.
 * @param {any} diff - Parsed diff.json
 * @returns {import('./types.mjs').SuggestedMemory}
 */
export function suggestMemoryEntries(diff) {
  /** @type {import('./types.mjs').SuggestedMapping[]} */
  const mappings = [];

  // Suggest mappings from ambiguous matches
  const ambiguous = diff.ambiguous_matches || [];
  for (const am of ambiguous) {
    if (am.tied_candidates && am.tied_candidates.length > 0) {
      const best = am.tied_candidates[0];
      mappings.push({
        feature_id: am.feature_id,
        trigger_label: best.source_label,
        confidence: best.composite_score,
        source: 'ambiguous',
        hint: `Resolve ambiguity: ${am.tied_candidates.length} tied candidates (gap ${am.confidence_gap.toFixed(2)})`,
      });
    }
  }

  // Suggest mappings from near-miss unmatched features (score 0.30–0.39)
  const unmatched = diff.documented_not_discoverable || [];
  for (const item of unmatched) {
    const top = (item.top_candidates || [])[0];
    if (top && top.composite_score >= 0.30 && top.composite_score < 0.40) {
      mappings.push({
        feature_id: item.feature_id,
        trigger_label: top.source_label,
        confidence: top.composite_score,
        source: 'near_miss',
        hint: `Near miss (score ${top.composite_score.toFixed(2)}, threshold 0.40) — add mapping if these are the same feature`,
      });
    }
  }

  // Deterministic sort
  mappings.sort((a, b) => a.feature_id.localeCompare(b.feature_id));

  return { mappings };
}

// =============================================================================
// init-memory command
// =============================================================================

/**
 * Create empty memory files with schema documentation.
 * @param {import('./types.mjs').AiUiConfig} config
 */
export function runInitMemory(config) {
  const cwd = process.cwd();
  const memoryDir = resolve(cwd, config.memory.dir);

  if (existsSync(memoryDir)) {
    // Check for existing files — don't overwrite
    const files = ['mappings.json', 'decisions.json', 'exceptions.json'];
    const existing = files.filter(f => existsSync(join(memoryDir, f)));
    if (existing.length > 0) {
      console.log(`Memory: directory already exists with ${existing.length} file(s) at ${config.memory.dir}/`);
      console.log('  Existing files will not be overwritten.');
    }
  }

  mkdirSync(memoryDir, { recursive: true });

  const files = [
    { name: 'mappings.json', content: {} },
    { name: 'decisions.json', content: {} },
    { name: 'exceptions.json', content: {} },
  ];

  let created = 0;
  for (const f of files) {
    const p = join(memoryDir, f.name);
    if (!existsSync(p)) {
      writeFileSync(p, JSON.stringify(f.content, null, 2) + '\n', 'utf-8');
      created++;
    }
  }

  // Always write/update README
  const readmePath = join(memoryDir, 'README.md');
  writeFileSync(readmePath, MEMORY_README, 'utf-8');

  console.log(`Memory: initialized ${config.memory.dir}/ (${created} file(s) created)`);
}

const MEMORY_README = `# AI-UI Memory

These files teach the pipeline what you've already decided.
They are read-only inputs — the pipeline never modifies them.
Commit them to git so your team can review changes in PRs.

## mappings.json

Force a feature to match a specific trigger/surface label.
Useful when the AI matching picks the wrong candidate or scores too low.

\`\`\`json
{
  "feature-id": {
    "trigger_label": "Exact Label In UI",
    "reason": "Why this mapping was established"
  }
}
\`\`\`

## decisions.json

Override the composer's placement decision for an orphan feature.
Use when you know exactly where a feature should be surfaced.

\`\`\`json
{
  "feature-id": {
    "priority": "P1",
    "rule": "hero_cta",
    "route": "/",
    "reason": "Key differentiator, deserves hero placement"
  }
}
\`\`\`

Rules: nav_menu_available, hero_cta, table_action, overflow_advanced, generic_cta

## exceptions.json

Exclude features from verify calculations.
Use for features that are planned-future, out-of-scope, or intentionally not surfaced.

\`\`\`json
{
  "feature-id": {
    "reason": "Planned for v2",
    "exclude_from": ["orphan_count", "coverage", "p0"]
  }
}
\`\`\`

Values for exclude_from: orphan_count, coverage, p0
`;
