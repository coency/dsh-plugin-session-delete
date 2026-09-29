# Changelog

## Unreleased

- Documentation: Chinese is now the repository's default README (`README.md`); English moved to
  `README.en.md`.
- Documentation: the install section also documents installing from the web UI (Plugins page →
  Add plugin → Install → **Enable now**), and starting `dsh web` afterwards.

## 0.2.0

Upgrade-hardening release.

- **Remote markers now use the protocol's own writer.** `installRemoteMarkers()` calls the
  installed protocol's decorator entry (`Remote(name, context)`) so the stored marker descriptor
  version follows whatever that protocol expects; the version-1 descriptor written by 0.1.0 stays
  as a fallback only. This removes the worst upgrade failure mode: a hardcoded descriptor version
  being rejected while the gateway scans the service (which could have failed every `/api`
  request, not just this plugin's).
- **New read-only tool `session_delete_selfcheck`.** After a DSH upgrade it reports which host
  contracts still match: the marker route, the explicit wire registration, `defineTool`
  resolution, the tools registry, the workspace-registry methods (`detachSession` /
  `unarchiveSession` / `unpinSession`), and the session / projection-cache storage layout — plus
  plugin, DSH, Node, and platform versions and a one-line verdict. It changes nothing.
- `__debug` now exposes `markerSource` and `strictRegistration` for offline verification.
- READMEs document version compatibility, the four possible upgrade outcomes, and the upgrade
  checklist.

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
