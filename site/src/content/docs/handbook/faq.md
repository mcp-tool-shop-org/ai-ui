---
title: FAQ
description: Common questions about AI-UI.
sidebar:
  order: 8
---

## Why does it use fuzzy matching instead of an LLM?

Determinism. The same docs and the same UI must produce the same report every time. LLMs introduce variance that makes CI gates unreliable. Fuzzy matching is less clever but perfectly reproducible — which is what you want when a PR gate decides whether to block a merge.

## Can it work with server-rendered apps?

Yes, as long as your app runs on a dev server that Playwright can reach. Probe doesn't care whether the HTML is server-rendered or client-rendered — it sees whatever the browser sees after JavaScript executes.

## Can it work with mobile apps?

No. AI-UI uses Playwright with Chromium, which means it only works with web apps. Native mobile apps, Electron apps with custom protocols, or apps behind authentication walls are out of scope.

## What about authenticated routes?

Probe runs unauthenticated. If your app requires login to see certain pages, those pages won't be crawled. You can work around this by:
- Using a dev mode that bypasses auth
- Pre-seeding a session cookie (not built-in — you'd need to modify probe)
- Only auditing the public portion of your app

## How do I add AI-UI to an existing CI pipeline?

Three lines:

```bash
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60
```

Exit code 0 means pass. That's it.

## Why does probe take so long?

Probe launches a real Chromium browser and visits every configured route. It waits for the page to settle, then inspects every interactive element. More routes = more time. A typical 5-route app takes 10-15 seconds. A 20-route app might take a minute.

Speed tips:
- Only include routes that matter for discoverability
- Don't include error pages, login pages, or admin panels
- Make sure your dev server is fast (HMR on, no heavy middleware)

## What does "must-surface" mean?

A feature is "must-surface" when your docs describe it but no UI trigger leads to it. Either:
- The feature exists but is buried too deep (add a visible entry point)
- The feature was removed but the docs weren't updated (remove from docs)
- The feature uses different terminology than the docs (add a `featureAlias`)

## What does "burial index" mean?

How many clicks from the primary navigation it takes to reach a feature. A button in the main nav has burial index 0. A setting inside a dialog behind a gear icon has burial index 3. Higher burial = harder to discover.

## Can I use AI-UI without docs?

Technically yes — atlas will just produce an empty feature catalog. But the value of AI-UI is in the match between docs and UI. Without docs, you only get the trigger inventory (probe output), which is useful but not the full picture.

## Does it work on Windows?

Yes. AI-UI runs on Windows, macOS, and Linux. The only requirement is Node.js 20+ and Playwright's Chromium browser.

## How do I safely use runtime-effects?

1. Read the [safety section](/ai-ui/handbook/security/) first
2. Start with `--dry-run` to see what would be clicked
3. Review the trigger list for anything destructive
4. Add `data-aiui-safe` to triggers that look dangerous but aren't
5. Run without `--dry-run` when you're confident

## What's the difference between probe and runtime-effects?

- **Probe** records what exists — it finds interactive elements and their properties
- **Runtime-effects** records what happens — it clicks triggers and observes side effects (storage writes, DOM mutations, fetch calls)

Probe is read-only observation. Runtime-effects is active interaction.

## Glossary

| Term | Meaning |
|------|---------|
| **Atlas** | Doc parser that extracts features from markdown |
| **Probe** | Browser crawler that records interactive triggers |
| **Trigger** | An interactive UI element (button, link, input, etc.) |
| **Feature** | A capability documented in your markdown files |
| **Coverage** | Percentage of features matched to at least one trigger |
| **Burial index** | Click depth from primary nav to a feature |
| **Goal rule** | Configurable predicate that detects SPA task completion |
| **Goal hit** | A goal rule that matched observed runtime evidence |
| **Task flow** | Inferred navigation chain through your app |
| **Design map** | Full diagnostic output (inventory + feature map + flows + IA) |
| **IA proposal** | Information architecture recommendation |
| **Replay pack** | Timestamped snapshot of all pipeline artifacts |
| **Must-surface** | A documented feature with no discoverable UI entry point |
