// @ts-check
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestPrompt, parseBrainResponse, BrainParseError } from '../src/ai-suggest-prompt.mjs';
import { OllamaError } from '../src/ollama.mjs';

// =============================================================================
// Prompt builder tests
// =============================================================================

describe('buildSuggestPrompt', () => {
  it('includes feature text and candidates in prompt', () => {
    const prompt = buildSuggestPrompt({
      featureText: 'Ambient sound system with 42 tracks',
      docSection: 'Features',
      candidates: [
        { surface_id: 'trigger:/|Audio Settings', label: 'Audio Settings', route: '/', location_group: 'primary_nav', safety: 'safe', role: 'button' },
        { surface_id: 'trigger:/|Mute', label: 'Mute', route: '/', location_group: 'toolbar', safety: 'safe', role: 'button' },
      ],
      existingAliases: {},
    });

    assert.ok(prompt.includes('Ambient sound system with 42 tracks'));
    assert.ok(prompt.includes('Audio Settings'));
    assert.ok(prompt.includes('Mute'));
    assert.ok(prompt.includes('primary_nav'));
    assert.ok(prompt.includes('Doc section: "Features"'));
    assert.ok(prompt.includes('No existing featureAliases'));
  });

  it('includes existing aliases warning when present', () => {
    const prompt = buildSuggestPrompt({
      featureText: 'Audio controls',
      docSection: null,
      candidates: [
        { surface_id: 'trigger:/|Volume', label: 'Volume', route: '/', location_group: 'settings', safety: 'safe', role: 'slider' },
      ],
      existingAliases: { 'audio-controls': ['volume', 'sound'] },
    });

    assert.ok(prompt.includes('do NOT re-suggest'));
    assert.ok(prompt.includes('"audio-controls"'));
    assert.ok(!prompt.includes('Doc section:'));
  });

  it('handles empty candidates list', () => {
    const prompt = buildSuggestPrompt({
      featureText: 'Offline mode',
      docSection: null,
      candidates: [],
      existingAliases: {},
    });

    assert.ok(prompt.includes('Offline mode'));
    assert.ok(prompt.includes('CANDIDATE SURFACES:'));
  });
});

// =============================================================================
// Brain response parser tests
// =============================================================================

describe('parseBrainResponse', () => {
  it('parses a well-formed Brain response (LoKey-Typer Mute button)', () => {
    const raw = {
      best_candidates: [
        { surface_id: 'trigger:/|Audio Settings', label: 'Audio Settings', score: 0.92, rationale: 'Direct access to ambient sound configuration' },
        { surface_id: 'trigger:/|Mute ambient', label: 'Mute ambient', score: 0.78, rationale: 'Mute control for ambient sounds' },
      ],
      alias_terms: ['audio', 'sound', 'ambient', 'mute', 'soundscape'],
      anchor_label: 'Audio Settings',
      confidence: 0.88,
      notes: 'Strong match: Audio Settings button opens the ambient sound configuration panel',
    };

    const result = parseBrainResponse(raw, 'ambient-sound-system');

    assert.equal(result.feature_id, 'ambient-sound-system');
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].surface_id, 'trigger:/|Audio Settings');
    assert.equal(result.candidates[0].score, 0.92);
    assert.equal(result.candidates[1].score, 0.78);
    assert.deepEqual(result.recommended_aliases, ['audio', 'sound', 'ambient', 'mute', 'soundscape']);
    assert.equal(result.recommended_anchor, 'Audio Settings');
    assert.equal(result.confidence, 0.88);
  });

  it('sorts candidates by score descending', () => {
    const raw = {
      best_candidates: [
        { surface_id: 'a', label: 'A', score: 0.3, rationale: '' },
        { surface_id: 'b', label: 'B', score: 0.9, rationale: '' },
        { surface_id: 'c', label: 'C', score: 0.6, rationale: '' },
      ],
      alias_terms: [],
      anchor_label: null,
      confidence: 0.5,
      notes: '',
    };

    const result = parseBrainResponse(raw, 'test');
    assert.equal(result.candidates[0].surface_id, 'b');
    assert.equal(result.candidates[1].surface_id, 'c');
    assert.equal(result.candidates[2].surface_id, 'a');
  });

  it('deduplicates alias terms', () => {
    const raw = {
      best_candidates: [],
      alias_terms: ['audio', 'Audio', 'AUDIO', 'sound', 'audio'],
      anchor_label: null,
      confidence: 0.5,
      notes: '',
    };

    const result = parseBrainResponse(raw, 'test');
    assert.deepEqual(result.recommended_aliases, ['audio', 'sound']);
  });

  it('clamps scores to 0..1', () => {
    const raw = {
      best_candidates: [
        { surface_id: 'x', label: 'X', score: 1.5, rationale: '' },
        { surface_id: 'y', label: 'Y', score: -0.3, rationale: '' },
      ],
      alias_terms: [],
      anchor_label: null,
      confidence: 2.0,
      notes: '',
    };

    const result = parseBrainResponse(raw, 'test');
    assert.equal(result.candidates[0].score, 1);
    assert.equal(result.candidates[1].score, 0);
    assert.equal(result.confidence, 1);
  });

  it('handles missing/null fields gracefully', () => {
    const raw = {
      best_candidates: [
        { surface_id: 'trigger:/|X' },
      ],
      // missing: alias_terms, anchor_label, confidence, notes
    };

    const result = parseBrainResponse(raw, 'test');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].label, '');
    assert.equal(result.candidates[0].score, 0);
    assert.deepEqual(result.recommended_aliases, []);
    assert.equal(result.recommended_anchor, null);
    assert.equal(result.confidence, 0);
    assert.equal(result.notes, '');
  });

  it('filters out invalid candidates (no surface_id)', () => {
    const raw = {
      best_candidates: [
        { label: 'No ID', score: 0.9, rationale: 'missing surface_id' },
        null,
        { surface_id: 'valid', label: 'Valid', score: 0.8, rationale: 'ok' },
        42,
      ],
      alias_terms: [],
      anchor_label: null,
      confidence: 0.5,
      notes: '',
    };

    const result = parseBrainResponse(raw, 'test');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].surface_id, 'valid');
  });

  it('throws BrainParseError for non-object input', () => {
    assert.throws(
      () => parseBrainResponse(null, 'test'),
      (err) => err instanceof BrainParseError && err.featureId === 'test'
    );

    assert.throws(
      () => parseBrainResponse('string', 'test'),
      (err) => err instanceof BrainParseError
    );
  });

  it('filters empty/whitespace alias terms', () => {
    const raw = {
      best_candidates: [],
      alias_terms: ['', '  ', 'valid', '   also valid  ', ''],
      anchor_label: null,
      confidence: 0.3,
      notes: '',
    };

    const result = parseBrainResponse(raw, 'test');
    assert.deepEqual(result.recommended_aliases, ['valid', 'also valid']);
  });
});

