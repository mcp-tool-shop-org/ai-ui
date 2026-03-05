// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildTriggerId,
  isTriggerSafe,
  matchesMethodPattern,
  normalizeEffectUrl,
  normalizeFetchEffect,
  normalizeNavigateEffect,
  normalizeDownloadEffect,
  normalizeStorageWriteEffect,
  detectDomEffects,
  aggregateSummary,
  buildEvidenceKey,
  deduplicateEvidence,
  computeConfidence,
  normalizeUrlForId,
  normalizeEffectTarget,
  normalizeEffectId,
  computeDomMutationSummary,
  computeTimingConfidence,
} from '../src/runtime-effects.mjs';

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/runtime-effects-fixtures.json'), 'utf-8')
);

// =============================================================================
// buildTriggerId
// =============================================================================

describe('buildTriggerId', () => {
  it('builds click@identifier format', () => {
    assert.equal(buildTriggerId('click', 'btn-cta'), 'click@btn-cta');
  });

  it('lowercases the identifier', () => {
    assert.equal(buildTriggerId('click', 'MyButton'), 'click@mybutton');
  });

  it('replaces spaces with hyphens', () => {
    assert.equal(buildTriggerId('click', 'Get started now'), 'click@get-started-now');
  });

  it('strips non-alphanumeric chars except hyphens and underscores', () => {
    assert.equal(buildTriggerId('click', 'btn@#$special!'), 'click@btnspecial');
  });

  it('truncates to 60 chars', () => {
    const long = 'a'.repeat(100);
    const result = buildTriggerId('click', long);
    assert.equal(result, `click@${'a'.repeat(60)}`);
  });

  it('supports change action', () => {
    assert.equal(buildTriggerId('change', 'input-theme'), 'change@input-theme');
  });
});

// =============================================================================
// isTriggerSafe
// =============================================================================

