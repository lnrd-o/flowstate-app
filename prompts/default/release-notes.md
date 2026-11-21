---
id: release-notes
name_en: Release notes
name_es: Notas de versión
description_en: Generate release notes from the git history between two refs.
description_es: Genera notas de versión a partir del historial de git entre dos referencias.
tags: git, docs, release
var: from | text | From (tag or commit) | Desde (etiqueta o commit) | | | required
var: to | text | To (tag or commit) | Hasta (etiqueta o commit) | HEAD | |
---

Write release notes for the changes from {{from}} to {{to}}.

Steps:
1. Use `git log {{from}}..{{to}} --no-merges --format="%h %s"` and `git diff --stat {{from}} {{to}}` to see what changed. Read diffs when a commit message is unclear.
2. Group the changes under: Highlights, New features, Improvements, Bug fixes, Breaking changes, Internal. Omit empty groups.
3. Write each item for a user, not a developer: say what changed and why it matters, in one line, and keep the short commit hash in parentheses.
4. Call out breaking changes and any migration steps explicitly.
5. Do not invent changes that are not in the history.

Save the result to artifacts/release-notes.md (create the folder if needed). Do not create tags or commits.
