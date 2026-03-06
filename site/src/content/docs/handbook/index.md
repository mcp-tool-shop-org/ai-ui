---
title: Handbook
description: Everything you need to know about AI-UI.
sidebar:
  order: 0
---

Welcome to the AI-UI handbook.

## What's inside

AI-UI is a CLI tool that measures the gap between what your docs promise and what your UI delivers. It crawls your running app, parses your documentation, and produces deterministic design diagnostics — no LLM required.

## Pipeline overview

```
atlas → probe → diff → graph → design-map
                 ↓
          runtime-effects → graph --with-runtime → design-map (with goals)
                                                        ↓
                                                   replay-pack → replay-diff
```

Each command reads the previous stage's output from `ai-ui-output/`. The pipeline is fully deterministic — same inputs produce same outputs.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui && npm install

# 2. Configure your project
# Create ai-ui.config.json in your project root

# 3. Run the basic pipeline
ai-ui stage0    # atlas + probe + diff
ai-ui graph     # build trigger graph
ai-ui design-map # generate diagnostics
```

## Configuration

Create `ai-ui.config.json` in your project root:

```json
{
  "docs": { "globs": ["README.md", "docs/*.md"] },
  "probe": {
    "baseUrl": "http://localhost:5173",
    "routes": ["/", "/settings"]
  }
}
```

All fields are optional — sensible defaults are applied. See `cli/src/config.mjs` for the full schema.