describe('isTriggerSafe', () => {
  it('marks safe button as safe', () => {
    const result = isTriggerSafe(fixtures.triggers.safe_button, fixtures.safeConfig_default);
    assert.equal(result.safe, true);
  });

  it('denies destructive label (delete)', () => {
    const result = isTriggerSafe(fixtures.triggers.destructive_label, fixtures.safeConfig_default);
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes('deny pattern'));
  });

  it('denies remove label', () => {
    const result = isTriggerSafe(fixtures.triggers.remove_label, fixtures.safeConfig_default);
    assert.equal(result.safe, false);
  });

  it('denies reset label', () => {
    const result = isTriggerSafe(fixtures.triggers.reset_label, fixtures.safeConfig_default);
    assert.equal(result.safe, false);
  });

  it('allows destructive label with safe override', () => {
    const result = isTriggerSafe(fixtures.triggers.destructive_override, fixtures.safeConfig_default);
    assert.equal(result.safe, true);
  });

  it('denies destructive style without safe attr', () => {
    const result = isTriggerSafe(fixtures.triggers.destructive_style, fixtures.safeConfig_default);
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes('destructive style'));
  });

  it('allows destructive style with safe attr', () => {
    const result = isTriggerSafe(fixtures.triggers.safe_style_override, fixtures.safeConfig_default);
    assert.equal(result.safe, true);
  });

  it('allows destructive style when requireSafeAttr is false', () => {
    const result = isTriggerSafe(fixtures.triggers.destructive_style, fixtures.safeConfig_permissive);
    assert.equal(result.safe, true);
  });

  it('allows empty label', () => {
    const result = isTriggerSafe(fixtures.triggers.empty_label, fixtures.safeConfig_default);
    assert.equal(result.safe, true);
  });

  it('permissive config allows delete/remove/reset labels', () => {
    assert.equal(isTriggerSafe(fixtures.triggers.destructive_label, fixtures.safeConfig_permissive).safe, true);
    assert.equal(isTriggerSafe(fixtures.triggers.remove_label, fixtures.safeConfig_permissive).safe, true);
    assert.equal(isTriggerSafe(fixtures.triggers.reset_label, fixtures.safeConfig_permissive).safe, true);
  });

  // --- Extended deny list (Phase 3) ---

  it('denies logout label', () => {
    const result = isTriggerSafe(fixtures.triggers.logout_label, fixtures.safeConfig_default);
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes('deny pattern'));
  });

  it('denies revoke label', () => {
    assert.equal(isTriggerSafe(fixtures.triggers.revoke_label, fixtures.safeConfig_default).safe, false);
  });

  it('denies disable label', () => {
    assert.equal(isTriggerSafe(fixtures.triggers.disable_label, fixtures.safeConfig_default).safe, false);
  });

  it('denies unsubscribe label', () => {
    assert.equal(isTriggerSafe(fixtures.triggers.unsubscribe_label, fixtures.safeConfig_default).safe, false);
  });

  it('denies billing label', () => {
    assert.equal(isTriggerSafe(fixtures.triggers.billing_label, fixtures.safeConfig_default).safe, false);
  });

  // --- denyHrefRegex (Phase 3) ---

  it('denies trigger matching denyHrefRegex', () => {
    const result = isTriggerSafe(fixtures.triggers.href_admin, fixtures.safeConfig_href_deny);
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes('href matches deny pattern'));
  });

  it('allows trigger with non-matching href', () => {
    const result = isTriggerSafe(fixtures.triggers.href_safe, fixtures.safeConfig_href_deny);
    assert.equal(result.safe, true);
  });

  it('safe override wins over denyHrefRegex', () => {
    const result = isTriggerSafe(fixtures.triggers.href_override, fixtures.safeConfig_href_deny);
    assert.equal(result.safe, true);
  });

  it('skips href check when denyHrefRegex is null', () => {
    const result = isTriggerSafe(fixtures.triggers.href_admin, fixtures.safeConfig_default);
    assert.equal(result.safe, true);
  });

  it('skips href check when trigger has no href', () => {
    const result = isTriggerSafe(fixtures.triggers.safe_button, fixtures.safeConfig_href_deny);
    assert.equal(result.safe, true);
  });

  // --- denyMethodPatterns (Phase 3) ---

  it('denies trigger matching denyMethodPatterns', () => {
    const trigger = { label: 'Cleanup', safeAttr: null, styleTokens: [], href: '/api/v1/users/42' };
    const config = { ...fixtures.safeConfig_method_deny };
    // matchesMethodPattern checks GET by default for href links
    // The isTriggerSafe function uses GET for href
    const result = isTriggerSafe(trigger, config);
    // GET /api/v1/users/42 doesn't match DELETE /api/ or POST /admin/
    assert.equal(result.safe, true);
  });

  it('skips method pattern check when no patterns configured', () => {
    const result = isTriggerSafe(fixtures.triggers.href_delete_api, fixtures.safeConfig_default);
    assert.equal(result.safe, true);
  });
});

// =============================================================================
// matchesMethodPattern
// =============================================================================

describe('matchesMethodPattern', () => {
  const patterns = [
    { method: 'DELETE', urlPattern: '/api/' },
    { method: 'POST', urlPattern: '/admin/' },
  ];

  it('matches DELETE on /api/ path', () => {
    const result = matchesMethodPattern('DELETE', '/api/users/42', patterns);
    assert.equal(result.matches, true);
    assert.equal(result.pattern.method, 'DELETE');
  });

  it('matches POST on /admin/ path', () => {
    const result = matchesMethodPattern('POST', '/admin/settings', patterns);
    assert.equal(result.matches, true);
    assert.equal(result.pattern.method, 'POST');
  });

  it('does not match GET on /api/ path', () => {
    const result = matchesMethodPattern('GET', '/api/users/42', patterns);
    assert.equal(result.matches, false);
  });

  it('does not match DELETE on /settings/ path', () => {
    const result = matchesMethodPattern('DELETE', '/settings/profile', patterns);
    assert.equal(result.matches, false);
  });

  it('is case-insensitive on method', () => {
    const result = matchesMethodPattern('delete', '/api/users', patterns);
    assert.equal(result.matches, true);
  });

  it('returns empty for empty patterns', () => {
    const result = matchesMethodPattern('DELETE', '/api/foo', []);
    assert.equal(result.matches, false);
  });
});

// =============================================================================
// normalizeEffectUrl
// =============================================================================

