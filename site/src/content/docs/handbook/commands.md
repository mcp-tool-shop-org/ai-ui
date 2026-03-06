---
title: Commands
description: Full CLI reference for all AI-UI commands.
sidebar:
  order: 3
---

## Pipeline commands

These run in sequence — each reads the previous stage's output from `ai-ui-output/`.

### atlas

Parse docs (README, CHANGELOG, etc.) into a feature catalog.

```bash
ai-ui atlas
```

**Input:** Markdown files matching `docs.globs` in your config.
**Output:** `ai-ui-output/atlas.json` — structured feature catalog with names, descriptions, and source locations.

### probe

Crawl the running UI and record every interactive trigger.

```bash
ai-ui probe
```

**Input:** Running dev server at `probe.baseUrl`.
**Output:** `ai-ui-output/probe.jsonl` — one trigger per line with element type, text, selector, and route.

Probe uses Playwright to launch headless Chromium. It clicks through every configured route and records buttons, links, inputs, and other interactive elements.

### surfaces

Extract surfaces from a WebSketch capture.

```bash
ai-ui surfaces
```

**Input:** WebSketch IR capture files.
**Output:** `ai-ui-output/surfaces.json` — structured surface data.

### diff

Match atlas features against probe triggers using fuzzy matching.

```bash
ai-ui diff
```

**Input:** `atlas.json` + `probe.jsonl`
**Output:** `ai-ui-output/diff.json` + `diff.md` — matched features, must-surface items, coverage percentage, burial index.

### graph

Build a trigger graph from probe, surfaces, and diff data.

```bash
ai-ui graph
ai-ui graph --with-runtime    # Include runtime evidence
```

**Input:** `probe.jsonl` + `surfaces.json` + `diff.json` (+ runtime effects if `--with-runtime`)
**Output:** `ai-ui-output/trigger-graph.json` — nodes and edges representing all interactive elements and their relationships.

### design-map

Generate the full design diagnostic output.

```bash
ai-ui design-map
```

**Input:** `trigger-graph.json` + config (including `goalRules`)
**Output:** `ai-ui-output/design-map.md` containing:
- **Surface inventory** — every trigger grouped by location
- **Feature map** — discoverability scores and recommended actions
- **Task flows** — inferred navigation chains with loop detection and goal tracking
- **IA proposal** — primary/secondary nav, conversion paths, goal scores

### stage0

Run atlas + probe + diff in sequence.

```bash
ai-ui stage0
```

Equivalent to running `atlas`, `probe`, and `diff` one after another. Convenience command for the basic pipeline.

## Analysis commands

### compose

Generate a surfacing plan from diff + graph.

```bash
ai-ui compose
```

Produces actionable recommendations for how to surface buried features.

### verify

Pass/fail verdict for CI pipelines.

```bash
ai-ui verify --strict --gate minimum --min-coverage 60
```

**Flags:**
- `--strict` — fail on any must-surface item
- `--gate <level>` — minimum, standard, or strict
- `--min-coverage <N>` — minimum coverage percentage (0-100)
- `--json` — machine-readable output

**Exit codes:** 0 = pass, 1 = user error, 2 = runtime error.

### baseline

Save or compare verification baselines.

```bash
ai-ui baseline --write     # Save current state
ai-ui baseline --compare   # Compare against saved state
```

### pr-comment

Generate a PR-ready markdown comment from the latest artifacts.

```bash
ai-ui pr-comment
```

Output is markdown suitable for pasting into a GitHub PR.

## Runtime commands

### runtime-effects

Click triggers in a real browser and capture observed side effects.

```bash
ai-ui runtime-effects
ai-ui runtime-effects --dry-run    # Hover instead of click
```

Launches Playwright, clicks each trigger, and records:
- localStorage/sessionStorage writes
- DOM mutations (dialogs, toasts, panels)
- Fetch/XHR requests

**Safety:** Triggers matching deny patterns (delete, remove, destroy, etc.) are skipped. Use `data-aiui-safe` attribute to override for known-safe triggers. Use `--dry-run` to hover instead of click.

### runtime-coverage

Per-trigger coverage matrix.

```bash
ai-ui runtime-coverage
```

Shows which triggers were probed, which were surfaced, and which were observed with runtime effects.

## Snapshot commands

### replay-pack

Bundle all artifacts into a reproducible replay snapshot.

```bash
ai-ui replay-pack
```

Creates a timestamped snapshot of all `ai-ui-output/` artifacts.

### replay-diff

Compare two replay packs.

```bash
ai-ui replay-diff
```

