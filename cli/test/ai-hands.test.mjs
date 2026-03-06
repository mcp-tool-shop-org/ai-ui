// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, isAllowedExtension, scanRepo, filterRelevantFiles, findNearLine, extractContextWindow } from '../src/repo-scan.mjs';
import { buildUnifiedDiff, buildFilesManifest, validateEdit } from '../src/git-diff.mjs';
import { buildCoderPrompt, parseCoderResponse, CoderParseError } from '../src/ollama-coder.mjs';
import { computeEditRank, rankEdits, rankSummary, filterByMinRank } from '../src/edit-rank.mjs';

// =============================================================================
// repo-scan tests
// =============================================================================

describe('detectLanguage', () => {
  it('detects common extensions', () => {
    assert.equal(detectLanguage('src/App.tsx'), 'tsx');
    assert.equal(detectLanguage('src/main.js'), 'javascript');
    assert.equal(detectLanguage('src/main.mjs'), 'javascript');
    assert.equal(detectLanguage('src/styles.css'), 'css');
    assert.equal(detectLanguage('src/Page.vue'), 'vue');
    assert.equal(detectLanguage('src/Comp.svelte'), 'svelte');
    assert.equal(detectLanguage('index.html'), 'html');
    assert.equal(detectLanguage('src/page.astro'), 'astro');
  });

  it('returns unknown for unrecognized extensions', () => {
    assert.equal(detectLanguage('README.md'), 'unknown');
    assert.equal(detectLanguage('image.png'), 'unknown');
    assert.equal(detectLanguage('data.json'), 'unknown');
  });

  it('is case-insensitive for extensions', () => {
    assert.equal(detectLanguage('App.TSX'), 'tsx');
    assert.equal(detectLanguage('styles.CSS'), 'css');
  });
});

describe('isAllowedExtension', () => {
  const allow = ['.tsx', '.jsx', '.ts', '.js', '.css'];

  it('allows listed extensions', () => {
    assert.ok(isAllowedExtension('App.tsx', allow));
    assert.ok(isAllowedExtension('main.js', allow));
    assert.ok(isAllowedExtension('styles.css', allow));
  });

  it('rejects unlisted extensions', () => {
    assert.ok(!isAllowedExtension('README.md', allow));
    assert.ok(!isAllowedExtension('package.json', allow));
    assert.ok(!isAllowedExtension('image.png', allow));
  });
});

describe('filterRelevantFiles', () => {
  const files = [
    { path: 'src/Button.tsx', language: 'tsx', size: 500, content: 'export function Button({ onClick }) { return <button onClick={onClick}>Click</button> }' },
    { path: 'src/Header.tsx', language: 'tsx', size: 300, content: 'export function Header() { return <header><nav>Navigation</nav></header> }' },
    { path: 'src/utils.ts', language: 'typescript', size: 200, content: 'export function formatDate(d: Date) { return d.toISOString() }' },
  ];

  it('filters by keyword presence', () => {
    const result = filterRelevantFiles(files, ['button', 'onClick']);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'src/Button.tsx');
  });

  it('returns files sorted by relevance', () => {
    const result = filterRelevantFiles(files, ['export', 'function']);
    assert.ok(result.length >= 2);
  });

  it('respects maxFiles limit', () => {
    const result = filterRelevantFiles(files, ['export'], 1);
    assert.equal(result.length, 1);
  });

  it('returns empty for no matches', () => {
    const result = filterRelevantFiles(files, ['zzzznotfound']);
    assert.equal(result.length, 0);
  });

  it('returns files up to maxFiles when no keywords', () => {
    const result = filterRelevantFiles(files, [], 2);
    assert.equal(result.length, 2);
  });
});

// =============================================================================
// git-diff tests
// =============================================================================