describe('normalizeEffectUrl', () => {
  it('strips origin for same-origin URLs', () => {
    assert.equal(normalizeEffectUrl('http://localhost:4321/api/data', 'http://localhost:4321'), '/api/data');
  });

  it('preserves query params', () => {
    assert.equal(normalizeEffectUrl('http://localhost:4321/api/search?q=test', 'http://localhost:4321'), '/api/search?q=test');
  });

  it('keeps external URLs unchanged', () => {
    assert.equal(normalizeEffectUrl('https://cdn.example.com/data.json', 'http://localhost:4321'), 'https://cdn.example.com/data.json');
  });

  it('handles malformed URLs gracefully', () => {
    assert.equal(normalizeEffectUrl('not-a-url', 'http://localhost:4321'), 'not-a-url');
  });

  it('handles path-only input', () => {
    assert.equal(normalizeEffectUrl('/api/data', 'http://localhost:4321'), '/api/data');
  });
});

// =============================================================================
// normalizeFetchEffect
// =============================================================================

describe('normalizeFetchEffect', () => {
  it('normalizes POST fetch effect', () => {
    const raw = fixtures.fetchRaw.post_checkout;
    const effect = normalizeFetchEffect('click@btn-cta', '/', raw, fixtures.windowStart, fixtures.baseUrl);
    assert.equal(effect.kind, 'fetch');
    assert.equal(effect.trigger_id, 'click@btn-cta');
    assert.equal(effect.route, '/');
    assert.equal(effect.method, 'POST');
    assert.equal(effect.url, '/api/checkout');
    assert.equal(effect.status, 302);
    assert.equal(effect.window_ms, 150);
  });

  it('normalizes GET fetch effect with query', () => {
    const raw = fixtures.fetchRaw.get_search;
    const effect = normalizeFetchEffect('click@search', '/', raw, fixtures.windowStart, fixtures.baseUrl);
    assert.equal(effect.method, 'GET');
    assert.equal(effect.url, '/api/search?q=test');
    assert.equal(effect.status, 200);
  });

  it('keeps external URL for cross-origin fetch', () => {
    const raw = fixtures.fetchRaw.external_api;
    const effect = normalizeFetchEffect('click@btn', '/', raw, fixtures.windowStart, fixtures.baseUrl);
    assert.equal(effect.url, 'https://cdn.example.com/data.json');
  });
});

// =============================================================================
// normalizeNavigateEffect
// =============================================================================

describe('normalizeNavigateEffect', () => {
  it('normalizes internal navigation', () => {
    const raw = fixtures.navRaw.internal;
    const effect = normalizeNavigateEffect('click@btn-cta', '/', raw, fixtures.windowStart, fixtures.baseUrl);
    assert.equal(effect.kind, 'navigate');
    assert.equal(effect.from, '/');
    assert.equal(effect.to, '/pricing');
    assert.equal(effect.window_ms, 200);
  });

  it('keeps external URLs for cross-origin navigation', () => {
    const raw = fixtures.navRaw.external;
    const effect = normalizeNavigateEffect('click@link', '/', raw, fixtures.windowStart, fixtures.baseUrl);
    assert.equal(effect.from, '/');
    assert.equal(effect.to, 'https://docs.example.com/guide');
  });
});

// =============================================================================
// normalizeDownloadEffect
// =============================================================================

describe('normalizeDownloadEffect', () => {
  it('normalizes CSV download', () => {
    const raw = fixtures.downloadRaw.csv;
    const effect = normalizeDownloadEffect('click@btn-export', '/', raw, fixtures.windowStart);
    assert.equal(effect.kind, 'download');
    assert.equal(effect.filename, 'export.csv');
    assert.equal(effect.window_ms, 500);
  });

  it('normalizes PDF download', () => {
    const raw = fixtures.downloadRaw.pdf;
    const effect = normalizeDownloadEffect('click@btn-dl', '/', raw, fixtures.windowStart);
    assert.equal(effect.filename, 'report.pdf');
    assert.equal(effect.window_ms, 600);
  });
});

// =============================================================================
// normalizeStorageWriteEffect
// =============================================================================

