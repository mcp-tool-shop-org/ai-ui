// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEIGHTS,
  patternScore,
  intentScore,
  styleScore,
  compositeScore,
  scoreCandidate,
  classifyFailure,
  generateSuggestions,
  detectAmbiguous,
  enrichDiscoverable,
  formatFailureReason,
} from '../src/diagnostics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/diagnostics-fixtures.json'), 'utf-8'));

// =============================================================================
// patternScore
// =============================================================================

describe('patternScore', () => {
  it('returns 1.0 when feature word matches pattern affinity', () => {
    assert.equal(patternScore(['search'], 'search_bar'), 1.0);
    assert.equal(patternScore(['login'], 'auth_form'), 1.0);
    assert.equal(patternScore(['table'], 'data_table'), 1.0);
    assert.equal(patternScore(['nav'], 'nav_menu'), 1.0);
  });

  it('returns 0 when no affinity match', () => {
    assert.equal(patternScore(['color', 'roles'], 'search_bar'), 0);
    assert.equal(patternScore(['spacing'], 'nav_menu'), 0);
  });

  it('returns 0 when pattern is null', () => {
    assert.equal(patternScore(['search'], null), 0);
  });
});

// =============================================================================
// intentScore
// =============================================================================

describe('intentScore', () => {
  it('returns 1.0 when feature word matches handler intent', () => {
    assert.equal(intentScore(['delete'], [{ event: 'click', intent: 'delete' }]), 1.0);
    assert.equal(intentScore(['navigate'], [{ event: 'click', intent: 'navigate' }]), 1.0);
    assert.equal(intentScore(['search'], [{ event: 'submit', intent: 'search' }]), 1.0);
  });

  it('returns 0 when no intent match', () => {
    assert.equal(intentScore(['color', 'roles'], [{ event: 'click', intent: 'navigate' }]), 0);
  });

  it('returns 0 when handlers empty', () => {
    assert.equal(intentScore(['delete'], []), 0);
  });
});

// =============================================================================
// styleScore
// =============================================================================

describe('styleScore', () => {
  it('returns 1.0 when feature word matches style token', () => {
    assert.equal(styleScore(['delete'], ['destructive']), 1.0);
    assert.equal(styleScore(['primary'], ['primary']), 1.0);
    assert.equal(styleScore(['danger'], ['destructive']), 1.0);
  });

  it('returns 0 when no style match', () => {
    assert.equal(styleScore(['color', 'roles'], ['primary']), 0);
  });

  it('returns 0 when tokens empty', () => {
    assert.equal(styleScore(['delete'], []), 0);
  });
});

// =============================================================================
// compositeScore
// =============================================================================

describe('compositeScore', () => {
  it('respects WEIGHTS', () => {
    const result = compositeScore(1.0, 0, 0, 0);
    assert.equal(result, WEIGHTS.label);
  });

  it('sums all dimensions with weights', () => {
    const result = compositeScore(1.0, 1.0, 1.0, 1.0);
    assert.ok(Math.abs(result - 1.0) < 0.001);
  });

  it('returns 0 for all zeros', () => {
    assert.equal(compositeScore(0, 0, 0, 0), 0);
  });
});

// =============================================================================
// scoreCandidate
// =============================================================================