// =============================================================================
// OllamaError tests
// =============================================================================

describe('OllamaError', () => {
  it('has code, message, hint, and name', () => {
    const err = new OllamaError('OLLAMA_TIMEOUT', 'timed out', 'try smaller model');
    assert.equal(err.code, 'OLLAMA_TIMEOUT');
    assert.equal(err.message, 'timed out');
    assert.equal(err.hint, 'try smaller model');
    assert.equal(err.name, 'OllamaError');
    assert.ok(err instanceof Error);
  });
});

// =============================================================================
// Integration-style tests (with mocked Ollama)
// =============================================================================

describe('ai-suggest patch generation', () => {
  // Test the patch logic by importing the module's internal via a thin wrapper
  // Since buildAliasPatch is not exported, we test it through the report shape

  it('existing aliases are preserved (append-only)', () => {
    // This tests the parseBrainResponse + patch merge logic
    const raw = {
      best_candidates: [
        { surface_id: 'trigger:/|Audio Settings', label: 'Audio Settings', score: 0.9, rationale: 'match' },
      ],
      alias_terms: ['audio', 'sound', 'settings'],
      anchor_label: 'Audio Settings',
      confidence: 0.9,
      notes: 'test',
    };

    const result = parseBrainResponse(raw, 'ambient-sound');

    // Simulate existing aliases
    const existingAliases = { 'ambient-sound': ['Audio Settings'] };
    const existingSet = new Set(existingAliases['ambient-sound'].map(a => a.toLowerCase()));

    // Filter out existing
    const newAliases = result.recommended_aliases.filter(t => !existingSet.has(t.toLowerCase()));
    const anchorNew = result.recommended_anchor && !existingSet.has(result.recommended_anchor.toLowerCase());

    // Should only include terms NOT already in existing
    assert.ok(!newAliases.includes('audio settings'));
    assert.equal(anchorNew, false); // "Audio Settings" already exists
    assert.ok(newAliases.includes('audio'));
    assert.ok(newAliases.includes('sound'));
    assert.ok(newAliases.includes('settings'));
  });

  it('zero-confidence suggestions produce no patch', () => {
    const raw = {
      best_candidates: [],
      alias_terms: [],
      anchor_label: null,
      confidence: 0,
      notes: 'no match found',
    };

    const result = parseBrainResponse(raw, 'offline-mode');
    assert.equal(result.confidence, 0);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.recommended_aliases, []);
  });
});

describe('prompt contract', () => {
  it('prompt contains JSON schema example', () => {
    const prompt = buildSuggestPrompt({
      featureText: 'Test feature',
      docSection: null,
      candidates: [],
      existingAliases: {},
    });

    assert.ok(prompt.includes('best_candidates'));
    assert.ok(prompt.includes('alias_terms'));
    assert.ok(prompt.includes('anchor_label'));
    assert.ok(prompt.includes('confidence'));
    assert.ok(prompt.includes('Respond with ONLY the JSON object'));
  });

  it('prompt includes all candidate fields', () => {
    const prompt = buildSuggestPrompt({
      featureText: 'Test',
      docSection: null,
      candidates: [{
        surface_id: 'trigger:/|Btn',
        label: 'Btn',
        route: '/settings',
        location_group: 'settings',
        safety: 'safe',
        role: 'button',
        aria_label: 'Settings button',
      }],
      existingAliases: {},
    });

    assert.ok(prompt.includes('surface_id: "trigger:/|Btn"'));
    assert.ok(prompt.includes('label: "Btn"'));
    assert.ok(prompt.includes('route: "/settings"'));
    assert.ok(prompt.includes('location: settings'));
    assert.ok(prompt.includes('safety: safe'));
    assert.ok(prompt.includes('role: button'));
    assert.ok(prompt.includes('aria-label: "Settings button"'));
  });
});
