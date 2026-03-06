// @ts-check
/**
 * repo-scan — Safe File Selection for Hands
 *
 * Scans the target repo for files that Hands is allowed to edit.
 * Enforces extension whitelist, size limits, and ignores common
 * non-source directories.
 *
 * Never reads secrets, .env, node_modules, or binary files.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

/** Directories that are always skipped. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.output',
  'dist', 'build', 'out', 'coverage', '.cache', '__pycache__',
  '.turbo', '.vercel', '.netlify', 'ai-ui-output', 'ai-ui-memory',
]);

/** Files that must never be sent to a coder model. */
const IGNORE_FILES = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  '.npmrc', '.yarnrc', '.gitignore',
]);

/** Extension → language mapping */
const LANG_MAP = {
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.astro': 'astro',
};

/**
 * Detect language from file extension.
 * @param {string} filePath
 * @returns {string}
 */
export function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  return LANG_MAP[ext] || 'unknown';
}

/**
 * Check if a file extension is in the allow list.
 * @param {string} filePath
 * @param {string[]} allowExtensions
 * @returns {boolean}
 */
export function isAllowedExtension(filePath, allowExtensions) {
  const ext = extname(filePath).toLowerCase();
  return allowExtensions.includes(ext);
}

/**
 * Scan a repository for editable source files.
 *
 * @param {string} repoRoot - Absolute path to the repo root
 * @param {{ allowExtensions: string[], maxFileSize: number, verbose?: boolean }} opts
 * @returns {import('./types.mjs').ScannedFile[]}
 */
export function scanRepo(repoRoot, opts) {
  /** @type {import('./types.mjs').ScannedFile[]} */
  const files = [];

  /**
   * @param {string} dir
   * @param {number} depth
   */
  function walk(dir, depth) {
    if (depth > 10) return; // safety: don't descend too deep

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission errors, etc.
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name) && entry.isDirectory()) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (IGNORE_FILES.has(entry.name)) continue;
      if (!isAllowedExtension(entry.name, opts.allowExtensions)) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.size > opts.maxFileSize) {
        if (opts.verbose) {
          console.error(`  [scan] skip (too large): ${relative(repoRoot, fullPath)} (${stat.size} bytes)`);
        }
        continue;
      }

      if (stat.size === 0) continue;

      let content;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue; // binary or unreadable
      }

      // Quick binary check — if content has null bytes, skip
      if (content.includes('\0')) continue;

      files.push({
        path: relative(repoRoot, fullPath).replace(/\\/g, '/'),
        language: detectLanguage(fullPath),
        size: stat.size,
        content,
      });
    }
  }

  walk(repoRoot, 0);

  if (opts.verbose) {
    console.error(`  [scan] ${files.length} files scanned from ${repoRoot}`);
  }

  return files;
}

/**
 * Filter scanned files to those relevant for a set of surface routes/labels.
 * Simple heuristic: keep files whose content mentions surface labels or route paths.
 *
 * @param {import('./types.mjs').ScannedFile[]} files
 * @param {string[]} keywords - Labels, routes, or other search terms
 * @param {number} [maxFiles=20] - Maximum files to return
 * @returns {import('./types.mjs').ScannedFile[]}
 */
export function filterRelevantFiles(files, keywords, maxFiles = 20) {
  if (keywords.length === 0) return files.slice(0, maxFiles);

  const lowerKeywords = keywords.map(k => k.toLowerCase()).filter(k => k.length > 2);

  const scored = files.map(f => {
    const lower = f.content.toLowerCase();
    let hits = 0;
    for (const kw of lowerKeywords) {
      if (lower.includes(kw)) hits++;
    }
    return { file: f, hits };
  });

  scored.sort((a, b) => b.hits - a.hits);
  return scored
    .filter(s => s.hits > 0)
    .slice(0, maxFiles)
    .map(s => s.file);
}

/**
 * Find the line in a file's content that contains the given search term.
 * Returns the matching line (trimmed) or null if not found.
 * Used to build "nearLine" targets that give the coder model an anchor.
 *
 * @param {string} content - Full file content
 * @param {string} searchTerm - Label, route, or other search term
 * @returns {string|null}
 */
export function findNearLine(content, searchTerm) {
  if (!searchTerm || searchTerm.length < 2) return null;
  const lower = searchTerm.toLowerCase();
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes(lower)) {
      return line;
    }
  }
  return null;
}

/**
 * Extract a context window (±N lines) around a search term within file content.
 * Returns the windowed content or the original if the term is not found.
 * This reduces prompt size while giving the model focused, real code to anchor against.
 *
 * @param {string} content - Full file content
 * @param {string} searchTerm - Label, route, or other search term
 * @param {number} [contextLines=12] - Lines above and below the match to include
 * @returns {{ windowed: string, lineOffset: number }}
 */
export function extractContextWindow(content, searchTerm, contextLines = 12) {
  if (!searchTerm || searchTerm.length < 2) {
    return { windowed: content, lineOffset: 0 };
  }

  const lower = searchTerm.toLowerCase();
  const lines = content.split('\n');

  // Find the first matching line
  let matchIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lower)) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    return { windowed: content, lineOffset: 0 };
  }

  const start = Math.max(0, matchIndex - contextLines);
  const end = Math.min(lines.length, matchIndex + contextLines + 1);
  const windowedLines = lines.slice(start, end);

  return {
    windowed: windowedLines.join('\n'),
    lineOffset: start,
  };
}
