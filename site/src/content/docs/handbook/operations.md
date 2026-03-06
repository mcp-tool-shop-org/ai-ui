---
title: Operations
description: CI integration, logging, troubleshooting, and resource usage.
sidebar:
  order: 6
---

## Expected runtime behavior

AI-UI runs locally. Every command reads files from disk and writes results to `ai-ui-output/`. The only network activity is Playwright connecting to `localhost` during probe and runtime-effects.

Typical run times:
- `atlas` — under 1 second for most projects
- `probe` — 5-30 seconds depending on route count
- `diff` — under 1 second
- `graph` + `design-map` — under 2 seconds
- `runtime-effects` — 10-60 seconds depending on trigger count

## Logging

Three verbosity levels:

| Level | Flag | What you see |
|-------|------|-------------|
| Silent | (none) | Only errors |
| Normal | (default) | Summary output + final report |
| Verbose | `--verbose` | Detailed step-by-step output |

Errors always print to stderr with structured format: code, message, hint.

No secrets are ever logged. AI-UI doesn't handle credentials — there's nothing to redact.

## Resource usage

| Resource | Usage |
|----------|-------|
| CPU | Low (text processing). Probe uses one Chromium process. |
| RAM | ~100-200MB for Playwright. Pipeline processing is negligible. |
| Disk | `ai-ui-output/` grows with project size. Typically under 1MB. |
| Network | localhost only. Zero external connections. |

## CI integration

### Basic CI gate

```bash
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60
```

Exit codes:
- `0` — pass
- `1` — user error (coverage below threshold, must-surface items found)
- `2` — runtime error (missing files, broken config)

### GitHub Actions example

```yaml
- name: Design audit
  run: |
    npx ai-ui stage0
    npx ai-ui graph
    npx ai-ui verify --strict --gate minimum --min-coverage 60
```

### Baseline tracking

```bash
# Save baseline on main branch
ai-ui baseline --write

# Compare on feature branches
ai-ui baseline --compare
```

Baselines let you detect regressions: if a PR removes a button that was the only path to a documented feature, the baseline comparison catches it.

## Troubleshooting

### What to do when it's on fire

1. **Run with verbose:** `ai-ui <command> --verbose`
2. **Check the output directory:** `ls ai-ui-output/`
3. **Check the config:** `cat ai-ui.config.json`
4. **Verify the dev server:** `curl http://localhost:5173` (or whatever your `baseUrl` is)

### Common errors

| Error code | Meaning | Fix |
|-----------|---------|-----|
| `CONFIG_NOT_FOUND` | No `ai-ui.config.json` in current directory | Create one (see [Configuration](/ai-ui/handbook/configuration/)) |
| `PROBE_TIMEOUT` | Dev server didn't respond | Start your dev server first |
| `ATLAS_NO_DOCS` | No files matched `docs.globs` | Check your glob patterns |
| `IO_READ` | Can't read an input file | Run the prerequisite command first |
| `IO_WRITE` | Can't write to `ai-ui-output/` | Check directory permissions |

### Probe finds no triggers

- Is the dev server running?
- Does `baseUrl` point to the right port?
- Are the routes correct? Try visiting them in a real browser.
- Does the app require authentication? Probe runs unauthenticated.
- Is JavaScript rendering? Some SSR apps need client-side hydration.

### Diff shows 0% coverage

- Did atlas find features? Check `atlas.json`.
- Did probe find triggers? Check `probe.jsonl`.
- Are feature names very different from UI text? Try adding `featureAliases`.
- Is the diff matching threshold too strict? Check if features are nearly matching by reading `diff.md`.

### runtime-effects skips triggers

Triggers matching deny patterns are skipped for safety:
- Labels containing "delete," "remove," "destroy," "reset," "drop," "purge"
- Override with `data-aiui-safe` attribute on the element
- Use `--dry-run` to see what would be clicked without clicking

## Metrics and telemetry

There is no telemetry. AI-UI collects nothing, sends nothing, phones home to nobody. This is stated in SECURITY.md and it's the truth.

## Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Dev server crashes during probe | Partial `probe.jsonl` | Restart server, re-run probe |
| Playwright can't launch | No probe data | Install Playwright: `npx playwright install chromium` |
| Disk full | Write failures | Clear old `ai-ui-output/` directories |
| Node.js < 20 | Import errors | Upgrade Node.js |