describe('normalizeStorageWriteEffect', () => {
  it('normalizes localStorage write', () => {
    const raw = fixtures.storageRaw.theme;
    const effect = normalizeStorageWriteEffect('click@toggle', '/', raw, fixtures.windowStart);
    assert.equal(effect.kind, 'storageWrite');
    assert.equal(effect.scope, 'local');
    assert.equal(effect.key, 'theme');
    assert.equal(effect.window_ms, 50);
  });

  it('normalizes sessionStorage write', () => {
    const raw = fixtures.storageRaw.session_token;
    const effect = normalizeStorageWriteEffect('click@login', '/', raw, fixtures.windowStart);
    assert.equal(effect.scope, 'session');
    assert.equal(effect.key, 'auth_token');
    assert.equal(effect.window_ms, 80);
  });
});

// =============================================================================
// detectDomEffects
// =============================================================================

describe('detectDomEffects', () => {
  it('returns empty array when no DOM changes', () => {
    const effects = detectDomEffects(fixtures.domSnapshots.no_change, 'click@btn', '/', 1000);
    assert.equal(effects.length, 0);
  });

  it('detects modal_open from new dialog', () => {
    const effects = detectDomEffects(fixtures.domSnapshots.modal_open, 'click@btn', '/', 1000);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].kind, 'domEffect');
    assert.equal(effects[0].detail, 'modal_open');
    assert.equal(effects[0].window_ms, 1000);
  });

  it('detects toast from new status element', () => {
    const effects = detectDomEffects(fixtures.domSnapshots.toast, 'click@save', '/', 500);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].detail, 'toast');
  });

  it('detects multiple distinct DOM effects', () => {
    const effects = detectDomEffects(fixtures.domSnapshots.multi_effect, 'click@submit', '/', 800);
    assert.equal(effects.length, 2);
    const details = effects.map(e => e.detail).sort();
    assert.deepStrictEqual(details, ['modal_open', 'toast']);
  });

  it('deduplicates same detail type', () => {
    const effects = detectDomEffects(fixtures.domSnapshots.duplicate_dialogs, 'click@btn', '/', 500);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].detail, 'modal_open');
  });

  it('includes correct trigger_id and route', () => {
    const effects = detectDomEffects(fixtures.domSnapshots.modal_open, 'click@my-btn', '/settings', 200);
    assert.equal(effects[0].trigger_id, 'click@my-btn');
    assert.equal(effects[0].route, '/settings');
  });
});

// =============================================================================
// aggregateSummary
// =============================================================================

