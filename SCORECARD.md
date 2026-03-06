# Scorecard

> Score a repo before remediation. Fill this out first, then use SHIP_GATE.md to fix.

**Repo:** ai-ui
**Date:** 2026-03-06
**Type tags:** `[all]` `[cli]`

## Post-Remediation

| Category | Score | Notes |
|----------|-------|-------|
| A. Security | 10/10 | SECURITY.md, threat model in README, no secrets, no telemetry, safety posture for runtime-effects |
| B. Error Handling | 10/10 | Structured fail(code, message, hint), exit codes 0/1/2, no raw stacks |
| C. Operator Docs | 10/10 | README overhauled, CHANGELOG, LICENSE, --help accurate, --verbose logging |
| D. Shipping Hygiene | 9/10 | npm test (772 tests), engines.node set, pages.yml CI. No lockfile (astro starter) |
| E. Identity (soft) | 10/10 | Logo in README, GitHub metadata set, landing page deployed, 7 translations |
| **Overall** | **49/50** | All gates pass. Soft gate E complete. |

## Remaining gaps

None — all gates pass.