describe('buildUnifiedDiff', () => {
  it('builds a valid unified diff from edits', () => {
    /** @type {import('../src/types.mjs').HandsEdit[]} */
    const edits = [
      {
        file: 'src/App.tsx',
        find: '<button>Click</button>',
        replace: '<button data-aiui-safe="true">Click</button>',
        rationale: 'Add safe attribute',
        artifact_trigger: 'add-aiui-hooks',
        confidence: 0.9,
        proposal_only: false,
      },
    ];

    const diff = buildUnifiedDiff(edits);
    assert.ok(diff.includes('--- a/src/App.tsx'));
    assert.ok(diff.includes('+++ b/src/App.tsx'));
    assert.ok(diff.includes('-<button>Click</button>'));
    assert.ok(diff.includes('+<button data-aiui-safe="true">Click</button>'));
    assert.ok(diff.includes('# Add safe attribute'));
  });

  it('returns empty string for no edits', () => {
    assert.equal(buildUnifiedDiff([]), '');
  });

  it('groups edits by file', () => {
    /** @type {import('../src/types.mjs').HandsEdit[]} */
    const edits = [
      { file: 'a.tsx', find: 'old1', replace: 'new1', rationale: '', artifact_trigger: '', confidence: 0.8, proposal_only: false },
      { file: 'b.tsx', find: 'old2', replace: 'new2', rationale: '', artifact_trigger: '', confidence: 0.8, proposal_only: false },
      { file: 'a.tsx', find: 'old3', replace: 'new3', rationale: '', artifact_trigger: '', confidence: 0.8, proposal_only: false },
    ];

    const diff = buildUnifiedDiff(edits);
    // Should have two file headers (a.tsx, b.tsx)
    const aHeaders = diff.split('--- a/a.tsx').length - 1;
    const bHeaders = diff.split('--- a/b.tsx').length - 1;
    assert.equal(aHeaders, 1);
    assert.equal(bHeaders, 1);
  });
});

describe('buildFilesManifest', () => {
  it('builds manifest with correct counts', () => {
    /** @type {import('../src/types.mjs').HandsEdit[]} */
    const edits = [
      { file: 'a.tsx', find: 'line1\nline2', replace: 'new1\nnew2\nnew3', rationale: '', artifact_trigger: '', confidence: 0.9, proposal_only: false },
      { file: 'a.tsx', find: 'old', replace: 'new', rationale: '', artifact_trigger: '', confidence: 0.8, proposal_only: false },
      { file: 'b.tsx', find: 'x', replace: 'y', rationale: '', artifact_trigger: '', confidence: 0.5, proposal_only: true },
    ];

    const manifest = buildFilesManifest(edits);
    assert.equal(manifest.length, 2);

    const fileA = manifest.find(m => m.path === 'a.tsx');
    assert.ok(fileA);
    assert.equal(fileA.edits, 2);
    assert.equal(fileA.proposal_only, false); // at least one non-proposal edit

    const fileB = manifest.find(m => m.path === 'b.tsx');
    assert.ok(fileB);
    assert.equal(fileB.edits, 1);
    assert.equal(fileB.proposal_only, true);
  });

  it('returns empty array for no edits', () => {
    assert.deepEqual(buildFilesManifest([]), []);
  });
});

describe('validateEdit', () => {
  const content = 'function hello() {\n  console.log("hello");\n  console.log("world");\n}';

  it('validates unique find string', () => {
    const result = validateEdit(content, 'console.log("hello")');
    assert.equal(result.valid, true);
    assert.equal(result.occurrences, 1);
  });

  it('rejects duplicate find string', () => {
    const result = validateEdit(content, 'console.log');
    assert.equal(result.valid, false);
    assert.equal(result.occurrences, 2);
  });

  it('rejects missing find string', () => {
    const result = validateEdit(content, 'notfound');
    assert.equal(result.valid, false);
    assert.equal(result.occurrences, 0);
  });

  it('rejects empty find string', () => {
    const result = validateEdit(content, '');
    assert.equal(result.valid, false);
    assert.equal(result.occurrences, 0);
  });
});

// =============================================================================
// ollama-coder tests
// =============================================================================

