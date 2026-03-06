# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

Email: **64996768+mcp-tool-shop@users.noreply.github.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Version affected
- Potential impact

### Response timeline

| Action | Target |
|--------|--------|
| Acknowledge report | 48 hours |
| Assess severity | 7 days |
| Release fix | 30 days |

## Scope

AI-UI operates **locally only** against your dev server.

- **Data touched:** markdown docs (read-only), browser DOM (read via Playwright), localStorage keys (read during runtime-effects). All output written to `ai-ui-output/` in the project directory.
- **No network egress** — all analysis runs locally. The only network activity is Playwright connecting to `localhost` at the configured `baseUrl`.
- **No secrets handling** — does not read, store, or transmit credentials.
- **No telemetry** is collected or sent.
- **Browser automation safety** — the `runtime-effects` command clicks real UI triggers. Destructive actions (delete, remove, destroy, etc.) are denied by default. The `data-aiui-safe` attribute can override safety for known-safe triggers. Use `--dry-run` to hover instead of click.
