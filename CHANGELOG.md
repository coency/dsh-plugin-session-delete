# Changelog

## 0.1.0

First release.

- Host half (`lib/index.js`): one `TypertRemoteService` subclass that also registers the model-facing
  `session_delete` tool, so a single Loader row carries both.
  - `session_delete(sessionId, dryRun?, keepFiles?)` — refuses the calling Session and any Session that is
    live in the host process.
  - `sessionDelete/planDelete(sessionId)` and `sessionDelete/deleteSession(sessionId, confirm)` as an
    explicitly registered host-face wire contract (`src-json` codecs; no generated schemas, no build step).
- Shared deletion core (`lib/core.js`): registry references first through the workspace domain write chain
  (`Workspace.detachSession` → `unarchiveSession` / `unpinSession`), stored files second (Session directory,
  projection-cache record, emptied project directory).
- Browser half (`lib/client.js`): a "delete session…" item in the Session row `...` menu plus a confirmation
  dialog, calling the host through `connection.rpc.call('/api', …)`. Hand-written in the module-loader
  bundle format — no bundler involved.
- Bundle manifest (`cordis.patch.yml` + `dsh.bundle.patch`), so `dsh plugin --profile web add <spec>`
  installs and enables it as one bundle.