describe('buildCoderPrompt', () => {
  it('includes task and file context in prompt', () => {
    const prompt = buildCoderPrompt({
      task: 'add-aiui-hooks',
      description: 'Add data-aiui-safe to buttons',
      fileContext: [
        { path: 'src/App.tsx', language: 'tsx', content: '<button>Click</button>' },
      ],
      artifactContext: 'Surface needs hooks',
      constraints: ['Only non-destructive elements'],
    });

    assert.ok(prompt.includes('add-aiui-hooks'));
    assert.ok(prompt.includes('src/App.tsx'));
    assert.ok(prompt.includes('<button>Click</button>'));
    assert.ok(prompt.includes('Only non-destructive elements'));
    assert.ok(prompt.includes('"edits"'));
    assert.ok(prompt.includes('"find"'));
    assert.ok(prompt.includes('"replace"'));
  });

  it('handles empty constraints', () => {
    const prompt = buildCoderPrompt({
      task: 'test',
      description: 'test',
      fileContext: [{ path: 'a.tsx', language: 'tsx', content: 'code' }],
      artifactContext: 'context',
      constraints: [],
    });

    assert.ok(!prompt.includes('Constraints:'));
  });

  it('includes multiple files', () => {
    const prompt = buildCoderPrompt({
      task: 'test',
      description: 'test',
      fileContext: [
        { path: 'a.tsx', language: 'tsx', content: 'file a' },
        { path: 'b.tsx', language: 'tsx', content: 'file b' },
      ],
      artifactContext: '',
      constraints: [],
    });

    assert.ok(prompt.includes('### File: a.tsx'));
    assert.ok(prompt.includes('### File: b.tsx'));
  });

  it('includes anchor_candidates in prompt contract', () => {
    const prompt = buildCoderPrompt({
      task: 'test',
      description: 'test',
      fileContext: [{ path: 'a.tsx', language: 'tsx', content: 'code' }],
      artifactContext: '',
      constraints: [],
    });

    assert.ok(prompt.includes('anchor_candidates'));
    assert.ok(prompt.includes('single line'));
  });

  it('includes edit targets when provided', () => {
    const prompt = buildCoderPrompt({
      task: 'add-aiui-hooks',
      description: 'Add hooks',
      fileContext: [{ path: 'src/App.tsx', language: 'tsx', content: '<button>Click</button>' }],
      artifactContext: '',
      constraints: [],
      targets: [
        { surfaceId: 'trigger:/|btn', label: 'Click', file: 'src/App.tsx', nearLine: '      <button>Click</button>' },
      ],
    });

    assert.ok(prompt.includes('## Edit Targets'));
    assert.ok(prompt.includes('Surface "Click"'));
    assert.ok(prompt.includes('src/App.tsx'));
    assert.ok(prompt.includes('<button>Click</button>'));
  });

  it('omits edit targets section when no targets', () => {
    const prompt = buildCoderPrompt({
      task: 'test',
      description: 'test',
      fileContext: [{ path: 'a.tsx', language: 'tsx', content: 'code' }],
      artifactContext: '',
      constraints: [],
      targets: [],
    });

    assert.ok(!prompt.includes('## Edit Targets'));
  });
});

describe('parseCoderResponse', () => {
  const validFiles = new Set(['src/App.tsx', 'src/Button.tsx']);

  it('parses a well-formed response', () => {
    const raw = {
      edits: [
        {
          file: 'src/App.tsx',
          find: '<button>',
          replace: '<button data-aiui-safe="true">',
          rationale: 'Add safe hook',
          confidence: 0.92,
        },
      ],
    };

    const result = parseCoderResponse(raw, 'test', validFiles);
    assert.equal(result.length, 1);
    assert.equal(result[0].file, 'src/App.tsx');
    assert.equal(result[0].find, '<button>');
    assert.equal(result[0].confidence, 0.92);
  });

  it('skips edits with unknown file paths', () => {
    const raw = {
      edits: [
        { file: 'src/NotReal.tsx', find: 'a', replace: 'b', rationale: '', confidence: 0.8 },
        { file: 'src/App.tsx', find: 'x', replace: 'y', rationale: '', confidence: 0.7 },
      ],
    };

    const result = parseCoderResponse(raw, 'test', validFiles);
    assert.equal(result.length, 1);
    assert.equal(result[0].file, 'src/App.tsx');
  });

  it('skips edits with empty find', () => {
    const raw = {
      edits: [
        { file: 'src/App.tsx', find: '', replace: 'new', rationale: '', confidence: 0.8 },
      ],
    };

    const result = parseCoderResponse(raw, 'test', validFiles);
    assert.equal(result.length, 0);
  });

  it('clamps confidence to 0..1', () => {
    const raw = {
      edits: [
        { file: 'src/App.tsx', find: 'x', replace: 'y', rationale: '', confidence: 1.5 },
        { file: 'src/Button.tsx', find: 'a', replace: 'b', rationale: '', confidence: -0.3 },
      ],
    };

    const result = parseCoderResponse(raw, 'test', validFiles);
    assert.equal(result[0].confidence, 1);
    assert.equal(result[1].confidence, 0);
  });

  it('handles non-string field types gracefully', () => {
    const raw = {
      edits: [
        { file: 'src/App.tsx', find: 42, replace: 'y', rationale: '', confidence: 0.8 },
      ],
    };

    const result = parseCoderResponse(raw, 'test', validFiles);
    assert.equal(result.length, 0); // find is not a string → skipped
  });

  it('throws CoderParseError for non-object input', () => {
    assert.throws(
      () => parseCoderResponse(null, 'test', validFiles),
      (err) => err instanceof CoderParseError && err.taskId === 'test'
    );
  });

  it('throws CoderParseError for missing edits array', () => {
    assert.throws(
      () => parseCoderResponse({ result: 'ok' }, 'test', validFiles),
      (err) => err instanceof CoderParseError
    );
  });

  it('handles empty edits array', () => {
    const result = parseCoderResponse({ edits: [] }, 'test', validFiles);
    assert.equal(result.length, 0);
  });
});

