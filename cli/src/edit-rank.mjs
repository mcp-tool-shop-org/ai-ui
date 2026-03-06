// @ts-check
/**
 * edit-rank — Deterministic Edit Ranking for Hands
 *
 * Scores and sorts Hands edits by trustworthiness using five signal
 * categories: validation, anchor quality, locality, provenance, and safety.
 *
 * All signals are deterministic — no model calls, no heuristics.
 * Pure functions over evidence you already have.
 */

/**
 * @typedef {Object} EditRank
 * @property {number} rank_score              - 0.0 to 1.0
 * @property {'high'|'medium'|'low'} rank_bucket
 * @property {string[]} rank_reasons          - Short strings explaining the score
 * @property {'low'|'med'|'high'} risk_level
 */

/**
 * @typedef {Object} RankProvenance
 * @property {Map<string, string>} [fileContents]        - file path → content
 * @property {{ surfaceId: string, label: string, file: string, nearLine?: string }[]} [targets]
 * @property {import('./types.mjs').EyesAnnotation[]} [eyesAnnotations]
 * @property {string[]} [goalRuleIds]                    - configured goal rule IDs
 */

// =============================================================================
// Signal A: Validation Strength
// =============================================================================

/**
 * @param {import('./types.mjs').HandsEdit} edit
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreValidation(edit) {
  if (!edit.proposal_only) {
    return { score: 0.60, reasons: ['validated edit (+0.60)'] };
  }
  return { score: 0.10, reasons: ['proposal_only (+0.10)'] };
}

// =============================================================================
// Signal B: Anchor Quality
// =============================================================================

/**
 * Count exact occurrences of a substring in content.
 * @param {string} content
 * @param {string} sub
 * @returns {number}
 */
