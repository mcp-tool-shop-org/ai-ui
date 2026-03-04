# Spec Generator Contract — Claude / qwen2.5:14b

Paste LLaVA's UI review output in, then append this prompt.

## Prompt

```
You are the design systems + product spec writer.

Given the UI review report, produce:

A) Prioritized plan
- P0/P1/P2 with rationale, max 10 items total.

B) Token changes
- Spacing / type / color roles / radius / shadow.
- Provide exact token edits (e.g., adjust --space-6, add --text-xxl, define --surface-3).
- Keep changes minimal.

C) Component changes
- List components affected and what changes (props, layout rules, states).

D) State matrix
- Empty / loading / error / permission / offline where relevant.

E) Dev tickets
- 5-10 tickets with acceptance criteria (Given/When/Then).
- Include "definition of done" checklist at the end.

Write in a human tone, but be precise. No fluff.
```