describe('CoderParseError', () => {
  it('has taskId, message, and name', () => {
    const err = new CoderParseError('add-hooks', 'missing edits');
    assert.equal(err.taskId, 'add-hooks');
    assert.ok(err.message.includes('add-hooks'));
    assert.ok(err.message.includes('missing edits'));
    assert.equal(err.name, 'CoderParseError');
    assert.ok(err instanceof Error);
  });
});

// =============================================================================
// Integration — task context building
// =============================================================================

// =============================================================================
// Anchor candidate resolution tests
// =============================================================================

describe('parseCoderResponse — anchor resolution', () => {
  const validFiles = new Set(['src/App.tsx']);
  const fileContents = new Map([
    ['src/App.tsx', '  <div className="container">\n    <button onClick={handleClick}>\n      Click me\n    </button>\n  </div>'],
  ]);

  it('uses find when it matches uniquely', () => {
    const raw = {
      edits: [{
        file: 'src/App.tsx',
        find: '    <button onClick={handleClick}>',
        anchor_candidates: ['    <button onClick={handleClick}>', '  <div className="container">'],
        replace: '    <button onClick={handleClick} data-aiui-safe="true">',
        rationale: 'Add hook',
        confidence: 0.9,
      }],
    };

    const result = parseCoderResponse(raw, 'test', validFiles, fileContents);
    assert.equal(result.length, 1);
    assert.equal(result[0].find, '    <button onClick={handleClick}>');
  });

  it('falls back to anchor_candidates when find misses', () => {
    const raw = {
      edits: [{
        file: 'src/App.tsx',
        find: '<button onClick={handleSave}>', // wrong handler name — 0 occurrences
        anchor_candidates: [
          '<button onClick={handleSave}>', // also wrong
          '    <button onClick={handleClick}>', // this one matches!
          '  <div className="container">',
        ],
        replace: '    <button onClick={handleClick} data-aiui-safe="true">',
        rationale: 'Add hook',
        confidence: 0.9,
      }],
    };

    const result = parseCoderResponse(raw, 'test', validFiles, fileContents);
    assert.equal(result.length, 1);
    // Should have resolved to the matching candidate
    assert.equal(result[0].find, '    <button onClick={handleClick}>');
  });

  it('keeps original find when no candidates match', () => {
    const raw = {
      edits: [{
        file: 'src/App.tsx',
        find: '<totally wrong>',
        anchor_candidates: ['<also wrong>', '<nope>'],
        replace: 'whatever',
        rationale: 'test',
        confidence: 0.5,
      }],
    };

    const result = parseCoderResponse(raw, 'test', validFiles, fileContents);
    assert.equal(result.length, 1);
    assert.equal(result[0].find, '<totally wrong>'); // kept original
  });

  it('works without fileContents (backward compat)', () => {
    const raw = {
      edits: [{
        file: 'src/App.tsx',
        find: '<button>',
        replace: '<button data-aiui-safe>',
        rationale: 'test',
        confidence: 0.8,
      }],
    };

    // No fileContents passed — should still parse fine
    const result = parseCoderResponse(raw, 'test', validFiles);
    assert.equal(result.length, 1);
    assert.equal(result[0].find, '<button>');
  });
});

// =============================================================================
// Context window + nearLine tests
// =============================================================================

describe('findNearLine', () => {
  const content = 'import React from "react";\n\nfunction App() {\n  return (\n    <div>\n      <button onClick={save}>Save</button>\n    </div>\n  );\n}';

  it('finds line containing search term', () => {
    const line = findNearLine(content, 'Save');
    assert.ok(line);
    assert.ok(line.includes('Save'));
    assert.ok(line.includes('<button'));
  });

  it('returns null for missing term', () => {
    assert.equal(findNearLine(content, 'DeleteAll'), null);
  });

  it('returns null for empty/short term', () => {
    assert.equal(findNearLine(content, ''), null);
    assert.equal(findNearLine(content, 'x'), null);
  });

  it('is case-insensitive', () => {
    const line = findNearLine(content, 'save');
    assert.ok(line);
    assert.ok(line.includes('Save'));
  });
});

