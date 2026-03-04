# AI-UI

**Eyes → Brain → Hands**

AI-UI is a repeatable UI workflow where a vision model audits screenshots, a reasoning model converts the audit into a prioritized spec, and a coder model (or human) implements consistent token-driven changes.

AI-UI (Eyes → Brain → Hands) is our UI iteration loop. We render a page, screenshot it, run a vision pass to produce an objective critique, convert that critique into a small set of token/component changes with acceptance criteria, then implement and re-review. It's optimized for Astro pages and design-system-first work: minimal changes, maximum consistency, fast iteration.

## The Pipeline

| Role | Model | Job |
|------|-------|-----|
| **Eyes** | LLaVA-13B | Screenshot review, layout/a11y audit, before/after diffs |
| **Brain** | Claude or qwen2.5:14b | Page plan, component breakdown, prioritized spec |
| **Hands** | qwen2.5-coder or deepseek-coder-v2 | Generate/edit Astro files and components |

## The Loop

1. Build and run the Astro site
2. Screenshot the page
3. Run `llava:13b` with the [UI Review Contract](prompts/ui-review.md)
4. Paste the audit into Claude with the [Spec Generator Contract](prompts/spec-generator.md)
5. Apply token and component edits
6. Screenshot again → repeat

## What's Inside

```
src/
  styles/
    tokens.css              Design tokens (spacing, type, color roles, radii, shadows)
    global.css              Base styles + utility classes
  layouts/
    BaseLayout.astro        Page shell (head, nav, main slot, footer)
  components/
    sections/
      Hero.astro            Kicker + h1 + subtitle + dual CTA + feature card
      FeatureGrid.astro     Section heading + 3-column card grid
      CTA.astro             2-column card with heading + CTA button
  pages/
    index.astro             Composes Hero + FeatureGrid + CTA
prompts/
  ui-review.md              LLaVA-13B prompt contract
  spec-generator.md         Claude/Qwen spec generator prompt contract
```

## Quick Start

```bash
npm install
npm run dev
```

## Design Tokens

All visual decisions live in `src/styles/tokens.css`:

- **Spacing:** 8pt rhythm (4px → 64px)
- **Type scale:** 13px → 36px with responsive clamp headings
- **Color roles:** bg / surface / text / muted / primary / danger / success
- **Dark default** with automatic light mode via `prefers-color-scheme`

Change tokens once, everything updates.

## Principles

- **Tokens first.** Decide spacing, type, and color roles before building components.
- **Composable sections.** Hero, features, CTA — swap like LEGO.
- **Measurable critique.** No "make it pop." Every edit is specific and verifiable.
- **Fast iteration.** The loop is designed to run in minutes, not hours.

---

Built by [MCP Tool Shop](https://mcp-tool-shop.github.io/)