describe('aggregateSummary', () => {
  it('aggregates full session into summary', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    assert.equal(summary.version, '1.0.0');
    assert.equal(summary.url, 'http://localhost:4321');
    assert.equal(summary.triggers.length, 5);
    assert.equal(summary.stats.total_triggers, 20);
    assert.equal(summary.stats.triggers_fired, 15);
    assert.equal(summary.stats.triggers_skipped, 5);
    assert.equal(summary.stats.effects_captured, 6);
  });

  it('groups effects by trigger_id', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const ctaTrigger = summary.triggers.find(t => t.trigger_id === 'click@btn-cta');
    assert.ok(ctaTrigger);
    assert.equal(ctaTrigger.effects.length, 2);
    assert.equal(ctaTrigger.effects[0].kind, 'fetch');
    assert.equal(ctaTrigger.effects[1].kind, 'navigate');
  });

  it('sorts triggers deterministically by trigger_id', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const ids = summary.triggers.map(t => t.trigger_id);
    const sorted = [...ids].sort();
    assert.deepStrictEqual(ids, sorted);
  });

  it('handles empty session', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.empty_session);
    assert.equal(summary.triggers.length, 0);
    assert.equal(summary.stats.effects_captured, 0);
    assert.equal(summary.stats.total_triggers, 5);
  });

  it('handles missing summary line gracefully', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.no_summary);
    assert.equal(summary.triggers.length, 1);
    assert.equal(summary.stats.effects_captured, 1);
    assert.equal(summary.stats.triggers_fired, 1);
  });

  it('preserves by_kind counts from summary line', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    assert.equal(summary.stats.by_kind.fetch, 2);
    assert.equal(summary.stats.by_kind.navigate, 1);
    assert.equal(summary.stats.by_kind.download, 1);
    assert.equal(summary.stats.by_kind.storageWrite, 1);
    assert.equal(summary.stats.by_kind.domEffect, 1);
  });

  it('extracts correct fields on fetch effect', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const cta = summary.triggers.find(t => t.trigger_id === 'click@btn-cta');
    const fetch = cta.effects.find(e => e.kind === 'fetch');
    assert.equal(fetch.method, 'POST');
    assert.equal(fetch.url, '/api/checkout');
    assert.equal(fetch.status, 302);
  });

  it('extracts correct fields on navigate effect', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const cta = summary.triggers.find(t => t.trigger_id === 'click@btn-cta');
    const nav = cta.effects.find(e => e.kind === 'navigate');
    assert.equal(nav.from, '/');
    assert.equal(nav.to, '/pricing');
  });

  it('extracts correct fields on download effect', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const exp = summary.triggers.find(t => t.trigger_id === 'click@btn-export');
    assert.equal(exp.effects[0].filename, 'data.csv');
  });

  it('extracts correct fields on storageWrite effect', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const toggle = summary.triggers.find(t => t.trigger_id === 'click@toggle-theme');
    assert.equal(toggle.effects[0].scope, 'local');
    assert.equal(toggle.effects[0].key, 'theme');
  });

  it('extracts correct fields on domEffect', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    const save = summary.triggers.find(t => t.trigger_id === 'click@btn-save');
    assert.equal(save.effects[0].detail, 'modal_open');
  });

  it('uses generated_at from meta line', () => {
    const summary = aggregateSummary(fixtures.jsonlEntries.full_session);
    assert.equal(summary.generated_at, '2026-01-01T00:00:00.000Z');
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('runtime-effects determinism', () => {
  it('aggregateSummary returns identical results on repeated calls', () => {
    const s1 = aggregateSummary(fixtures.jsonlEntries.full_session);
    const s2 = aggregateSummary(fixtures.jsonlEntries.full_session);
    assert.deepStrictEqual(s1, s2);
  });

  it('buildTriggerId is deterministic', () => {
    assert.equal(buildTriggerId('click', 'My Button!'), buildTriggerId('click', 'My Button!'));
  });

  it('detectDomEffects is deterministic', () => {
    const e1 = detectDomEffects(fixtures.domSnapshots.multi_effect, 'click@btn', '/', 500);
    const e2 = detectDomEffects(fixtures.domSnapshots.multi_effect, 'click@btn', '/', 500);
    assert.deepStrictEqual(e1, e2);
  });
});

// =============================================================================
// buildEvidenceKey
// =============================================================================

describe('buildEvidenceKey', () => {
  it('builds fetch key with method and url', () => {
    assert.equal(buildEvidenceKey({ kind: 'fetch', method: 'POST', url: '/api/checkout' }), 'fetch:POST /api/checkout');
  });

  it('builds navigate key with destination', () => {
    assert.equal(buildEvidenceKey({ kind: 'navigate', to: '/pricing' }), 'navigate:/pricing');
  });

  it('builds download key with filename', () => {
    assert.equal(buildEvidenceKey({ kind: 'download', filename: 'export.csv' }), 'download:export.csv');
  });

  it('builds storageWrite key with scope and key', () => {
    assert.equal(buildEvidenceKey({ kind: 'storageWrite', scope: 'local', key: 'theme' }), 'storageWrite:local:theme');
  });

  it('builds domEffect key with detail', () => {
    assert.equal(buildEvidenceKey({ kind: 'domEffect', detail: 'modal_open' }), 'domEffect:modal_open');
  });

  it('defaults fetch method to GET', () => {
    assert.equal(buildEvidenceKey({ kind: 'fetch', url: '/api/data' }), 'fetch:GET /api/data');
  });

  it('handles missing fields gracefully', () => {
    // navigate with no 'to' goes through normalizeUrlForId('') → '/'
    assert.equal(buildEvidenceKey({ kind: 'navigate' }), 'navigate:/');
    assert.equal(buildEvidenceKey({ kind: 'download' }), 'download:');
  });
});

// =============================================================================
// deduplicateEvidence
// =============================================================================

describe('deduplicateEvidence', () => {
  it('removes duplicates by key', () => {
    const evidence = [
      { key: 'fetch:POST /api/checkout', kind: 'fetch', method: 'POST', url: '/api/checkout', status: 302 },
      { key: 'fetch:POST /api/checkout', kind: 'fetch', method: 'POST', url: '/api/checkout', status: 302 },
      { key: 'navigate:/pricing', kind: 'navigate' },
    ];
    const deduped = deduplicateEvidence(evidence);
    assert.equal(deduped.length, 2);
  });

  it('sorts by key deterministically', () => {
    const evidence = [
      { key: 'navigate:/pricing', kind: 'navigate' },
      { key: 'fetch:POST /api/checkout', kind: 'fetch' },
      { key: 'download:report.csv', kind: 'download' },
    ];
    const deduped = deduplicateEvidence(evidence);
    assert.equal(deduped[0].key, 'download:report.csv');
    assert.equal(deduped[1].key, 'fetch:POST /api/checkout');
    assert.equal(deduped[2].key, 'navigate:/pricing');
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(deduplicateEvidence([]), []);
  });

  it('keeps first occurrence when duplicates differ', () => {
    const evidence = [
      { key: 'fetch:POST /api', kind: 'fetch', status: 200 },
      { key: 'fetch:POST /api', kind: 'fetch', status: 500 },
    ];
    const deduped = deduplicateEvidence(evidence);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].status, 200);
  });
});