describe('extractContextWindow', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`line ${i}: content ${i}`);
  const content = lines.join('\n');

  it('windows around the matching line', () => {
    const { windowed, lineOffset } = extractContextWindow(content, 'content 25', 5);
    const windowedLines = windowed.split('\n');
    // Should contain ~11 lines (5 before + match + 5 after)
    assert.ok(windowedLines.length <= 11);
    assert.ok(windowedLines.length >= 6);
    assert.ok(windowed.includes('content 25'));
    assert.ok(lineOffset >= 20);
  });

  it('returns full content if term not found', () => {
    const { windowed } = extractContextWindow(content, 'notfound', 5);
    assert.equal(windowed, content);
  });

  it('clamps to beginning of file', () => {
    const { windowed, lineOffset } = extractContextWindow(content, 'content 2', 5);
    // content 2 is line 2, window starts at max(0, 2-5) = 0
    assert.equal(lineOffset, 0);
    assert.ok(windowed.includes('content 2'));
  });

  it('clamps to end of file', () => {
    const { windowed } = extractContextWindow(content, 'content 48', 5);
    assert.ok(windowed.includes('content 48'));
    assert.ok(windowed.includes('content 49')); // should include the last line
  });
});

// =============================================================================
// Integration — task context building
// =============================================================================

describe('Hands task selection', () => {
  it('all four task types are recognized', () => {
    /** @type {import('../src/types.mjs').HandsTaskType[]} */
    const allTasks = ['add-aiui-hooks', 'surface-settings', 'goal-hooks', 'copy-fix'];
    assert.equal(allTasks.length, 4);
    for (const t of allTasks) {
      assert.ok(typeof t === 'string');
      assert.ok(t.length > 0);
    }
  });
});

describe('Hands edit → diff round-trip', () => {
  it('edits produce valid diff with artifact provenance', () => {
    /** @type {import('../src/types.mjs').HandsEdit[]} */
    const edits = [
      {
        file: 'src/Settings.tsx',
        find: '<dialog>',
        replace: '<dialog data-aiui-goal="settings_open">',
        rationale: 'Mark settings dialog as goal element',
        artifact_trigger: 'goal-hooks: Add data-aiui-goal attributes',
        confidence: 0.85,
        proposal_only: false,
      },
    ];

    const diff = buildUnifiedDiff(edits);
    assert.ok(diff.includes('--- a/src/Settings.tsx'));
    assert.ok(diff.includes('-<dialog>'));
    assert.ok(diff.includes('+<dialog data-aiui-goal="settings_open">'));
    assert.ok(diff.includes('# artifact: goal-hooks'));

    const manifest = buildFilesManifest(edits);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].path, 'src/Settings.tsx');
    assert.equal(manifest[0].proposal_only, false);
  });

  it('low-confidence edits are marked as proposal_only', () => {
    /** @type {import('../src/types.mjs').HandsEdit[]} */
    const edits = [
      {
        file: 'src/Nav.tsx',
        find: '<Link>',
        replace: '<Link aria-label="Settings">',
        rationale: 'Improve discoverability',
        artifact_trigger: 'surface-settings',
        confidence: 0.3,
        proposal_only: true,
      },
    ];

    const manifest = buildFilesManifest(edits);
    assert.equal(manifest[0].proposal_only, true);
  });
});

// =============================================================================
// Edit Ranking tests
// =============================================================================

