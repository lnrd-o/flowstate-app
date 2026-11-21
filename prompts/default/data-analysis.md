---
id: data-analysis
name_en: Data analysis
name_es: Análisis de datos
description_en: Analyse a data file, answer a question and produce a report with charts.
description_es: Analiza un archivo de datos, responde una pregunta y genera un informe con gráficos.
tags: python, data, report
var: data_file | text | Data file (CSV, XLSX, JSON) | Archivo de datos (CSV, XLSX, JSON) | | | required
var: question | textarea | Question to answer | Pregunta a responder | | | required
---

Analyse the data and answer a question.

Data file: {{data_file}}
Question: {{question}}

Steps:
1. Profile the data with Python (pandas): shape, column types, missing values, duplicates, obvious outliers. Use the project's .venv if it exists; otherwise a plain script is fine. Do not modify the original data file.
2. Clean only what is needed and document each cleaning decision.
3. Do the analysis that answers the question. Support every claim with numbers from the data; state assumptions and limits (sample size, bias, missing data).
4. Create 2 to 5 charts with Plotly and save each as a standalone HTML file in artifacts/ (for example artifacts/chart-1-trend.html) with include_plotlyjs=True so each file also works offline.
5. Write the report to artifacts/report.md: question, short answer first, key findings with numbers, methodology, limitations, and links to the chart HTML files.
6. Save the script you used as artifacts/analysis.py so the work can be repeated.

Keep the report clear enough for a non-technical reader.
