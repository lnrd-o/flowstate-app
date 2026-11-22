# Project store (`<project>/.flowstate/`)

Since Phase 7 every project keeps its own settings, session ids, UI state and chat history INSIDE its folder. The registry in
`<userData>/projects.json` is only an index of known folders (id, path) so a project can be moved to another machine (or cloned
from git) and picked up again with everything it had.

```
<project>/.flowstate/
  project.json    shareable (commit it): {version:1, name, agent, mode, model, effort, autoCommit, developerMode|null, createdAt, updatedAt}
  state.json      private: {version:1, sessions:{claude,agy}, lastOpened, lastTurn:{ts,ok,agent}|null, counters:{turns,filesChanged}, ui:{...}, lastRun:RunState|null}
  history.jsonl   private: one HistoryRecord per line (same format and caps as before: 2 MB file, 200 KB per diff, last 500 records returned)
  attachments/    private: pasted / dropped images (<YYYYMMDD-HHMMSS>-<6hex>.<ext>)
  methodologies/  shareable: project-local methodology .json files (listed with source 'project')
  .gitignore      created on first write: state.json, history.jsonl, attachments/
```

## Write path (`src/main/svc/store.js`)

* `projects.onChange` triggers a debounced (500 ms) atomic write (tmp + rename) of `project.json` and `state.json`; `file.saveState`,
  `store:save` and the quit flow flush immediately. A project folder that no longer exists is never recreated by a write.
* `history.js` appends straight to `<project>/.flowstate/history.jsonl`. When the folder is unknown or read-only it falls back to
  `<userData>/history/<id>.jsonl`. An existing userData file is migrated into the folder once (the folder copy wins if both exist).
  `projects:remove` only forgets the userData copy: the folder history stays so re-adding the folder reloads it.
* Sessions: `state.sessions[agent]` is updated whenever `project.sessionId` changes; an agent switch alone never copies a session to
  the other agent.
* Counters and `lastTurn` come from `result` and `file-change` agent events; `lastRun` is `runner.state(projectId)` at write time.

## Read path (auto-load)

`projects.add` (and `store:open-folder`, which picks a folder first) consults a loader for a NEW folder: if `.flowstate/project.json`
exists its valid fields (name, agent, mode, model, effort, autoCommit, developerMode) are merged and `state.json` supplies
`sessions[agent]` (becomes `sessionId`), the UI state and the counters; history is simply picked up from the folder. The returned
project has `loadedFromFolder: true` (never persisted). `store:open-folder` returns `{project, created, loaded:{projectJson,state,history}}`.
Corrupt JSON is renamed `<file>.corrupt-<timestamp>` and ignored; invalid fields are dropped individually.

## Clearing

* `store.clear(id, 'history')` truncates history (folder and any leftover userData copy).
* `store.clear(id, 'all')` removes exactly `<project>/.flowstate`: it must be a real directory (never a symlink or junction) whose
  realpath equals `<realpath(project)>/.flowstate`; links inside it are removed as links (targets are never followed). The registry
  entry stays and pending writes are cancelled so the folder is not recreated.

## UI state

Global UI state: `<userData>/ui-state.json` (shallow merge, <= 16 KB per patch, `null` deletes a key). Per project: `state.json -> ui`
via `ui:project-get/set`.