describe('computeEditRank', () => {
  /** @returns {import('../src/types.mjs').HandsEdit} */
  function makeEdit(overrides = {}) {
    return {
      file: 'src/App.tsx',
      find: '      <button onClick={handleClick}>',
      replace: '      <button onClick={handleClick} data-aiui-safe="true">',
      rationale: 'Add safe hook for probe',
      artifact_trigger: 'add-aiui-hooks: Add data-aiui-safe attributes',
      confidence: 0.95,
      proposal_only: false,
      ...overrides,
    };
  }

  it('validated + single-line anchor scores high', () => {
    const edit = makeEdit();
    const rank = computeEditRank(edit);
    // validated=0.60, single-line=0.20, small edit=0.10, no penalty
    assert.ok(rank.rank_score >= 0.75, `expected high, got ${rank.rank_score}`);
    assert.equal(rank.rank_bucket, 'high');
    assert.equal(rank.risk_level, 'low');
    assert.ok(rank.rank_reasons.some(r => r.includes('validated')));
    assert.ok(rank.rank_reasons.some(r => r.includes('single-line')));
  });

  it('proposal_only scores lower than validated', () => {
    const validated = makeEdit({ proposal_only: false });
    const proposal = makeEdit({ proposal_only: true });
    const vRank = computeEditRank(validated);
    const pRank = computeEditRank(proposal);
    assert.ok(vRank.rank_score > pRank.rank_score,
      `validated ${vRank.rank_score} should beat proposal ${pRank.rank_score}`);
    assert.ok(pRank.rank_score < 0.75, 'proposal should not be high-confidence');
  });

  it('validated + unique anchor outranks validated + repeated anchor', () => {
    const fileContent = '  <button onClick={handleClick}>\n  <div>other stuff</div>';
    const uniqueEdit = makeEdit({ find: '  <button onClick={handleClick}>' });
    const repeatedEdit = makeEdit({ find: '<div>' }); // NOT unique if we add another
    const fileWithDupes = '<div>a</div>\n<div>b</div>\n<button onClick={handleClick}>';

    const uniqueRank = computeEditRank(uniqueEdit, fileContent);
    const repeatedRank = computeEditRank(repeatedEdit, fileWithDupes);

    assert.ok(uniqueRank.rank_score > repeatedRank.rank_score,
      `unique ${uniqueRank.rank_score} should beat repeated ${repeatedRank.rank_score}`);
  });

  it('small insertion outranks large multi-line replacement', () => {
    const smallEdit = makeEdit({
      find: '<button>',
      replace: '<button data-aiui-safe="true">',
    });
    const largeEdit = makeEdit({
      find: '<div>\n  <span>\n    content\n  </span>\n</div>',
      replace: '<section>\n  <article>\n    <p>new content</p>\n    <p>more content</p>\n  </article>\n</section>\n<!-- end -->',
    });

    const smallRank = computeEditRank(smallEdit);
    const largeRank = computeEditRank(largeEdit);

    assert.ok(smallRank.rank_score > largeRank.rank_score,
      `small ${smallRank.rank_score} should beat large ${largeRank.rank_score}`);
  });

  it('penalizes edits touching auth/config files', () => {
    const normalEdit = makeEdit();
    const authEdit = makeEdit({ file: 'src/auth/login.tsx' });

    const normalRank = computeEditRank(normalEdit);
    const authRank = computeEditRank(authEdit);

    assert.ok(normalRank.rank_score > authRank.rank_score,
      `normal ${normalRank.rank_score} should beat auth ${authRank.rank_score}`);
    assert.ok(authRank.rank_reasons.some(r => r.includes('config/auth/routing')));
    assert.ok(authRank.risk_level === 'med' || authRank.risk_level === 'high');
  });

  it('penalizes code deletion', () => {
    const addEdit = makeEdit();
    const deleteEdit = makeEdit({
      find: '<button onClick={handleClick}>Click me</button>',
      replace: '',
    });

    const addRank = computeEditRank(addEdit);
    const deleteRank = computeEditRank(deleteEdit);

    assert.ok(addRank.rank_score > deleteRank.rank_score,
      `add ${addRank.rank_score} should beat delete ${deleteRank.rank_score}`);
    assert.equal(deleteRank.risk_level, 'high');
    assert.ok(deleteRank.rank_reasons.some(r => r.includes('deletes')));
  });

  it('data-aiui edits get no business-logic penalty', () => {
    const safeEdit = makeEdit({
      find: '      <button onClick={handleClick}>',
      replace: '      <button onClick={handleClick} data-aiui-safe="true">',
    });

    const rank = computeEditRank(safeEdit);
    assert.ok(!rank.rank_reasons.some(r => r.includes('modifies existing code')));
  });

  it('Eyes confidence boosts score', () => {
    const edit = makeEdit();
    const provWithEyes = {
      eyesAnnotations: [/** @type {any} */ ({
        surface_id: 'trigger:/|btn',
        label: 'Click me',
        route: '/App',
        confidence: 0.9,
        visible_text: 'handleClick',
      })],
    };

    const withEyes = computeEditRank(edit, undefined, provWithEyes);
    const withoutEyes = computeEditRank(edit);

    assert.ok(withEyes.rank_score >= withoutEyes.rank_score,
      `with Eyes ${withEyes.rank_score} should >= without ${withoutEyes.rank_score}`);
  });

  it('goal rule target boosts score', () => {
    const goalEdit = makeEdit({
      artifact_trigger: 'goal-hooks: Add data-aiui-goal attributes',
      replace: '<dialog data-aiui-goal="audio_open">',
    });

    const provWithGoals = { goalRuleIds: ['audio_open', 'audio_change'] };

    const withGoals = computeEditRank(goalEdit, undefined, provWithGoals);
    const withoutGoals = computeEditRank(goalEdit);

    assert.ok(withGoals.rank_score > withoutGoals.rank_score,
      `with goals ${withGoals.rank_score} should beat without ${withoutGoals.rank_score}`);
  });

  it('clamps score to 0..1', () => {
    // Even with all bonuses, never exceeds 1
    const edit = makeEdit();
    const fileContent = '      <button onClick={handleClick}>';
    const rank = computeEditRank(edit, fileContent, {
      eyesAnnotations: [/** @type {any} */ ({ surface_id: 'x', label: 'x', route: '/App', confidence: 0.95, visible_text: 'handleClick' })],
      goalRuleIds: ['audio'],
      targets: [{ surfaceId: 'x', label: 'probe', file: 'src/App.tsx', nearLine: '<button' }],
    });
    assert.ok(rank.rank_score <= 1.0);
    assert.ok(rank.rank_score >= 0.0);
  });
});

