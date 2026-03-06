# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-03-06

### Added
- Goal rules system (Stage 0E) — configurable effect predicates for SPA task success
- `evaluateGoalRules()` engine with storageWrite, fetch, domEffect, composite matchers
- Three-tier goal detection: route → rule → legacy effect (backward compat)
- Per-step `goals_hit` + per-flow `goals_reached` with score aggregation
- `data-aiui-goal` DOM convention for stable goal markers
- `hasRuntimeEvidence()` to distinguish "not reached" from "unknown"
- Atlas-level feature dedup (matchScore >= 0.7 merges near-duplicates)
- `documented_non_surface` category separates architectural capabilities from must-surface
- Effect-based goal detection for SPAs (storageWrite, domEffect, fetch)

## [1.0.0] — 2026-02-28

### Added
- 20-command CLI: atlas, probe, surfaces, diff, graph, compose, verify, baseline, pr-comment, init-memory, runtime-effects, runtime-coverage, replay-pack, replay-diff, design-map, stage0
- Trigger graph with runtime effect augmentation
- Design-map: surface inventory, feature map, task flows, IA proposal
- CI coverage gates with set-based ratchet
- Replay packs for reproducible artifact snapshots
- 772 tests using Node.js native test runner
