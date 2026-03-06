// @ts-check
import { matchScore, normalize } from './normalize.mjs';

// =============================================================================
// Weights for composite scoring
// =============================================================================

/** @type {{ label: number, pattern: number, intent: number, style: number }} */
export const WEIGHTS = {
  label: 0.50,
  pattern: 0.20,
  intent: 0.20,
  style: 0.10,
};

// =============================================================================
// Affinity tables: feature keywords → candidate signals
// =============================================================================

/** Feature keyword → relevant pattern kinds */
const PATTERN_AFFINITY = {
  search: ['search_bar'],
  auth: ['auth_form'],
  login: ['auth_form'],
  signup: ['auth_form'],
  register: ['auth_form'],
  nav: ['nav_menu'],
  menu: ['nav_menu'],
  navigation: ['nav_menu'],
  table: ['data_table'],
  list: ['data_table'],
  grid: ['data_table'],
  form: ['auth_form'],
  wizard: ['wizard_step'],
  step: ['wizard_step'],
  player: ['media_player'],
  video: ['media_player'],
  audio: ['media_player'],
  chat: ['chat_thread'],
  message: ['chat_thread'],
  dashboard: ['dashboard_widget'],
  widget: ['dashboard_widget'],
  card: ['product_card'],
  product: ['product_card'],
  hero: ['custom'],
};

/** Feature verb → relevant handler intents */
const INTENT_AFFINITY = {
  go: ['navigate'],
  navigate: ['navigate'],
  start: ['navigate'],
  open: ['navigate'],
  view: ['navigate'],
  visit: ['navigate'],
  save: ['submit_form', 'submit'],
  submit: ['submit_form', 'submit'],
  apply: ['submit_form'],
  send: ['submit_form'],
  search: ['search', 'filter'],
  filter: ['filter'],
  find: ['search', 'filter'],
  delete: ['delete'],
  remove: ['delete'],
  destroy: ['delete'],
  edit: ['validate', 'input'],
  change: ['input', 'change'],
  toggle: ['toggle_menu', 'change'],
  select: ['change', 'input'],
  validate: ['validate'],
};

/** Feature characteristic → relevant style tokens */
const STYLE_AFFINITY = {
  primary: ['primary'],
  main: ['primary'],
  action: ['primary'],
  cta: ['primary'],
  danger: ['destructive'],
  destructive: ['destructive'],
  delete: ['destructive'],
  remove: ['destructive'],
  warning: ['warning'],
  warn: ['warning'],
  caution: ['warning'],
  success: ['success'],
  confirm: ['success'],
  info: ['info'],
  secondary: ['secondary'],
};

// =============================================================================
// Suggestion heuristic keywords
// =============================================================================

export const ONBOARDING_WORDS = new Set([
  'start', 'begin', 'setup', 'onboard', 'welcome', 'try', 'demo', 'intro', 'get',
]);

export const ADVANCED_WORDS = new Set([
  'settings', 'preferences', 'configure', 'config', 'advanced', 'tokens',
  'options', 'admin', 'debug', 'export', 'import', 'api', 'webhook',
  'roles', 'permissions', 'scale', 'spacing', 'color', 'theme', 'dark',
]);

export const DATA_WORDS = new Set([
  'list', 'table', 'view', 'manage', 'filter', 'sort', 'data', 'items',
  'records', 'entries', 'rows', 'columns',
]);

// =============================================================================
// Scoring functions
// =============================================================================

/**
 * Compute pattern affinity score.
 * @param {string[]} featureWords - normalized words from feature name
 * @param {string|null} candidatePattern - PatternSignal kind
 * @returns {number} 0-1
 */
export function patternScore(featureWords, candidatePattern) {
  if (!candidatePattern) return 0;
  for (const word of featureWords) {
    const affinities = PATTERN_AFFINITY[word];
    if (affinities && affinities.includes(candidatePattern)) return 1.0;
  }
  return 0;
}

/**
 * Compute intent affinity score.
 * @param {string[]} featureWords - normalized words from feature name
 * @param {{ event: string, intent: string }[]} candidateHandlers
 * @returns {number} 0-1
 */
export function intentScore(featureWords, candidateHandlers) {
  if (!candidateHandlers || candidateHandlers.length === 0) return 0;
  const intents = candidateHandlers.map(h => h.intent);
  for (const word of featureWords) {
    const affinities = INTENT_AFFINITY[word];
    if (affinities) {
      for (const aff of affinities) {
        if (intents.includes(aff)) return 1.0;
      }
    }
  }
  return 0;
}

/**
 * Compute style token affinity score.
 * @param {string[]} featureWords - normalized words from feature name
 * @param {string[]} candidateStyleTokens
 * @returns {number} 0-1
 */