Shows what changed between two snapshots — coverage deltas, new/removed triggers, goal score changes.

## AI commands (local Ollama)

Three commands use local [Ollama](https://ollama.com) models to extend the pipeline with semantic matching, visual analysis, and code generation. All processing runs locally — no data leaves your machine.

**Prerequisites:** Ollama must be running (`ollama serve`). Pull the required models before first use:

```bash
ollama pull qwen2.5:14b          # for ai-suggest
ollama pull llava:13b             # for ai-eyes
ollama pull qwen2.5-coder:7b     # for ai-hands
```

### ai-suggest

Semantic matching between documented features and UI surfaces using a general-purpose LLM (Brain).

```bash
ai-ui ai-suggest
ai-ui ai-suggest --model qwen2.5:14b
ai-ui ai-suggest --min-confidence 0.7
ai-ui ai-suggest --eyes ai-ui-output/eyes.json
```

**Input:** `atlas.json` + `probe.jsonl` + `diff.json` (+ optional Eyes annotations)
**Output:** `ai-ui-output/ai-suggest.json`, `ai-suggest.patch.json`, `ai-suggest.md` — alias patches that tell the diff engine which features map to which triggers.

**Flags:**
- `--model <name>` — Ollama model (default: configured in `ai-ui.config.json`)
- `--min-confidence <n>` — minimum match confidence 0.0–1.0 (default: 0.55)
- `--eyes <path>` — path to Eyes annotations for visual enrichment

### ai-eyes

Visual surface enrichment using a vision model (Eyes). Identifies icon-only buttons, text-poor controls, and visually ambiguous surfaces.

```bash
ai-ui ai-eyes
ai-ui ai-eyes --model llava:7b
```

**Input:** `probe.jsonl` + screenshots from `probe.baseUrl`
**Output:** `ai-ui-output/eyes.json` — annotated surfaces with `icon_guess`, `visible_text`, `nearby_context`, and confidence scores.

Each surface gets a visual annotation describing what a human would see. This context feeds into ai-suggest (better alias matching) and ai-hands (precise edit targeting).

**Flags:**
- `--model <name>` — Vision model (default: `llava:13b`)

### ai-hands

PR-ready patch generator using a code model (Hands). Reads the full design-map pipeline output, scans the target repo, and generates find/replace edits to close surfacing gaps.

```bash
ai-ui ai-hands
ai-ui ai-hands --tasks surface-settings,goal-hooks
ai-ui ai-hands --repo /path/to/project
ai-ui ai-hands --min-rank 0.50
ai-ui ai-hands --dry-run
```

**Input:** design-map artifacts + repo source files (+ optional Eyes annotations)
**Output:**
- `hands.plan.md` — ranked edit groups (High → Medium → Low confidence) with per-edit reasons
- `hands.patch.diff` — unified diff with hunks ordered by trustworthiness
- `hands.files.json` — manifest with `rank_score`, `rank_bucket`, `rank_reasons` per file
- `hands.verify.md` — verification checklist

**Task types:**

| Task | What it does |
|------|-------------|
| `add-aiui-hooks` | Add `data-aiui-safe` to non-destructive interactive elements |
| `surface-settings` | Improve discoverability for documented-but-buried features |
| `goal-hooks` | Add `data-aiui-goal` for task completion detection |
| `copy-fix` | Align UI labels with documentation terminology |

**Flags:**
- `--model <name>` — Code model (default: `qwen2.5-coder:7b`)
- `--tasks <list>` — Comma-separated task types (default: all four)
- `--repo <path>` — Target repo root (default: CWD)
- `--min-rank <n>` — Minimum rank score 0.0–1.0 to include (suppresses low-confidence hunks)
- `--dry-run` — Skip Ollama queries, generate empty plans
- `--verbose` — Show per-edit rank breakdowns

**Edit ranking:** Every edit is scored across five deterministic signals (validation strength, anchor quality, edit locality, provenance alignment, safety risk) and sorted into High (≥0.75) / Medium (0.50–0.74) / Low (<0.50) buckets. Validated edits always appear before proposal-only edits. High-risk edits (touching auth/routing, deleting code) show a ⚠️ indicator even within High confidence.

**Safety:** Edits are never applied automatically. All outputs are proposals for human review. Apply with `git apply hands.patch.diff` after reviewing `hands.plan.md`.

## Utility commands

### init-memory

Create empty memory files for decision tracking.

```bash
ai-ui init-memory
```

Sets up the memory file structure used by the pipeline to track decisions across runs.
