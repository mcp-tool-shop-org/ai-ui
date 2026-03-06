<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ai-ui/readme.png" alt="AI-UI" width="360" />
</p>

**Automated design diagnostics for SPAs.** AI-UI crawls your running app, reads your docs, and tells you exactly which documented features have no discoverable UI entry point — and which UI surfaces aren't documented at all.

It doesn't guess. It builds a trigger graph from real browser interactions, matches features to triggers deterministically, and produces a design-map with actionable verdicts: must-surface, demote, keep, merge. Then it verifies the fix.

## What it does

```
README says "ambient soundscapes"  →  atlas extracts the feature
Probe clicks every button           →  "Audio Settings" trigger found
Diff matches feature to trigger     →  coverage: 64%
Design-map says: must-surface 0     →  all documented features are discoverable
```

AI-UI closes the loop between documentation promises and UI reality.

## Install

```bash
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui
npm install
```

Requires Node.js 20+ and a running dev server for probe/runtime-effects commands.

## Quick start

```bash
# 1. Parse your docs into a feature catalog
ai-ui atlas

# 2. Crawl your running app
ai-ui probe

# 3. Match features to triggers
ai-ui diff

# Or run all three in sequence:
ai-ui stage0
```

Output lands in `ai-ui-output/`. The diff report tells you what's matched, what's missing, and what's undocumented.

## Commands

| Command | What it does |
|---------|-------------|
| `atlas` | Parse docs (README, CHANGELOG, etc.) into a feature catalog |
| `probe` | Crawl the running UI, record every interactive trigger |
| `surfaces` | Extract surfaces from a WebSketch capture |
| `diff` | Match atlas features against probe triggers |
| `graph` | Build trigger graph from probe + surfaces + diff |
| `design-map` | Generate surface inventory, feature map, task flows, IA proposal |
| `compose` | Generate a surfacing plan from diff + graph |
| `verify` | Judge pipeline artifacts — pass/fail verdict for CI |
| `baseline` | Save/compare verification baselines |
| `pr-comment` | Generate a PR-ready markdown comment from artifacts |
| `runtime-effects` | Click triggers in a real browser, capture observed side effects |
| `runtime-coverage` | Per-trigger coverage matrix (probed / surfaced / observed) |
| `replay-pack` | Bundle all artifacts into a reproducible replay pack |
| `replay-diff` | Compare two replay packs — show what changed and why |
| `ai-suggest` | Match doc features to UI surfaces using Ollama (Brain) |
| `ai-eyes` | Visually identify icon-only and text-poor surfaces using LLaVA (Eyes) |
| `ai-hands` | Generate PR-ready patches for surfacing gaps using qwen2.5-coder (Hands) |
| `stage0` | Run atlas + probe + diff in sequence |
| `init-memory` | Create empty memory files for decision tracking |

## Configuration

Create `ai-ui.config.json` in your project root:

```json
{
  "docs": { "globs": ["README.md", "CHANGELOG.md", "docs/*.md"] },
  "probe": {
    "baseUrl": "http://localhost:5173",
    "routes": ["/", "/settings", "/dashboard"]
  },
  "featureAliases": {
    "dark-mode-support": ["Theme", "Dark mode"]
  },
  "goalRules": [
    { "id": "settings_open", "label": "Open Settings", "kind": "domEffect", "dom": { "textRegex": "Settings" }, "score": 2 }
  ]
}
```

All fields are optional — sensible defaults are applied. See `cli/src/config.mjs` for the full schema.

### Goal rules

For SPAs where URLs don't change, route-based goals are useless. Goal rules let you define success as observable effects:

| Kind | Matches | Example |
|------|---------|---------|
| `storageWrite` | localStorage/sessionStorage writes | `{ "keyRegex": "^user\\.prefs\\." }` |
| `fetch` | HTTP requests by method/URL/status | `{ "method": ["POST"], "urlRegex": "/api/save" }` |
| `domEffect` | DOM mutations (modal open, toast, etc.) | `{ "textRegex": "saved" }` |
| `composite` | AND of multiple kinds | storage + dom for "settings saved" |

Rules require runtime evidence (`ai-ui runtime-effects` + `ai-ui graph --with-runtime`) to produce goal hits. Without evidence, goals remain unevaluated — no false positives.

## Design-map output

The `design-map` command produces four artifacts:

