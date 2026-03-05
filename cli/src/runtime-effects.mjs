// @ts-check
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';

// =============================================================================
// Pure functions — exported for testing
// =============================================================================

/**
 * Build a stable trigger ID from action + identifier.
 * @param {string} action - e.g. "click", "change"
 * @param {string} identifier - e.g. "btn-cta", "input-theme"
 * @returns {string}
 */
export function buildTriggerId(action, identifier) {
  const clean = identifier
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
    .slice(0, 60);
  return `${action}@${clean}`;
}

/**
 * Check if a method+URL matches any deny pattern.
 * @param {string} method
 * @param {string} url
 * @param {{ method: string, urlPattern: string }[]} patterns
 * @returns {{ matches: boolean, pattern?: { method: string, urlPattern: string } }}
 */
export function matchesMethodPattern(method, url, patterns) {
  for (const p of patterns) {
    if (p.method.toUpperCase() === method.toUpperCase()) {
      const re = new RegExp(p.urlPattern, 'i');
      if (re.test(url)) {
        return { matches: true, pattern: p };
      }
    }
  }
  return { matches: false };
}

/**
 * Check if a trigger is safe to click.
 * @param {{ label: string, safeAttr?: string|null, styleTokens?: string[], href?: string|null }} trigger
 * @param {import('./types.mjs').RuntimeEffectsSafeConfig} safeConfig
 * @returns {{ safe: boolean, reason?: string }}
 */
export function isTriggerSafe(trigger, safeConfig) {
  // Explicit safe override always wins
  if (trigger.safeAttr === 'true') {
    return { safe: true };
  }

  // Deny if label matches deny regex
  const denyRe = new RegExp(safeConfig.denyLabelRegex, 'i');
  if (denyRe.test(trigger.label)) {
    return { safe: false, reason: `label matches deny pattern: ${safeConfig.denyLabelRegex}` };
  }

  // Deny if href matches deny href regex
  if (safeConfig.denyHrefRegex && trigger.href) {
    const hrefRe = new RegExp(safeConfig.denyHrefRegex, 'i');
    if (hrefRe.test(trigger.href)) {
      return { safe: false, reason: `href matches deny pattern: ${safeConfig.denyHrefRegex}` };
    }
  }

  // Deny if method+URL matches deny method patterns
  if (safeConfig.denyMethodPatterns && safeConfig.denyMethodPatterns.length > 0 && trigger.href) {
    const result = matchesMethodPattern('GET', trigger.href, safeConfig.denyMethodPatterns);
    if (result.matches) {
      return { safe: false, reason: `href matches method pattern: ${result.pattern.method} ${result.pattern.urlPattern}` };
    }
  }

  // If destructive style + requireSafeAttr, deny unless safe attr present
  const destructiveTokens = ['destructive', 'danger', 'warning'];
  const hasDestructiveStyle = (trigger.styleTokens || []).some(t => destructiveTokens.includes(t));
  if (hasDestructiveStyle && safeConfig.requireSafeAttrForDestructive && trigger.safeAttr !== 'true') {
    return { safe: false, reason: 'destructive style without data-aiui-safe' };
  }

  return { safe: true };
}

/**
 * Normalize a URL relative to base, stripping origin.
 * @param {string} url
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeEffectUrl(url, baseUrl) {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.origin === base.origin) {
      return parsed.pathname + parsed.search;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Normalize a fetch event into a RuntimeEffect.
 * @param {string} triggerId
 * @param {string} route
 * @param {{ method: string, url: string, status: number, timestamp: number }} raw
 * @param {number} windowStart
 * @param {string} baseUrl
 * @returns {import('./types.mjs').RuntimeEffect}
 */
export function normalizeFetchEffect(triggerId, route, raw, windowStart, baseUrl) {
  return {
    kind: 'fetch',
    trigger_id: triggerId,
    route,
    window_ms: raw.timestamp - windowStart,
    method: raw.method,
    url: normalizeEffectUrl(raw.url, baseUrl),
    status: raw.status,
  };
}

