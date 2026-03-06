---
title: Security
description: Threat model, safety posture, and what AI-UI does and doesn't touch.
sidebar:
  order: 7
---

## Threat model summary

AI-UI operates **locally only** against your dev server. The full threat model is in [SECURITY.md](https://github.com/mcp-tool-shop-org/ai-ui/blob/main/SECURITY.md).

### What it touches

- **Markdown docs** — read-only. Atlas parses them but never modifies them.
- **Browser DOM** — read via Playwright. Probe clicks buttons and records what it sees.
- **localStorage keys** — read during runtime-effects to detect storage writes.
- **All output** — written to `ai-ui-output/` in your project directory. Nothing else is modified.

### What it does NOT touch

- **Your source code** — never read, never modified
- **Your git history** — never accessed
- **External services** — zero network egress
- **Credentials** — never reads, stores, or transmits secrets
- **Production servers** — only connects to localhost

### Network activity

The only network activity is Playwright connecting to `localhost` at the configured `baseUrl`. There is no DNS resolution to external hosts, no telemetry, no analytics, no phone-home behavior.

## No telemetry

AI-UI collects no telemetry. None. No opt-in, no opt-out — there's nothing to opt out of. This is by design, not by laziness.

## Secrets handling

AI-UI doesn't handle secrets. There are no API keys, no tokens, no credentials involved in any command. If your dev server requires authentication, you'll need to handle that separately — AI-UI can't log in.

Nothing goes in logs because there's nothing sensitive to log.

## Browser automation safety

The `runtime-effects` command clicks real UI triggers in a Playwright browser. This is the one command that has side effects.

Safety rules:

1. **Deny patterns** — triggers with labels matching destructive words (delete, remove, destroy, reset, drop, purge, etc.) are skipped automatically.

2. **Safe override** — add `data-aiui-safe` to elements that look destructive but are actually safe:
   ```html
   <button data-aiui-safe>Remove filter</button>
   ```

3. **Dry run** — `--dry-run` hovers instead of clicking. Use this to preview what would happen.

4. **Scope** — only clicks triggers found by probe. Doesn't type into forms, doesn't submit forms, doesn't navigate away from configured routes.

## Permission model

AI-UI needs:
- Read access to your markdown docs
- Network access to `localhost` (for Playwright)
- Write access to `ai-ui-output/` directory

That's it. No filesystem scanning, no process listing, no system calls beyond normal Node.js file operations.

## Supply chain

AI-UI has three production dependencies:
- `astro` — static site framework (for the landing page, not the CLI)
- `markdown-it` — markdown parser (devDep used by atlas)
- `playwright` — browser automation (devDep used by probe)

The CLI itself (`cli/`) has zero production dependencies. Everything runs on Node.js built-ins.

## Reporting a vulnerability

Email: **64996768+mcp-tool-shop@users.noreply.github.com**

Include: description, steps to reproduce, version affected, potential impact.

Response timeline:
- Acknowledge: 48 hours
- Assess severity: 7 days
- Release fix: 30 days
