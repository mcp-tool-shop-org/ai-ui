// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSurfaces } from '../src/surfaces.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/sample-capture.json'), 'utf-8'));

describe('extractSurfaces', () => {
  it('returns a SurfaceInventory with correct shape', () => {
    const inv = extractSurfaces(fixture, 'test.json');
    assert.equal(inv.version, '1.0.0');
    assert.equal(typeof inv.generated_at, 'string');
    assert.equal(inv.source_capture, 'test.json');
    assert.ok(Array.isArray(inv.surfaces));
    assert.equal(typeof inv.stats.total_nodes, 'number');
    assert.equal(typeof inv.stats.surfaces_extracted, 'number');
  });

  it('counts total nodes correctly', () => {
    const inv = extractSurfaces(fixture);
    // page + nav + 3 nav children + hero section + 2 hero children
    // + search section + search bar + auth section + form + 4 form children
    // + footer + footer text = 18
    assert.equal(inv.stats.total_nodes, 18);
  });

  it('extracts surfaces with handlers', () => {
    const inv = extractSurfaces(fixture);
    const btnGetStarted = inv.surfaces.find(s => s.nodeId === 'btn-get-started');
    assert.ok(btnGetStarted, 'btn-get-started should be a surface');
    assert.equal(btnGetStarted.role, 'BUTTON');
    assert.equal(btnGetStarted.label, 'get-started');
    assert.deepEqual(btnGetStarted.handlers, [{ event: 'click', intent: 'navigate' }]);
  });

  it('extracts surfaces with pattern signals', () => {
    const inv = extractSurfaces(fixture);
    const searchBar = inv.surfaces.find(s => s.nodeId === 'search-bar');
    assert.ok(searchBar, 'search-bar should be a surface');
    assert.equal(searchBar.pattern, 'search_bar');
    assert.deepEqual(searchBar.handlers, [
      { event: 'input', intent: 'filter' },
      { event: 'submit', intent: 'search' },
    ]);
  });

  it('extracts surfaces with write/readwrite state', () => {
    const inv = extractSurfaces(fixture);
    const searchBar = inv.surfaces.find(s => s.nodeId === 'search-bar');
    assert.ok(searchBar);
    // Only write/readwrite state — search.results (read) should be excluded
    assert.deepEqual(searchBar.state, [
      { key: 'search.query', access: 'readwrite' },
    ]);
  });

  it('extracts surfaces with actionable style tokens', () => {
    const inv = extractSurfaces(fixture);
    const btnCta = inv.surfaces.find(s => s.nodeId === 'btn-cta');
    assert.ok(btnCta, 'btn-cta should be a surface');
    // 'primary' is actionable, 'elevated' is not
    assert.deepEqual(btnCta.styleTokens, ['primary']);
  });

  it('includes destructive style tokens', () => {
    const inv = extractSurfaces(fixture);
    const btnDelete = inv.surfaces.find(s => s.nodeId === 'btn-delete-account');
    assert.ok(btnDelete, 'btn-delete-account should be a surface');
    assert.deepEqual(btnDelete.styleTokens, ['destructive']);
  });

  it('includes pattern-only surfaces (no handlers)', () => {
    const inv = extractSurfaces(fixture);
    // section-hero has pattern but no handlers
    const hero = inv.surfaces.find(s => s.nodeId === 'section-hero');
    assert.ok(hero, 'section-hero with pattern should be a surface');
    assert.equal(hero.pattern, 'custom');
  });

  it('includes state-write-only surfaces (password input)', () => {
    const inv = extractSurfaces(fixture);
    const pw = inv.surfaces.find(s => s.nodeId === 'input-password');
    assert.ok(pw, 'input-password should be a surface (state write)');
    assert.deepEqual(pw.state, [{ key: 'form.password', access: 'write' }]);
  });

  it('does NOT include non-interactive nodes without signals', () => {
    const inv = extractSurfaces(fixture);
    const textCopyright = inv.surfaces.find(s => s.nodeId === 'text-copyright');
    assert.equal(textCopyright, undefined, 'text-copyright should not be a surface');
    const headingHero = inv.surfaces.find(s => s.nodeId === 'heading-hero');
    assert.equal(headingHero, undefined, 'heading-hero should not be a surface');
    const pageRoot = inv.surfaces.find(s => s.nodeId === 'page-0');
    assert.equal(pageRoot, undefined, 'page-0 should not be a surface');
  });

  it('sets route from capture URL pathname', () => {
    const inv = extractSurfaces(fixture);
    for (const s of inv.surfaces) {
      assert.equal(s.route, '/app');
    }
  });

  it('produces deterministic sort order (route → nodeId → label)', () => {
    const inv = extractSurfaces(fixture);
    const ids = inv.surfaces.map(s => s.nodeId);
    const sorted = [...ids].sort();
    // Since all have same route, should be sorted by nodeId
    assert.deepEqual(ids, sorted);
  });

  it('is a pure function — same input → same output (minus timestamp)', () => {
    const inv1 = extractSurfaces(fixture, 'test.json');
    const inv2 = extractSurfaces(fixture, 'test.json');
    // Zero out timestamps for comparison
    inv1.generated_at = inv2.generated_at = '';
    assert.deepEqual(inv1, inv2);
  });

  it('extracts the auth_form pattern with variant', () => {
    const inv = extractSurfaces(fixture);
    const form = inv.surfaces.find(s => s.nodeId === 'form-login');
    assert.ok(form, 'form-login should be a surface');
    assert.equal(form.pattern, 'auth_form');
  });
});
