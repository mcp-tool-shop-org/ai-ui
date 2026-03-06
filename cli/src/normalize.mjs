// @ts-check

/**
 * Normalize a string for comparison: lowercase, strip punctuation, collapse whitespace.
 * @param {string} str
 * @returns {string}
 */
export function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a string to kebab-case for use as an ID.
 * @param {string} str
 * @returns {string}
 */
export function kebabCase(str) {
  return normalize(str)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Compute a match confidence score between two strings.
 * Returns 0–1 where 1 is an exact normalized match.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function matchScore(a, b) {
  const na = normalize(a);
  const nb = normalize(b);

  if (!na || !nb) return 0;

  // Exact match
  if (na === nb) return 1.0;

  // One contains the other
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return 0.6 + 0.3 * (shorter / longer);
  }

  // Word overlap (Jaccard-ish)
  const wordsA = new Set(na.split(' ').filter(Boolean));
  const wordsB = new Set(nb.split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = overlap / union;

  // Only return a score if there's meaningful overlap
  return jaccard >= 0.3 ? jaccard * 0.6 : 0;
}

/**
 * Find the best match for a query among candidates.
 * @param {string} query
 * @param {string[]} candidates
 * @param {number} [threshold=0.4]
 * @returns {{ match: string, score: number } | null}
 */
/**
 * Strip a base path prefix from a route.
 * @param {string} route
 * @param {string} basePath
 * @returns {string}
 */
export function stripBasePath(route, basePath) {
  if (!basePath || basePath === '/') return route;
  const norm = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (route.startsWith(norm)) {
    const stripped = route.slice(norm.length);
    return stripped === '' ? '/' : stripped.startsWith('/') ? stripped : '/' + stripped;
  }
  return route;
}

/**
 * Detect the base path from a baseUrl.
 * @param {string} baseUrl
 * @returns {string}
 */
export function detectBasePath(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function bestMatch(query, candidates, threshold = 0.4) {
  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const score = matchScore(query, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return bestScore >= threshold ? { match: /** @type {string} */ (best), score: bestScore } : null;
}