export function styleScore(featureWords, candidateStyleTokens) {
  if (!candidateStyleTokens || candidateStyleTokens.length === 0) return 0;
  for (const word of featureWords) {
    const affinities = STYLE_AFFINITY[word];
    if (affinities) {
      for (const aff of affinities) {
        if (candidateStyleTokens.includes(aff)) return 1.0;
      }
    }
  }
  return 0;
}

/**
 * Compute weighted composite score.
 * @param {number} label
 * @param {number} pattern
 * @param {number} intent
 * @param {number} style
 * @returns {number}
 */
export function compositeScore(label, pattern, intent, style) {
  return label * WEIGHTS.label + pattern * WEIGHTS.pattern + intent * WEIGHTS.intent + style * WEIGHTS.style;
}

/**
 * Score a single candidate against feature names across all 4 dimensions.
 * @param {string[]} featureNames - [feature.name, ...feature.synonyms]
 * @param {Object} candidate
 * @param {'trigger'|'surface'} candidate.source_type
 * @param {string} candidate.source_id
 * @param {string} candidate.source_label
 * @param {string} candidate.source_route
 * @param {string|null} candidate.pattern
 * @param {{ event: string, intent: string }[]} candidate.handlers
 * @param {string[]} candidate.styleTokens
 * @param {string[]} [candidate.enriched_labels] - aria-label, title, etc.
 * @returns {import('./types.mjs').CandidateAttempt}
 */
export function scoreCandidate(featureNames, candidate) {
  // Best label score across all feature name variants AND enriched labels
  const allLabels = [candidate.source_label, ...(candidate.enriched_labels || [])];
  let bestLabel = 0;
  for (const name of featureNames) {
    for (const candidateLabel of allLabels) {
      if (!candidateLabel) continue;
      const score = matchScore(name, candidateLabel);
      if (score > bestLabel) bestLabel = score;
    }
  }

  // Extract words from all feature names for affinity matching
  const allWords = featureNames.flatMap(n => normalize(n).split(' ').filter(Boolean));
  const uniqueWords = [...new Set(allWords)];

  const pScore = patternScore(uniqueWords, candidate.pattern);
  const iScore = intentScore(uniqueWords, candidate.handlers);
  const sScore = styleScore(uniqueWords, candidate.styleTokens);
  const comp = compositeScore(bestLabel, pScore, iScore, sScore);

  // Determine which dimension scored highest
  const dims = [
    { name: 'label', score: bestLabel },
    { name: 'pattern', score: pScore },
    { name: 'intent', score: iScore },
    { name: 'style', score: sScore },
  ];
  dims.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    source_type: candidate.source_type,
    source_id: candidate.source_id,
    source_label: candidate.source_label,
    source_route: candidate.source_route,
    label_score: Math.round(bestLabel * 100) / 100,
    pattern_score: Math.round(pScore * 100) / 100,
    intent_score: Math.round(iScore * 100) / 100,
    style_score: Math.round(sScore * 100) / 100,
    composite_score: Math.round(comp * 100) / 100,
    match_dimension: dims[0].name,
  };
}

// =============================================================================
// Failure reason classification
// =============================================================================

/**
 * Classify why a feature failed to match.
 * @param {import('./types.mjs').Feature} feature
 * @param {import('./types.mjs').CandidateAttempt[]} topCandidates
 * @param {import('./types.mjs').Surface[]} surfaces
 * @returns {import('./types.mjs').FailureReason}
 */
export function classifyFailure(feature, topCandidates, surfaces) {
  if (surfaces.length === 0 && topCandidates.length === 0) return 'missing_surface';
  if (topCandidates.length === 0) return 'missing_surface';

  const best = topCandidates[0];
  if (best.composite_score === 0) return 'missing_surface';

  // Label partially matched but intent/pattern didn't push it over threshold
  if (best.label_score >= 0.3 && best.composite_score < 0.4) return 'intent_mismatch';

  // Pattern matched but label was wrong
  if (best.pattern_score >= 0.5 && best.label_score < 0.3) return 'label_mismatch';

  return 'pattern_mismatch';
}

/**
 * Format failure reason into backward-compatible reason string.
 * @param {import('./types.mjs').FailureReason} reason
 * @returns {string}
 */
export function formatFailureReason(reason) {
  switch (reason) {
    case 'missing_surface': return 'No trigger or surface found with any signal overlap';
    case 'label_mismatch': return 'Pattern matched but label did not overlap';
    case 'intent_mismatch': return 'Label partially matched but intent/pattern did not align';
    case 'pattern_mismatch': return 'No trigger or surface matched above threshold';
    default: return 'No matching trigger found in any crawled route';
  }
}

// =============================================================================
// Fix suggestion generation (rule-based heuristics)
// =============================================================================

/**
 * Generate concrete fix suggestions for an unmatched feature.
 * @param {import('./types.mjs').Feature} feature
 * @param {import('./types.mjs').Surface[]} surfaces
 * @param {any[]} triggers - probe triggers
 * @returns {import('./types.mjs').FixSuggestion[]}
 */
