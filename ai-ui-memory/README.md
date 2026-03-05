# AI-UI Memory

These files teach the pipeline what you've already decided.
They are read-only inputs — the pipeline never modifies them.
Commit them to git so your team can review changes in PRs.

## mappings.json

Force a feature to match a specific trigger/surface label.
Useful when the AI matching picks the wrong candidate or scores too low.

```json
{
  "feature-id": {
    "trigger_label": "Exact Label In UI",
    "reason": "Why this mapping was established"
  }
}
```

## decisions.json

Override the composer's placement decision for an orphan feature.
Use when you know exactly where a feature should be surfaced.

```json
{
  "feature-id": {
    "priority": "P1",
    "rule": "hero_cta",
    "route": "/",
    "reason": "Key differentiator, deserves hero placement"
  }
}
```

Rules: nav_menu_available, hero_cta, table_action, overflow_advanced, generic_cta

## exceptions.json

Exclude features from verify calculations.
Use for features that are planned-future, out-of-scope, or intentionally not surfaced.

```json
{
  "feature-id": {
    "reason": "Planned for v2",
    "exclude_from": ["orphan_count", "coverage", "p0"]
  }
}
```

Values for exclude_from: orphan_count, coverage, p0
