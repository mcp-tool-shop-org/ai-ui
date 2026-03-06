---
title: Getting Started
description: Install AI-UI and run your first design audit in under two minutes.
sidebar:
  order: 1
---

## Install

```bash
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui
npm install
```

AI-UI requires **Node.js 20+** and a running dev server for the probe and runtime-effects commands.

## Smallest working example

Create `ai-ui.config.json` in your project root:

```json
{
  "docs": { "globs": ["README.md"] },
  "probe": {
    "baseUrl": "http://localhost:5173",
    "routes": ["/"]
  }
}
```

Start your dev server, then:

```bash
ai-ui stage0
```

That runs `atlas → probe → diff` in sequence.

## Expected output

```
ai-ui-output/
├── atlas.json          # Feature catalog from your docs
├── probe.jsonl         # Trigger graph from browser crawl
├── diff.json           # Feature-to-trigger matching
└── diff.md             # Human-readable diff report
```

The diff report tells you:
- **Matched features** — documented features with a discoverable UI trigger
- **Must-surface** — documented features with no visible entry point
- **Undocumented triggers** — UI elements that aren't mentioned in docs
- **Coverage percentage** — how much of your docs is discoverable

## Uninstall

AI-UI is a local clone — just delete the directory:

```bash
rm -rf ai-ui
```

All output goes to `ai-ui-output/` in your project directory. Delete that too if you want a clean slate.

## Compatibility

| Requirement | Minimum |
|-------------|---------|
| Node.js | 20.0.0 |
| OS | Windows, macOS, Linux |
| Browser | Chromium (via Playwright) |
| Dev server | Any (Vite, Next, Astro, etc.) |

The probe command uses Playwright to launch a headless Chromium browser. It connects to your dev server over `localhost` — no external network access.

### Works in CI

```bash
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60
# Exit: 0=pass, 1=user error, 2=runtime error
```

No secrets, no API keys, no external dependencies. Just Node.js and a dev server.
