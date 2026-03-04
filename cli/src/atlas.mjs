// @ts-check
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { parseMarkdown } from './markdown.mjs';
import { kebabCase } from './normalize.mjs';
import { fail } from './config.mjs';

/**
 * Run the Atlas command: parse docs → feature catalog → atlas.json.
 * @param {import('./types.mjs').AiUiConfig} config
 * @param {{ verbose?: boolean }} flags
 */
export async function runAtlas(config, flags) {
  const cwd = process.cwd();
  const docFiles = expandGlobs(config.docs.globs, cwd);

  if (docFiles.length === 0) {
    fail('ATLAS_NO_DOCS', 'No doc files found matching configured globs.', 'Check docs.globs in ai-ui.config.json.');
  }

  if (flags.verbose) {
    console.log(`Atlas: scanning ${docFiles.length} file(s)...`);
  }

  /** @type {Map<string, import('./types.mjs').Feature>} */
  const featureMap = new Map();
  let tagCount = 0;

  for (const filePath of docFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const relPath = relative(cwd, filePath);
    const items = parseMarkdown(content, relPath);

    if (flags.verbose) {
      console.log(`  ${relPath}: ${items.length} item(s)`);
    }

    for (const item of items) {
      // Get a clean feature name from the text
      const name = item.tagId ? item.tagId.replace(/\./g, ' ').replace(/-/g, ' ') : cleanFeatureName(item.text);
      const id = item.tagId || kebabCase(name);
      if (!id) continue;

      if (item.type === 'tag') tagCount++;

      if (featureMap.has(id)) {
        // Merge sources
        const existing = featureMap.get(id);
        existing.sources.push({
          file: relPath,
          line: item.line,
          type: item.type,
          section: item.section,
        });
      } else {
        featureMap.set(id, {
          id,
          name,
          synonyms: [],
          sources: [{
            file: relPath,
            line: item.line,
            type: item.type,
            section: item.section,
          }],
          expected_entrypoints: [],
        });
      }
    }
  }

  // Sort features deterministically by ID
  const features = [...featureMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  const atlas = {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    features,
    stats: {
      files_scanned: docFiles.length,
      features_extracted: features.length,
      tag_count: tagCount,
    },
  };

  // Write output
  const outPath = resolve(cwd, config.output.atlas);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(atlas, null, 2) + '\n', 'utf-8');

  console.log(`Atlas: ${features.length} features from ${docFiles.length} file(s) → ${relative(cwd, outPath)}`);
}

/**
 * Clean up a raw text string into a presentable feature name.
 * Strips leading bullets, numbers, and extracts the "name" portion
 * from patterns like "Name: description" or "Name. Description."
 * @param {string} text
 * @returns {string}
 */
function cleanFeatureName(text) {
  let name = text
    .replace(/^[-*•]\s*/, '')           // leading bullets
    .replace(/^\d+[.)]\s*/, '');        // leading numbers

  // "Name: description" or "Name — description"
  const colonSplit = name.match(/^([^:—–]+?)\s*[:—–]\s/);
  if (colonSplit) return colonSplit[1].trim();

  // "Name. Rest of sentence." — take text before first period followed by space
  const periodSplit = name.match(/^([^.]+?)\.\s/);
  if (periodSplit && periodSplit[1].length >= 3) return periodSplit[1].trim();

  // Strip trailing parenthetical
  name = name.replace(/\s*\(.*?\)\s*$/, '');

  // If still very long, truncate at a reasonable word boundary
  if (name.length > 60) {
    const words = name.split(/\s+/);
    let truncated = '';
    for (const w of words) {
      if ((truncated + ' ' + w).length > 50) break;
      truncated = truncated ? truncated + ' ' + w : w;
    }
    return truncated;
  }

  return name.trim();
}

/**
 * Expand an array of glob patterns into actual file paths.
 * Supports: exact filenames, and simple ** patterns.
 * @param {string[]} globs
 * @param {string} cwd
 * @returns {string[]}
 */
function expandGlobs(globs, cwd) {
  /** @type {Set<string>} */
  const found = new Set();

  for (const pattern of globs) {
    if (pattern.includes('**')) {
      // Recursive glob: e.g. "docs/**/*.md"
      const parts = pattern.split('**/');
      const baseDir = resolve(cwd, parts[0] || '.');
      const suffix = parts[1] || '';

      if (existsSync(baseDir) && statSync(baseDir).isDirectory()) {
        walkDir(baseDir, (filePath) => {
          if (matchSuffix(filePath, suffix)) {
            found.add(filePath);
          }
        });
      }
    } else {
      // Exact file
      const filePath = resolve(cwd, pattern);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        found.add(filePath);
      }
    }
  }

  return [...found].sort();
}

/**
 * Recursively walk a directory.
 * @param {string} dir
 * @param {(filePath: string) => void} callback
 */
function walkDir(dir, callback) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

/**
 * Check if a file path matches a glob suffix like "*.md".
 * @param {string} filePath
 * @param {string} suffix
 * @returns {boolean}
 */
function matchSuffix(filePath, suffix) {
  if (!suffix) return true;
  if (suffix.startsWith('*.')) {
    return filePath.endsWith(suffix.slice(1));
  }
  return filePath.endsWith(suffix);
}