function countOccurrences(content, sub) {
  if (!sub) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

/**
 * @param {import('./types.mjs').HandsEdit} edit
 * @param {string} [fileContent]
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreAnchorQuality(edit, fileContent) {
  let score = 0;
  const reasons = [];

  // Single-line vs multi-line anchor
  const findLines = edit.find.split('\n').length;
  if (findLines === 1) {
    score += 0.20;
    reasons.push('single-line anchor (+0.20)');
  } else {
    score += 0.08;
    reasons.push(`multi-line anchor (${findLines} lines, +0.08)`);
  }

  // Anchor uniqueness bonus — requires file content
  if (fileContent) {
    const occurrences = countOccurrences(fileContent, edit.find);
    if (occurrences === 1) {
      score += 0.05;
      reasons.push('unique anchor (+0.05)');
    }
  }

  return { score, reasons };
}

// =============================================================================
// Signal C: Edit Locality and Size
// =============================================================================

/**
 * @param {import('./types.mjs').HandsEdit} edit
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreLocality(edit) {
  let score = 0;
  const reasons = [];

  // Count replacement lines (new content size)
  const replaceLines = edit.replace.split('\n').length;
  const findLines = edit.find.split('\n').length;
  const netLines = Math.abs(replaceLines - findLines) + Math.max(replaceLines, findLines);

  if (netLines <= 3) {
    score += 0.10;
    reasons.push(`small edit (${netLines} lines, +0.10)`);
  } else if (netLines <= 12) {
    score += 0.06;
    reasons.push(`medium edit (${netLines} lines, +0.06)`);
  } else {
    score += 0.02;
    reasons.push(`large edit (${netLines} lines, +0.02)`);
  }

  return { score, reasons };
}

// =============================================================================
// Signal D: Evidence Provenance Alignment
// =============================================================================

/**
 * @param {import('./types.mjs').HandsEdit} edit
 * @param {RankProvenance} provenance
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreProvenance(edit, provenance) {
  let score = 0;
  const reasons = [];

  // Check if edit references an Eyes surface with high confidence
  if (provenance.eyesAnnotations && provenance.eyesAnnotations.length > 0) {
    const matchingEyes = provenance.eyesAnnotations.find(ann =>
      ann.confidence >= 0.8 && (
        edit.file.includes(ann.route.replace(/^\//, '')) ||
        (edit.rationale && edit.rationale.toLowerCase().includes(ann.label?.toLowerCase() || '')) ||
        (ann.visible_text && edit.find.toLowerCase().includes(ann.visible_text.toLowerCase()))
      )
    );
    if (matchingEyes) {
      score += 0.06;
      reasons.push(`Eyes surface (conf=${matchingEyes.confidence.toFixed(2)}, +0.06)`);
    }
  }

  // Check if edit addresses a goal rule
  if (provenance.goalRuleIds && provenance.goalRuleIds.length > 0) {
    const matchesGoal = provenance.goalRuleIds.some(id =>
      edit.artifact_trigger?.includes('goal') ||
      edit.replace.includes('data-aiui-goal')
    );
    if (matchesGoal) {
      score += 0.06;
      reasons.push('addresses goal rule (+0.06)');
    }
  }

  // Check if edit maps to a specific target (surfaceId/file/nearLine)
  if (provenance.targets && provenance.targets.length > 0) {
    const matchingTarget = provenance.targets.find(t =>
      t.file === edit.file && (
        (t.nearLine && edit.find.includes(t.nearLine.trim())) ||
        (t.label && edit.rationale?.toLowerCase().includes(t.label.toLowerCase()))
      )
    );
    if (matchingTarget) {
      score += 0.03;
      reasons.push(`target match: "${matchingTarget.label}" (+0.03)`);
    }
  }

  return { score, reasons };
}

// =============================================================================
// Signal E: Safety / Risk Penalty
// =============================================================================

/** Patterns that indicate routing/auth/config files */
const RISKY_PATH_RE = /\/(router|routing|auth|login|middleware|config|webpack|vite\.config|next\.config|tsconfig|package\.json)/i;

/** Patterns that indicate code deletion */
const DELETION_RE = /^$/; // empty replace means deletion

/**
 * @param {import('./types.mjs').HandsEdit} edit
 * @returns {{ penalty: number, reasons: string[], risk_level: 'low'|'med'|'high' }}
 */
function scoreSafety(edit) {
  let penalty = 0;
  const reasons = [];

  // Check if edit touches routing/auth/build config
  if (RISKY_PATH_RE.test(edit.file)) {
    penalty += 0.10;
    reasons.push('touches config/auth/routing (-0.10)');
  }

  // Check for code deletion (replace is much shorter than find)
  const findLen = edit.find.trim().length;
  const replaceLen = edit.replace.trim().length;
  if (replaceLen === 0 && findLen > 0) {
    penalty += 0.15;
    reasons.push('deletes code (-0.15)');
  } else if (replaceLen < findLen * 0.5 && findLen > 20) {
    penalty += 0.15;
    reasons.push('removes significant code (-0.15)');
  }

  // Check if edit changes business logic vs adding hooks/labels
  const isSafeEdit = (
    edit.replace.includes('data-aiui') ||
    edit.replace.includes('aria-label') ||
    edit.replace.includes('aria-') ||
    edit.replace.includes('title=')
  );
  if (!isSafeEdit) {
    // Check if the edit is modifying logic rather than just adding attributes
    const findTrimmed = edit.find.trim();
    const replaceTrimmed = edit.replace.trim();
    if (findTrimmed !== '' && !replaceTrimmed.startsWith(findTrimmed)) {
      // The replacement doesn't simply extend the original — it modifies it
      penalty += 0.05;
      reasons.push('modifies existing code (-0.05)');
    }
  }

  // Derive risk_level from total penalty
  let risk_level = /** @type {'low'|'med'|'high'} */ ('low');
  if (penalty >= 0.15) {
    risk_level = 'high';
  } else if (penalty > 0) {
    risk_level = 'med';
  }

  return { penalty, reasons, risk_level };
}

// =============================================================================
// Core: computeEditRank
// =============================================================================

/**
 * Compute a deterministic rank for a single edit.
 *
 * @param {import('./types.mjs').HandsEdit} edit
 * @param {string} [fileContent] - Full file content (for anchor uniqueness check)
 * @param {RankProvenance} [provenance] - Upstream evidence for provenance scoring
 * @returns {EditRank}
 */
export function computeEditRank(edit, fileContent, provenance) {
  const allReasons = [];

  // A) Validation
  const validation = scoreValidation(edit);
  allReasons.push(...validation.reasons);

  // B) Anchor quality
  const anchor = scoreAnchorQuality(edit, fileContent);
  allReasons.push(...anchor.reasons);

  // C) Locality
  const locality = scoreLocality(edit);
  allReasons.push(...locality.reasons);

  // D) Provenance
  const prov = scoreProvenance(edit, provenance || {});
  allReasons.push(...prov.reasons);

  // E) Safety
  const safety = scoreSafety(edit);
  if (safety.reasons.length > 0) allReasons.push(...safety.reasons);

  // Sum and clamp
  const rawScore = validation.score + anchor.score + locality.score + prov.score - safety.penalty;
  const rank_score = Math.max(0, Math.min(1, rawScore));

  // Bucket
  let rank_bucket = /** @type {'high'|'medium'|'low'} */ ('low');
  if (rank_score >= 0.75) {
    rank_bucket = 'high';
  } else if (rank_score >= 0.50) {
    rank_bucket = 'medium';
  }

  return {
    rank_score,
    rank_bucket,
    rank_reasons: allReasons,
    risk_level: safety.risk_level,
  };
}

// =============================================================================
// Core: rankEdits — sort and annotate
// =============================================================================

/**
 * @typedef {import('./types.mjs').HandsEdit & { rank: EditRank }} RankedEdit
 */

/**
 * Rank and sort a list of edits by trustworthiness (descending).
 *
 * @param {import('./types.mjs').HandsEdit[]} edits
 * @param {Map<string, string>} [fileContents] - file path → content
 * @param {RankProvenance} [provenance]
 * @returns {RankedEdit[]}
 */
export function rankEdits(edits, fileContents, provenance) {
  /** @type {RankedEdit[]} */
  const ranked = edits.map(edit => {
    const fileContent = fileContents?.get(edit.file);
    const rank = computeEditRank(edit, fileContent, provenance);
    return { ...edit, rank };
  });

  // Sort: validated before proposal_only (stable invariant), then by rank_score desc.
  // This guarantees no proposal_only edit ever appears above a validated edit,
  // regardless of score — the validation gap is the dominant signal.
  ranked.sort((a, b) => {
    // Primary: validated (0) before proposal_only (1)
    const aProposal = a.proposal_only ? 1 : 0;
    const bProposal = b.proposal_only ? 1 : 0;
    if (aProposal !== bProposal) return aProposal - bProposal;
    // Secondary: rank_score descending
    return b.rank.rank_score - a.rank.rank_score;
  });

  return ranked;
}

/**
 * Build a summary string of rank bucket counts.
 *
 * @param {RankedEdit[]} rankedEdits
 * @returns {string}
 */
export function rankSummary(rankedEdits) {
  let high = 0, medium = 0, low = 0;
  for (const e of rankedEdits) {
    if (e.rank.rank_bucket === 'high') high++;
    else if (e.rank.rank_bucket === 'medium') medium++;
    else low++;
  }
  return `${high} high-confidence, ${medium} medium, ${low} low`;
}

/**
 * Filter edits by minimum rank score threshold.
 * Useful for --min-rank to suppress low-confidence hunks.
 *
 * @param {RankedEdit[]} rankedEdits
 * @param {number} minScore - Minimum rank_score to keep (0.0–1.0)
 * @returns {{ kept: RankedEdit[], dropped: number }}
 */
export function filterByMinRank(rankedEdits, minScore) {
  const kept = rankedEdits.filter(e => e.rank.rank_score >= minScore);
  return { kept, dropped: rankedEdits.length - kept.length };
}
