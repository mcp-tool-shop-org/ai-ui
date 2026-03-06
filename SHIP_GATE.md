# Ship Gate

> No repo is "done" until every applicable line is checked.
> Copy this into your repo root. Check items off per-release.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline) (2026-03-06)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required) (2026-03-06)
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output (2026-03-06)
- [x] `[all]` No telemetry by default — state it explicitly even if obvious (2026-03-06)

### Default safety posture

- [x] `[cli|mcp|desktop]` Dangerous actions (kill, delete, restart) require explicit `--allow-*` flag (2026-03-06) runtime-effects uses denyLabelRegex + data-aiui-safe override
- [x] `[cli|mcp|desktop]` File operations constrained to known directories (2026-03-06) output limited to ai-ui-output/
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[mcp]` SKIP: not an MCP server

## B. Error Handling

- [x] `[all]` Errors follow the Structured Error Shape: `code`, `message`, `hint`, `cause?`, `retryable?` (2026-03-06) fail(code, message, hint) in config.mjs
- [x] `[cli]` Exit codes: 0 ok · 1 user error · 2 runtime error · 3 partial success (2026-03-06)
- [x] `[cli]` No raw stack traces without `--debug` (2026-03-06) errors go through fail() which prints code+message+hint only
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[desktop]` SKIP: not a desktop app
- [ ] `[vscode]` SKIP: not a VS Code extension

## C. Operator Docs

- [x] `[all]` README is current: what it does, install, usage, supported platforms + runtime versions (2026-03-06)
- [x] `[all]` CHANGELOG.md (Keep a Changelog format) (2026-03-06)
- [x] `[all]` LICENSE file present and repo states support status (2026-03-06) MIT
- [x] `[cli]` `--help` output accurate for all commands and flags (2026-03-06) 20 commands, 30+ flags
- [x] `[cli|mcp|desktop]` Logging levels defined: silent / normal / verbose / debug — secrets redacted at all levels (2026-03-06) --verbose flag for detailed output, default is summary
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[complex]` SKIP: not complex enough for a handbook — single CLI with --help

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists (test + build + smoke in one command) (2026-03-06) npm test runs 772 tests
- [ ] `[all]` SKIP: Version in manifest matches git tag — no published artifact, private repo
- [ ] `[all]` SKIP: Dependency scanning runs in CI — no CI workflows yet (private tool)
- [ ] `[all]` SKIP: Automated dependency update mechanism — private tool, manual updates
- [ ] `[npm]` SKIP: private: true, not published to npm
- [x] `[npm]` `engines.node` set (2026-03-06)
- [ ] `[npm]` SKIP: Lockfile committed — package-lock.json in .gitignore by design (astro starter)
- [ ] `[vsix]` SKIP: not a VS Code extension
- [ ] `[desktop]` SKIP: not a desktop app

## E. Identity (soft gate — does not block ship)

- [x] `[all]` Logo in README header (2026-03-06)
- [x] `[all]` Translations (polyglot-mcp, 7 languages: ja zh es fr hi it pt) (2026-03-06)
- [x] `[org]` Landing page (@mcptoolshop/site-theme) (2026-03-06)
- [x] `[all]` GitHub repo metadata: description, homepage, topics (2026-03-06)

---

## Gate Rules

**Hard gate (A–D):** Must pass before any version is tagged or published.
If a section doesn't apply, mark `SKIP:` with justification — don't leave it unchecked.

**Soft gate (E):** Should be done. Product ships without it, but isn't "whole."

**Checking off:**
```
- [x] `[all]` SECURITY.md exists (2026-02-27)
```

**Skipping:**
```
- [ ] `[pypi]` SKIP: not a Python project
```