describe('rankEdits', () => {
  /** @returns {import('../src/types.mjs').HandsEdit} */
  function makeEdit(overrides = {}) {
    return {
      file: 'src/App.tsx',
      find: '<button>Click</button>',
      replace: '<button data-aiui-safe="true">Click</button>',
      rationale: 'Add safe hook',
      artifact_trigger: 'add-aiui-hooks',
      confidence: 0.9,
      proposal_only: false,
      ...overrides,
    };
  }

  it('sorts edits by rank_score descending', () => {
    const edits = [
      makeEdit({ proposal_only: true, confidence: 0.3, rationale: 'weak edit' }),   // should rank lower
      makeEdit({ proposal_only: false, confidence: 0.95, rationale: 'strong edit' }), // should rank higher
    ];

    const ranked = rankEdits(edits);
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].rank.rank_score >= ranked[1].rank.rank_score,
      `first (${ranked[0].rank.rank_score}) should >= second (${ranked[1].rank.rank_score})`);
    assert.equal(ranked[0].rationale, 'strong edit');
    assert.equal(ranked[1].rationale, 'weak edit');
  });

  it('attaches rank metadata to each edit', () => {
    const edits = [makeEdit()];
    const ranked = rankEdits(edits);
    assert.equal(ranked.length, 1);
    assert.ok(ranked[0].rank);
    assert.ok(typeof ranked[0].rank.rank_score === 'number');
    assert.ok(['high', 'medium', 'low'].includes(ranked[0].rank.rank_bucket));
    assert.ok(Array.isArray(ranked[0].rank.rank_reasons));
    assert.ok(['low', 'med', 'high'].includes(ranked[0].rank.risk_level));
  });

  it('uses fileContents for anchor uniqueness', () => {
    const fileContents = new Map([
      ['src/App.tsx', '<button>Click</button>\n<div>other</div>'],
    ]);
    const edits = [makeEdit()];
    const ranked = rankEdits(edits, fileContents);
    assert.ok(ranked[0].rank.rank_reasons.some(r => r.includes('unique anchor')));
  });

  it('handles empty edit list', () => {
    const ranked = rankEdits([]);
    assert.equal(ranked.length, 0);
  });
});

describe('rankSummary', () => {
  it('counts buckets correctly', () => {
    const ranked = [
      { rank: { rank_score: 0.90, rank_bucket: /** @type {const} */ ('high'), rank_reasons: [], risk_level: /** @type {const} */ ('low') } },
      { rank: { rank_score: 0.80, rank_bucket: /** @type {const} */ ('high'), rank_reasons: [], risk_level: /** @type {const} */ ('low') } },
      { rank: { rank_score: 0.60, rank_bucket: /** @type {const} */ ('medium'), rank_reasons: [], risk_level: /** @type {const} */ ('med') } },
      { rank: { rank_score: 0.30, rank_bucket: /** @type {const} */ ('low'), rank_reasons: [], risk_level: /** @type {const} */ ('low') } },
    ];

    const summary = rankSummary(/** @type {any} */ (ranked));
    assert.equal(summary, '2 high-confidence, 1 medium, 1 low');
  });

  it('handles empty list', () => {
    assert.equal(rankSummary([]), '0 high-confidence, 0 medium, 0 low');
  });

  it('handles all same bucket', () => {
    const ranked = [
      { rank: { rank_score: 0.90, rank_bucket: /** @type {const} */ ('high'), rank_reasons: [], risk_level: /** @type {const} */ ('low') } },
      { rank: { rank_score: 0.85, rank_bucket: /** @type {const} */ ('high'), rank_reasons: [], risk_level: /** @type {const} */ ('low') } },
    ];
    assert.equal(rankSummary(/** @type {any} */ (ranked)), '2 high-confidence, 0 medium, 0 low');
  });
});

// =============================================================================
// Stable sort invariant: validated always before proposal_only
// =============================================================================

