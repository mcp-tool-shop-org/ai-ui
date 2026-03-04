// @ts-check
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fail } from './config.mjs';

/**
 * Run the Probe command: Playwright crawl → trigger graph → probe.jsonl.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean }} flags
 */
export async function runProbe(config, flags) {
  // Lazy-load Playwright
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    fail('PROBE_NO_PLAYWRIGHT', 'Playwright not installed.', 'Run: npm install', 2);
  }

  const { baseUrl, routes, maxDepth, timeout, skipLabels, safeOverride } = config.probe;
  const cwd = process.cwd();
  const outPath = resolve(cwd, config.output.probe);
  mkdirSync(dirname(outPath), { recursive: true });

  // Clear output file
  writeFileSync(outPath, '', 'utf-8');

  /** @param {object} obj */
  const writeLine = (obj) => {
    const line = JSON.stringify(obj) + '\n';
    writeFileSync(outPath, line, { flag: 'a', encoding: 'utf-8' });
  };

  const startedAt = new Date().toISOString();
  writeLine({ type: 'meta', base_url: baseUrl, started_at: startedAt, routes_configured: routes.length });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    fail('PROBE_BROWSER', `Failed to launch browser: ${e.message}`, 'Run: npx playwright install chromium', 2);
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  /** @type {Set<string>} */
  const visitedRoutes = new Set();
  /** @type {{ route: string, label: string, href: string, selector: string, element: string, parentNav: boolean, depth: number }[]} */
  const allTriggers = [];
  let skippedDestructive = 0;
  let networkEvents = 0;

  // Capture network requests
  page.on('request', (req) => {
    const url = req.url();
    // Only log interesting requests (not static assets)
    if (url.startsWith(baseUrl) && !url.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)(\?|$)/)) {
      networkEvents++;
    }
  });

  // Capture dialogs
  page.on('dialog', async (dialog) => {
    writeLine({
      type: 'dialog',
      route: page.url().replace(baseUrl, '') || '/',
      kind: dialog.type(),
      message: dialog.message(),
      timestamp: new Date().toISOString(),
    });
    await dialog.dismiss();
  });

  /**
   * Visit a route and extract triggers.
   * @param {string} route
   * @param {number} depth
   */
  async function visitRoute(route, depth) {
    if (visitedRoutes.has(route)) return;
    if (depth > maxDepth) return;
    visitedRoutes.add(route);

    const url = baseUrl + route;
    if (flags.verbose) console.log(`  Probe: visiting ${route} (depth ${depth})`);

    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout });
      if (!response || response.status() >= 400) {
        if (flags.verbose) console.log(`    Skipped: ${response?.status() || 'no response'}`);
        return;
      }
    } catch (e) {
      if (flags.verbose) console.log(`    Failed: ${e.message}`);
      return;
    }

    // Extract all clickable elements
    const triggers = await page.evaluate(({ skipLabels, safeOverride }) => {
      const results = [];
      const seen = new Set();

      // Query all interactive elements
      const elements = document.querySelectorAll('a[href], button, [role="button"], [onclick]');

      for (const el of elements) {
        const label = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!label || label.length > 100) continue;

        const href = el.getAttribute('href') || '';
        const tag = el.tagName.toLowerCase();

        // Deduplicate by label + href
        const key = `${label}|${href}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Check if inside <nav>
        let parentNav = false;
        let node = el.parentElement;
        while (node) {
          if (node.tagName === 'NAV' || node.tagName === 'HEADER') {
            parentNav = true;
            break;
          }
          node = node.parentElement;
        }

        // Check for destructive labels
        const isDestructive = skipLabels.some(s =>
          label.toLowerCase().includes(s.toLowerCase())
        );
        const isSafeOverride = el.hasAttribute(safeOverride);

        // Build a reasonable CSS selector
        let selector = tag;
        if (el.id) selector = `#${el.id}`;
        else if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(/\s+/).filter(c => c && !c.startsWith('_')).slice(0, 2);
          if (classes.length) selector = `${tag}.${classes.join('.')}`;
        }

        results.push({
          label,
          href,
          element: tag,
          selector,
          parentNav,
          isDestructive,
          isSafeOverride,
        });
      }

      return results;
    }, { skipLabels, safeOverride });

    for (const t of triggers) {
      if (t.isDestructive && !t.isSafeOverride) {
        skippedDestructive++;
        continue;
      }

      const trigger = {
        type: 'trigger',
        route,
        element: t.element,
        label: t.label,
        href: t.href,
        selector: t.selector,
        depth,
        parent_nav: t.parentNav,
        timestamp: new Date().toISOString(),
      };

      allTriggers.push({ ...trigger, route });
      writeLine(trigger);
    }

    // Discover new same-origin routes from links
    if (depth < maxDepth) {
      const newRoutes = triggers
        .filter(t => {
          if (t.isDestructive && !t.isSafeOverride) return false;
          if (!t.href || t.href.startsWith('#') || t.href.startsWith('mailto:') || t.href.startsWith('javascript:')) return false;
          // Same-origin check
          try {
            const u = new URL(t.href, baseUrl);
            return u.origin === new URL(baseUrl).origin;
          } catch { return false; }
        })
        .map(t => {
          try {
            const u = new URL(t.href, baseUrl);
            return u.pathname;
          } catch { return null; }
        })
        .filter(r => r && !visitedRoutes.has(r));

      for (const newRoute of newRoutes) {
        writeLine({
          type: 'route_change',
          from: route,
          to: newRoute,
          trigger_label: triggers.find(t => {
            try { return new URL(t.href, baseUrl).pathname === newRoute; } catch { return false; }
          })?.label || 'unknown',
          timestamp: new Date().toISOString(),
        });

        await visitRoute(newRoute, depth + 1);
      }
    }
  }

  // Visit all configured routes
  console.log(`Probe: crawling ${routes.length} route(s) from ${baseUrl}...`);
  for (const route of routes) {
    await visitRoute(route, 0);
  }

  const duration = Date.now() - new Date(startedAt).getTime();

  // Write summary
  writeLine({
    type: 'summary',
    total_triggers: allTriggers.length,
    routes_visited: visitedRoutes.size,
    duration_ms: duration,
    skipped_destructive: skippedDestructive,
    network_events: networkEvents,
  });

  await browser.close();

  console.log(`Probe: ${allTriggers.length} triggers across ${visitedRoutes.size} route(s) → ${relative(cwd, outPath)} (${duration}ms)`);
}
