---
id: refactor
name_en: Refactor
name_es: Refactorizar
description_en: Restructure code for a goal without changing behaviour, in small verified steps.
description_es: Reestructura código con un objetivo sin cambiar su comportamiento, en pasos pequeños y verificados.
tags: refactor, quality
var: target | text | What to refactor | Qué refactorizar | | | required
var: goal | text | Goal | Objetivo | make it simpler and easier to test | | required
---

Refactor: {{target}}

Goal: {{goal}}

Rules:
1. Behaviour must not change. Before touching anything, run the existing tests and record the result. If there are no tests for this code, write characterisation tests first that pin down the current behaviour.
2. Work in small steps. After each step run the tests; stop and fix if they break.
3. Keep public interfaces stable unless the goal requires changing them; if you change one, update every caller.
4. Do not mix in unrelated fixes or formatting-only changes.
5. Remove code that becomes dead, but only after confirming nothing references it.

When finished, write artifacts/refactor-summary.md listing what changed and why, what you deliberately left alone, and the before/after test results.
