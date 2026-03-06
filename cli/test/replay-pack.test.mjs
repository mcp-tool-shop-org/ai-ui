// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stableStringify,
  hashArtifact,
  canonicalizeArtifacts,
  redactUrl,
  redactArtifacts,
  buildManifest,
  buildReplayPack,
  loadReplayPack,
  extractArtifactsFromPack,
  PACK_VERSION,
} from '../src/replay-pack.mjs';
import { applyCoverageGate } from '../src/verify.mjs';
import { buildActionSummary } from '../src/runtime-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/replay-pack-fixtures.json'), 'utf-8'));

// =============================================================================
// stableStringify
// =============================================================================

describe('stableStringify', () => {
  it('sorts keys at all levels', () => {
    const a = stableStringify({ z: 1, a: { y: 2, b: 3 } });
    const b = stableStringify({ a: { b: 3, y: 2 }, z: 1 });
    assert.equal(a, b);
    // Verify keys are sorted: "a" before "z", "b" before "y"
    assert.ok(a.indexOf('"a"') < a.indexOf('"z"'));
  });

  it('preserves arrays in order', () => {
    const result = stableStringify({ items: [3, 1, 2] });
    assert.equal(result, '{"items":[3,1,2]}');
  });

  it('handles null, undefined, and primitives', () => {
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(undefined), undefined); // JSON.stringify(undefined) returns undefined
    assert.equal(stableStringify(42), '42');
    assert.equal(stableStringify('hello'), '"hello"');
    assert.equal(stableStringify(true), 'true');
  });
});

// =============================================================================
// hashArtifact
// =============================================================================

describe('hashArtifact', () => {
  it('produces deterministic hex output', () => {
    const hash1 = hashArtifact({ z: 1, a: 2 });
    const hash2 = hashArtifact({ a: 2, z: 1 });
    assert.equal(hash1, hash2);
    assert.match(hash1, /^[0-9a-f]{64}$/);
  });

  it('different inputs produce different hashes', () => {
    const hash1 = hashArtifact({ x: 1 });
    const hash2 = hashArtifact({ x: 2 });
    assert.notEqual(hash1, hash2);
  });
});

// =============================================================================
// canonicalizeArtifacts
// =============================================================================

describe('canonicalizeArtifacts', () => {
  it('sorts runtimeCoverage triggers by trigger_id', () => {
    const result = canonicalizeArtifacts({
      runtimeCoverage: fixtures.coverageReport,
    });
    const ids = result.runtimeCoverage.triggers.map(t => t.trigger_id);
    assert.deepEqual(ids, ['trigger:/|A', 'trigger:/|B', 'trigger:/|C']);
  });

  it('sorts runtimeCoverage surprises_v2 by (category, trigger_id, expected_id)', () => {
    const result = canonicalizeArtifacts({
      runtimeCoverage: fixtures.coverageReport,
    });
    const categories = result.runtimeCoverage.surprises_v2.map(s => s.category);
    assert.deepEqual(categories, ['missing_expected', 'new_effect', 'risky_skipped']);
  });

  it('sorts runtimeCoverageActions by actionId', () => {
    const result = canonicalizeArtifacts({
      runtimeCoverageActions: fixtures.actionReport,
    });
    const ids = result.runtimeCoverageActions.actions.map(a => a.actionId);
    assert.deepEqual(ids, ['act:aaa00001', 'act:bbb00002', 'act:ccc00003']);
  });

  it('sorts graph nodes by id and edges by from+to+type', () => {
    const result = canonicalizeArtifacts({
      graph: fixtures.graph,
    });
    const nodeIds = result.graph.nodes.map(n => n.id);
    assert.deepEqual(nodeIds, ['feature:search', 'trigger:A', 'trigger:B']);
    const edgeKeys = result.graph.edges.map(e => `${e.from}→${e.to}`);
    assert.deepEqual(edgeKeys, ['trigger:A→feature:search', 'trigger:B→feature:search']);
  });

  it('is idempotent', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
      graph: fixtures.graph,
    };
    const first = canonicalizeArtifacts(artifacts);
    const second = canonicalizeArtifacts(first);
    assert.deepEqual(first, second);
  });

  it('does not mutate input', () => {
    const original = JSON.parse(JSON.stringify({ runtimeCoverage: fixtures.coverageReport }));
    const originalStr = JSON.stringify(original);
    canonicalizeArtifacts(original);
    assert.equal(JSON.stringify(original), originalStr);
  });
});

