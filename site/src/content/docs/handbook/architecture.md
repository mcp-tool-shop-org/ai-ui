---
title: Architecture
description: Mental model, key files, and design decisions behind AI-UI.
sidebar:
  order: 5
---

## Mental model

AI-UI answers one question: **"Can users find the features your docs promise?"**

It does this in three phases:

1. **Extract** — Parse your docs into a feature catalog (atlas)
2. **Discover** — Crawl your UI and record every interactive trigger (probe)
3. **Match** — Fuzzy-match features to triggers and compute coverage (diff)

Everything after that — graph, design-map, goals, replays — is analysis on top of these three inputs.

## Core concepts

- **Feature** — A capability your docs claim to have. Extracted from markdown headings and content.
- **Trigger** — An interactive UI element. Buttons, links, inputs, checkboxes, dialogs.
- **Coverage** — The percentage of documented features that have at least one discoverable trigger.
- **Burial index** — How deep a feature is in the navigation hierarchy. Higher = harder to find.
- **Goal** — An observable effect that proves a user completed a meaningful action (storage write, DOM mutation, fetch call).
- **Task flow** — An inferred sequence of navigation steps a user might take.
- **Design map** — The full diagnostic output: surface inventory, feature map, task flows, IA proposal.

## Inputs, processing, outputs

```
Inputs                    Processing               Outputs
─────────────────────     ────────────────────      ──────────────────
README.md, docs/*.md  →   atlas (markdown-it)   →   atlas.json
Running dev server    →   probe (Playwright)    →   probe.jsonl
WebSketch captures    →   surfaces              →   surfaces.json
atlas + probe         →   diff (fuzzy match)    →   diff.json, diff.md
diff + probe + surf   →   graph (DAG builder)   →   trigger-graph.json
graph + config        →   design-map            →   design-map.md
graph + browser       →   runtime-effects       →   effects data
two replay packs      →   replay-diff           →   delta report
```

## Key files

| File | Purpose |
|------|---------|
| `cli/bin/ai-ui.mjs` | CLI entry point — argument parsing, command dispatch |
| `cli/src/config.mjs` | Config loading, defaults, validation, `fail()` error helper |
| `cli/src/atlas.mjs` | Doc parser — markdown-it → feature catalog |
| `cli/src/probe.mjs` | Browser crawler — Playwright → trigger records |
| `cli/src/diff.mjs` | Feature-trigger matcher — fuzzy matching + burial index |
| `cli/src/graph.mjs` | Trigger graph builder — DAG from probe + surfaces + diff |
| `cli/src/design-map.mjs` | Design diagnostic engine — surface inventory, task flows, IA, goal rules |
| `cli/src/verify.mjs` | CI verification — coverage gates, baseline comparison |
| `cli/src/runtime-effects.mjs` | Runtime capture — click triggers, observe side effects |
| `cli/src/types.mjs` | JSDoc typedefs — the type system for the entire pipeline |

## Design decisions

### Why no LLM?

Determinism. The same docs + the same UI = the same report, every time. LLMs introduce variance that makes CI gates unreliable. If your coverage drops from 64% to 62%, you need to know it's because a button was removed — not because the model had a different day.

AI-UI uses fuzzy string matching, not semantic similarity. It's less clever but perfectly reproducible.

### Why Playwright?

Probe needs to see what a real user sees. DOM inspection misses dynamic content, lazy-loaded components, and client-side routing. Playwright gives us a real Chromium browser that renders JavaScript, handles SPA routing, and interacts with the page.

### Why JSONL for probe output?

Probe can generate thousands of triggers. JSONL (one JSON object per line) makes it easy to stream, filter, and process without loading everything into memory. It also makes diffs readable in version control.

### Why three-tier goal detection?

We don't want to break existing behavior when adding new features:

1. **Route goals** (always active) — traditional URL-change detection
2. **Rule goals** (when `goalRules` is configured) — effect-based detection for SPAs
3. **Legacy effect goals** (fallback when no rules) — binary "did anything happen?" check

If you configure goal rules, the legacy fallback is disabled. If you don't, everything works exactly as before.

### Why split atlas/probe/diff instead of one command?

Each stage is independently useful and independently testable. You might want to:
- Run atlas without a dev server (just parse docs)
- Run probe against a staging environment
- Re-run diff after changing feature aliases

Splitting also makes CI caching possible — if your docs haven't changed, skip atlas.

## Extensibility

### Adding a new command

1. Create `cli/src/my-command.mjs` with a default export function
2. Add it to the command dispatch in `cli/bin/ai-ui.mjs`
3. Add tests in `cli/test/`

### Adding a new goal rule kind

1. Add the kind to `GoalRuleKind` in `cli/src/types.mjs`
2. Add a `matchMyRule()` function in `cli/src/design-map.mjs`
3. Wire it into `matchSingleRule()`
4. Add tests

### Custom probe behavior

Probe is designed around the config file. To change which elements it records, modify the trigger detection logic in `cli/src/probe.mjs`. The probe doesn't depend on any other pipeline stage — it's a standalone crawler.
