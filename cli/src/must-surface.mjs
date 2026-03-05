// @ts-check
import { readFileSync, existsSync } from 'node:fs';

// =============================================================================
// Load must-surface config
// =============================================================================

/**
 * Load must-surface.json from the given path.
 * Returns null if the file doesn't exist.
 * @param {string} filePath - Absolute path to must-surface.json
 * @returns {import('./types.mjs').MustSurfaceConfig | null}
 */
export function loadMustSurface(filePath) {
  if (!existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw || !Array.isArray(raw.required)) {
      console.warn('Must-surface: invalid format (expected { required: [...] })');
      return null;
    }
    return raw;
  } catch (e) {
    console.warn(`Must-surface: failed to parse: ${e.message}`);
    return null;
  }
}

// =============================================================================
// Check must-surface contract against graph — pure function
// =============================================================================

/**
 * Check each required feature against the trigger graph.
 * @param {import('./types.mjs').MustSurfaceConfig} config
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {{ blockers: import('./types.mjs').VerifyBlocker[], warnings: import('./types.mjs').VerifyWarning[], results: import('./types.mjs').MustSurfaceResult[] }}
 */
export function checkMustSurface(config, graph) {
  /** @type {import('./types.mjs').VerifyBlocker[]} */
  const blockers = [];
  /** @type {import('./types.mjs').VerifyWarning[]} */
  const warnings = [];
  /** @type {import('./types.mjs').MustSurfaceResult[]} */
  const results = [];

  for (const entry of config.required) {
    if (!entry.feature_id || !entry.severity) continue;

    const nodeId = `feature:${entry.feature_id}`;
    const featureExists = graph.nodes.some(n => n.id === nodeId);

    if (!featureExists) {
      // Feature not in graph at all — may have been renamed or removed from docs
      warnings.push({
        rule: 'must_surface_missing',
        message: `Required feature "${entry.feature_id}" not found in graph (may be renamed or removed from docs)`,
      });
      results.push({
        feature_id: entry.feature_id,
        severity: entry.severity,
        status: 'missing',
        reason: entry.reason,
      });
      continue;
    }

    const hasDocumentsEdge = graph.edges.some(
      e => e.to === nodeId && e.type === 'documents'
    );

    if (hasDocumentsEdge) {
      // Feature is documented — all good
      results.push({
        feature_id: entry.feature_id,
        severity: entry.severity,
        status: 'ok',
        reason: entry.reason,
      });
    } else {
      // Feature is orphaned — severity determines blocker vs warning
      const result = /** @type {import('./types.mjs').MustSurfaceResult} */ ({
        feature_id: entry.feature_id,
        severity: entry.severity,
        status: 'orphaned',
        reason: entry.reason,
      });
      results.push(result);

      const reasonSuffix = entry.reason ? ` — ${entry.reason}` : '';

      if (entry.severity === 'P0' || entry.severity === 'P1') {
        blockers.push({
          rule: `must_surface_${entry.severity.toLowerCase()}`,
          message: `Required ${entry.severity} feature "${entry.feature_id}" is orphaned${reasonSuffix}`,
        });
      } else {
        // P2 = warning only
        warnings.push({
          rule: `must_surface_${entry.severity.toLowerCase()}`,
          message: `Required ${entry.severity} feature "${entry.feature_id}" is orphaned${reasonSuffix}`,
        });
      }
    }
  }

  // Deterministic sort
  blockers.sort((a, b) => a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message));
  warnings.sort((a, b) => a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message));
  results.sort((a, b) => a.feature_id.localeCompare(b.feature_id));

  return { blockers, warnings, results };
}