/**
 * Normalize a navigation event into a RuntimeEffect.
 * @param {string} triggerId
 * @param {string} route
 * @param {{ from: string, to: string, timestamp: number }} raw
 * @param {number} windowStart
 * @param {string} baseUrl
 * @returns {import('./types.mjs').RuntimeEffect}
 */
export function normalizeNavigateEffect(triggerId, route, raw, windowStart, baseUrl) {
  return {
    kind: 'navigate',
    trigger_id: triggerId,
    route,
    window_ms: raw.timestamp - windowStart,
    from: normalizeEffectUrl(raw.from, baseUrl),
    to: normalizeEffectUrl(raw.to, baseUrl),
  };
}

/**
 * Normalize a download event into a RuntimeEffect.
 * @param {string} triggerId
 * @param {string} route
 * @param {{ filename: string, timestamp: number }} raw
 * @param {number} windowStart
 * @returns {import('./types.mjs').RuntimeEffect}
 */
export function normalizeDownloadEffect(triggerId, route, raw, windowStart) {
  return {
    kind: 'download',
    trigger_id: triggerId,
    route,
    window_ms: raw.timestamp - windowStart,
    filename: raw.filename,
  };
}

/**
 * Normalize a storage write event into a RuntimeEffect.
 * @param {string} triggerId
 * @param {string} route
 * @param {{ scope: string, key: string, timestamp: number }} raw
 * @param {number} windowStart
 * @returns {import('./types.mjs').RuntimeEffect}
 */
export function normalizeStorageWriteEffect(triggerId, route, raw, windowStart) {
  return {
    kind: 'storageWrite',
    trigger_id: triggerId,
    route,
    window_ms: raw.timestamp - windowStart,
    scope: raw.scope,
    key: raw.key,
  };
}

/**
 * Detect DOM effects by diffing pre/post snapshots.
 * Snapshots are arrays of { role, label, visible } objects.
 * Detects: modal_open (new dialog/alertdialog), toast (new status/alert), other new elements.
 * @param {{ before: { role: string, label: string, visible: boolean }[], after: { role: string, label: string, visible: boolean }[] }} snapshots
 * @param {string} triggerId
 * @param {string} route
 * @param {number} windowMs
 * @returns {import('./types.mjs').RuntimeEffect[]}
 */
export function detectDomEffects(snapshots, triggerId, route, windowMs) {
  /** @type {import('./types.mjs').RuntimeEffect[]} */
  const effects = [];

  // Build fingerprint sets
  const beforeSet = new Set(snapshots.before.map(s => `${s.role}|${s.label}|${s.visible}`));

  for (const item of snapshots.after) {
    const key = `${item.role}|${item.label}|${item.visible}`;
    if (beforeSet.has(key)) continue;

    // New element appeared
    let detail = 'dom_change';
    if (item.role === 'dialog' || item.role === 'alertdialog') {
      detail = 'modal_open';
    } else if (item.role === 'status' || item.role === 'alert') {
      detail = 'toast';
    }

    effects.push({
      kind: 'domEffect',
      trigger_id: triggerId,
      route,
      window_ms: windowMs,
      detail,
    });
  }

  // Deduplicate by detail
  const seen = new Set();
  return effects.filter(e => {
    if (seen.has(e.detail)) return false;
    seen.add(e.detail);
    return true;
  });
}

// =============================================================================
// DOM mutation summary + timing confidence
// =============================================================================

/**
 * Compute a lightweight DOM mutation summary from before/after snapshots.
 * Snapshots are arrays of { role, label, visible } objects.
 * @param {{ role: string, label: string, visible: boolean }[]} before
 * @param {{ role: string, label: string, visible: boolean }[]} after
 * @returns {import('./types.mjs').DomMutationSummary}
 */
