---
id: security-review
name_en: Security review
name_es: Revisión de seguridad
description_en: Look for vulnerabilities and unsafe practices and write a risk report.
description_es: Busca vulnerabilidades y malas prácticas de seguridad y escribe un informe de riesgos.
tags: security, review
var: scope | text | What to review | Qué revisar | the whole project | | required
---

Perform a security review of: {{scope}}

Look for, and verify by reading the code:
1. Injection: shell, SQL, path traversal, template and HTML injection (XSS).
2. Authentication and authorisation flaws, insecure session or token handling.
3. Secrets: keys, passwords or tokens committed in code, config or history (check with a search, never print real secrets in your report; mask them).
4. Unsafe use of the file system, subprocesses, deserialisation, eval or dynamic code loading.
5. Dependencies: outdated or known-vulnerable packages (use the package manager's audit command if available offline-safe; do not install anything new).
6. Insecure defaults: permissive CORS, disabled TLS verification, debug mode, overly broad permissions.

Do NOT modify any source file and do not run anything that changes the system or contacts external services beyond a dependency audit.

Write the report to artifacts/security-review.md: an executive summary, a findings table (severity critical/high/medium/low, location file:line, description, exploit scenario, recommended fix), and a prioritised remediation checklist. Mark anything you could not confirm as "unverified".
