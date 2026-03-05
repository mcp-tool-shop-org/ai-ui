// @ts-check
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { validateCapture } from '@mcptoolshop/websketch-ir';
import { fail } from './config.mjs';

/**
 * A "surface" is any UINode that has at least one of:
 * - HandlerSignal (click, submit, etc.)
 * - PatternSignal (search_bar, auth_form, etc.)
 * - StateSignal with write|readwrite access
 * - StyleIntent with actionable tokens (primary, destructive, etc.)
 *
 * These are the nodes that represent discoverable, interactive UI features.
 */

/** Tokens that indicate actionable intent (not purely decorative) */
const ACTIONABLE_STYLE_TOKENS = new Set([
  'primary', 'secondary', 'destructive', 'success', 'warning', 'info',
]);

/**
 * Check if a node qualifies as a surface.
 * @param {any} node - UINode
 * @returns {boolean}
 */
function isSurface(node) {
  if (node.handlers && node.handlers.length > 0) return true;
  if (node.pattern) return true;
  if (node.state && node.state.some(s => s.access === 'write' || s.access === 'readwrite')) return true;
  if (node.style?.tokens && node.style.tokens.some(t => ACTIONABLE_STYLE_TOKENS.has(t))) return true;
  return false;
}

/**
 * Extract surfaces from a WebSketch capture.
 * Pure function: capture in → SurfaceInventory out.
 *
 * @param {any} capture - Validated WebSketchCapture object
 * @param {string} [sourcePath] - Path/URL of source capture (for metadata)
 * @returns {import('./types.mjs').SurfaceInventory}
 */
export function extractSurfaces(capture, sourcePath = '') {
  const route = new URL(capture.url).pathname;
  /** @type {import('./types.mjs').Surface[]} */
  const surfaces = [];
  let totalNodes = 0;

  /**
   * Walk the node tree depth-first, collecting surfaces.
   * @param {any} node
   */
  function walk(node) {
    totalNodes++;

    if (isSurface(node)) {
      surfaces.push({
        nodeId: node.id,
        route,
        role: node.role,
        label: node.semantic || null,
        pattern: node.pattern?.kind || null,
        styleTokens: node.style?.tokens?.filter(t => ACTIONABLE_STYLE_TOKENS.has(t)) || [],
        handlers: (node.handlers || []).map(h => ({ event: h.event, intent: h.intent })),
        state: (node.state || [])
          .filter(s => s.access === 'write' || s.access === 'readwrite')
          .map(s => ({ key: s.key, access: s.access })),
      });
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(capture.root);

  // Deterministic sort: route → nodeId → label
  surfaces.sort((a, b) =>
    a.route.localeCompare(b.route) ||
    a.nodeId.localeCompare(b.nodeId) ||
    (a.label || '').localeCompare(b.label || '')
  );

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    source_capture: sourcePath,
    surfaces,
    stats: {
      total_nodes: totalNodes,
      surfaces_extracted: surfaces.length,
    },
  };
}

/**
 * CLI entrypoint: ai-ui surfaces --from <capture.json>
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {Record<string, any>} flags
 */
export async function runSurfaces(config, flags) {
  const fromPath = flags.from;
  if (!fromPath) {
    fail('MISSING_ARG', 'Missing --from <capture.json>', 'Provide a WebSketch capture file path.');
  }

  const absPath = resolve(fromPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (e) {
    fail('CAPTURE_READ', `Failed to read capture: ${e.message}`, 'Check the file path and ensure it is valid JSON.');
  }

  // Validate capture before extraction
  const issues = validateCapture(raw);
  if (issues.length > 0) {
    const top3 = issues.slice(0, 3).map(i => `  - ${i.path}: ${i.message}`).join('\n');
    fail('CAPTURE_INVALID', `Capture has ${issues.length} validation issue(s):\n${top3}`, 'Ensure the capture was produced by websketch-ir v2+.');
  }

  const outPath = resolve(flags.out || config.output.surfaces);
  const inventory = extractSurfaces(raw, absPath);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(inventory, null, 2) + '\n');

  console.log(`Surfaces: ${inventory.stats.surfaces_extracted} extracted from ${inventory.stats.total_nodes} nodes`);
  console.log(`  → ${outPath}`);
}
