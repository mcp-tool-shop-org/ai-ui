// @ts-check
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';
import { matchScore } from './normalize.mjs';
import { buildEvidenceKey, deduplicateEvidence, computeConfidence, normalizeEffectId } from './runtime-effects.mjs';

// =============================================================================
// Graph builder — pure function, no I/O
// =============================================================================

/**
 * Build a trigger graph from pre-computed pipeline outputs.
 * @param {any[]} triggers - Probe trigger entries from probe.jsonl
 * @param {any[]} routeChanges - Probe route_change entries from probe.jsonl
 * @param {import('./types.mjs').Surface[]} surfaces - From probe.surfaces.json
 * @param {import('./types.mjs').Feature[]} features - From atlas.json
 * @param {any} diff - Parsed diff.json
 * @returns {import('./types.mjs').TriggerGraph}
 */
export function buildGraph(triggers, routeChanges, surfaces, features, diff) {
  /** @type {Map<string, import('./types.mjs').GraphNode>} */
  const nodeMap = new Map();
  /** @type {import('./types.mjs').GraphEdge[]} */
  const edges = [];

  // --- 1. Route nodes from route_changes ---
  const routePaths = new Set();
  for (const rc of routeChanges) {
    routePaths.add(rc.from);
    routePaths.add(rc.to);
  }
  // Also add routes from triggers
  for (const t of triggers) {
    routePaths.add(t.route);
  }
  for (const path of routePaths) {
    const id = `route:${path}`;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, type: 'route', label: path, route: path, meta: {} });
    }
  }

  // --- 2. Trigger nodes ---
  const triggerDedup = new Set();
  for (const t of triggers) {
    const id = `trigger:${t.route}|${t.label}`;
    if (triggerDedup.has(id)) continue;
    triggerDedup.add(id);

    nodeMap.set(id, {
      id, type: 'trigger', label: t.label, route: t.route,
      meta: {
        element: t.element,
        selector: t.selector,
        parent_nav: t.parent_nav || false,
        depth: t.depth || 0,
        href: t.href || null,
      },
    });

    // Edge: route → trigger (contains)
    const routeId = `route:${t.route}`;
    edges.push({ from: routeId, to: id, type: 'contains' });

    // Edge: trigger → route (navigates_to) from href
    if (t.href) {
      let targetPath = t.href;
      try {
        // Handle absolute URLs by extracting pathname
        if (t.href.startsWith('http')) {
          targetPath = new URL(t.href).pathname;
        }
      } catch { /* keep as-is */ }
      const targetRouteId = `route:${targetPath}`;
      // Ensure target route node exists
      if (!nodeMap.has(targetRouteId)) {
        nodeMap.set(targetRouteId, { id: targetRouteId, type: 'route', label: targetPath, route: targetPath, meta: {} });
      }
      edges.push({ from: id, to: targetRouteId, type: 'navigates_to' });
    }
  }

  // --- 3. Surface nodes ---
  for (const s of surfaces) {
    const id = `surface:${s.nodeId}`;
    nodeMap.set(id, {
      id, type: 'surface', label: s.label || s.nodeId, route: s.route,
      meta: {
        role: s.role,
        pattern: s.pattern,
        styleTokens: s.styleTokens,
      },
    });
  }

  // --- 4. Effect nodes from surface handlers + state ---
  for (const s of surfaces) {
    const surfaceId = `surface:${s.nodeId}`;

    // Handler-based effects
    for (const h of s.handlers) {
      let effectTarget = h.intent;
      // For navigate intents, try to derive a path from the surface label
      // (we don't have href on surfaces, so use the intent as the target)
      const effectId = `effect:${h.intent}:${s.route}`;
      if (!nodeMap.has(effectId)) {
        nodeMap.set(effectId, {
          id: effectId, type: 'effect', label: `${h.intent}`,
          meta: { kind: h.intent, event: h.event, route: s.route },
        });
      }
      edges.push({
        from: surfaceId, to: effectId, type: 'produces',
        meta: { event: h.event, intent: h.intent },
      });
    }

    // State-based effects
    for (const st of s.state) {
      const effectId = `effect:stateWrite:${st.key}`;
      if (!nodeMap.has(effectId)) {
        nodeMap.set(effectId, {
          id: effectId, type: 'effect', label: `write → ${st.key}`,
          meta: { kind: 'stateWrite', key: st.key, access: st.access },
        });
      }
      edges.push({
        from: surfaceId, to: effectId, type: 'writes',
        meta: { key: st.key, access: st.access },
      });
    }
  }

  // --- 5. Feature nodes ---
  for (const f of features) {
    const id = `feature:${f.id}`;
    nodeMap.set(id, {
      id, type: 'feature', label: f.name,
      meta: {
        sources: f.sources.map(s => `${s.file}:${s.line}`),
      },
    });
  }

  // --- 6. Trigger → Surface edges (maps_to) via label matching ---
  for (const t of triggers) {
    const triggerId = `trigger:${t.route}|${t.label}`;
    if (!nodeMap.has(triggerId)) continue;

    let bestSurface = null;
    let bestScore = 0;
    for (const s of surfaces) {
      if (!s.label) continue;
      const score = matchScore(t.label, s.label);
      if (score > bestScore) {
        bestScore = score;
        bestSurface = s;
      }
    }

    if (bestSurface && bestScore >= 0.4) {
      edges.push({
        from: triggerId,
        to: `surface:${bestSurface.nodeId}`,
        type: 'maps_to',
        weight: Math.round(bestScore * 100) / 100,
      });
    }
  }

  // --- 7. Feature → Trigger/Surface edges (documents) from diff.matched ---
  const matched = diff.matched || [];
  for (const m of matched) {
    const featureId = `feature:${m.feature_id}`;
    if (!nodeMap.has(featureId)) continue;

    // Try to find the matching trigger or surface node
    const triggerNodeId = `trigger:${m.trigger_route}|${m.trigger_label}`;
    if (nodeMap.has(triggerNodeId)) {
      edges.push({
        from: featureId, to: triggerNodeId, type: 'documents',
        weight: m.confidence,
      });
    }

    // Also check if match_type indicates a surface match
    if (m.match_type && m.match_type.startsWith('surface-')) {
      // Find the surface by label
      for (const s of surfaces) {
        const surfaceLabel = s.label || s.pattern || s.nodeId;
        if (matchScore(m.trigger_label, surfaceLabel) >= 0.4) {
          edges.push({
            from: featureId, to: `surface:${s.nodeId}`, type: 'documents',
            weight: m.confidence,
          });
          break;
        }
      }
    }
  }

  // --- Deduplicate edges ---
  const edgeKeys = new Set();
  const dedupedEdges = [];
  for (const e of edges) {
    const key = `${e.from}→${e.to}→${e.type}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      dedupedEdges.push(e);
    }
  }

  // --- Deterministic sort ---
  const nodes = [...nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  dedupedEdges.sort((a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.type.localeCompare(b.type)
  );

  // --- Stats ---
  /** @type {Record<string, number>} */
  const byType = { trigger: 0, surface: 0, effect: 0, route: 0, feature: 0 };
  for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;

  /** @type {Record<string, number>} */
  const byEdgeType = { maps_to: 0, produces: 0, writes: 0, navigates_to: 0, contains: 0, documents: 0 };
  for (const e of dedupedEdges) byEdgeType[e.type] = (byEdgeType[e.type] || 0) + 1;

  const orphanFeatures = findOrphanFeatures(nodes, dedupedEdges);
  const orphanTriggers = findOrphanTriggers(nodes, dedupedEdges);

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    nodes,
    edges: dedupedEdges,
    stats: {
      total_nodes: nodes.length,
      by_type: /** @type {any} */ (byType),
      total_edges: dedupedEdges.length,
      by_edge_type: /** @type {any} */ (byEdgeType),
      orphan_features: orphanFeatures.length,
      orphan_triggers: orphanTriggers.length,
    },
  };
}

// =============================================================================
// Surfacing Value
// =============================================================================

/**
 * Compute surfacing value for all trigger nodes.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {any[]} burialIndex - From diff.json burial_index
 * @returns {import('./types.mjs').SurfacingValue[]}
 */
export function computeSurfacingValues(graph, burialIndex) {
  const triggerNodes = graph.nodes.filter(n => n.type === 'trigger');
  const burialMap = new Map();
  for (const b of burialIndex) {
    burialMap.set(b.trigger_label, b.burial_score);
  }

  /** @type {import('./types.mjs').SurfacingValue[]} */
  const values = [];

  for (const node of triggerNodes) {
    // Count feature edges (documents edges pointing TO this trigger)
    const featureEdges = graph.edges.filter(e => e.to === node.id && e.type === 'documents').length;

    // Count effect edges reachable: trigger → surface (maps_to) → effect (produces/writes)
    const surfaceIds = graph.edges
      .filter(e => e.from === node.id && e.type === 'maps_to')
      .map(e => e.to);
    const effectEdges = graph.edges
      .filter(e => surfaceIds.includes(e.from) && (e.type === 'produces' || e.type === 'writes'))
      .length;

    const hasSurface = surfaceIds.length > 0;
    const parentNav = node.meta.parent_nav || false;
    const depth = node.meta.depth || 0;
    const burialScore = burialMap.get(node.label) || 0;

    const value = Math.max(0,
      featureEdges * 5
      + effectEdges * 2
      + (hasSurface ? 2 : 0)
      + (parentNav ? 2 : 0)
      + (depth === 0 ? 1 : 0)
      - burialScore * 0.5
    );

    values.push({
      trigger_id: node.id,
      label: node.label,
      route: node.route || '/',
      value: Math.round(value * 100) / 100,
      feature_edges: featureEdges,
      effect_edges: effectEdges,
      has_surface: hasSurface,
      parent_nav: parentNav,
    });
  }

  values.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return values;
}

// =============================================================================
// Orphan detection
// =============================================================================

/**
 * Find feature nodes with no incoming 'documents' edge.
 * @param {import('./types.mjs').GraphNode[]} nodes
 * @param {import('./types.mjs').GraphEdge[]} edges
 * @returns {{ id: string, name: string, source: string }[]}
 */
export function findOrphanFeatures(nodes, edges) {
  const documentedFeatures = new Set(
    edges.filter(e => e.type === 'documents').map(e => e.from)
  );
  return nodes
    .filter(n => n.type === 'feature' && !documentedFeatures.has(n.id))
    .map(n => ({
      id: n.id,
      name: n.label,
      source: (n.meta.sources || [])[0] || 'unknown',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Find trigger nodes with no outgoing 'maps_to' edge.
 * @param {import('./types.mjs').GraphNode[]} nodes
 * @param {import('./types.mjs').GraphEdge[]} edges
 * @returns {{ id: string, label: string, route: string }[]}
 */
export function findOrphanTriggers(nodes, edges) {
  const mappedTriggers = new Set(
    edges.filter(e => e.type === 'maps_to').map(e => e.from)
  );
  return nodes
    .filter(n => n.type === 'trigger' && !mappedTriggers.has(n.id))
    .map(n => ({ id: n.id, label: n.label, route: n.route || '/' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// =============================================================================
// Markdown report
// =============================================================================

/**
 * Generate a markdown trigger graph report.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').SurfacingValue[]} surfacingValues
 * @param {{ id: string, name: string, source: string }[]} orphanFeatures
 * @returns {string}
 */
export function generateGraphReport(graph, surfacingValues, orphanFeatures) {
  const lines = [];
  const s = graph.stats;

  lines.push('# Trigger Graph Report');
  lines.push('');
  lines.push(`Generated: ${graph.generated_at}`);
  lines.push('');

  // --- Summary ---
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **${s.total_nodes} nodes** (${s.by_type.trigger} triggers, ${s.by_type.surface} surfaces, ${s.by_type.effect} effects, ${s.by_type.route} routes, ${s.by_type.feature} features)`);
  lines.push(`- **${s.total_edges} edges** (${Object.entries(s.by_edge_type).filter(([,v]) => v > 0).map(([k,v]) => `${v} ${k}`).join(', ')})`);
  const totalFeatures = s.by_type.feature;
  const connectedFeatures = totalFeatures - s.orphan_features;
  lines.push(`- **Feature connectivity:** ${connectedFeatures}/${totalFeatures} features reachable from triggers`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Top 20 Triggers by Surfacing Value ---
  lines.push('## Top 20 Triggers by Surfacing Value');
  lines.push('');
  const top20 = surfacingValues.slice(0, 20);
  if (top20.length === 0) {
    lines.push('No triggers found.');
  } else {
    lines.push('| # | Trigger | Route | Value | Features | Effects | Nav |');
    lines.push('|---|---------|-------|-------|----------|---------|-----|');
    for (let i = 0; i < top20.length; i++) {
      const v = top20[i];
      lines.push(`| ${i + 1} | ${v.label} | ${v.route} | ${v.value} | ${v.feature_edges} | ${v.effect_edges} | ${v.parent_nav ? 'yes' : 'no'} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Unreachable Features ---
  lines.push('## Unreachable Features');
  lines.push('');
  lines.push('Features with no graph path from any trigger.');
  lines.push('');
  if (orphanFeatures.length === 0) {
    lines.push('All features are reachable.');
  } else {
    lines.push('| Feature | Source |');
    lines.push('|---------|--------|');
    for (const f of orphanFeatures) {
      lines.push(`| ${f.name} | ${f.source} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Effect Coverage ---
  lines.push('## Effect Coverage');
  lines.push('');
  const effectNodes = graph.nodes.filter(n => n.type === 'effect');
  if (effectNodes.length === 0) {
    lines.push('No effects detected.');
  } else {
    // Group effects by kind and find which surfaces produce them
    /** @type {Map<string, { effect: import('./types.mjs').GraphNode, triggeredBy: string[] }>} */
    const effectMap = new Map();
    for (const e of effectNodes) {
      const producers = graph.edges
        .filter(edge => edge.to === e.id && (edge.type === 'produces' || edge.type === 'writes'))
        .map(edge => {
          const sourceNode = graph.nodes.find(n => n.id === edge.from);
          return sourceNode ? sourceNode.label : edge.from;
        });
      effectMap.set(e.id, { effect: e, triggeredBy: producers });
    }

    lines.push('| Effect | Kind | Triggered By |');
    lines.push('|--------|------|--------------|');
    for (const [, { effect, triggeredBy }] of [...effectMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${effect.label} | ${effect.meta.kind || '-'} | ${triggeredBy.join(', ') || '-'} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Route Connectivity ---
  lines.push('## Route Connectivity');
  lines.push('');
  const routeNodes = graph.nodes.filter(n => n.type === 'route');
  if (routeNodes.length === 0) {
    lines.push('No routes found.');
  } else {
    lines.push('| Route | Triggers | Surfaces | Outbound |');
    lines.push('|-------|----------|----------|----------|');
    for (const r of routeNodes) {
      const triggerCount = graph.edges.filter(e => e.from === r.id && e.type === 'contains').length;
      const surfaceCount = graph.nodes.filter(n => n.type === 'surface' && n.route === r.route).length;
      const outbound = graph.edges
        .filter(e => {
          if (e.type !== 'navigates_to') return false;
          // Check if the trigger that navigates is contained in this route
          const triggerEdge = graph.edges.find(ce => ce.from === r.id && ce.to === e.from && ce.type === 'contains');
          return !!triggerEdge;
        })
        .map(e => {
          const targetNode = graph.nodes.find(n => n.id === e.to);
          return targetNode ? targetNode.label : e.to;
        });
      const uniqueOutbound = [...new Set(outbound)];
      lines.push(`| ${r.label} | ${triggerCount} | ${surfaceCount} | ${uniqueOutbound.join(', ') || '-'} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// =============================================================================
// DOT export
// =============================================================================

const DOT_COLORS = {
  trigger: '#4A90D9',
  surface: '#50C878',
  effect: '#FF6B6B',
  route: '#FFD700',
  feature: '#9B59B6',
};

const DOT_SHAPES = {
  trigger: 'box',
  surface: 'ellipse',
  effect: 'diamond',
  route: 'hexagon',
  feature: 'note',
};

/**
 * Generate a Graphviz DOT representation of the trigger graph.
 * @param {import('./types.mjs').TriggerGraph} graph
 * @returns {string}
 */
export function generateDot(graph) {
  const lines = [];
  lines.push('digraph TriggerGraph {');
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Helvetica" fontsize=10];');
  lines.push('  edge [fontname="Helvetica" fontsize=8];');
  lines.push('');

  // Subgraphs by node type
  for (const type of /** @type {const} */ (['trigger', 'surface', 'effect', 'route', 'feature'])) {
    const nodesOfType = graph.nodes.filter(n => n.type === type);
    if (nodesOfType.length === 0) continue;

    lines.push(`  subgraph cluster_${type} {`);
    lines.push(`    label="${type}s";`);
    lines.push(`    style=dashed;`);
    lines.push(`    color="${DOT_COLORS[type]}";`);
    for (const n of nodesOfType) {
      const escaped = n.label.replace(/"/g, '\\"');
      lines.push(`    "${n.id}" [label="${escaped}" shape=${DOT_SHAPES[type]} fillcolor="${DOT_COLORS[type]}" style=filled fontcolor=white];`);
    }
    lines.push('  }');
    lines.push('');
  }

  // Edges
  for (const e of graph.edges) {
    const label = e.type + (e.weight ? ` (${e.weight})` : '');
    const escaped = label.replace(/"/g, '\\"');
    lines.push(`  "${e.from}" -> "${e.to}" [label="${escaped}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}

// =============================================================================
// Runtime effects augmentation — pure function
// =============================================================================

/**
 * Intent mapping: runtime effect kind → graph intent.
 * @type {Record<string, string[]>}
 */
const RUNTIME_INTENT_MAP = {
  'fetch:POST': ['submit', 'delete', 'change'],
  'fetch:PUT': ['submit', 'change'],
  'fetch:PATCH': ['change'],
  'fetch:DELETE': ['delete'],
  'fetch:GET': ['search', 'filter', 'navigate'],
  'navigate': ['navigate'],
  'download': ['data'],
  'storageWrite': ['stateWrite'],
  'domEffect': [],
};

/**
 * Augment a trigger graph with observed runtime effects.
 * Returns a new graph (does not mutate the input).
 * @param {import('./types.mjs').TriggerGraph} graph
 * @param {import('./types.mjs').RuntimeEffectsSummary} runtimeSummary
 * @returns {import('./types.mjs').TriggerGraph}
 */
export function augmentWithRuntime(graph, runtimeSummary) {
  // Deep clone to avoid mutation
  const nodes = graph.nodes.map(n => ({ ...n, meta: { ...n.meta } }));
  const edges = graph.edges.map(e => ({ ...e, meta: e.meta ? { ...e.meta } : undefined }));

  /** @type {Map<string, import('./types.mjs').GraphNode>} */
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Delta tracking
  let nodesAdded = 0;
  let nodesUpdated = 0;
  let observedEffects = 0;
  let newEdges = 0;
  const originalNodeCount = nodes.length;
  const originalEdgeCount = edges.length;

  for (const trigger of runtimeSummary.triggers) {
    // Find matching trigger node in graph
    const triggerNode = nodes.find(n =>
      n.type === 'trigger' &&
      n.route === trigger.route &&
      (n.label === trigger.label || n.id === `trigger:${trigger.route}|${trigger.label}`)
    );

    for (const effect of trigger.effects) {
      // Determine the intent key for matching
      const intentKey = effect.kind === 'fetch'
        ? `fetch:${effect.method || 'GET'}`
        : effect.kind;
      const matchableIntents = RUNTIME_INTENT_MAP[intentKey] || [];

      // Try to find existing effect node that matches
      let matched = false;
      // Also try normalized ID as fallback
      const normalizedId = normalizeEffectId(effect);
      const candidateIds = [];
      for (const intent of matchableIntents) {
        const effectId = effect.kind === 'storageWrite'
          ? `effect:stateWrite:${effect.key}`
          : `effect:${intent}:${effect.route}`;
        candidateIds.push(effectId);
      }
      // Add normalized ID as last fallback
      if (!candidateIds.includes(normalizedId)) {
        candidateIds.push(normalizedId);
      }

      for (const effectId of candidateIds) {
        if (nodeMap.has(effectId)) {
          const node = nodeMap.get(effectId);
          const wasObserved = node.meta.observed;
          node.meta.observed = true;
          if (!node.meta.evidence) node.meta.evidence = [];
          node.meta.evidence.push({
            key: buildEvidenceKey(effect),
            kind: effect.kind,
            method: effect.method,
            url: effect.url,
            status: effect.status,
            filename: effect.filename,
            detail: effect.detail,
          });
          if (!wasObserved) nodesUpdated++;
          observedEffects++;
          matched = true;
          break;
        }
      }

      // If no match, create a new effect node
      if (!matched) {
        const newId = normalizeEffectId(effect);
        let label;
        if (effect.kind === 'fetch') {
          label = `${effect.method || 'GET'} ${effect.url}`;
        } else if (effect.kind === 'navigate') {
          label = `navigate → ${effect.to}`;
        } else if (effect.kind === 'download') {
          label = `download → ${effect.filename}`;
        } else if (effect.kind === 'storageWrite') {
          label = `write → ${effect.key}`;
        } else if (effect.kind === 'domEffect') {
          label = `dom → ${effect.detail}`;
        } else {
          continue;
        }

        if (!nodeMap.has(newId)) {
          const newNode = {
            id: newId,
            type: /** @type {const} */ ('effect'),
            label,
            meta: {
              kind: effect.kind,
              observed: true,
              evidence: [{
                key: buildEvidenceKey(effect),
                kind: effect.kind,
                method: effect.method,
                url: effect.url,
                status: effect.status,
                filename: effect.filename,
                detail: effect.detail,
              }],
            },
          };
          nodeMap.set(newId, newNode);
          nodes.push(newNode);
          nodesAdded++;
          observedEffects++;
        } else {
          // Node already exists (created by earlier runtime effect) — append evidence
          const existing = nodeMap.get(newId);
          if (!existing.meta.evidence) existing.meta.evidence = [];
          existing.meta.evidence.push({
            key: buildEvidenceKey(effect),
            kind: effect.kind,
            method: effect.method,
            url: effect.url,
            status: effect.status,
            filename: effect.filename,
            detail: effect.detail,
          });
          observedEffects++;
        }

        // Add runtime_observed edge from trigger if we found the trigger node
        if (triggerNode) {
          edges.push({
            from: triggerNode.id,
            to: newId,
            type: 'runtime_observed',
          });
          newEdges++;
        }
      }
    }
  }

  // Deduplicate evidence + set confidence on all observed nodes
  for (const node of nodes) {
    if (node.meta.evidence && node.meta.evidence.length > 0) {
      node.meta.evidence = deduplicateEvidence(node.meta.evidence);
      node.meta.confidence = computeConfidence(node.meta.evidence);
      node.meta.lastObservedAt = runtimeSummary.generated_at;
      node.meta.observedCount = node.meta.evidence.length;
    }
  }

  // Re-sort nodes and deduplicate edges
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  const edgeKeys = new Set();
  const dedupedEdges = [];
  for (const e of edges) {
    const key = `${e.from}→${e.to}→${e.type}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      dedupedEdges.push(e);
    }
  }
  dedupedEdges.sort((a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.type.localeCompare(b.type)
  );

  // Recompute stats
  /** @type {Record<string, number>} */
  const byType = { trigger: 0, surface: 0, effect: 0, route: 0, feature: 0 };
  for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;

  /** @type {Record<string, number>} */
  const byEdgeType = { maps_to: 0, produces: 0, writes: 0, navigates_to: 0, contains: 0, documents: 0, runtime_observed: 0 };
  for (const e of dedupedEdges) byEdgeType[e.type] = (byEdgeType[e.type] || 0) + 1;

  const orphanFeatures = findOrphanFeatures(nodes, dedupedEdges);
  const orphanTriggers = findOrphanTriggers(nodes, dedupedEdges);

  // Build graphDelta
  const hasChanges = nodesAdded > 0 || nodesUpdated > 0 || observedEffects > 0 || newEdges > 0;
  const reason = hasChanges
    ? `augmented: ${nodesAdded} nodes added, ${nodesUpdated} nodes updated, ${observedEffects} effects observed, ${newEdges} new edges`
    : 'no runtime effects matched';

  /** @type {import('./types.mjs').GraphDelta} */
  const graphDelta = { nodesAdded, nodesUpdated, observedEffects, newEdges, reason };

  return {
    version: hasChanges ? '1.1.0' : '1.0.0',
    generated_at: graph.generated_at,
    nodes,
    edges: dedupedEdges,
    stats: {
      total_nodes: nodes.length,
      by_type: /** @type {any} */ (byType),
      total_edges: dedupedEdges.length,
      by_edge_type: /** @type {any} */ (byEdgeType),
      orphan_features: orphanFeatures.length,
      orphan_triggers: orphanTriggers.length,
    },
    graphDelta,
  };
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * Run the Graph command.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, withRuntime?: boolean }} flags
 */
export async function runGraph(config, flags) {
  const cwd = process.cwd();

  // Load atlas
  const atlasPath = resolve(cwd, config.output.atlas);
  if (!existsSync(atlasPath)) {
    fail('GRAPH_NO_ATLAS', `Atlas file not found: ${atlasPath}`, 'Run "ai-ui atlas" first.');
  }
  const atlas = JSON.parse(readFileSync(atlasPath, 'utf-8'));

  // Load probe
  const probePath = resolve(cwd, config.output.probe);
  if (!existsSync(probePath)) {
    fail('GRAPH_NO_PROBE', `Probe file not found: ${probePath}`, 'Run "ai-ui probe" first.');
  }
  const probeLines = readFileSync(probePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

  const triggers = probeLines.filter(l => l.type === 'trigger');
  const routeChanges = probeLines.filter(l => l.type === 'route_change');
  const features = atlas.features || [];

  // Load surfaces (optional)
  const surfacesPath = resolve(cwd, config.output.surfaces);
  /** @type {import('./types.mjs').Surface[]} */
  let surfaces = [];
  if (existsSync(surfacesPath)) {
    try {
      const inv = JSON.parse(readFileSync(surfacesPath, 'utf-8'));
      surfaces = inv.surfaces || [];
      if (flags.verbose) {
        console.log(`Graph: loaded ${surfaces.length} surfaces from ${relative(cwd, surfacesPath)}`);
      }
    } catch { /* optional */ }
  }

  // Load diff (optional but needed for documents edges + burial index)
  const diffPath = resolve(cwd, config.output.diff);
  let diff = { matched: [], burial_index: [] };
  if (existsSync(diffPath)) {
    try {
      diff = JSON.parse(readFileSync(diffPath, 'utf-8'));
      if (flags.verbose) {
        console.log(`Graph: loaded diff from ${relative(cwd, diffPath)}`);
      }
    } catch { /* optional */ }
  }

  if (flags.verbose) {
    console.log(`Graph: ${triggers.length} triggers, ${surfaces.length} surfaces, ${features.length} features, ${routeChanges.length} route changes`);
  }

  // Build graph
  let graph = buildGraph(triggers, routeChanges, surfaces, features, diff);

  // --with-runtime: augment with runtime effects if available
  if (flags.withRuntime) {
    const runtimePath = resolve(cwd, config.output.runtimeEffectsSummary);
    if (existsSync(runtimePath)) {
      try {
        const runtimeSummary = JSON.parse(readFileSync(runtimePath, 'utf-8'));
        graph = augmentWithRuntime(graph, runtimeSummary);
        if (flags.verbose) {
          console.log(`Graph: augmented with runtime effects (v${graph.version})`);
        }
      } catch (e) {
        if (flags.verbose) {
          console.log(`Graph: failed to load runtime effects: ${e.message}`);
        }
      }
    } else if (flags.verbose) {
      console.log('Graph: --with-runtime specified but no runtime-effects.summary.json found');
    }
  }

  // Compute surfacing values
  const surfacingValues = computeSurfacingValues(graph, diff.burial_index || []);
  const orphanFeats = findOrphanFeatures(graph.nodes, graph.edges);

  // Write trigger-graph.json
  const graphPath = resolve(cwd, config.output.graph);
  mkdirSync(dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');

  // Write trigger-graph.md
  const reportPath = resolve(cwd, config.output.graphReport);
  writeFileSync(reportPath, generateGraphReport(graph, surfacingValues, orphanFeats), 'utf-8');

  // Write trigger-graph.dot
  const dotPath = resolve(cwd, config.output.graphDot);
  writeFileSync(dotPath, generateDot(graph), 'utf-8');

  console.log(`Graph: ${graph.stats.total_nodes} nodes, ${graph.stats.total_edges} edges → ${relative(cwd, graphPath)}`);
  if (flags.verbose) {
    console.log(`  Version: ${graph.version}`);
    console.log(`  Nodes: ${Object.entries(graph.stats.by_type).map(([k,v]) => `${v} ${k}`).join(', ')}`);
    console.log(`  Edges: ${Object.entries(graph.stats.by_edge_type).filter(([,v]) => v > 0).map(([k,v]) => `${v} ${k}`).join(', ')}`);
    console.log(`  Orphan features: ${graph.stats.orphan_features}, Orphan triggers: ${graph.stats.orphan_triggers}`);
  }
}