export function computeDomMutationSummary(before, after) {
  const beforeMap = new Map();
  for (const item of before) {
    const key = `${item.role}|${item.label}`;
    beforeMap.set(key, item);
  }

  const afterMap = new Map();
  for (const item of after) {
    const key = `${item.role}|${item.label}`;
    afterMap.set(key, item);
  }

  let nodesAdded = 0;
  let nodesRemoved = 0;
  let attributesChanged = 0;
  let textChanged = 0;

  // Check for added/changed nodes
  for (const [key, item] of afterMap) {
    if (!beforeMap.has(key)) {
      nodesAdded++;
    } else {
      const prev = beforeMap.get(key);
      if (prev.visible !== item.visible) {
        attributesChanged++;
      }
    }
  }

  // Check for removed nodes
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) {
      nodesRemoved++;
    }
  }

  // Text changes: same role but different label
  const beforeByRole = new Map();
  for (const item of before) {
    if (!beforeByRole.has(item.role)) beforeByRole.set(item.role, []);
    beforeByRole.get(item.role).push(item.label);
  }
  const afterByRole = new Map();
  for (const item of after) {
    if (!afterByRole.has(item.role)) afterByRole.set(item.role, []);
    afterByRole.get(item.role).push(item.label);
  }
  for (const [role, afterLabels] of afterByRole) {
    const beforeLabels = beforeByRole.get(role) || [];
    const beforeSet = new Set(beforeLabels);
    for (const label of afterLabels) {
      if (!beforeSet.has(label) && beforeLabels.length > 0) {
        textChanged++;
      }
    }
  }

  return { nodesAdded, nodesRemoved, attributesChanged, textChanged };
}

/**
 * Compute a timing-based confidence bonus.
 * Effects arriving < 200ms from trigger are high-confidence (causal).
 * @param {number} windowMs - The effect's window_ms
 * @returns {'bonus'|'neutral'}
 */
export function computeTimingConfidence(windowMs) {
  return windowMs < 200 ? 'bonus' : 'neutral';
}

// =============================================================================
// Effect node identity stabilization
// =============================================================================

/** Cache-buster query params to strip from URLs */
const CACHE_BUSTER_PARAMS = new Set(['_t', '_', 'cb', 'cachebust', 'timestamp', 'ts', 'nocache', 'bust']);

/**
 * Normalize a URL for use in stable effect node IDs.
 * - Strips cache-buster query params
 * - Sorts remaining query params alphabetically
 * - Collapses numeric path segments to :id
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrlForId(url) {
  try {
    // Handle relative URLs by checking for scheme
    const hasScheme = /^https?:\/\//.test(url);
    const parsed = hasScheme ? new URL(url) : new URL(url, 'http://_placeholder');

    // Collapse numeric path segments
    const segments = parsed.pathname.split('/').map(seg =>
      /^\d+$/.test(seg) ? ':id' : seg
    );
    const normalizedPath = segments.join('/');

    // Filter and sort query params
    const params = [...parsed.searchParams.entries()]
      .filter(([key]) => !CACHE_BUSTER_PARAMS.has(key.toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0]));

    const queryStr = params.length > 0
      ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&')
      : '';

    if (hasScheme) {
      return `${parsed.origin}${normalizedPath}${queryStr}`;
    }
    return `${normalizedPath}${queryStr}`;
  } catch {
    return url;
  }
}

/**
 * Compute the normalized target string for an effect.
 * Shared by buildEvidenceKey and normalizeEffectId.
 * @param {{ kind: string, method?: string, url?: string, to?: string, filename?: string, scope?: string, key?: string, detail?: string }} effect
 * @returns {string}
 */
export function normalizeEffectTarget(effect) {
  switch (effect.kind) {
    case 'fetch':
      return `${effect.method || 'GET'} ${normalizeUrlForId(effect.url || '')}`;
    case 'navigate':
      return normalizeUrlForId(effect.to || '');
    case 'download':
      return effect.filename || '';
    case 'storageWrite':
      return `${effect.scope || 'local'}:${effect.key || ''}`;
    case 'domEffect':
      return effect.detail || '';
    default:
      return 'unknown';
  }
}

