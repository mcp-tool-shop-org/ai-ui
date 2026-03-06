// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEyesPrompt, parseEyesResponse, EyesParseError } from '../src/ai-eyes-prompt.mjs';
import { OllamaError } from '../src/ollama.mjs';

// =============================================================================
// Prompt builder tests
// =============================================================================

describe('buildEyesPrompt', () => {
  it('includes element context in prompt', () => {
    const prompt = buildEyesPrompt({
      existingLabel: 'Audio Settings',
      role: 'button',
      route: '/',
      locationGroup: 'primary_nav',
    });

    assert.ok(prompt.includes('Audio Settings'));
    assert.ok(prompt.includes('button'));
    assert.ok(prompt.includes('primary_nav'));
    assert.ok(prompt.includes('icon_guess'));
    assert.ok(prompt.includes('Respond with ONLY the JSON object'));
  });

  it('handles empty label (icon-only element)', () => {
    const prompt = buildEyesPrompt({
      existingLabel: '',
      role: 'button',
      route: '/settings',
      locationGroup: 'toolbar',
    });

    assert.ok(prompt.includes('(none)'));
    assert.ok(prompt.includes('toolbar'));
  });

  it('includes route and role context', () => {
    const prompt = buildEyesPrompt({
      existingLabel: '⚙',
      role: 'a',
      route: '/dashboard',
      locationGroup: 'secondary_nav',
    });

    assert.ok(prompt.includes('/dashboard'));
    assert.ok(prompt.includes('a'));
    assert.ok(prompt.includes('secondary_nav'));
  });
});

// =============================================================================
// Response parser tests
// =============================================================================

describe('parseEyesResponse', () => {
  it('parses a well-formed LLaVA response (gear icon)', () => {
    const raw = {
      icon_guess: 'Settings',
      visible_text: '',
      nearby_context: 'Audio Settings panel',
      action_guess: 'opens settings menu',
      confidence: 0.92,
    };

    const result = parseEyesResponse(raw, 'trigger:/|gear-btn');

    assert.equal(result.icon_guess, 'settings'); // lowercased
    assert.equal(result.visible_text, '');
    assert.equal(result.nearby_context, 'Audio Settings panel');
    assert.equal(result.action_guess, 'opens settings menu');
    assert.equal(result.confidence, 0.92);
  });

  it('parses a speaker/audio icon response', () => {
    const raw = {
      icon_guess: 'Speaker',
      visible_text: 'Mute',
      nearby_context: 'Volume controls',
      action_guess: 'mutes audio',
      confidence: 0.88,
    };

    const result = parseEyesResponse(raw, 'trigger:/|mute-btn');

    assert.equal(result.icon_guess, 'speaker');
    assert.equal(result.visible_text, 'Mute');
    assert.equal(result.nearby_context, 'Volume controls');
  });

  it('clamps confidence to 0..1', () => {
    const raw = {
      icon_guess: 'menu',
      visible_text: '',
      nearby_context: '',
      action_guess: '',
      confidence: 1.5,
    };

    assert.equal(parseEyesResponse(raw, 'test').confidence, 1);

    raw.confidence = -0.3;
    assert.equal(parseEyesResponse(raw, 'test').confidence, 0);
  });

  it('handles missing fields gracefully', () => {
    const raw = {};

    const result = parseEyesResponse(raw, 'test');

    assert.equal(result.icon_guess, '');
    assert.equal(result.visible_text, '');
    assert.equal(result.nearby_context, '');
    assert.equal(result.action_guess, '');
    assert.equal(result.confidence, 0);
  });

  it('trims whitespace from all string fields', () => {
    const raw = {
      icon_guess: '  gear  ',
      visible_text: '  Settings  ',
      nearby_context: '  navigation bar  ',
      action_guess: '  open settings  ',
      confidence: 0.7,
    };

    const result = parseEyesResponse(raw, 'test');

    assert.equal(result.icon_guess, 'gear');
    assert.equal(result.visible_text, 'Settings');
    assert.equal(result.nearby_context, 'navigation bar');
    assert.equal(result.action_guess, 'open settings');
  });

  it('throws EyesParseError for non-object input', () => {
    assert.throws(
      () => parseEyesResponse(null, 'test'),
      (err) => err instanceof EyesParseError && err.surfaceId === 'test'
    );

    assert.throws(
      () => parseEyesResponse('string', 'test'),
      (err) => err instanceof EyesParseError
    );
  });

  it('handles non-string field types gracefully', () => {
    const raw = {
      icon_guess: 42,
      visible_text: true,
      nearby_context: null,
      action_guess: undefined,
      confidence: 'high',
    };

    const result = parseEyesResponse(raw, 'test');

    assert.equal(result.icon_guess, '');
    assert.equal(result.visible_text, '');
    assert.equal(result.nearby_context, '');
    assert.equal(result.action_guess, '');
    assert.equal(result.confidence, 0);
  });
});

