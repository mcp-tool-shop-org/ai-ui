---
title: AI-UI Handbook
description: Everything you need to know about AI-UI — automated design diagnostics for SPAs.
sidebar:
  order: 0
---

**What is this?** AI-UI is a CLI that measures the gap between what your docs promise and what your UI delivers. It crawls your running app, parses your documentation, and tells you which features are invisible — deterministically, with no LLM required.

**Who is it for?** Frontend developers and design teams who want to keep their UI honest. If your README says "ambient soundscapes" but no button leads there, AI-UI finds that.

**Status:** Stable (v1.0.1)

**TL;DR:** Point it at your docs and your dev server. It tells you what's buried, what's missing, and what to fix. `ai-ui stage0` runs the whole thing.

---

## The elevator pitch

**The problem:** SPAs accumulate features faster than they accumulate navigation paths to those features. Docs promise capabilities that users can't find. Nobody notices until a support ticket arrives.

**What AI-UI does better:** It doesn't guess. It builds a trigger graph from real browser interactions, fuzzy-matches features to triggers deterministically, and produces actionable verdicts: promote, keep, demote, merge.

**What it doesn't do:** It doesn't redesign your app. It doesn't generate code. It doesn't use an LLM. It measures discoverability and tells you where the gaps are. You decide what to do about them.

*If you only remember one thing about this repo, remember:* it closes the loop between documentation promises and UI reality.

*This is not for:* visual regression testing, accessibility auditing, or performance profiling. Those are different tools.

---

## What's inside

- **[Getting Started](/ai-ui/handbook/getting-started/)** — Install and first run
- **[Common Tasks](/ai-ui/handbook/usage/)** — Pipeline recipes for everyday work
- **[Commands](/ai-ui/handbook/commands/)** — Full CLI reference
- **[Configuration](/ai-ui/handbook/configuration/)** — Config file, goal rules, feature aliases
- **[Architecture](/ai-ui/handbook/architecture/)** — Mental model and design decisions
- **[Operations](/ai-ui/handbook/operations/)** — CI integration, troubleshooting, debug bundles
- **[Security](/ai-ui/handbook/security/)** — Threat model and safety posture
- **[FAQ](/ai-ui/handbook/faq/)** — Common questions

[Back to landing page](/ai-ui/)
