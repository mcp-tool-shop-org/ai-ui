// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateFeatures } from '../src/atlas.mjs';

/** @param {string} id @param {string} name @param {Array<{file:string,line:number,type:string,section:string|null}>} [sources] */
function feature(id, name, sources) {
  return { id, name, synonyms: [], sources: sources || [{ file: 'README.md', line: 1, type: 'prose', section: 'Features' }], expected_entrypoints: [] };
}

describe('deduplicateFeatures', () => {
  it('merges two features when one name contains the other (score >= 0.7)', () => {
    const features = [
      feature('mechanical-typewriter-keystroke-audio', 'Mechanical typewriter keystroke audio'),
      feature('mechanical-typewriter-keystroke-audio-with-synth-fallback', 'Mechanical typewriter keystroke audio with synth fallback'),
    ];
    const result = deduplicateFeatures(features);
    assert.equal(result.length, 1);
    // Shorter name wins as primary
    assert.equal(result[0].name, 'Mechanical typewriter keystroke audio');
  });

  it('keeps two features with matchScore < 0.7', () => {
    const features = [
      feature('four-practice-modes', 'Four practice modes'),
      feature('wpm-and-accuracy-metrics', 'WPM and accuracy metrics'),
    ];
    const result = deduplicateFeatures(features);
    assert.equal(result.length, 2);
  });

  it('puts longer name into synonyms when shorter name wins', () => {
    const features = [
      feature('keyboard-shortcuts', 'Keyboard shortcuts'),
      feature('keyboard-shortcuts-support', 'Keyboard shortcuts support'),
    ];
    const result = deduplicateFeatures(features);
    assert.equal(result.length, 1);
    assert.ok(result[0].synonyms.includes('Keyboard shortcuts support'));
    assert.equal(result[0].name, 'Keyboard shortcuts');
  });

  it('combines sources from both features', () => {
    const features = [
      feature('offline-support', 'Offline support', [{ file: 'README.md', line: 36, type: 'prose', section: 'Features' }]),
      feature('offline-support-via-service-worker', 'Offline support via service worker', [{ file: 'CHANGELOG.md', line: 17, type: 'prose', section: 'Added' }]),
    ];
    const result = deduplicateFeatures(features);
    assert.equal(result.length, 1);
    assert.equal(result[0].sources.length, 2);
    assert.ok(result[0].sources.some(s => s.file === 'README.md'));
    assert.ok(result[0].sources.some(s => s.file === 'CHANGELOG.md'));
  });

  it('handles three-way merge (A⊂B⊂C)', () => {
    const features = [
      feature('a', 'Keyboard shortcuts'),
      feature('b', 'Keyboard shortcuts for navigation'),
      feature('c', 'Keyboard shortcuts for navigation and editing'),
    ];
    const result = deduplicateFeatures(features);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Keyboard shortcuts');
    assert.equal(result[0].sources.length, 3);
  });

  it('returns empty array for empty input', () => {
    const result = deduplicateFeatures([]);
    assert.deepEqual(result, []);
  });
});