describe('scoreCandidate', () => {
  it('returns 1.0 label_score for exact name match', () => {
    const attempt = scoreCandidate(['Search'], {
      source_type: 'trigger',
      source_id: '/|Search',
      source_label: 'Search',
      source_route: '/',
      pattern: null,
      handlers: [],
      styleTokens: [],
    });
    assert.equal(attempt.label_score, 1.0);
    assert.equal(attempt.match_dimension, 'label');
  });

  it('returns 0 for completely unrelated strings', () => {
    const attempt = scoreCandidate(['Color roles'], {
      source_type: 'trigger',
      source_id: '/|xyz',
      source_label: 'xyz',
      source_route: '/',
      pattern: null,
      handlers: [],
      styleTokens: [],
    });
    assert.equal(attempt.label_score, 0);
    assert.equal(attempt.composite_score, 0);
  });

  it('computes pattern_score when pattern matches affinity', () => {
    const attempt = scoreCandidate(['Search'], {
      source_type: 'surface',
      source_id: 'sb-1',
      source_label: 'global-search',
      source_route: '/',
      pattern: 'search_bar',
      handlers: [],
      styleTokens: [],
    });
    assert.equal(attempt.pattern_score, 1.0);
  });

  it('computes intent_score when handler intent matches affinity', () => {
    const attempt = scoreCandidate(['Delete account'], {
      source_type: 'surface',
      source_id: 'btn-del',
      source_label: 'remove',
      source_route: '/',
      pattern: null,
      handlers: [{ event: 'click', intent: 'delete' }],
      styleTokens: ['destructive'],
    });
    assert.equal(attempt.intent_score, 1.0);
    assert.equal(attempt.style_score, 1.0);
  });

  it('uses best label score across synonyms', () => {
    const attempt = scoreCandidate(['Delete account', 'remove account'], {
      source_type: 'surface',
      source_id: 'btn-del',
      source_label: 'delete-account',
      source_route: '/',
      pattern: null,
      handlers: [],
      styleTokens: [],
    });
    // "delete account" vs "delete-account" → normalize → should get high label score
    assert.ok(attempt.label_score > 0.5);
  });

  it('rounds scores to 2 decimals', () => {
    const attempt = scoreCandidate(['test'], {
      source_type: 'trigger',
      source_id: '/|test',
      source_label: 'testing',
      source_route: '/',
      pattern: null,
      handlers: [],
      styleTokens: [],
    });
    const decimals = String(attempt.composite_score).split('.')[1] || '';
    assert.ok(decimals.length <= 2);
  });
});

// =============================================================================
// classifyFailure
// =============================================================================

describe('classifyFailure', () => {
  const feature = fixtures.features[2]; // color-roles

  it('returns missing_surface when no surfaces and no candidates', () => {
    assert.equal(classifyFailure(feature, [], []), 'missing_surface');
  });

  it('returns missing_surface when best composite is 0', () => {
    const candidates = [{ composite_score: 0, label_score: 0, pattern_score: 0 }];
    assert.equal(classifyFailure(feature, candidates, fixtures.surfaces), 'missing_surface');
  });

  it('returns intent_mismatch when label matched but composite too low', () => {
    const candidates = [{ composite_score: 0.35, label_score: 0.4, pattern_score: 0 }];
    assert.equal(classifyFailure(feature, candidates, fixtures.surfaces), 'intent_mismatch');
  });

  it('returns label_mismatch when pattern matched but label did not', () => {
    const candidates = [{ composite_score: 0.3, label_score: 0.1, pattern_score: 0.7 }];
    assert.equal(classifyFailure(feature, candidates, fixtures.surfaces), 'label_mismatch');
  });

  it('returns pattern_mismatch as default', () => {
    const candidates = [{ composite_score: 0.2, label_score: 0.1, pattern_score: 0.1 }];
    assert.equal(classifyFailure(feature, candidates, fixtures.surfaces), 'pattern_mismatch');
  });
});

// =============================================================================
// generateSuggestions
// =============================================================================