export function generateSuggestions(feature, surfaces, triggers) {
  /** @type {import('./types.mjs').FixSuggestion[]} */
  const suggestions = [];
  const words = normalize(feature.name).split(' ').filter(Boolean);
  const tagHint = `data-aiui='feature.${feature.id}'`;

  // Rule: nav_menu_available — if any trigger is in primary nav
  const hasNav = triggers.some(t => t.parent_nav);
  if (hasNav) {
    suggestions.push({
      action: `Add '${feature.name}' to the primary navigation`,
      rule: 'nav_menu_available',
      tag_hint: tagHint,
    });
  }

  // Rule: hero_cta — onboarding-like features
  const isOnboarding = words.some(w => ONBOARDING_WORDS.has(w));
  const hasHero = surfaces.some(s => s.pattern === 'custom' || s.role === 'SECTION');
  if (isOnboarding || (hasHero && words.length <= 3)) {
    suggestions.push({
      action: `Add a primary CTA labeled '${feature.name}' in the Hero section`,
      rule: 'hero_cta',
      tag_hint: tagHint,
    });
  }

  // Rule: table_action — data-centric features
  const isDataFeature = words.some(w => DATA_WORDS.has(w));
  const hasTable = surfaces.some(s => s.pattern === 'data_table');
  if (isDataFeature && hasTable) {
    suggestions.push({
      action: `Add row action or toolbar button for '${feature.name}' in the data table`,
      rule: 'table_action',
      tag_hint: tagHint,
    });
  }

  // Rule: overflow_advanced — settings/config/advanced features
  const isAdvanced = words.some(w => ADVANCED_WORDS.has(w));
  if (isAdvanced) {
    suggestions.push({
      action: `Add '${feature.name}' to overflow menu or settings panel`,
      rule: 'overflow_advanced',
      tag_hint: tagHint,
    });
  }

  // Rule: generic_cta — always as fallback
  const route = triggers.length > 0 ? triggers[0].route : '/';
  suggestions.push({
    action: `Add a CTA on ${route} labeled '${feature.name}'`,
    rule: 'generic_cta',
    tag_hint: tagHint,
  });

  return suggestions;
}

// =============================================================================
// Ambiguous match detection
// =============================================================================

/**
 * Detect if a feature has ambiguous matches (top candidates within gap).
 * @param {import('./types.mjs').Feature} feature
 * @param {import('./types.mjs').CandidateAttempt[]} candidates - sorted by composite desc
 * @param {number} [gap=0.05]
 * @returns {import('./types.mjs').AmbiguousMatch|null}
 */
export function detectAmbiguous(feature, candidates, gap = 0.05) {
  if (candidates.length < 2) return null;
  const top = candidates[0].composite_score;
  if (top < 0.4) return null; // only flag ambiguity on actual matches

  const tied = candidates.filter(c => top - c.composite_score <= gap);
  if (tied.length < 2) return null;

  return {
    feature_id: feature.id,
    feature_name: feature.name,
    tied_candidates: tied,
    confidence_gap: Math.round((candidates[0].composite_score - candidates[1].composite_score) * 100) / 100,
  };
}

// =============================================================================
// Discoverable-not-documented enrichment
// =============================================================================

/**
 * Enrich a discoverable-not-documented trigger with surface evidence.
 * @param {{ label: string, route: string, selector: string }} trigger
 * @param {import('./types.mjs').Surface[]} surfaces
 * @returns {{ surface_evidence: any, doc_suggestion: string }}
 */
export function enrichDiscoverable(trigger, surfaces) {
  // Find matching surface by label similarity
  let bestSurface = null;
  let bestScore = 0;
  for (const surface of surfaces) {
    if (!surface.label) continue;
    const score = matchScore(trigger.label, surface.label);
    if (score > bestScore) {
      bestScore = score;
      bestSurface = surface;
    }
  }

  const surfaceEvidence = bestSurface && bestScore >= 0.4
    ? {
        has_surface: true,
        surface_nodeId: bestSurface.nodeId,
        surface_pattern: bestSurface.pattern,
        surface_styleTokens: bestSurface.styleTokens,
        surface_handlers: bestSurface.handlers,
      }
    : { has_surface: false };

  // Build doc suggestion
  const parts = [trigger.label];
  if (bestSurface) {
    if (bestSurface.handlers.length > 0) {
      parts.push(`(${bestSurface.handlers.map(h => h.intent).join(', ')} action)`);
    }
    if (bestSurface.styleTokens.length > 0) {
      parts.push(`[${bestSurface.styleTokens.join(', ')}]`);
    }
  }

  return {
    surface_evidence: surfaceEvidence,
    doc_suggestion: `Add '${parts.join(' ')}' as a feature entry in atlas docs`,
  };
}
