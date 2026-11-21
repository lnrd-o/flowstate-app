---
id: explain-code
name_en: Explain code
name_es: Explicar código
description_en: Explain how some code works, tailored to the reader's level.
description_es: Explica cómo funciona un código, adaptado al nivel del lector.
tags: learn, docs
var: target | text | What to explain | Qué explicar | | | required
var: audience | select | Audience | Audiencia | intermediate | beginner;intermediate;expert | required
---

Explain how this works: {{target}}

The reader is: {{audience}}. Adjust vocabulary and depth to that level (beginner: avoid jargon and define terms; intermediate: focus on design and flow; expert: focus on trade-offs, edge cases and complexity).

Read the actual code before answering; do not guess. Structure the explanation as:
1. Purpose: what problem it solves, in two sentences.
2. Big picture: the main pieces and how data flows between them. Include a small Mermaid diagram if it helps.
3. Walkthrough: the key functions or steps in execution order, with file:line references.
4. Gotchas: non-obvious behaviour, assumptions and likely pitfalls.
5. Where to start if I want to change it.

Save the explanation to artifacts/explanation.md as well as summarising it here.
