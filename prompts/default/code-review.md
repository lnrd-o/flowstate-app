---
id: code-review
name_en: Code review
name_es: Revisión de código
description_en: Review code for bugs, risks and readability and write a prioritised report.
description_es: Revisa código en busca de errores, riesgos y legibilidad y escribe un informe priorizado.
tags: review, quality
var: scope | text | What to review | Qué revisar | uncommitted changes | | required
---

Do a careful code review of: {{scope}}

If the scope is "uncommitted changes", use `git diff` and `git status` to find them. Otherwise review the files or folders named.

Check, in this order:
1. Correctness: logic errors, off-by-one, unhandled errors, race conditions, wrong assumptions about input.
2. Security: injection, unsafe file or shell use, secrets in code, missing validation.
3. Tests: what is untested or poorly tested.
4. Maintainability: naming, duplication, overly complex functions, dead code.

Do NOT modify any source file. Write the report to artifacts/code-review.md with:
- A one-paragraph overall assessment.
- A table of findings with columns: severity (high, medium, low), file:line, problem, suggested fix.
- A short list of what is done well.

Only report issues you verified by reading the code; mark anything uncertain as "to verify".
