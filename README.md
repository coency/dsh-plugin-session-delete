# dsh-session-delete

English | [中文](README.zh.md)

Adds the **Session deletion** that DeepSeek Harness (DSH) deliberately does not ship: deleting a stored
Session becomes a first-class capability running **inside the host process** and driven through the
official write chain — not an external script poking at `~/.dsh`.

> DSH ships archiving as the terminal in-app state; cleaning up stored Sessions is documented as
> out-of-band maintenance. This plugin automates that maintenance in the correct order — **registry
> state first (through the domain write chain), stored files second** — which is what prevents the
> "host memory writes the deleted id back into the file" class of corruption.

## Two entry points

| Entry | For | What it does |
|---|---|---|
| **Sidebar menu** | people | Session row `...` → "Delete session…" → confirmation dialog showing the target, the reclaimable size, and an irreversible warning |
| **`session_delete` tool** | agents | Lets the agent delete directly; supports `dryRun` preview and `keepFiles` (unlink references only) |

Both share one deletion core, so they can never drift apart.

## Install

```bash
dsh plugin --profile web add github:coency/dsh-session-delete
```

The package declares `dsh.bundle.patch`, so the plugin manager installs and enables it as a bundle.
Restart `dsh web` afterwards (a `patchReload: live` profile picks it up immediately).

## Usage

**Sidebar**: hover any Session row → `...` → "Delete session…". The dialog asks the host what would be
removed (directories, bytes) and only the **Delete permanently** button performs the deletion.

**Tool**: ask the agent to delete a Session, or call it explicitly:

```jsonc
// preview, changes nothing
{ "sessionId": "session-2d79a3ce-569d-4193-b14b-f718a998f7ee", "dryRun": true }
// unlink registry references but keep the log files
{ "sessionId": "…", "keepFiles": true }
```

**Refused**: the Session running the call (no self-deletion), and any Session still live in the host
process (open writer) — archive it and restart `dsh web` first.

## What deletion does

1. **Registry first**, through the workspace domain write chain (memory and disk move together):
   `Workspace.detachSession(id)` → `workspaceRegistry.unarchiveSession(id)` / `unpinSession(id)`.
2. **Files second**: `$DSH_HOME/sessions/<project>/<id>/` and the projection-cache record
   `$DSH_HOME/storages/session_projcache/sessions/<id>.json`; an emptied project directory is removed too.

**Irreversible. No backup is kept.**

## Compatibility

- Verified on **dsh 0.1.7-rc.2** (Web profile, Node v24.14.1, Windows): both the sidebar dialog and the
  tool deleted real Sessions end to end.
- No DSH peer dependency is declared on purpose: `dsh plugin add` validates declared peers before
  installing, so pinning one would force every future DSH version through a version exemption. If your
  DSH build rejects the install, inspect `dsh plugin --profile web version-exemptions` and follow its
  `allow-version` hint.
- The internals it relies on (Typert Remote marker descriptors, the client-module bundle shape, the
  `connection.rpc.call('/api', …)` transport) can change between DSH versions — re-run a `dryRun` after
  upgrading.

## Uninstall

```bash
dsh plugin --profile web remove dsh-session-delete
```

Nothing is restored: deleted Sessions stay deleted.

## Known limitations

- **No undo, no backup** — deliberately; a backup would make deletion a two-place state problem.
- **Live Sessions cannot be deleted** (the host holds their writer): archive, restart `dsh web`, then delete.
- **Subagent Sessions** use a bare uuid as their directory name (no `session-` prefix); the id check here
  accepts both spellings.
- **Projection-cache references can remain** — e.g. a parent Session's subagent catalog keeps `childId`
  entries (ids only, no Session data).
- **Host plugins are not sandboxed**: this code deletes files under `$DSH_HOME`. That is the whole point,
  and the implementation is short and auditable.

## Development notes (read before editing)

> Local iteration only: build an isolated test profile in a throwaway home so your everyday profile stays
> untouched. This is not an installation method for users.

```bash
export DSH_HOME=/tmp/dsh-test
dsh --profile webtest --from-default-profile web --dump-config   # compose the profile, do not serve
dsh plugin --profile webtest add /path/to/checkout               # install the local checkout
dsh --profile webtest --dump-config | grep session-delete        # confirm the bundle patch row landed
```

DSH caches plugin state in ways that will bite you repeatedly:

1. **Changing a Loader row's `name` does not re-import its module** — change the entry **id** (and use a
   new file name).
2. **`dsh-client-modules` caches "this package is not a client package" permanently**: a package scanned
   before it declared `dsh.client` never produces a browser bundle until a restart.
3. **One client source per package**: two rows resolving to the same `dsh.client`-declaring package fail
   composition outright — that is why this plugin is one package and one row.
4. **`?query` specifiers are unusable**: the loader percent-encodes the `?` into the file name and the
   import fails with `ERR_MODULE_NOT_FOUND`. Bust caches with file names or entry ids.
5. **Client bundles are snapshotted at compose time**: editing `lib/client.js` without changing the entry
   keeps serving the old bundle (unless `pnpm run dev:web` is running).
6. **Never fabricate a Typert contribution from the browser**: a descriptor that disagrees with the host
   contract is rejected with `args fields do not match the descriptor` and is hard to trace. Register the
   wire contract host-side (`ctx.typert.register({face:'host', …})` with `src-json` codecs — no generation,
   no build step).
7. **The browser must use the Connection transport**: `connection.rpc.call('/api', '<ns>/<method>', { args })`.
   A hand-rolled `fetch('/api/…')` is rejected by the trust fence with `401 + plain-text unauthorized`, and
   that plain text makes `response.json()` throw — easily masked as "remote unavailable".

## License

MIT.
