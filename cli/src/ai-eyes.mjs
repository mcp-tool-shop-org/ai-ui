// @ts-check
/**
 * ai-eyes — Eyes v0: Visual Surface Enrichment
 *
 * Uses Playwright to capture element screenshots, then LLaVA (local Ollama)
 * to identify icon-only buttons and text-poor surfaces.
 *
 * Outputs:
 *   - eyes.json           (per-surface visual annotations)
 *   - eyes.patch.json     (suggested surface hints)
 *   - eyes.md             (human summary)
 *   - eyes-screenshots/   (element PNGs, opt-in)
 *
 * AI outputs suggestions only. Never mutates truth artifacts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './config.mjs';
import { loadDesignMapInputs, buildSurfaceInventory } from './design-map.mjs';
import { checkOllamaAvailable, checkModelAvailable, queryOllamaVision, OllamaError } from './ollama.mjs';
import { buildEyesPrompt, parseEyesResponse, EyesParseError } from './ai-eyes-prompt.mjs';

const VERSION = '1.0.0';

/** Selector for interactive elements — same as probe.mjs / runtime-effects.mjs */
const TRIGGER_SELECTOR = 'a[href], button, [role="button"], [onclick]';

/**
 * Determine if a surface is "text-poor" (icon-only or very short label).
 * These are the surfaces that benefit most from visual analysis.
 * @param {string} label
 * @returns {boolean}
 */
function isTextPoor(label) {
  if (!label || label.trim().length === 0) return true;
  // Single character or emoji-only
  if (label.trim().length <= 2) return true;
  // Common icon-only patterns
  if (/^[…⋯⋮⋱☰✕✖×⚙🔊🔇🎵⏸⏵▶■●]+$/.test(label.trim())) return true;
  return false;
}

/**
 * SHA-256 hash of a buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Capture element screenshots using Playwright.
 *
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {import('./types.mjs').DesignSurfaceInventory} inventory
 * @param {{ maxElements: number, saveScreenshots: boolean, screenshotDir: string, timeout: number, verbose: boolean }} opts
 * @returns {Promise<{ surfaceId: string, label: string, route: string, locationGroup: string, role: string, imgBuffer: Buffer, imgHash: string, pngPath: string|null, boundingBox: { x: number, y: number, width: number, height: number } }[]>}
 */
