---
title: Configuration
description: Config file reference — docs, probe, feature aliases, goal rules.
sidebar:
  order: 4
---

## Where config lives

AI-UI reads `ai-ui.config.json` from your project root. Every field is optional — sensible defaults are applied.

## Full example

```json
{
  "docs": {
    "globs": ["README.md", "CHANGELOG.md", "docs/*.md"]
  },
  "probe": {
    "baseUrl": "http://localhost:5173",
    "routes": ["/", "/settings", "/dashboard"]
  },
  "featureAliases": {
    "dark-mode-support": ["Theme", "Dark mode", "Light mode"]
  },
  "goalRules": [
    {
      "id": "settings_open",
      "label": "Open Settings",
      "kind": "domEffect",
      "dom": { "textRegex": "Settings" },
      "score": 2
    },
    {
      "id": "prefs_saved",
      "label": "Save Preferences",
      "kind": "storageWrite",
      "storage": { "keyRegex": "^user\\.prefs\\." },
      "score": 5
    }
  ]
}
```

## Config fields

### docs

Controls which files atlas parses for features.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `globs` | `string[]` | `["README.md"]` | Glob patterns for doc files |

Atlas treats every markdown heading as a potential feature. More docs = more features to match against triggers.

### probe

Controls how the browser crawl works.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | `"http://localhost:3000"` | Dev server URL |
| `routes` | `string[]` | `["/"]` | Routes to crawl |

Each route is visited in headless Chromium. Probe records every interactive element it finds — buttons, links, inputs, checkboxes, etc.

**Tip:** Include all top-level routes. Don't include routes that require authentication — probe runs unauthenticated.

### featureAliases

Maps slugified feature names to UI text that might represent them.

```json
{
  "ambient-sound-system-with-42-non-rhythmic-soundscape-tracks": [
    "change", "Audio Settings"
  ]
}
```

When diff can't fuzzy-match a feature name to a trigger, it checks aliases. This is useful when your docs use different language than your UI.

**Key format:** Feature names are slugified (lowercase, hyphens). The key must match the slugified form of a feature from your atlas.

### goalRules

Configurable effect predicates for SPAs where URLs don't change. Goal rules define what "success" looks like when a user interacts with your app.

## Goal rules in depth

### Why goal rules exist

Traditional web apps change the URL when something meaningful happens. SPAs often don't — clicking "Save" writes to localStorage, opening a dialog mutates the DOM, submitting a form fires a POST request. None of these change the URL.

Without goal rules, AI-UI can only detect route-based goals. Goal rules let you define success as observable effects.

### Rule kinds

| Kind | What it matches | Config fields |
|------|----------------|---------------|
| `storageWrite` | localStorage/sessionStorage writes | `storage.keyRegex`, `storage.valueRegex` |
| `fetch` | HTTP requests | `fetch.method[]`, `fetch.urlRegex`, `fetch.status[]` |
| `domEffect` | DOM mutations | `dom.selector`, `dom.textRegex`, `dom.goalId` |
| `composite` | AND of multiple kinds | Combine `storage` + `fetch` + `dom` |

### storageWrite example

Matches when the app writes to localStorage with a key matching the regex:

```json
{
  "id": "audio_change",
  "label": "Change Audio Preference",
  "kind": "storageWrite",
  "storage": { "keyRegex": "^lokey\\.audio\\." },
  "score": 5
}
```

### fetch example

Matches when the app makes a POST request to a URL matching the regex:

```json
{
  "id": "save_profile",
  "label": "Save User Profile",
  "kind": "fetch",
  "fetch": {
    "method": ["POST", "PUT"],
    "urlRegex": "/api/profile"
  },
  "score": 5
}
```

### domEffect example

Matches when a DOM mutation contains text matching the regex:

```json
{
  "id": "settings_open",
  "label": "Open Settings Panel",
  "kind": "domEffect",
  "dom": { "textRegex": "Settings" },
  "score": 2
}
```

You can also use `goalId` to match the `data-aiui-goal` attribute:

```json
{
  "id": "dialog_open",
  "label": "Open Dialog",
  "kind": "domEffect",
  "dom": { "goalId": "settings_dialog" }
}
```

This matches elements with `data-aiui-goal="settings_dialog"` in your HTML.

### composite example

AND logic — all sub-predicates must match:

```json
{
  "id": "settings_saved",
  "label": "Settings Saved",
  "kind": "composite",
  "storage": { "keyRegex": "^app\\.settings\\." },
  "dom": { "textRegex": "saved|updated" },
  "score": 10
}
```

This only fires when both a storage write AND a DOM mutation are observed.

### Scoring

Each rule has a `score` (default: 1). Scores are summed per flow. Higher scores mean more meaningful interactions.

**Scoring guidelines:**
- **1-2:** Low-value actions (opening a menu, hovering)
- **3-5:** Medium-value actions (changing a setting, toggling a feature)
- **5-10:** High-value actions (saving data, completing a flow)

### Unknown vs. not reached

Goal rules require runtime evidence to produce hits. If you haven't run `runtime-effects`, goals remain unevaluated — not "failed," just unknown. The design map shows `(unknown)` suffix for goals without runtime data.

This prevents false positives. No guessing.

## Danger zone

There are no settings in AI-UI that can hurt production, delete data, or publish anything. The entire tool is read-only analysis.

The closest thing to a dangerous setting is `runtime-effects`, which clicks real buttons in a browser. But it respects safety rules:
- Deny patterns skip destructive-looking triggers
- `data-aiui-safe` overrides for known-safe triggers
- `--dry-run` hovers instead of clicking