describe('generateSuggestions', () => {
  it('suggests nav_menu when triggers include parent_nav items', () => {
    const feature = fixtures.features[2]; // color-roles
    const suggestions = generateSuggestions(feature, fixtures.surfaces, fixtures.triggers);
    const navSugg = suggestions.find(s => s.rule === 'nav_menu_available');
    assert.ok(navSugg, 'should suggest nav_menu_available');
    assert.ok(navSugg.action.includes('Color roles'));
    assert.ok(navSugg.action.includes('navigation'));
  });

  it('suggests overflow_advanced for settings/config features', () => {
    const feature = fixtures.features[2]; // color-roles (has "color" → advanced)
    const suggestions = generateSuggestions(feature, fixtures.surfaces, fixtures.triggers);
    const advSugg = suggestions.find(s => s.rule === 'overflow_advanced');
    assert.ok(advSugg, 'should suggest overflow_advanced for "color roles"');
  });

  it('always includes generic_cta as fallback', () => {
    const feature = fixtures.features[2];
    const suggestions = generateSuggestions(feature, fixtures.surfaces, fixtures.triggers);
    const generic = suggestions.find(s => s.rule === 'generic_cta');
    assert.ok(generic, 'should always include generic_cta');
    assert.ok(generic.action.includes('Color roles'));
  });

  it('includes tag_hint with correct feature ID', () => {
    const feature = fixtures.features[0]; // search
    const suggestions = generateSuggestions(feature, fixtures.surfaces, fixtures.triggers);
    for (const s of suggestions) {
      assert.ok(s.tag_hint.includes('feature.search'));
    }
  });

  it('returns deterministic order', () => {
    const feature = fixtures.features[2];
    const s1 = generateSuggestions(feature, fixtures.surfaces, fixtures.triggers);
    const s2 = generateSuggestions(feature, fixtures.surfaces, fixtures.triggers);
    assert.deepEqual(s1, s2);
  });
});

// =============================================================================
// detectAmbiguous
// =============================================================================

describe('detectAmbiguous', () => {
  const feature = fixtures.features[0];

  it('returns null when fewer than 2 candidates', () => {
    assert.equal(detectAmbiguous(feature, [{ composite_score: 0.5 }]), null);
  });

  it('returns null when top candidate is clearly ahead', () => {
    const candidates = [
      { composite_score: 0.8, source_id: 'a' },
      { composite_score: 0.3, source_id: 'b' },
    ];
    assert.equal(detectAmbiguous(feature, candidates), null);
  });

  it('returns AmbiguousMatch when gap < 0.05', () => {
    const candidates = [
      { composite_score: 0.6, source_id: 'a' },
      { composite_score: 0.58, source_id: 'b' },
    ];
    const result = detectAmbiguous(feature, candidates);
    assert.ok(result, 'should detect ambiguity');
    assert.equal(result.feature_id, 'search');
    assert.equal(result.tied_candidates.length, 2);
    assert.equal(result.confidence_gap, 0.02);
  });

  it('returns null when top score below 0.4', () => {
    const candidates = [
      { composite_score: 0.3, source_id: 'a' },
      { composite_score: 0.28, source_id: 'b' },
    ];
    assert.equal(detectAmbiguous(feature, candidates), null);
  });
});

// =============================================================================
// enrichDiscoverable
// =============================================================================

describe('enrichDiscoverable', () => {
  it('cross-references trigger with matching surface by label', () => {
    const trigger = { label: 'Search', route: '/', selector: 'a.search' };
    const result = enrichDiscoverable(trigger, fixtures.surfaces);
    assert.equal(result.surface_evidence.has_surface, true);
    assert.equal(result.surface_evidence.surface_nodeId, 'search-bar-1');
    assert.equal(result.surface_evidence.surface_pattern, 'search_bar');
  });

  it('returns has_surface false when no match', () => {
    const trigger = { label: 'Unknown', route: '/', selector: 'a.unknown' };
    const result = enrichDiscoverable(trigger, fixtures.surfaces);
    assert.equal(result.surface_evidence.has_surface, false);
  });

  it('generates doc_suggestion text', () => {
    const trigger = { label: 'Search', route: '/', selector: 'a.search' };
    const result = enrichDiscoverable(trigger, fixtures.surfaces);
    assert.ok(result.doc_suggestion.includes('Search'));
  });
});

// =============================================================================
// formatFailureReason
// =============================================================================

describe('formatFailureReason', () => {
  it('formats all reason types', () => {
    assert.ok(formatFailureReason('missing_surface').length > 0);
    assert.ok(formatFailureReason('label_mismatch').length > 0);
    assert.ok(formatFailureReason('intent_mismatch').length > 0);
    assert.ok(formatFailureReason('pattern_mismatch').length > 0);
  });
});
