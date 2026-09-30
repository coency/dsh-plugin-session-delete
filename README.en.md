# dsh-plugin-session-delete

[中文](README.md) | English

Adds the **Session deletion** DeepSeek Harness (DSH) does not ship: every Session row's `...` menu gains
a "Delete session" item that permanently removes one stored Session together with its registry references.

> DSH itself only archives; cleaning up stored Sessions is documented as out-of-band maintenance. This
> plugin automates it in the correct order — **registry references first through the official write
> chain, stored files second** — so host memory can never write a deleted id back into the file.

## ⚠️ Read this before deleting

> **Precondition**: set the sidebar's session filter to **"All conversations (show archived)"** — archived
> Sessions are otherwise invisible and cannot be selected for deletion.

**There is one test: does the host hold a running agent for this Session right now?**

| "Delete permanently" | Meaning | What to do |
|---|---|---|
| **clickable** | the host has no agent running for it | click "Delete permanently" — the row disappears immediately |
| **greyed out (disabled)** | the host still holds it (an agent or a background task is running inside) | click **Archive session** first to stop its work, then **Delete session** — the button becomes available |

**Beyond that test, a few rules matter:**

1. **It has nothing to do with how long it ran or has been idle** — only whether an agent is running for it right now.
2. **Archiving ≠ releasing memory**: archiving only **stops its work**; the host keeps it in memory. An archived Session can be deleted, but **the row stays in the sidebar afterwards** (visible in "All conversations (show archived)") — that is only a leftover row in the list; **ignore it**, it disappears after restarting DSH.
3. **Restarting DSH puts every Session back to "no agent running"** — if a batch of Sessions refuses to delete, restart first and delete them then; that is the easiest path.
4. **Grouping does not affect deletion**: a workspace is only a grouping record and **deleting a workspace does not delete Session files** — those Sessions move to "ungrouped", and whether they can be deleted still follows the table above.
5. **Deletion is irreversible and keeps no backup.**

## Install

**Desktop app (DeepSeek Harness)**

Add this in **Settings → Plugins**:

```
github:coency/dsh-plugin-session-delete
```

Then **quit the app completely and start it again** (the host half only loads at startup). After the
restart, every Session row's `...` menu offers "Delete session".

**Web surface / CLI (`dsh plugin`)**

```bash
dsh plugin --profile web add github:coency/dsh-plugin-session-delete
dsh web
```

A `patchReload: live` profile needs nothing else: the sidebar item is available right after the restart.

> The package declares `dsh.bundle.patch`, so the plugin manager installs and enables it as a bundle.
> Add `#v0.2.8` to the URL to pin a version.

## Usage

Hover any Session row in the sidebar → click `...` → pick "Delete session" → the dialog asks the host
what would be removed (directories, bytes) and only the **Delete permanently** button performs it.

**Irreversible. No backup is kept.**

## What deletion does

1. **Registry first** (through the workspace domain write chain, memory and disk moving together): the
   Session is removed from workspace membership, the archived set, and the pinned set;
2. **Files second**: `$DSH_HOME/sessions/<project>/<id>/` and the Session projection-cache record; an
   emptied project directory is removed too.

## Known limitations

- **No undo, no backup** — deliberately; a backup would make deletion a two-place state problem.
- **A live, unarchived Session cannot be deleted**: the host holds its writer → **archive it first** (DSH's archive action stops that Session's work), then delete it — **no restart needed**.
- **An archived Session can be deleted right away**, even while the host still holds it in memory (DSH keeps archived Sessions loaded until the process exits). If a shutdown flush recreates its directory, delete it again — by then it is not loaded.
- **Subagent Sessions** use a bare uuid as their directory name (no `session-` prefix); both spellings are accepted.
- **Host plugins are not sandboxed**: this code deletes files under `$DSH_HOME`. That is the whole point, and the implementation is short and auditable.
- **One Session cannot be deleted concurrently**: if a deletion for the same Session is already running (you clicked while an agent was deleting it, say), the second call reports that it is already being deleted — retry once the first finishes.
- **The legacy whole-unit projection cache is left alone**: the per-record file (`storages/session_projcache/sessions/<id>.json`) is deleted, but the old `storages/session_projcache.json` is not touched. DSH only rebuilds a record from that file when no per-record file exists, and it validates the record's identity, so a rebuilt stale record is not adopted.

## Version compatibility

This plugin depends on DSH **internal contracts**, not on a public plugin API; it is verified on
**dsh 0.1.7-rc.2** (Web profile, Windows). DSH is at release-candidate stage, so if the sidebar item
disappears or a delete reports an error after an upgrade, one of those internal contracts moved — the fix
is usually a few lines, found by reading the new DSH package sources.

No DSH peer dependency is declared on purpose: pinning one would force every future DSH version through a
version exemption and raise the install barrier.

## Uninstall

**Desktop app**: remove this plugin in **Settings → Plugins**, then **quit the app completely and start it again**.

**Web surface / CLI**:

```bash
dsh plugin --profile web remove dsh-plugin-session-delete
```

Restart DSH afterwards, then refresh the browser page:

- The running host process may still hold the **already-loaded plugin module** — deleting its files and
  removing its Loader row is not enough to unload it; only a restart of the process does that (the same
  reason an install needs a restart);
- The bundle the browser already loaded also survives until the page is reloaded, so the sidebar can keep
  the "Delete session" item until then;
- A `patchReload: live` profile usually recomposes the host side right away, but **a restart remains the
  reliable route**.

Nothing is restored: deleted Sessions stay deleted.

## License

MIT.
