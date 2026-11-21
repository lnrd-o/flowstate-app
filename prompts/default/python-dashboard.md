---
id: python-dashboard
name_en: Python dashboard (Streamlit)
name_es: Dashboard en Python (Streamlit)
description_en: Build an interactive Streamlit + Plotly dashboard from a data file.
description_es: Construye un dashboard interactivo con Streamlit y Plotly a partir de un archivo de datos.
tags: python, data, dashboard
var: data_file | text | Data file (CSV, XLSX, JSON) | Archivo de datos (CSV, XLSX, JSON) | | | required
var: question | textarea | What should the dashboard answer? | ¿Qué debe responder el dashboard? | | | required
---

Build an interactive dashboard with Streamlit and Plotly.

Data file: {{data_file}}
Question the dashboard must answer: {{question}}

Requirements:
1. First inspect the data file (columns, types, missing values, row count) with a short pandas script and tell me what you found.
2. Create dashboard.py in the project root. It must read the data file by a path relative to the project, cache loading with st.cache_data, and handle missing or malformed values without crashing.
3. Include: a title and one-line summary, 3 to 5 KPI cards (st.metric), sidebar filters for the most useful columns, and 2 to 4 Plotly charts that directly answer the question. Label axes and units, and use readable colours.
4. Keep dependencies minimal: only streamlit, plotly and pandas (plus openpyxl only if the file is .xlsx). Do not add anything else.
5. Create requirements.txt with exactly the packages used.
6. Verify the script at least by running `python -c "import ast,sys; ast.parse(open('dashboard.py').read())"` and by loading the data with the same code path. Do not leave a server running.
7. Write run instructions to artifacts/dashboard-README.md: how to create a virtual environment, install requirements and run `python -m streamlit run dashboard.py`.

Save any static preview charts (HTML) under artifacts/.