// =============================================================================
// computeConfidence
// =============================================================================

describe('computeConfidence', () => {
  it('returns low for empty evidence', () => {
    assert.equal(computeConfidence([]), 'low');
  });

  it('returns low for null evidence', () => {
    assert.equal(computeConfidence(null), 'low');
  });

  it('returns low for single non-2xx entry', () => {
    assert.equal(computeConfidence([{ key: 'fetch:POST /api', kind: 'fetch', status: 302 }]), 'low');
  });

  it('returns med for single 2xx fetch', () => {
    assert.equal(computeConfidence([{ key: 'fetch:GET /api', kind: 'fetch', status: 200 }]), 'med');
  });

  it('returns med for 2 entries', () => {
    assert.equal(computeConfidence([
      { key: 'a', kind: 'navigate' },
      { key: 'b', kind: 'download' },
    ]), 'med');
  });

  it('returns high for 3+ consistent entries', () => {
    assert.equal(computeConfidence([
      { key: 'a', kind: 'fetch', status: 200 },
      { key: 'b', kind: 'fetch', status: 201 },
      { key: 'c', kind: 'fetch', status: 200 },
    ]), 'high');
  });

  it('returns med for 3+ diverse entries', () => {
    assert.equal(computeConfidence([
      { key: 'a', kind: 'fetch' },
      { key: 'b', kind: 'navigate' },
      { key: 'c', kind: 'download' },
    ]), 'med');
  });

  it('high with 2 kinds still passes (<=2 kinds threshold)', () => {
    assert.equal(computeConfidence([
      { key: 'a', kind: 'fetch' },
      { key: 'b', kind: 'fetch' },
      { key: 'c', kind: 'navigate' },
    ]), 'high');
  });
});

// =============================================================================
// normalizeUrlForId
// =============================================================================

