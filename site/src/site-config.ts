import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'AI-UI',
  description: 'Automated design diagnostics for SPAs — crawl, diff, verify UI against docs.',
  logoBadge: '◎',
  brandName: 'ai-ui',
  repoUrl: 'https://github.com/mcp-tool-shop-org/ai-ui',
  footerText: 'MIT Licensed — built by <a href="https://github.com/mcp-tool-shop-org" style="color:var(--color-muted);text-decoration:underline">mcp-tool-shop-org</a>',

  hero: {
    badge: 'CLI Tool',
    headline: 'AI-UI.',
    headlineAccent: 'Design diagnostics for SPAs.',
    description: 'Crawls your running app, reads your docs, and tells you exactly which features have no discoverable UI — and which UI surfaces aren\'t documented. Deterministic. No LLM required.',
    primaryCta: { href: '#usage', label: 'Get started' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      { label: 'Install', code: 'git clone https://github.com/mcp-tool-shop-org/ai-ui.git\ncd ai-ui && npm install' },
      { label: 'Run', code: 'ai-ui atlas          # parse docs → feature catalog\nai-ui probe          # crawl UI → trigger graph\nai-ui diff           # match features ↔ triggers' },
      { label: 'All-in-one', code: 'ai-ui stage0         # atlas + probe + diff\nai-ui graph          # build trigger graph\nai-ui design-map     # surface inventory + IA proposal' },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'features',
      title: 'How it works',
      subtitle: 'Docs promise features. UI exposes triggers. AI-UI measures the gap.',
      features: [
        {
          title: 'Atlas',
          desc: 'Parses your README, CHANGELOG, and docs into a structured feature catalog. Every claim your docs make becomes a testable assertion.',
        },
        {
          title: 'Probe',
          desc: 'Playwright-powered black-box crawl of your running app. Records every interactive trigger — buttons, links, inputs, dialogs — across all configured routes.',
        },
        {
          title: 'Diff Engine',
          desc: 'Fuzzy-matches documented features against discovered triggers. Produces coverage percentage, burial index, and actionable verdicts: promote, keep, demote, merge.',
        },
        {
          title: 'Design Map',
          desc: 'Generates surface inventory, feature discoverability scores, inferred task flows with loop detection, and a complete IA proposal for your app.',
        },
        {
          title: 'Goal Rules',
          desc: 'Configurable effect predicates for SPAs where URLs don\'t change. Define success as storage writes, DOM mutations, or fetch calls — scored and named.',
        },
        {
          title: 'Replay Packs',
          desc: 'Bundle all artifacts into reproducible snapshots. Diff two packs to see exactly what changed, what improved, and what regressed between runs.',
        },
      ],
    },
    {
      kind: 'code-cards',
      id: 'usage',
      title: 'Usage',
      cards: [
        {
          title: 'Basic pipeline',
          code: `# Parse docs into feature catalog
ai-ui atlas

# Crawl UI and record triggers
ai-ui probe

# Match features to triggers
ai-ui diff

# Build graph and generate design map
ai-ui graph
ai-ui design-map`,
        },
        {
          title: 'Runtime evidence',
          code: `# Click triggers, capture side effects
ai-ui runtime-effects

# Rebuild graph with runtime data
ai-ui graph --with-runtime

# Design map now evaluates goal rules
ai-ui design-map`,
        },
        {
          title: 'CI integration',
          code: `# Run full pipeline + verify
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum \\
  --min-coverage 60

# Exit: 0=pass, 1=user, 2=runtime`,
        },
        {
          title: 'Snapshot & compare',
          code: `# Save a baseline
ai-ui replay-pack

# After changes, pack again
ai-ui replay-pack

# See what changed
ai-ui replay-diff`,
        },
      ],
    },
    {
      kind: 'data-table',
      id: 'commands',
      title: 'Commands',
      columns: ['Command', 'Description'],
      rows: [
        ['`atlas`', 'Parse docs into a feature catalog'],
        ['`probe`', 'Crawl running UI, record every trigger'],
        ['`surfaces`', 'Extract surfaces from WebSketch capture'],
        ['`diff`', 'Match atlas features against probe triggers'],
        ['`graph`', 'Build trigger graph from probe + surfaces + diff'],
        ['`design-map`', 'Surface inventory, feature map, task flows, IA proposal'],
        ['`compose`', 'Generate surfacing plan from diff + graph'],
        ['`verify`', 'Pass/fail verdict for CI pipelines'],
        ['`baseline`', 'Save/compare verification baselines'],
        ['`pr-comment`', 'PR-ready markdown from artifacts'],
        ['`runtime-effects`', 'Click triggers, capture observed side effects'],
        ['`runtime-coverage`', 'Per-trigger coverage matrix'],
        ['`replay-pack`', 'Bundle artifacts into replay snapshot'],
        ['`replay-diff`', 'Compare two replay packs'],
        ['`stage0`', 'Run atlas + probe + diff in sequence'],
        ['`init-memory`', 'Create empty memory files for tracking'],
      ],
    },
  ],
};
