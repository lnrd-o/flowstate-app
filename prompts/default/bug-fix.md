---
id: bug-fix
name_en: Fix a bug
name_es: Corregir un error
description_en: Reproduce, diagnose and fix a bug with a regression test.
description_es: Reproduce, diagnostica y corrige un error con una prueba de regresión.
tags: debug, fix
var: description | textarea | What goes wrong? | ¿Qué falla? | | | required
var: file | text | File or area (optional) | Archivo o zona (opcional) | |
---

Fix the following bug in this project.

Problem description:
{{description}}

Where to look first (may be empty): {{file}}

Work like this:
1. Reproduce the problem first. Find the exact command, input or test that shows it. If you cannot reproduce it, say so and explain what you tried.
2. Find the root cause by reading the code involved. Explain the cause in two or three sentences before changing anything.
3. Make the smallest change that fixes the root cause. Do not refactor unrelated code.
4. Add or update a regression test that fails without your fix and passes with it. Use the project's existing test framework and style.
5. Run the full test suite and report the result. If something unrelated was already failing, tell me instead of fixing it silently.

At the end, write a short summary of the cause, the fix and the tests to artifacts/bug-fix-notes.md.
