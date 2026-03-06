---
title: Common Tasks
description: Pipeline recipes for everyday AI-UI work — from basic audits to CI gates.
sidebar:
  order: 2
---

Each task is a recipe: what you want to do, the commands, what success looks like, and what to check if it fails.

## Run a basic design audit

**Goal:** Find out which documented features are discoverable and which are buried.

```bash
ai-ui atlas          # Parse docs → feature catalog
ai-ui probe          # Crawl UI → trigger graph
ai-ui diff           # Match features ↔ triggers
```

Or all three at once:

```bash
ai-ui stage0
```

**Success:** `ai-ui-output/diff.md` exists and shows coverage percentage, matched features, and must-surface items.

**If it fails:**
- `CONFIG_NOT_FOUND` — create `ai-ui.config.json` in your project root
- `PROBE_TIMEOUT` — make sure your dev server is running at the configured `baseUrl`
- `ATLAS_NO_DOCS` — check that your `docs.globs` patterns match actual files

## Build the full design map

**Goal:** Get surface inventory, feature discoverability scores, task flows, and an IA proposal.

```bash
ai-ui stage0         # Run atlas + probe + diff first
ai-ui graph          # Build trigger graph
ai-ui design-map     # Generate design map
```

**Success:** `ai-ui-output/design-map.md` contains four sections: surface inventory, feature map, task flows, and IA proposal.

**If it fails:**
- `GRAPH_NO_INPUT` — run `stage0` first to generate the required input files
- Empty design map — your probe may not have found any triggers (check `probe.jsonl`)

## Capture runtime evidence (SPAs)

**Goal:** For apps where URLs don't change, capture what actually happens when buttons are clicked — storage writes, DOM mutations, fetch calls.

```bash
ai-ui runtime-effects    # Click triggers in a real browser
ai-ui graph --with-runtime   # Rebuild graph with evidence
ai-ui design-map         # Now evaluates goal rules
```

**Success:** Task flows in `design-map.md` show goal tags like `GOALS: Open Audio Settings [score: 2]`.

**If it fails:**
- No goals showing — make sure `goalRules` is configured in `ai-ui.config.json`
- All goals `(unknown)` — runtime-effects didn't observe matching effects. Check that the UI actually writes to storage/fires fetches when clicked.

## Set up CI verification

**Goal:** Block PRs that reduce discoverability below a threshold.

```bash
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60
```

**Success:** Exit code 0 means coverage is above the threshold. Exit code 1 means it dropped.

**If it fails:**
- Exit code 2 — runtime error (missing files, broken config)
- Coverage dropped — check `diff.md` to see which features lost their triggers

## Save and compare baselines

**Goal:** Track discoverability across releases. See what improved and what regressed.

```bash
# Save a baseline after a known-good state
ai-ui baseline --write

# After making changes, run the pipeline again
ai-ui stage0 && ai-ui graph && ai-ui design-map

# Compare
ai-ui replay-pack
# ... make changes, run pipeline again ...
ai-ui replay-pack
ai-ui replay-diff
```

**Success:** The replay-diff shows a before/after comparison of coverage, goals, and task flows.

## Generate a PR comment

**Goal:** Post a summary of design diagnostics as a PR comment.

```bash
ai-ui stage0 && ai-ui graph && ai-ui design-map
ai-ui pr-comment
```

**Success:** Markdown output suitable for pasting into a GitHub PR comment.

## Debug a failure

**Goal:** Understand why a command failed.

```bash
ai-ui <command> --verbose
```

Verbose mode prints detailed output including:
- Which files were parsed (atlas)
- Which routes were crawled and which triggers were found (probe)
- Which features matched which triggers and why (diff)
- Graph construction details (graph)

**Common failure patterns:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No triggers found | Dev server not running | Start your dev server first |
| 0% coverage | Wrong `baseUrl` in config | Check the URL matches your dev server |
| Missing features | Doc globs don't match files | Check `docs.globs` patterns |
| Probe hangs | Route requires auth | Probe runs unauthenticated — use public routes |
