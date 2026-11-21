---
id: write-tests
name_en: Write tests
name_es: Escribir pruebas
description_en: Add meaningful automated tests for a module or feature.
description_es: Añade pruebas automáticas significativas para un módulo o función.
tags: testing, quality
var: target | text | What to test | Qué probar | | | required
var: framework | text | Test framework | Framework de pruebas | auto-detect from the project | |
---

Write automated tests for: {{target}}

Framework: {{framework}} (if it says auto-detect, inspect the project's config and existing tests and follow the same framework, folder layout and naming style; do not add a new framework unless there is none).

Steps:
1. Read the code under test and list its behaviours: normal cases, edge cases (empty, large, invalid input), and error paths.
2. Write tests that check behaviour, not implementation details. Each test needs a clear name that says what is expected.
3. Use temporary directories and fakes for file system, network and time; tests must not touch real user data or the network.
4. Run the new tests and the full suite. All must pass. If a test reveals a real bug, do not hide it: report it and mark the test clearly.
5. Report coverage gaps you could not cover and why.

Write a short summary (tests added, how to run them, gaps) to artifacts/test-report.md.