// =============================================================================
// EyesParseError tests
// =============================================================================

describe('EyesParseError', () => {
  it('has surfaceId, message, and name', () => {
    const err = new EyesParseError('trigger:/|btn', 'not an object');
    assert.equal(err.surfaceId, 'trigger:/|btn');
    assert.ok(err.message.includes('trigger:/|btn'));
    assert.ok(err.message.includes('not an object'));
    assert.equal(err.name, 'EyesParseError');
    assert.ok(err instanceof Error);
  });
});

// =============================================================================
// Integration — Eyes → Brain enrichment
// =============================================================================

describe('Eyes → Brain enrichment', () => {
  it('icon_guess enriches surface signatures for Brain', () => {
    // Simulates the enrichment path in ai-suggest.mjs
    const surfaces = [
      { surface_id: 'trigger:/|gear', label: '', route: '/', location_group: 'toolbar', safety: 'safe', role: 'button', aria_label: '' },
    ];

    // Simulate Eyes annotation
    const eyesAnnotation = {
      surface_id: 'trigger:/|gear',
      icon_guess: 'settings',
      nearby_context: 'Audio panel',
      confidence: 0.85,
    };

    // Enrich (same logic as ai-suggest.mjs)
    const surface = surfaces.find(s => s.surface_id === eyesAnnotation.surface_id);
    if (surface && eyesAnnotation.icon_guess && eyesAnnotation.icon_guess !== 'none') {
      surface.aria_label = [surface.aria_label, eyesAnnotation.icon_guess, eyesAnnotation.nearby_context]
        .filter(Boolean).join(' | ');
    }

    // After enrichment, the previously label-less surface now has context
    assert.equal(surface.aria_label, 'settings | Audio panel');
  });

  it('preserves existing aria_label when enriching', () => {
    const surfaces = [
      { surface_id: 'trigger:/|btn', label: 'X', route: '/', location_group: 'modal', safety: 'safe', role: 'button', aria_label: 'Close dialog' },
    ];

    const eyesAnnotation = {
      surface_id: 'trigger:/|btn',
      icon_guess: 'close',
      nearby_context: 'Settings modal',
      confidence: 0.9,
    };

    const surface = surfaces.find(s => s.surface_id === eyesAnnotation.surface_id);
    if (surface && eyesAnnotation.icon_guess && eyesAnnotation.icon_guess !== 'none') {
      surface.aria_label = [surface.aria_label, eyesAnnotation.icon_guess, eyesAnnotation.nearby_context]
        .filter(Boolean).join(' | ');
    }

    assert.equal(surface.aria_label, 'Close dialog | close | Settings modal');
  });

  it('skips enrichment when icon_guess is "none"', () => {
    const surfaces = [
      { surface_id: 'trigger:/|btn', label: 'Submit', route: '/', location_group: 'inline', safety: 'safe', role: 'button', aria_label: '' },
    ];

    const eyesAnnotation = {
      surface_id: 'trigger:/|btn',
      icon_guess: 'none',
      nearby_context: '',
      confidence: 0.3,
    };

    const surface = surfaces.find(s => s.surface_id === eyesAnnotation.surface_id);
    if (surface && eyesAnnotation.icon_guess && eyesAnnotation.icon_guess !== 'none') {
      surface.aria_label = [surface.aria_label, eyesAnnotation.icon_guess, eyesAnnotation.nearby_context]
        .filter(Boolean).join(' | ');
    }

    assert.equal(surface.aria_label, ''); // unchanged
  });
});

// =============================================================================
// Stable image hashing
// =============================================================================

describe('image hashing', () => {
  it('same buffer produces same hash', async () => {
    const { createHash } = await import('node:crypto');

    const buf1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buf2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const hash1 = createHash('sha256').update(buf1).digest('hex');
    const hash2 = createHash('sha256').update(buf2).digest('hex');

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // SHA-256 hex = 64 chars
  });

  it('different buffers produce different hashes', async () => {
    const { createHash } = await import('node:crypto');

    const buf1 = Buffer.from([0x00, 0x01, 0x02]);
    const buf2 = Buffer.from([0x03, 0x04, 0x05]);

    const hash1 = createHash('sha256').update(buf1).digest('hex');
    const hash2 = createHash('sha256').update(buf2).digest('hex');

    assert.notEqual(hash1, hash2);
  });
});