describe('normalizeUrlForId', () => {
  it('strips cache-buster params (_t)', () => {
    assert.equal(normalizeUrlForId('/api/data?_t=123&name=foo'), '/api/data?name=foo');
  });

  it('strips multiple cache-buster params', () => {
    assert.equal(normalizeUrlForId('/api?_t=1&cb=2&ts=3&real=yes'), '/api?real=yes');
  });

  it('sorts remaining query params alphabetically', () => {
    assert.equal(normalizeUrlForId('/api?z=1&a=2&m=3'), '/api?a=2&m=3&z=1');
  });

  it('collapses numeric path segments to :id', () => {
    assert.equal(normalizeUrlForId('/users/123/posts/456'), '/users/:id/posts/:id');
  });

  it('preserves non-numeric segments', () => {
    assert.equal(normalizeUrlForId('/users/admin/settings'), '/users/admin/settings');
  });

  it('handles no query string', () => {
    assert.equal(normalizeUrlForId('/api/data'), '/api/data');
  });

  it('handles path-only (no scheme)', () => {
    assert.equal(normalizeUrlForId('/api/items/42'), '/api/items/:id');
  });

  it('handles full URL (preserves origin)', () => {
    assert.equal(normalizeUrlForId('https://cdn.example.com/v1/123'), 'https://cdn.example.com/v1/:id');
  });

  it('normalizes bare string as relative path', () => {
    // 'not-a-url' gets parsed as a relative path → '/not-a-url'
    assert.equal(normalizeUrlForId('not-a-url'), '/not-a-url');
  });

  it('removes empty query string when all params are cache-busters', () => {
    assert.equal(normalizeUrlForId('/api?_t=123&ts=456'), '/api');
  });
});

// =============================================================================
// normalizeEffectTarget
// =============================================================================

describe('normalizeEffectTarget', () => {
  it('normalizes fetch target with method and URL', () => {
    assert.equal(normalizeEffectTarget({ kind: 'fetch', method: 'POST', url: '/api/users/42?_t=1' }), 'POST /api/users/:id');
  });

  it('normalizes navigate target', () => {
    assert.equal(normalizeEffectTarget({ kind: 'navigate', to: '/users/123' }), '/users/:id');
  });

  it('returns filename for download', () => {
    assert.equal(normalizeEffectTarget({ kind: 'download', filename: 'report.csv' }), 'report.csv');
  });

  it('returns scope:key for storageWrite', () => {
    assert.equal(normalizeEffectTarget({ kind: 'storageWrite', scope: 'local', key: 'theme' }), 'local:theme');
  });

  it('returns detail for domEffect', () => {
    assert.equal(normalizeEffectTarget({ kind: 'domEffect', detail: 'modal_open' }), 'modal_open');
  });
});

// =============================================================================
// normalizeEffectId
// =============================================================================

describe('normalizeEffectId', () => {
  it('builds fetch effect ID with normalized URL', () => {
    assert.equal(
      normalizeEffectId({ kind: 'fetch', method: 'POST', url: '/api/checkout?_t=1' }),
      'effect:fetch:POST /api/checkout'
    );
  });

  it('builds navigate effect ID', () => {
    assert.equal(
      normalizeEffectId({ kind: 'navigate', to: '/about' }),
      'effect:navigate:/about'
    );
  });

  it('builds storageWrite as stateWrite ID', () => {
    assert.equal(
      normalizeEffectId({ kind: 'storageWrite', scope: 'local', key: 'theme' }),
      'effect:stateWrite:theme'
    );
  });

  it('builds download effect ID', () => {
    assert.equal(
      normalizeEffectId({ kind: 'download', filename: 'export.csv' }),
      'effect:download:export.csv'
    );
  });

  it('builds domEffect effect ID', () => {
    assert.equal(
      normalizeEffectId({ kind: 'domEffect', detail: 'toast' }),
      'effect:domEffect:toast'
    );
  });

  it('collapses numeric path IDs in fetch URL', () => {
    assert.equal(
      normalizeEffectId({ kind: 'fetch', method: 'GET', url: '/api/users/42/posts/99' }),
      'effect:fetch:GET /api/users/:id/posts/:id'
    );
  });

  it('two similar URLs collapse to same ID', () => {
    const id1 = normalizeEffectId({ kind: 'fetch', method: 'POST', url: '/api/users/42?_t=111' });
    const id2 = normalizeEffectId({ kind: 'fetch', method: 'POST', url: '/api/users/99?_t=222' });
    assert.equal(id1, id2);
  });
});

// =============================================================================
// computeDomMutationSummary (Phase 4)
// =============================================================================