// =============================================================================
// redactUrl
// =============================================================================

describe('redactUrl', () => {
  it('strips query params and fragment from full URL', () => {
    assert.equal(
      redactUrl('http://localhost:4321/api/data?token=secret&session=abc'),
      'http://localhost:4321/api/data',
    );
  });

  it('strips fragment from URL', () => {
    assert.equal(
      redactUrl('http://localhost:4321/page#section'),
      'http://localhost:4321/page',
    );
  });

  it('preserves plain path (no scheme)', () => {
    assert.equal(redactUrl('/api/data?x=1'), '/api/data');
  });

  it('returns empty/falsy input unchanged', () => {
    assert.equal(redactUrl(''), '');
    assert.equal(redactUrl(null), null);
  });
});

// =============================================================================
// redactArtifacts
// =============================================================================

describe('redactArtifacts', () => {
  it('strips query params from fetch effect URLs', () => {
    const result = redactArtifacts({ runtimeEffectsSummary: fixtures.runtimeEffectsSummary });
    const fetchEffect = result.runtimeEffectsSummary.triggers[0].effects[0];
    assert.equal(fetchEffect.url, 'http://localhost:4321/api/data');
    assert.ok(!fetchEffect.url.includes('token'));
  });

  it('strips query params from navigate effect URLs', () => {
    const result = redactArtifacts({ runtimeEffectsSummary: fixtures.runtimeEffectsSummary });
    const navEffect = result.runtimeEffectsSummary.triggers[0].effects[1];
    assert.equal(navEffect.from, 'http://localhost:4321/');
    assert.equal(navEffect.to, 'http://localhost:4321/about');
  });

  it('preserves trigger labels and routes', () => {
    const result = redactArtifacts({ runtimeEffectsSummary: fixtures.runtimeEffectsSummary });
    assert.equal(result.runtimeEffectsSummary.triggers[0].label, 'A');
    assert.equal(result.runtimeEffectsSummary.triggers[0].route, '/');
  });

  it('is a no-op without runtimeEffectsSummary', () => {
    const input = { runtimeCoverage: fixtures.coverageReport };
    const result = redactArtifacts(input);
    assert.deepEqual(result.runtimeCoverage, fixtures.coverageReport);
  });

  it('does not mutate input', () => {
    const original = JSON.parse(JSON.stringify({ runtimeEffectsSummary: fixtures.runtimeEffectsSummary }));
    const originalUrl = original.runtimeEffectsSummary.triggers[0].effects[0].url;
    redactArtifacts(original);
    assert.equal(original.runtimeEffectsSummary.triggers[0].effects[0].url, originalUrl);
  });
});

// =============================================================================
// buildManifest
// =============================================================================

describe('buildManifest', () => {
  it('produces correct structure', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const manifest = buildManifest(artifacts, fixtures.minimalConfig, null);
    assert.equal(manifest.tool.name, 'ai-ui');
    assert.equal(manifest.tool.version, '1.0.0');
    assert.ok(manifest.created_at);
    assert.ok(manifest.config_snapshot);
    assert.ok(Array.isArray(manifest.inputs));
    assert.ok(manifest.summary);
    assert.equal(manifest.baseline_slice, null);
  });

  it('includes SHA-256 for present inputs', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const manifest = buildManifest(artifacts, fixtures.minimalConfig, null);
    const coverageInput = manifest.inputs.find(i => i.key === 'runtimeCoverage');
    assert.ok(coverageInput.present);
    assert.match(coverageInput.sha256, /^[0-9a-f]{64}$/);
  });

  it('marks absent inputs', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const manifest = buildManifest(artifacts, fixtures.minimalConfig, null);
    const graphInput = manifest.inputs.find(i => i.key === 'graph');
    assert.equal(graphInput.present, false);
    assert.equal(graphInput.sha256, '');
  });

  it('extracts summary from coverage data', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const manifest = buildManifest(artifacts, fixtures.minimalConfig, null);
    assert.equal(manifest.summary.coverage_percent, 33);
    assert.equal(manifest.summary.total_actions, 3);
  });

  it('includes baseline slice when provided', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const manifest = buildManifest(artifacts, fixtures.minimalConfig, fixtures.baselineSlice);
    assert.ok(manifest.baseline_slice);
    assert.equal(manifest.baseline_slice.coverage_percent, 33);
    assert.deepEqual(manifest.baseline_slice.action_ids, fixtures.baselineSlice.action_ids);
  });
});

