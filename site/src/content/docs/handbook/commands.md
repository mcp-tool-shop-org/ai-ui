---
title: Commands
description: Full CLI reference for all 16 AI-UI commands.
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

## Utility commands

### init-memory

Create empty memory files for decision tracking.

```bash
ai-ui init-memory
```

Sets up the memory file structure used by the pipeline to track decisions across runs.