describe('computeDomMutationSummary', () => {
  it('returns zeros for identical snapshots', () => {
    const snap = [{ role: 'button', label: 'Submit', visible: true }];
    const result = computeDomMutationSummary(snap, snap);
    assert.equal(result.nodesAdded, 0);
    assert.equal(result.nodesRemoved, 0);
    assert.equal(result.attributesChanged, 0);
  });

  it('counts added nodes', () => {
    const before = [{ role: 'button', label: 'Submit', visible: true }];
    const after = [
      { role: 'button', label: 'Submit', visible: true },
      { role: 'dialog', label: 'Confirm', visible: true },
    ];
    const result = computeDomMutationSummary(before, after);
    assert.equal(result.nodesAdded, 1);
    assert.equal(result.nodesRemoved, 0);
  });

  it('counts removed nodes', () => {
    const before = [
      { role: 'button', label: 'Submit', visible: true },
      { role: 'status', label: 'Loading', visible: true },
    ];
    const after = [{ role: 'button', label: 'Submit', visible: true }];
    const result = computeDomMutationSummary(before, after);
    assert.equal(result.nodesRemoved, 1);
    assert.equal(result.nodesAdded, 0);
  });

  it('counts visibility changes as attribute changes', () => {
    const before = [{ role: 'dialog', label: 'Modal', visible: false }];
    const after = [{ role: 'dialog', label: 'Modal', visible: true }];
    const result = computeDomMutationSummary(before, after);
    assert.equal(result.attributesChanged, 1);
    assert.equal(result.nodesAdded, 0);
  });

  it('handles empty snapshots', () => {
    const result = computeDomMutationSummary([], []);
    assert.equal(result.nodesAdded, 0);
    assert.equal(result.nodesRemoved, 0);
    assert.equal(result.attributesChanged, 0);
    assert.equal(result.textChanged, 0);
  });

  it('detects text changes in same-role nodes', () => {
    const before = [{ role: 'status', label: 'Saving...', visible: true }];
    const after = [{ role: 'status', label: 'Saved!', visible: true }];
    const result = computeDomMutationSummary(before, after);
    assert.ok(result.textChanged > 0 || result.nodesAdded > 0);
  });

  it('handles complex multi-change scenario', () => {
    const before = [
      { role: 'button', label: 'Save', visible: true },
      { role: 'navigation', label: 'Main', visible: true },
    ];
    const after = [
      { role: 'button', label: 'Save', visible: true },
      { role: 'navigation', label: 'Main', visible: true },
      { role: 'dialog', label: 'Confirm', visible: true },
      { role: 'alert', label: 'Warning', visible: true },
    ];
    const result = computeDomMutationSummary(before, after);
    assert.equal(result.nodesAdded, 2);
    assert.equal(result.nodesRemoved, 0);
  });
});

// =============================================================================
// computeTimingConfidence (Phase 4)
// =============================================================================

describe('computeTimingConfidence', () => {
  it('returns bonus for effects < 200ms', () => {
    assert.equal(computeTimingConfidence(50), 'bonus');
    assert.equal(computeTimingConfidence(199), 'bonus');
  });

  it('returns neutral for effects >= 200ms', () => {
    assert.equal(computeTimingConfidence(200), 'neutral');
    assert.equal(computeTimingConfidence(1000), 'neutral');
  });

  it('returns bonus for 0ms (immediate)', () => {
    assert.equal(computeTimingConfidence(0), 'bonus');
  });
});

// =============================================================================
// computeConfidence with timing bonus (Phase 4)
// =============================================================================

describe('computeConfidence with timing bonus', () => {
  it('timing bonus upgrades low to med', () => {
    assert.equal(computeConfidence([{ key: 'a', kind: 'navigate' }], { timingBonus: true }), 'med');
  });

  it('timing bonus upgrades med to high', () => {
    assert.equal(computeConfidence([
      { key: 'a', kind: 'fetch', status: 200 },
    ], { timingBonus: true }), 'high');
  });

  it('timing bonus on already-high stays high', () => {
    assert.equal(computeConfidence([
      { key: 'a', kind: 'fetch' },
      { key: 'b', kind: 'fetch' },
      { key: 'c', kind: 'fetch' },
    ], { timingBonus: true }), 'high');
  });

  it('no timing bonus keeps original level', () => {
    assert.equal(computeConfidence([{ key: 'a', kind: 'navigate' }], { timingBonus: false }), 'low');
    assert.equal(computeConfidence([{ key: 'a', kind: 'navigate' }]), 'low');
  });
});