// =============================================================================
// buildReplayPack
// =============================================================================

describe('buildReplayPack', () => {
  it('produces a valid pack', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
      runtimeEffectsSummary: fixtures.runtimeEffectsSummary,
      graph: fixtures.graph,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    assert.equal(pack.version, PACK_VERSION);
    assert.ok(pack.manifest);
    assert.ok(pack.artifacts);
  });

  it('canonicalizes artifacts', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    // Triggers should be sorted (fixture has B, A, C — should become A, B, C)
    const ids = pack.artifacts.runtimeCoverage.triggers.map(t => t.trigger_id);
    assert.deepEqual(ids, ['trigger:/|A', 'trigger:/|B', 'trigger:/|C']);
  });

  it('redacts URLs by default', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
      runtimeEffectsSummary: fixtures.runtimeEffectsSummary,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    const fetchEffect = pack.artifacts.runtimeEffectsSummary.triggers[0].effects[0];
    assert.ok(!fetchEffect.url.includes('token'));
  });

  it('preserves URLs with --no-redact', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
      runtimeEffectsSummary: fixtures.runtimeEffectsSummary,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null, { redact: false });
    const fetchEffect = pack.artifacts.runtimeEffectsSummary.triggers[0].effects[0];
    assert.ok(fetchEffect.url.includes('token'));
  });

  it('handles missing optional artifacts', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    assert.equal(pack.artifacts.graph, undefined);
    assert.equal(pack.artifacts.runtimeEffectsSummary, undefined);
  });
});

// =============================================================================
// loadReplayPack
// =============================================================================

describe('loadReplayPack', () => {
  const tmpDir = resolve(__dirname, '.tmp-replay-test');

  it('loads a valid pack', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);

    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, 'valid.replay.json');
    writeFileSync(path, JSON.stringify(pack), 'utf-8');

    const loaded = loadReplayPack(path);
    assert.equal(loaded.version, PACK_VERSION);
    assert.ok(loaded.manifest);
    assert.ok(loaded.artifacts);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects missing version', () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, 'no-version.replay.json');
    writeFileSync(path, JSON.stringify(fixtures.invalidPack_noVersion), 'utf-8');

    assert.throws(() => loadReplayPack(path), /missing "version"/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects missing manifest', () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, 'no-manifest.replay.json');
    writeFileSync(path, JSON.stringify(fixtures.invalidPack_noManifest), 'utf-8');

    assert.throws(() => loadReplayPack(path), /missing "manifest"/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects missing artifacts', () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, 'no-artifacts.replay.json');
    writeFileSync(path, JSON.stringify(fixtures.invalidPack_noArtifacts), 'utf-8');

    assert.throws(() => loadReplayPack(path), /missing "artifacts"/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects version mismatch', () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, 'wrong-version.replay.json');
    writeFileSync(path, JSON.stringify(fixtures.invalidPack_wrongVersion), 'utf-8');

    assert.throws(() => loadReplayPack(path), /incompatible.*major version/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-existent file', () => {
    assert.throws(() => loadReplayPack('/nonexistent/path.replay.json'), /not found/);
  });
});

// =============================================================================
// extractArtifactsFromPack
// =============================================================================

describe('extractArtifactsFromPack', () => {
  it('maps artifact keys correctly', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
      graph: fixtures.graph,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, fixtures.baselineSlice);
    const extracted = extractArtifactsFromPack(pack);

    assert.ok(extracted.coverageReport);
    assert.ok(extracted.actionReport);
    assert.ok(extracted.graph);
    assert.ok(extracted.baselineCoverage);
    assert.equal(extracted.baselineCoverage.coverage_percent, 33);
  });

  it('returns null for missing artifacts', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    const extracted = extractArtifactsFromPack(pack);

    assert.equal(extracted.graph, null);
    assert.equal(extracted.runtimeSummary, null);
    assert.equal(extracted.verify, null);
    assert.equal(extracted.baselineCoverage, null);
  });
});