async function captureElementScreenshots(baseUrl, routes, inventory, opts) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    fail('EYES_NO_PW', 'Playwright is not installed', 'Install with: npm i -D playwright');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  /** @type {typeof captures} */
  const captures = [];

  try {
    // Collect all surfaces we want to screenshot
    const allSurfaces = [];
    for (const [group, entries] of Object.entries(inventory.groups)) {
      for (const entry of entries) {
        allSurfaces.push({ ...entry, location_group: group });
      }
    }

    // Group by route to minimize navigation
    const byRoute = new Map();
    for (const s of allSurfaces) {
      if (!byRoute.has(s.route)) byRoute.set(s.route, []);
      byRoute.get(s.route).push(s);
    }

    for (const route of routes) {
      const surfaces = byRoute.get(route) || [];
      if (surfaces.length === 0) continue;

      const url = new URL(route, baseUrl).href;
      if (opts.verbose) console.error(`  [eyes] navigating to ${url} (${surfaces.length} surfaces)`);

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeout });
      } catch (err) {
        console.error(`  [eyes] ⚠ failed to load ${url}: ${err.message}`);
        continue;
      }

      // Wait a moment for animations to settle
      await page.waitForTimeout(500);

      // Find all interactive elements on this page
      const elements = await page.$$(TRIGGER_SELECTOR);

      // Map surfaces to elements by label match
      let capturedThisRoute = 0;
      for (const surface of surfaces) {
        if (capturedThisRoute >= opts.maxElements) break;

        // Find matching element by label
        let matchedEl = null;
        for (const el of elements) {
          const text = await el.textContent().catch(() => '');
          const trimmed = (text || '').trim().slice(0, 100);
          const ariaLabel = await el.getAttribute('aria-label').catch(() => '');
          if (trimmed === surface.label || ariaLabel === surface.label) {
            matchedEl = el;
            break;
          }
        }

        if (!matchedEl) {
          // Try selector-based match
          if (surface.selector) {
            try {
              matchedEl = await page.$(surface.selector);
            } catch { /* ignore selector errors */ }
          }
        }

        if (!matchedEl) continue;

        // Check if element is visible
        const isVisible = await matchedEl.isVisible().catch(() => false);
        if (!isVisible) continue;

        // Capture bounding box
        const box = await matchedEl.boundingBox().catch(() => null);
        if (!box || box.width < 4 || box.height < 4) continue;

        // Capture element screenshot
        try {
          const imgBuffer = await matchedEl.screenshot({ type: 'png' });
          const imgHash = hashBuffer(imgBuffer);
          const surfaceId = surface.linked_triggers[0] || `surface:${surface.route}|${surface.label}`;

          let pngPath = null;
          if (opts.saveScreenshots) {
            mkdirSync(opts.screenshotDir, { recursive: true });
            const safeName = surfaceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
            pngPath = join(opts.screenshotDir, `${safeName}.png`);
            writeFileSync(pngPath, imgBuffer);
          }

          captures.push({
            surfaceId,
            label: surface.label,
            route: surface.route,
            locationGroup: surface.location_group,
            role: surface.role,
            imgBuffer,
            imgHash,
            pngPath,
            boundingBox: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
          });

          capturedThisRoute++;
          if (opts.verbose) {
            console.error(`    ✓ ${surface.label || '(no label)'} [${box.width.toFixed(0)}×${box.height.toFixed(0)}]`);
          }
        } catch (err) {
          if (opts.verbose) {
            console.error(`    ⚠ screenshot failed for "${surface.label}": ${err.message}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  return captures;
}

/**
 * Build surface hints patch from Eyes annotations.
 *
 * @param {import('./types.mjs').EyesAnnotation[]} annotations
 * @param {string} model
 * @returns {import('./types.mjs').EyesPatch}
 */
function buildEyesPatch(annotations, model) {
  /** @type {Record<string, { iconLabel: string, nearbyContext: string }>} */
  const surfaceHints = {};
  /** @type {Record<string, import('./types.mjs').EyesPatchProvenance>} */
  const provenance = {};

  for (const ann of annotations) {
    // Only generate hints for text-poor surfaces with decent confidence
    if (!isTextPoor(ann.label)) continue;
    if (ann.confidence < 0.3) continue;
    if (!ann.icon_guess || ann.icon_guess === 'none') continue;

    surfaceHints[ann.surface_id] = {
      iconLabel: ann.icon_guess,
      nearbyContext: ann.nearby_context,
    };
    provenance[ann.surface_id] = {
      icon_guess: ann.icon_guess,
      visible_text: ann.visible_text,
      confidence: ann.confidence,
      img_hash: ann.img_hash,
      model,
    };
  }

  return { surfaceHints, provenance };
}

/**
 * Render a human-readable markdown summary.
 *
 * @param {import('./types.mjs').AiEyesReport} report
 * @returns {string}
 */
function renderEyesMd(report) {
  const lines = [
    `# AI Eyes Report`,
    ``,
    `**Model:** ${report.model}`,
    `**Generated:** ${report.generated_at}`,
    `**Surfaces screenshotted:** ${report.stats.surfaces_screenshotted} / ${report.stats.total_surfaces}`,
    `**Annotated:** ${report.stats.surfaces_annotated}`,
    `**Icon-only found:** ${report.stats.icon_only_found}`,
    `**Avg confidence:** ${(report.stats.avg_confidence * 100).toFixed(1)}%`,
    ``,
  ];

  // Annotations table
  const sorted = [...report.annotations]
    .filter(a => a.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  if (sorted.length > 0) {
    lines.push(`## Visual Annotations`, ``);
    lines.push(`| Surface | Label | Icon Guess | Visible Text | Confidence |`);
    lines.push(`|---------|-------|------------|-------------|------------|`);
    for (const a of sorted.slice(0, 30)) {
      const label = a.label || '(none)';
      const conf = (a.confidence * 100).toFixed(0) + '%';
      lines.push(`| ${a.surface_id.slice(0, 40)} | ${label} | ${a.icon_guess} | ${a.visible_text.slice(0, 30)} | ${conf} |`);
    }
    lines.push(``);
  }

  // Patch summary
  const hintKeys = Object.keys(report.patch.surfaceHints);
  if (hintKeys.length > 0) {
    lines.push(`## Surface Hints Patch`, ``);
    lines.push(`${hintKeys.length} text-poor surface(s) identified:`, ``);
    for (const key of hintKeys.slice(0, 20)) {
      const hint = report.patch.surfaceHints[key];
      lines.push(`- **${key.slice(0, 50)}**: icon="${hint.iconLabel}" context="${hint.nearbyContext.slice(0, 40)}"`);
    }
    lines.push(``);
    lines.push(`Use \`--eyes eyes.json\` with \`ai-suggest\` to feed these annotations into Brain.`);
  } else {
    lines.push(`## Surface Hints Patch`, ``, `No text-poor surfaces found that need visual annotation.`);
  }

  return lines.join('\n');
}

/**
 * Main command handler for ai-eyes.
 *
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ from?: string, out?: string, replay?: string, verbose?: boolean, dryRun?: boolean, url?: string, model?: string }} flags
 */
export async function runAiEyes(config, flags) {
  const cwd = process.cwd();
  const eyesConfig = config.aiEyes || { model: 'llava:13b', timeout: 90000, maxElements: 30, saveScreenshots: true };
  const model = flags.model || eyesConfig.model;
  const timeout = eyesConfig.timeout;
  const maxElements = eyesConfig.maxElements;
  const baseUrl = flags.url || config.probe.baseUrl;
  const routes = config.probe.routes;
  const screenshotDir = flags.out
    ? join(flags.out, 'eyes-screenshots')
    : resolve(cwd, config.output.aiEyesScreenshots);

  // 1. Pre-flight: check Ollama + model
  if (!flags.dryRun) {
    console.error('Checking Ollama availability...');
    const available = await checkOllamaAvailable();
    if (!available) {
      fail('EYES_NO_OLLAMA', 'Ollama is not running', 'Start Ollama with: ollama serve');
    }

    const modelReady = await checkModelAvailable(model);
    if (!modelReady) {
      fail('EYES_NO_MODEL', `Model "${model}" is not available`, `Pull it with: ollama pull ${model}`);
    }
    console.error(`Ollama ready: model=${model}`);
  }

  // 2. Load design-map artifacts for surface inventory
  console.error('Loading design-map artifacts...');
  const inputs = loadDesignMapInputs(config, cwd, { replay: flags.replay, verbose: flags.verbose });
  const inventory = buildSurfaceInventory(inputs.graph, inputs.diff, inputs.coverage);

  const totalSurfaces = Object.values(inventory.groups).reduce((sum, entries) => sum + entries.length, 0);
  console.error(`${totalSurfaces} surfaces in inventory across ${routes.length} route(s).`);

  // 3. Capture element screenshots
  console.error('Capturing element screenshots...');
  const captures = await captureElementScreenshots(baseUrl, routes, inventory, {
    maxElements,
    saveScreenshots: eyesConfig.saveScreenshots,
    screenshotDir,
    timeout: config.probe.timeout,
    verbose: flags.verbose || false,
  });

  console.error(`Captured ${captures.length} element screenshots.`);

  if (captures.length === 0) {
    console.error('No elements captured. Is the dev server running?');
    return;
  }

  // 4. Query LLaVA for each capture
  /** @type {import('./types.mjs').EyesAnnotation[]} */
  const annotations = [];
  let errorCount = 0;
  let iconOnlyCount = 0;

  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const labelDisplay = cap.label || '(no label)';
    console.error(`  [${i + 1}/${captures.length}] ${labelDisplay} [${cap.locationGroup}]`);

    if (flags.dryRun) {
      annotations.push({
        surface_id: cap.surfaceId,
        label: cap.label,
        route: cap.route,
        location_group: /** @type {import('./types.mjs').LocationGroup} */ (cap.locationGroup),
        icon_guess: '(dry run)',
        visible_text: '',
        nearby_context: '',
        confidence: 0,
        img_hash: cap.imgHash,
        png_path: cap.pngPath,
        bounding_box: cap.boundingBox,
      });
      continue;
    }

    const prompt = buildEyesPrompt({
      existingLabel: cap.label,
      role: cap.role,
      route: cap.route,
      locationGroup: cap.locationGroup,
    });

    try {
      const imageBase64 = cap.imgBuffer.toString('base64');
      const rawResponse = await queryOllamaVision(prompt, imageBase64, {
        model,
        timeout,
        verbose: flags.verbose,
      });

      const parsed = parseEyesResponse(rawResponse, cap.surfaceId);

      if (isTextPoor(cap.label)) iconOnlyCount++;

      annotations.push({
        surface_id: cap.surfaceId,
        label: cap.label,
        route: cap.route,
        location_group: /** @type {import('./types.mjs').LocationGroup} */ (cap.locationGroup),
        icon_guess: parsed.icon_guess,
        visible_text: parsed.visible_text,
        nearby_context: parsed.nearby_context,
        confidence: parsed.confidence,
        img_hash: cap.imgHash,
        png_path: cap.pngPath,
        bounding_box: cap.boundingBox,
      });
    } catch (err) {
      if (err instanceof OllamaError || err instanceof EyesParseError) {
        console.error(`    ⚠ ${err.message}`);
        errorCount++;
        annotations.push({
          surface_id: cap.surfaceId,
          label: cap.label,
          route: cap.route,
          location_group: /** @type {import('./types.mjs').LocationGroup} */ (cap.locationGroup),
          icon_guess: '',
          visible_text: '',
          nearby_context: '',
          confidence: 0,
          img_hash: cap.imgHash,
          png_path: cap.pngPath,
          bounding_box: cap.boundingBox,
        });
      } else {
        throw err;
      }
    }
  }

  // 5. Build patch
  const patch = buildEyesPatch(annotations, model);

  // 6. Assemble report
  const confidences = annotations.filter(a => a.confidence > 0).map(a => a.confidence);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  /** @type {import('./types.mjs').AiEyesReport} */
  const report = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    model,
    annotations,
    patch,
    stats: {
      total_surfaces: totalSurfaces,
      surfaces_screenshotted: captures.length,
      surfaces_annotated: annotations.filter(a => a.confidence > 0).length,
      icon_only_found: iconOnlyCount,
      avg_confidence: avgConfidence,
    },
  };

  // 7. Write outputs
  const outDir = flags.out || dirname(resolve(cwd, config.output.aiEyesJson));
  mkdirSync(outDir, { recursive: true });

  const eyesPath = flags.out ? join(flags.out, 'eyes.json') : resolve(cwd, config.output.aiEyesJson);
  const patchPath = flags.out ? join(flags.out, 'eyes.patch.json') : resolve(cwd, config.output.aiEyesPatchJson);
  const mdPath = flags.out ? join(flags.out, 'eyes.md') : resolve(cwd, config.output.aiEyesMd);

  // Strip imgBuffer from annotations before writing (not serializable / huge)
  writeFileSync(eyesPath, JSON.stringify(report, null, 2));
  writeFileSync(patchPath, JSON.stringify(patch, null, 2));
  writeFileSync(mdPath, renderEyesMd(report));

  // 8. Summary
  console.error(`\n✓ AI Eyes complete`);
  console.error(`  Model: ${model}`);
  console.error(`  Surfaces screenshotted: ${captures.length}`);
  console.error(`  Annotated: ${annotations.filter(a => a.confidence > 0).length}`);
  console.error(`  Icon-only: ${iconOnlyCount}`);
  console.error(`  Avg confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  console.error(`  Errors: ${errorCount}`);
  console.error(`  Surface hints: ${Object.keys(patch.surfaceHints).length}`);
  console.error(`\n  Outputs:`);
  console.error(`    ${eyesPath}`);
  console.error(`    ${patchPath}`);
  console.error(`    ${mdPath}`);
  if (eyesConfig.saveScreenshots) {
    console.error(`    ${screenshotDir}/`);
  }
}