/**
 * Build a stable, deterministic effect node ID.
 * @param {{ kind: string, method?: string, url?: string, to?: string, filename?: string, scope?: string, key?: string, detail?: string }} effect
 * @returns {string}
 */
export function normalizeEffectId(effect) {
  const target = normalizeEffectTarget(effect);
  if (effect.kind === 'storageWrite') {
    return `effect:stateWrite:${effect.key || ''}`;
  }
  return `effect:${effect.kind}:${target}`;
}

// =============================================================================
// Evidence dedupe + confidence
// =============================================================================

/**
 * Build a stable evidence key from an effect or evidence entry.
 * Uses normalizeEffectTarget for URL normalization.
 * @param {{ kind: string, method?: string, url?: string, to?: string, filename?: string, scope?: string, key?: string, detail?: string }} effect
 * @returns {string}
 */
export function buildEvidenceKey(effect) {
  return `${effect.kind}:${normalizeEffectTarget(effect)}`;
}

/**
 * Deduplicate evidence entries by key. Returns unique entries sorted by key.
 * @param {import('./types.mjs').EvidenceEntry[]} evidence
 * @returns {import('./types.mjs').EvidenceEntry[]}
 */
export function deduplicateEvidence(evidence) {
  /** @type {Map<string, import('./types.mjs').EvidenceEntry>} */
  const seen = new Map();
  for (const e of evidence) {
    if (!seen.has(e.key)) {
      seen.set(e.key, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Compute confidence level from evidence array.
 * - high: 3+ entries with consistent kinds, OR med + timing bonus
 * - med: 2+ entries, or any fetch with 2xx status, OR low + timing bonus
 * - low: everything else
 * @param {import('./types.mjs').EvidenceEntry[]} evidence
 * @param {{ timingBonus?: boolean }} [opts]
 * @returns {import('./types.mjs').ConfidenceLevel}
 */
export function computeConfidence(evidence, opts) {
  if (!evidence || evidence.length === 0) return 'low';

  const hasTimingBonus = opts?.timingBonus === true;

  // Check for 2xx fetch (strong signal)
  const has2xxFetch = evidence.some(e => e.kind === 'fetch' && e.status !== undefined && e.status >= 200 && e.status < 300);

  /** @type {import('./types.mjs').ConfidenceLevel} */
  let base;

  if (evidence.length >= 3) {
    const kinds = new Set(evidence.map(e => e.kind));
    base = kinds.size <= 2 ? 'high' : 'med';
  } else if (evidence.length >= 2 || has2xxFetch) {
    base = 'med';
  } else {
    base = 'low';
  }

  // Apply timing bonus: low→med, med→high, high stays high
  if (hasTimingBonus) {
    if (base === 'low') return 'med';
    if (base === 'med') return 'high';
  }

  return base;
}

/**
 * Aggregate JSONL entries into a RuntimeEffectsSummary.
 * @param {{ type: string, [key: string]: any }[]} entries - Parsed JSONL lines
 * @returns {import('./types.mjs').RuntimeEffectsSummary}
 */
export function aggregateSummary(entries) {
  const meta = entries.find(e => e.type === 'meta');
  const effectEntries = entries.filter(e => e.type === 'effect');
  const summaryEntry = entries.find(e => e.type === 'summary');

  // Group effects by trigger_id
  /** @type {Map<string, { trigger_id: string, route: string, label: string, effects: import('./types.mjs').RuntimeEffect[] }>} */
  const triggerMap = new Map();

  for (const e of effectEntries) {
    if (!triggerMap.has(e.trigger_id)) {
      triggerMap.set(e.trigger_id, {
        trigger_id: e.trigger_id,
        route: e.route,
        label: e.label || e.trigger_id,
        effects: [],
      });
    }
    const entry = triggerMap.get(e.trigger_id);
    // Build the RuntimeEffect (strip type/label fields used for JSONL)
    /** @type {import('./types.mjs').RuntimeEffect} */
    const effect = { kind: e.kind, trigger_id: e.trigger_id, route: e.route, window_ms: e.window_ms };
    if (e.method !== undefined) effect.method = e.method;
    if (e.url !== undefined) effect.url = e.url;
    if (e.status !== undefined) effect.status = e.status;
    if (e.from !== undefined) effect.from = e.from;
    if (e.to !== undefined) effect.to = e.to;
    if (e.filename !== undefined) effect.filename = e.filename;
    if (e.scope !== undefined) effect.scope = e.scope;
    if (e.key !== undefined) effect.key = e.key;
    if (e.detail !== undefined) effect.detail = e.detail;
    entry.effects.push(effect);
  }

  // Sort triggers deterministically
  const triggers = [...triggerMap.values()].sort((a, b) => a.trigger_id.localeCompare(b.trigger_id));

  // Compute by_kind
  /** @type {Record<string, number>} */
  const by_kind = {};
  for (const e of effectEntries) {
    by_kind[e.kind] = (by_kind[e.kind] || 0) + 1;
  }

  const stats = summaryEntry
    ? {
        total_triggers: summaryEntry.total_triggers,
        triggers_fired: summaryEntry.triggers_fired,
        triggers_skipped: summaryEntry.triggers_skipped,
        effects_captured: summaryEntry.effects_captured,
        by_kind: summaryEntry.by_kind || by_kind,
      }
    : {
        total_triggers: triggerMap.size,
        triggers_fired: triggerMap.size,
        triggers_skipped: 0,
        effects_captured: effectEntries.length,
        by_kind,
      };

  return {
    version: '1.0.0',
    generated_at: meta?.started_at || new Date().toISOString(),
    url: meta?.url || '',
    triggers,
    stats,
  };
}

// =============================================================================
// CLI handler — Playwright orchestration
// =============================================================================

/**
 * Run the runtime-effects command: click triggers and capture observed effects.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean, url?: string, dryRun?: boolean }} flags
 */
export async function runRuntimeEffects(config, flags) {
  // Lazy-load Playwright
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    fail('RUNTIME_NO_PLAYWRIGHT', 'Playwright not installed.', 'Run: npm install', 2);
  }

  const baseUrl = flags.url || config.probe.baseUrl;
  const { routes, maxTriggersPerRoute, windowMs, safe: safeConfig } = config.runtimeEffects;
  const cwd = process.cwd();
  const outPath = resolve(cwd, config.output.runtimeEffects);
  const summaryPath = resolve(cwd, config.output.runtimeEffectsSummary);
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(summaryPath), { recursive: true });

  // Clear output file
  writeFileSync(outPath, '', 'utf-8');

  /** @param {object} obj */
  const writeLine = (obj) => {
    writeFileSync(outPath, JSON.stringify(obj) + '\n', { flag: 'a', encoding: 'utf-8' });
  };

  const dryRun = !!flags.dryRun;
  const startedAt = new Date().toISOString();
  writeLine({ type: 'meta', url: baseUrl, started_at: startedAt, routes, ...(dryRun ? { dry_run: true } : {}) });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    fail('RUNTIME_BROWSER', `Failed to launch browser: ${e.message}`, 'Run: npx playwright install chromium', 2);
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  let totalTriggers = 0;
  let triggersFired = 0;
  let triggersSkipped = 0;
  let effectsCaptured = 0;
  /** @type {Record<string, number>} */
  const byKind = {};

  const startTime = Date.now();

  for (const routePath of routes) {
    const routeUrl = new URL(routePath, baseUrl).href;
    if (flags.verbose) console.log(`Runtime-effects: navigating to ${routeUrl}`);

    try {
      await page.goto(routeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      if (flags.verbose) console.log(`  Skipping route ${routePath}: ${e.message}`);
      continue;
    }

    // Enumerate interactive elements
    const triggerElements = await page.$$eval(
      'a[href], button, [role="button"], [onclick]',
      (els) => els.map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        label: el.textContent?.trim().slice(0, 80) || el.getAttribute('aria-label') || '',
        id: el.id || null,
        safeAttr: el.getAttribute('data-aiui-safe'),
        styleTokens: (el.getAttribute('data-aiui-style') || '').split(/\s+/).filter(Boolean),
      }))
    );

    const triggerCount = Math.min(triggerElements.length, maxTriggersPerRoute);
    if (flags.verbose) console.log(`  Found ${triggerElements.length} triggers, processing up to ${triggerCount}`);

    for (let i = 0; i < triggerCount; i++) {
      const trig = triggerElements[i];
      totalTriggers++;

      // Compute trigger ID
      const identifier = trig.id || trig.label || `${trig.tag}-${trig.index}`;
      const triggerId = buildTriggerId('click', identifier);

      // Safety check
      const safeResult = isTriggerSafe(trig, safeConfig);
      if (!safeResult.safe) {
        triggersSkipped++;
        if (flags.verbose) console.log(`  Skip ${triggerId}: ${safeResult.reason}`);
        continue;
      }

      // Pre-click DOM snapshot
      const beforeSnapshot = await page.$$eval(
        '[role]',
        (els) => els.map(el => ({
          role: el.getAttribute('role') || '',
          label: el.textContent?.trim().slice(0, 40) || '',
          visible: el.checkVisibility?.() ?? true,
        }))
      );

      // Capture buffers
      /** @type {{ method: string, url: string, status: number, timestamp: number }[]} */
      const fetchEvents = [];
      /** @type {{ from: string, to: string, timestamp: number }[]} */
      const navEvents = [];
      /** @type {{ filename: string, timestamp: number }[]} */
      const downloadEvents = [];
      /** @type {{ scope: string, key: string, timestamp: number }[]} */
      const storageEvents = [];

      // Install listeners
      const currentUrl = page.url();

      /** @param {import('playwright').Response} response */
      const onResponse = (response) => {
        const req = response.request();
        const resUrl = response.url();
        // Skip static assets
        if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)(\?|$)/.test(resUrl)) return;
        fetchEvents.push({
          method: req.method(),
          url: resUrl,
          status: response.status(),
          timestamp: Date.now(),
        });
      };

      /** @param {import('playwright').Frame} frame */
      const onFrameNavigated = (frame) => {
        if (frame !== page.mainFrame()) return;
        const newUrl = frame.url();
        if (newUrl !== currentUrl && newUrl !== 'about:blank') {
          navEvents.push({ from: currentUrl, to: newUrl, timestamp: Date.now() });
        }
      };

      /** @param {import('playwright').Download} download */
      const onDownload = (download) => {
        downloadEvents.push({
          filename: download.suggestedFilename(),
          timestamp: Date.now(),
        });
      };

      page.on('response', onResponse);
      page.on('framenavigated', onFrameNavigated);
      page.on('download', onDownload);

      // Inject storage monkey-patch
      await page.evaluate(() => {
        // @ts-ignore
        if (!window.__aiui_storage_writes) {
          // @ts-ignore
          window.__aiui_storage_writes = [];
          const origLocal = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            // @ts-ignore
            window.__aiui_storage_writes.push({ scope: this === localStorage ? 'local' : 'session', key, timestamp: Date.now() });
            return origLocal.call(this, key, value);
          };
        }
      });

      // Activate the trigger (click or hover in dry-run mode)
      const windowStart = Date.now();
      try {
        const selector = `a[href], button, [role="button"], [onclick]`;
        const allEls = await page.$$(selector);
        const el = allEls[trig.index];
        if (el) {
          if (dryRun) {
            await el.hover({ timeout: 2000 }).catch(() => {});
          } else {
            await el.click({ timeout: 2000 }).catch(() => {});
          }
        }
      } catch {
        // Activation failed, continue
      }

      // Wait for settle
      try {
        await page.waitForLoadState('networkidle', { timeout: windowMs });
      } catch {
        // Timeout is expected — window closed
      }

      // Collect storage writes from page
      const storageWrites = await page.evaluate(() => {
        // @ts-ignore
        const writes = window.__aiui_storage_writes || [];
        // @ts-ignore
        window.__aiui_storage_writes = [];
        return writes;
      }).catch(() => []);

      for (const sw of storageWrites) {
        storageEvents.push(sw);
      }

      // Post-click DOM snapshot
      const afterSnapshot = await page.$$eval(
        '[role]',
        (els) => els.map(el => ({
          role: el.getAttribute('role') || '',
          label: el.textContent?.trim().slice(0, 40) || '',
          visible: el.checkVisibility?.() ?? true,
        }))
      ).catch(() => []);

      // Remove listeners
      page.off('response', onResponse);
      page.off('framenavigated', onFrameNavigated);
      page.off('download', onDownload);

      // Normalize effects and write JSONL
      const windowEnd = Date.now();

      const dryTag = dryRun ? { dry_run: true } : {};

      for (const raw of fetchEvents) {
        const effect = normalizeFetchEffect(triggerId, routePath, raw, windowStart, baseUrl);
        writeLine({ type: 'effect', label: trig.label, ...effect, ...dryTag });
        effectsCaptured++;
        byKind[effect.kind] = (byKind[effect.kind] || 0) + 1;
      }

      for (const raw of navEvents) {
        const effect = normalizeNavigateEffect(triggerId, routePath, raw, windowStart, baseUrl);
        writeLine({ type: 'effect', label: trig.label, ...effect, ...dryTag });
        effectsCaptured++;
        byKind[effect.kind] = (byKind[effect.kind] || 0) + 1;
      }

      for (const raw of downloadEvents) {
        const effect = normalizeDownloadEffect(triggerId, routePath, raw, windowStart);
        writeLine({ type: 'effect', label: trig.label, ...effect, ...dryTag });
        effectsCaptured++;
        byKind[effect.kind] = (byKind[effect.kind] || 0) + 1;
      }

      for (const raw of storageEvents) {
        const effect = normalizeStorageWriteEffect(triggerId, routePath, raw, windowStart);
        writeLine({ type: 'effect', label: trig.label, ...effect, ...dryTag });
        effectsCaptured++;
        byKind[effect.kind] = (byKind[effect.kind] || 0) + 1;
      }

      const domEffects = detectDomEffects(
        { before: beforeSnapshot, after: afterSnapshot },
        triggerId, routePath, windowEnd - windowStart
      );
      for (const effect of domEffects) {
        writeLine({ type: 'effect', label: trig.label, ...effect, ...dryTag });
        effectsCaptured++;
        byKind[effect.kind] = (byKind[effect.kind] || 0) + 1;
      }

      triggersFired++;

      // Navigate back for clean state
      try {
        await page.goto(routeUrl, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        // Best effort reset
      }
    }
  }

  const duration = Date.now() - startTime;

  // Write summary line
  writeLine({
    type: 'summary',
    total_triggers: totalTriggers,
    triggers_fired: triggersFired,
    triggers_skipped: triggersSkipped,
    effects_captured: effectsCaptured,
    by_kind: byKind,
    duration_ms: duration,
  });

  // Build and write summary JSON
  const jsonlContent = readFileSync(outPath, 'utf-8');
  const entries = jsonlContent.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const summary = aggregateSummary(entries);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  await browser.close();

  const modeLabel = dryRun ? ' (dry-run)' : '';
  console.log(`Runtime-effects${modeLabel}: ${triggersFired} triggers ${dryRun ? 'hovered' : 'fired'}, ${effectsCaptured} effects captured → ${relative(cwd, outPath)}`);
  if (flags.verbose) {
    console.log(`  Skipped: ${triggersSkipped}, Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log(`  Effects by kind: ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
    console.log(`  Summary: ${relative(cwd, summaryPath)}`);
  }
}