// =============================================================================
// Round-trip: gate reproducibility
// =============================================================================

describe('round-trip gate reproducibility', () => {
  it('same gate result from pack vs direct (regressions mode, no regressions)', () => {
    // Direct: apply gate to raw artifacts
    const directResult = applyCoverageGate(
      'regressions',
      fixtures.actionReport,
      fixtures.coverageReport,
      fixtures.minimalConfig.coverageGate,
      fixtures.baselineSlice,
    );

    // Via pack: build → extract → apply gate
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, fixtures.baselineSlice);
    const extracted = extractArtifactsFromPack(pack);
    const packResult = applyCoverageGate(
      'regressions',
      extracted.actionReport,
      extracted.coverageReport,
      fixtures.minimalConfig.coverageGate,
      extracted.baselineCoverage,
    );

    assert.equal(directResult.blockers.length, packResult.blockers.length);
    assert.equal(directResult.warnings.length, packResult.warnings.length);
    // Delta new/resolved counts match
    assert.equal(directResult.delta?.new_action_ids.length, packResult.delta?.new_action_ids.length);
    assert.equal(directResult.delta?.resolved_action_ids.length, packResult.delta?.resolved_action_ids.length);
  });

  it('same gate result from pack vs direct (minimum mode)', () => {
    const strictGate = { minCoveragePercent: 80, maxTotalActions: 2, maxActionsByType: null };

    const directResult = applyCoverageGate(
      'minimum',
      fixtures.actionReport,
      fixtures.coverageReport,
      strictGate,
      null,
    );

    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    const extracted = extractArtifactsFromPack(pack);
    const packResult = applyCoverageGate(
      'minimum',
      extracted.actionReport,
      extracted.coverageReport,
      strictGate,
      null,
    );

    assert.equal(directResult.blockers.length, packResult.blockers.length);
    for (let i = 0; i < directResult.blockers.length; i++) {
      assert.equal(directResult.blockers[i].rule, packResult.blockers[i].rule);
    }
  });

  it('empty baseline fallback works in pack', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    const extracted = extractArtifactsFromPack(pack);

    const result = applyCoverageGate(
      'regressions',
      extracted.actionReport,
      extracted.coverageReport,
      fixtures.minimalConfig.coverageGate,
      extracted.baselineCoverage, // null
    );

    // Should warn about no baseline, not block
    assert.equal(result.blockers.length, 0);
    assert.ok(result.warnings.some(w => w.rule === 'gate_no_baseline'));
  });

  it('action summary round-trips through pack', () => {
    const directSummary = buildActionSummary(
      fixtures.actionReport.actions,
      fixtures.coverageReport.surprises_v2,
      fixtures.coverageReport.summary.coverage_percent,
    );

    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    const extracted = extractArtifactsFromPack(pack);
    const packSummary = buildActionSummary(
      extracted.actionReport.actions,
      extracted.coverageReport.surprises_v2,
      extracted.coverageReport.summary.coverage_percent,
    );

    assert.equal(directSummary.total_actions, packSummary.total_actions);
    assert.equal(directSummary.coverage_percent, packSummary.coverage_percent);
    assert.deepEqual(directSummary.by_action_type, packSummary.by_action_type);
    assert.deepEqual(directSummary.by_surprise_category, packSummary.by_surprise_category);
  });

  it('pack hash is deterministic', () => {
    const artifacts = {
      runtimeCoverage: fixtures.coverageReport,
      runtimeCoverageActions: fixtures.actionReport,
    };
    const pack1 = buildReplayPack(artifacts, fixtures.minimalConfig, null);
    const pack2 = buildReplayPack(artifacts, fixtures.minimalConfig, null);

    // Artifacts should be identical (canonicalized)
    assert.equal(
      stableStringify(pack1.artifacts),
      stableStringify(pack2.artifacts),
    );
  });
});