- **Surface inventory** — every interactive element grouped by location (primary nav, settings, toolbar, inline)
- **Feature map** — each documented feature with discoverability score, entry points, and recommended action
- **Task flows** — inferred navigation chains with loop detection and goal tracking
- **IA proposal** — primary nav, secondary nav, must-surface, documented-non-surface, conversion paths

### Recommended actions

| Action | Meaning |
|--------|---------|
| `promote` | Feature is documented but buried — needs a more discoverable entry point |
| `keep` | Feature is well-balanced — documented and discoverable |
| `demote` | Feature is prominent but risky or low-value — move to advanced/settings |
| `merge` | Duplicate feature names across routes — consolidate |
| `skip` | Not a real feature (sentence-like name, ungrounded) |

## Pipeline

The full pipeline sequence:

```
atlas → probe → diff → graph → design-map → ai-suggest → ai-eyes → ai-hands
                 ↓                                                      ↓
          runtime-effects → graph --with-runtime                  hands.plan.md
                                    ↓                             hands.patch.diff
                              design-map (with goals)             hands.files.json
                                    ↓                             hands.verify.md
                              replay-pack → replay-diff
```

Each stage reads the previous stage's output from `ai-ui-output/`. The pipeline is deterministic — same inputs produce same outputs.

## AI commands (local Ollama)

Three commands use local Ollama models to go beyond deterministic matching. They require [Ollama](https://ollama.com) running locally — no data leaves your machine.

### ai-suggest (Brain)

Semantic matching between documented features and UI surfaces using a general-purpose LLM.

```bash
ai-ui ai-suggest                        # default model
ai-ui ai-suggest --model qwen2.5:14b    # specify model
ai-ui ai-suggest --eyes ai-ui-output/eyes.json  # enrich with Eyes data
```

Outputs alias patches that tell the diff engine which features map to which triggers — closing gaps that fuzzy string matching misses.

### ai-eyes (Eyes)

Visual surface enrichment using a vision model (LLaVA). Identifies icon-only buttons, text-poor controls, and visually ambiguous surfaces.

```bash
ai-ui ai-eyes                           # default: llava:13b
ai-ui ai-eyes --model llava:7b          # lighter model
```

Annotates surfaces with `icon_guess`, `visible_text`, and `nearby_context` — context that downstream commands (ai-suggest, ai-hands) use for precise targeting.

### ai-hands (Hands)

PR-ready patch generator using a code model (qwen2.5-coder). Reads the full design-map pipeline output and generates find/replace edits to close surfacing gaps.

```bash
ai-ui ai-hands                          # all tasks, default model
ai-ui ai-hands --tasks surface-settings,goal-hooks  # specific tasks
ai-ui ai-hands --repo /path/to/project  # target a different repo
ai-ui ai-hands --min-rank 0.50          # only high/medium confidence edits
```

**Task types:**
- `add-aiui-hooks` — add `data-aiui-safe` attributes to non-destructive interactive elements
- `surface-settings` — improve discoverability for documented-but-buried features
- `goal-hooks` — add `data-aiui-goal` attributes for task completion detection
- `copy-fix` — align UI labels with documentation terminology

**Outputs:** `hands.plan.md` (ranked edit groups), `hands.patch.diff` (hunks in trust order), `hands.files.json` (manifest with rank metadata), `hands.verify.md` (verification checklist).

Every edit is ranked by trustworthiness (validation strength, anchor quality, locality, provenance, safety) and sorted into High/Medium/Low confidence buckets. Edits are never applied automatically — the output is always a proposal for human review.

## CI integration

```bash
# Run pipeline + verify in CI
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60

# Exit code 0 = pass, 1 = user error, 2 = runtime error
```

Use `--json` for machine-readable output. Use `baseline --write` to lock in thresholds.

## Threat model

AI-UI runs locally against your dev server. It does not:
- Send data to external services (AI commands use local Ollama only)
- Modify your source code or configuration (ai-hands outputs proposals, never applies them)
- Access anything outside the configured `baseUrl` and doc globs
- Require network access (all analysis is local)

The `runtime-effects` command clicks real buttons in a Playwright browser. It respects safety rules:
- Triggers matching deny patterns (delete, remove, destroy, etc.) are skipped
- The `data-aiui-safe` attribute can override safety for known-safe triggers
- `--dry-run` mode hovers instead of clicking

## Tests

```bash
npm test
```

877 tests using Node.js native test runner. No external test framework.

## License

MIT — see [LICENSE](LICENSE).

---

Built by [MCP Tool Shop](https://mcp-tool-shop.github.io/)