describe('rankEdits — stable sort invariant', () => {
  /** @returns {import('../src/types.mjs').HandsEdit} */
  function makeEdit(overrides = {}) {
    return {
      file: 'src/App.tsx',
      find: '<button>Click</button>',
      replace: '<button data-aiui-safe="true">Click</button>',
      rationale: 'Add safe hook',
      artifact_trigger: 'add-aiui-hooks',
      confidence: 0.9,
      proposal_only: false,
      ...overrides,
    };
  }

  it('validated edits always come before proposal_only regardless of score', () => {
    // Craft a case where a proposal_only edit could theoretically score higher
    // (e.g., via provenance bonuses) but must still sort after validated edits
    const edits = [
      makeEdit({ proposal_only: true, confidence: 0.4, rationale: 'proposal A' }),
      makeEdit({ proposal_only: false, confidence: 0.9, rationale: 'validated B' }),
      makeEdit({ proposal_only: true, confidence: 0.3, rationale: 'proposal C' }),
      makeEdit({ proposal_only: false, confidence: 0.85, rationale: 'validated D' }),
    ];

    const ranked = rankEdits(edits);
    assert.equal(ranked.length, 4);

    // First two must be validated, last two must be proposal_only
    assert.equal(ranked[0].proposal_only, false, 'position 0 should be validated');
    assert.equal(ranked[1].proposal_only, false, 'position 1 should be validated');
    assert.equal(ranked[2].proposal_only, true, 'position 2 should be proposal_only');
    assert.equal(ranked[3].proposal_only, true, 'position 3 should be proposal_only');
  });

  it('within validated group, sorts by rank_score descending', () => {
    // Use different file paths to create different rank scores:
    // auth file gets a -0.10 safety penalty, so normal file scores higher
    const edits = [
      makeEdit({ proposal_only: false, file: 'src/auth/login.tsx', rationale: 'lower score (auth penalty)' }),
      makeEdit({ proposal_only: false, file: 'src/App.tsx', rationale: 'higher score (no penalty)' }),
    ];

    const ranked = rankEdits(edits);
    assert.ok(ranked[0].rank.rank_score > ranked[1].rank.rank_score,
      `first (${ranked[0].rank.rank_score}) should > second (${ranked[1].rank.rank_score})`);
    assert.equal(ranked[0].rationale, 'higher score (no penalty)');
  });

  it('within proposal_only group, sorts by rank_score descending', () => {
    const edits = [
      makeEdit({ proposal_only: true, confidence: 0.2, rationale: 'weaker proposal' }),
      makeEdit({ proposal_only: true, confidence: 0.4, rationale: 'stronger proposal' }),
    ];

    const ranked = rankEdits(edits);
    assert.ok(ranked[0].rank.rank_score >= ranked[1].rank.rank_score);
  });
});

// =============================================================================
// filterByMinRank
// =============================================================================

describe('filterByMinRank', () => {
  /** @returns {import('../src/edit-rank.mjs').RankedEdit} */
  function makeRankedEdit(score, bucket = /** @type {const} */ ('high')) {
    return /** @type {any} */ ({
      file: 'src/App.tsx',
      find: '<button>',
      replace: '<button data-aiui-safe>',
      rationale: 'test',
      artifact_trigger: 'test',
      confidence: 0.9,
      proposal_only: false,
      rank: { rank_score: score, rank_bucket: bucket, rank_reasons: [], risk_level: /** @type {const} */ ('low') },
    });
  }

  it('keeps edits above threshold', () => {
    const edits = [
      makeRankedEdit(0.90, 'high'),
      makeRankedEdit(0.60, 'medium'),
      makeRankedEdit(0.30, 'low'),
    ];

    const { kept, dropped } = filterByMinRank(edits, 0.50);
    assert.equal(kept.length, 2);
    assert.equal(dropped, 1);
    assert.ok(kept.every(e => e.rank.rank_score >= 0.50));
  });

  it('drops all below threshold', () => {
    const edits = [makeRankedEdit(0.30, 'low'), makeRankedEdit(0.20, 'low')];
    const { kept, dropped } = filterByMinRank(edits, 0.50);
    assert.equal(kept.length, 0);
    assert.equal(dropped, 2);
  });

  it('keeps all when threshold is 0', () => {
    const edits = [makeRankedEdit(0.10, 'low'), makeRankedEdit(0.90, 'high')];
    const { kept, dropped } = filterByMinRank(edits, 0);
    assert.equal(kept.length, 2);
    assert.equal(dropped, 0);
  });

  it('handles empty list', () => {
    const { kept, dropped } = filterByMinRank([], 0.50);
    assert.equal(kept.length, 0);
    assert.equal(dropped, 0);
  });
});
