// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripBasePath, detectBasePath } from '../src/normalize.mjs';

describe('stripBasePath', () => {
  it('strips prefix and returns clean route', () => {
    assert.equal(stripBasePath('/LoKey-Typer/daily', '/LoKey-Typer'), '/daily');
  });

  it('returns route unchanged when no prefix match', () => {
    assert.equal(stripBasePath('/daily', '/LoKey-Typer'), '/daily');
  });

  it('returns / when route equals basePath', () => {
    assert.equal(stripBasePath('/LoKey-Typer', '/LoKey-Typer'), '/');
  });

  it('handles trailing slash on basePath', () => {
    assert.equal(stripBasePath('/LoKey-Typer/focus', '/LoKey-Typer/'), '/focus');
  });

  it('returns route unchanged for empty basePath', () => {
    assert.equal(stripBasePath('/daily', ''), '/daily');
  });

  it('returns route unchanged for / basePath', () => {
    assert.equal(stripBasePath('/daily', '/'), '/daily');
  });
});

describe('detectBasePath', () => {
  it('extracts pathname from baseUrl', () => {
    assert.equal(detectBasePath('http://localhost:5173/LoKey-Typer/'), '/LoKey-Typer');
  });

  it('returns empty string for root baseUrl', () => {
    assert.equal(detectBasePath('http://localhost:4321'), '');
  });

  it('returns empty string for root with slash', () => {
    assert.equal(detectBasePath('http://localhost:4321/'), '');
  });

  it('returns empty string for invalid url', () => {
    assert.equal(detectBasePath('not-a-url'), '');
  });
});
