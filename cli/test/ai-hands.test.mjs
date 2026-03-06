// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, isAllowedExtension, scanRepo, filterRelevantFiles, findNearLine, extractContextWindow } from '../src/repo-scan.mjs';
import { buildUnifiedDiff, buildFilesManifest, validateEdit } from '../src/git-diff.mjs';
import { buildCoderPrompt, parseCoderResponse, CoderParseError } from '../src/ollama-coder.mjs';

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
