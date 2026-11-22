/**
 * Shared Session-deletion core for the `dsh-plugin-session-delete` plugin.
 *
 * The sidebar's "Delete session…" dialog and the model-facing `session_delete`
 * tool both funnel through here, so the sanctioned order exists exactly once:
 *
 *   1. registry state through the workspace domain write chain
 *      (`Workspace.detachSession`, `unarchiveSession`, `unpinSession`), which
 *      keeps host memory and disk equal and leaves no stale id behind;
 *   2. stored files (`sessions/<project>/<id>/` and the projection-cache
 *      record) plus the emptied project directory.
 *
 * `planDelete` is the read-only preview; `runDelete` performs the deletion.
 *
 * Two rules shape the file:
 *
 *  - **Nothing is claimed that was not verified.** Absolute byte totals are
 *    reported as a lower bound when entries were unreadable, `freedBytes` is
 *    summed only over paths confirmed gone, and a partial failure is reported as
 *    such instead of as a generic error.
 *  - **No path is deleted that this module cannot prove is the intended one.**
 *    Session ids are validated before they become path segments, every candidate
 *    is re-checked for containment, and an emptied project directory is removed
 *    with a non-recursive `rmdir` so a directory that received a sibling Session
 *    in the meantime fails with `ENOTEMPTY` instead of being deleted with it.
 *
 * @module dsh-plugin-session-delete/core
 */

import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, dirname, sep } from 'node:path'

/**
 * Expand the tilde prefixes DSH's own `expandHomePath` supports (`~`, `~/`,
 * `~\`) against the operating-system home. A configured `$DSH_HOME=~/.dsh` is
 * otherwise resolved against the working directory, which would point the whole
 * deletion at the wrong tree.
 * @param candidate - the configured path that may begin with a tilde prefix.
 * @returns the expanded path, or the original value when no prefix is present.
 */
export function expandHomePath(candidate) {
  if (candidate === '~') return homedir()
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) return join(homedir(), candidate.slice(2))
  return candidate
}

/**
 * Resolve the harness home the way this host actually uses it. The boot layer
 * provides `dshHomePath` **as a function** (`ctx.provide('dshHomePath',
 * dshHomePath)`, from `@deepseek-ai/dsh-home-paths`), and calling it with no
 * segment returns the resolved home — which honours an explicitly configured
 * home, unlike the environment variable alone, so that service wins when
 * present.
 * @param ctx - host context.
 * @returns the home plus which source answered.
 */
export function harnessHome(ctx) {
  try {
    const provided = ctx?.get?.('dshHomePath')
    if (typeof provided === 'function') {
      const fromCall = provided()
      if (typeof fromCall === 'string' && fromCall.trim().length > 0) {
        const candidate = resolve(expandHomePath(fromCall.trim()))
        if (isAbsolute(candidate)) return { home: candidate, source: 'ctx.dshHomePath' }
      }
    }
    if (typeof provided === 'string' && provided.trim().length > 0) {
      const candidate = resolve(expandHomePath(provided.trim()))
      if (isAbsolute(candidate)) return { home: candidate, source: 'ctx.dshHomePath' }
    }
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { home: resolve(expandHomePath(fromEnv.trim())), source: 'DSH_HOME' }
  }
  return { home: join(homedir(), '.dsh'), source: '~/.dsh' }
}

/**
 * Tri-state probe of one path. A plain boolean probe silently turns an
 * unreadable path (EACCES/EPERM/EBUSY/EMFILE) into "absent", which is exactly
 * the claim a deletion must never invent: "the file is gone" and "the file
 * exists" are both wrong answers to "I could not look".
 * @param candidate - the path to probe.
 * @param probe - the `lstat`-shaped implementation to use; production callers
 *   never pass it, the verification tests inject the unreadable cases that no
 *   ordinary account can construct (`node:fs/promises` re-exports are live
 *   bindings, so patching the module namespace cannot reach this module).
 * @returns `'absent'` on ENOENT, `'unknown'` on any other error, else `'present'`.
 */
export async function probePath(candidate, probe = lstat) {
  try {
    await probe(candidate)
    return 'present'
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'unknown'
  }
}

/**
 * Whether a path exists. Kept for callers whose decision does not hinge on the
 * difference between "absent" and "unreadable"; every caller that must not
 * confuse the two uses {@link probePath} directly.
 */
export async function pathExists(candidate) {
  return (await probePath(candidate)) === 'present'
}

/** A short machine-readable reason for a failed filesystem or registry call. */
function reasonOf(error) {
  return String(error?.code ?? error?.message ?? error)
}

/** An error the wire and the tool face can branch on without reading prose. */
export function codedError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

/**
 * Build the coded `session-delete/partial` failure for a deletion that removed
 * some paths and could not remove others.
 *
 * Kept apart from the deletion because the contract it enforces is not obvious:
 * both the message and the details cross the wire to the browser, so neither may
 * contain the absolute host paths the failures were observed at. The paths go to
 * the host log; only counts and reason codes travel.
 * @param id - the Session id.
 * @param failedPaths - the `{ path, reason }` entries that could not be removed.
 * @param totalPaths - how many paths the deletion targeted in total.
 * @returns the path-free message plus the coded details.
 */
export function describeRemovalFailures(id, failedPaths, totalPaths) {
  const failed = failedPaths.length
  const removed = totalPaths - failed
  const reasons = [...new Set(failedPaths.map((entry) => String(entry.reason)))]
  const summary = reasons.length === 0 ? 'an unspecified error' : reasons.join(', ')
  return {
    message: `deleted ${removed} of ${totalPaths} path(s) for "${id}"; ${failed} could not be removed (${summary}). Registry references were already dropped, so retrying is safe.`,
    details: {
      deletedPathCount: removed,
      failedPathCount: failed,
      totalPathCount: totalPaths,
      failedReasons: reasons
    }
  }
}

/** The one Session-id rule, shared so a defensive scan cannot drift from validation. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * The shared Session-id predicate: the same charset `assertSessionId` enforces,
 * exposed without throwing for callers that merely filter a list of candidates.
 * @param id - the candidate Session id.
 * @returns whether the value is a well-formed Session id.
 */
export function isSessionId(id) {
  return typeof id === 'string'
    && id.length > 0
    && SESSION_ID_PATTERN.test(id)
    && id !== 'undefined'
    && id !== 'null'
}

/**
 * Validate a Session id before it is ever used as a path segment. DSH uses
 * `session-<uuid>` for ordinary Sessions and a bare uuid for subagent Session
 * directories, so only letters, digits, `_` and `-` are legal — which also makes
 * path traversal (`..`, separators, drive letters) impossible by construction.
 *
 * No type coercion happens here on purpose: `String(undefined)` is `"undefined"`,
 * which would pass this charset. Callers must pass the value through unchanged.
 * @param id - the candidate Session id.
 * @returns the same id once validated.
 */
export function assertSessionId(id) {
  if (typeof id !== 'string' || id.length === 0 || !SESSION_ID_PATTERN.test(id)) {
    throw codedError('session-delete/bad-request', `refusing to act on "${String(id)}": a Session id may only contain letters, digits, "_" and "-"`)
  }
  if (id === 'undefined' || id === 'null') {
    throw codedError('session-delete/bad-request', `refusing to act on "${id}": that is a stringified non-id, not a Session id`)
  }
  return id
}

/**
 * Whether `candidate` resolves to `root` itself or to something inside it.
 *
 * Belt-and-braces only: `assertSessionId` already rejects every character that
 * could escape, so this cannot fire with a validated id. It stays because it is
 * the check that keeps a future weaker id rule from silently becoming a delete
 * outside the harness home.
 * @param root - the directory the path must stay inside.
 * @param candidate - the path about to be used.
 * @returns whether the path is contained.
 */
export function isInside(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base + sep)
}

/**
 * Session directories for one id. The project segment is the escaped cwd, so the
 * id is located by scanning rather than by re-deriving the escaping rule.
 *
 * Only a real directory counts: an entry that merely carries the id as its name —
 * a stray file, or a junction — is not a stored Session, and deleting it as one
 * would both destroy something that is not a Session and make this plugin's view
 * disagree with the audit's ({@link scanStoredSessions} takes dirents only).
 *
 * An unreadable sessions root or project directory is reported as
 * `incomplete` instead of collapsing into "no directories": an empty list that
 * came from a failed `readdir` is negative existence evidence this plugin may
 * not act on.
 * @param sessionsRoot - the harness `sessions` directory.
 * @param id - the Session id.
 * @returns the absolute session directories that exist, plus whether the scan
 *   could not read every directory it needed.
 */
export async function sessionDirsOf(sessionsRoot, id) {
  const found = []
  assertSessionId(id)
  const root = resolve(sessionsRoot)
  let incomplete = false
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return { dirs: found, incomplete: true }
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, id)
    if (!isInside(root, candidate)) continue
    let children = []
    try {
      children = await readdir(join(sessionsRoot, project.name), { withFileTypes: true })
    } catch {
      // The project segment is unreadable, so the id may be there unseen: this
      // scan cannot prove the Session has no files.
      incomplete = true
      continue
    }
    if (children.some((child) => child.name === id && child.isDirectory())) found.push(candidate)
  }
  return { dirs: found, incomplete }
}

/**
 * One pass over the sessions root: which Session ids are stored, and where.
 *
 * {@link sessionDirsOf} answers this for one id by scanning every project
 * directory, which is the right shape when a deletion names one Session. An audit
 * asks it for every id at once, so this walks the tree once — O(projects +
 * entries) instead of O(ids × projects).
 *
 * Directory entries come from the dirents, so a junction or symlink sitting where
 * a Session directory would go is not mistaken for one.
 * @param sessionsRoot - the harness `sessions` directory.
 * @returns the id → absolute directories map, plus the project segments that could
 *   not be read.
 */
export async function scanStoredSessions(sessionsRoot) {
  const byId = new Map()
  const unreadableProjects = []
  const root = resolve(sessionsRoot)
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return { byId, complete: false, unreadableProjects }
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    let children = []
    try {
      children = await readdir(projectDir, { withFileTypes: true })
    } catch {
      unreadableProjects.push(project.name)
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const id = child.name
      if (!isSessionId(id)) continue
      const dir = join(projectDir, id)
      if (!isInside(root, dir)) continue
      const known = byId.get(id)
      if (known === undefined) byId.set(id, [dir])
      else known.push(dir)
    }
  }
  return { byId, complete: unreadableProjects.length === 0, unreadableProjects }
}

/**
 * Read the per-Session projection-cache records, keyed by Session id.
 * @param cacheRoot - the `storages/session_projcache/sessions` directory.
 * @returns the id → record path map, plus whether the directory could be read.
 */
export async function scanCacheRecords(cacheRoot) {
  const byId = new Map()
  let entries = []
  try {
    entries = await readdir(cacheRoot, { withFileTypes: true })
  } catch {
    return { byId, complete: false }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!isSessionId(id)) continue
    byId.set(id, join(cacheRoot, entry.name))
  }
  return { byId, complete: true }
}

/** Deepest level `totalBytes` descends; a deeper tree is reported, never guessed at. */
const MAX_BYTES_DEPTH = 64

/**
 * Recursive byte total, per top-level path.
 *
 * Unreadable entries are counted as zero but reported, because a locked file or
 * an unreadable directory must not turn into a confident "0 bytes freed" claim.
 * `lstat` is used for the measurement itself (a file's size), while link detection
 * comes from the parent's `readdir` dirents — see the note on junctions in
 * {@link totalBytes}'s inner walk. Recursion is bounded so a link cycle cannot hang
 * the dialog.
 * @param paths - top-level paths to measure.
 * @returns the total, the number of unreadable or skipped entries, and the
 *   per-path totals.
 */
export async function totalBytes(paths) {
  let bytes = 0
  let unreadable = 0

  /**
   * @param candidate - the entry to measure.
   * @param depth - how deep this call is, from the top-level path (0).
   * @param linked - whether the parent's directory entry already reported this
   *   entry as a link; see the note on junctions below.
   */
  const visit = async (candidate, depth, linked = false) => {
    if (linked) {
      unreadable += 1
      return
    }
    let info
    try {
      info = await lstat(candidate)
    } catch {
      unreadable += 1
      return
    }
    if (info.isSymbolicLink()) {
      // Symlinks are skipped, not followed and not counted.
      unreadable += 1
      return
    }
    if (info.isDirectory()) {
      if (depth >= MAX_BYTES_DEPTH) {
        unreadable += 1
        return
      }
      let children = []
      try {
        children = await readdir(candidate, { withFileTypes: true })
      } catch {
        unreadable += 1
        return
      }
      // The dirents are what decide, not `lstat`: on Windows a junction is
      // reported by `lstat` as an ordinary directory, so a walk that trusted it
      // would descend into the linked tree and count bytes the deletion will never
      // free (and could follow a link far outside the Session). `readdir`'s
      // `dirent.isSymbolicLink()` does flag junctions.
      for (const child of children) await visit(join(candidate, child.name), depth + 1, child.isSymbolicLink())
      return
    }
    if (!info.isFile()) {
      // A device, FIFO, or socket: nothing this plugin deletes.
      unreadable += 1
      return
    }
    bytes += info.size
  }

  const byPath = []
  for (const candidate of paths) {
    const before = bytes
    await visit(candidate, 0)
    byPath.push({ path: candidate, bytes: bytes - before })
  }
  return { bytes, unreadable, byPath }
}

/**
 * Remove a Session directory's project parent when the last Session left it.
 *
 * Non-recursive on purpose: this is a check-then-act on a directory shared by
 * every Session of that project, so a directory that received a sibling Session
 * after the check must fail with `ENOTEMPTY` rather than be deleted with it.
 * @param sessionDir - the removed Session directory.
 * @returns whether the parent directory was removed.
 */
export async function pruneEmptyParent(sessionDir) {
  const parent = dirname(sessionDir)
  try {
    await rmdir(parent)
    return true
  } catch {
    /* shared, non-empty, or already gone: leave it */
    return false
  }
}

/**
 * Drop every registry reference to one Session through the domain write chain.
 *
 * `detachSession` is called for every Workspace rather than only for those whose
 * `sessionIds` already lists the id: that getter filters by a header index that
 * skips unresolvable cwds, so it can omit an id the durable record still holds —
 * exactly the stale reference this plugin exists to remove. Whether the detach
 * took effect is decided afterwards, from the observable state.
 *
 * A write failure here is fatal on purpose: `runDelete` calls this before it
 * removes anything, so aborting now leaves the Session fully intact instead of
 * deleting files whose registry reference is still durable.
 * @param ctx - host context.
 * @param id - the Session id.
 * @returns the ids of the Workspaces the Session was verifiably detached from.
 * @throws a `session-delete/registry-unavailable` coded error when a Workspace
 *   could not be updated, naming each one and its reason.
 */
export async function detachFromWorkspaces(ctx, id) {
  const detached = []
  const failures = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    let wasAttached = false
    try {
      wasAttached = workspace.sessionIds.includes(id)
    } catch {
      // The getter is filtered evidence, so it can only weaken a claim, never
      // create one: an unreadable list is treated as "do not know".
      wasAttached = false
    }
    try {
      await workspace.detachSession(id)
    } catch (error) {
      failures.push({
        workspaceId: String(workspace.id),
        reason: reasonOf(error)
      })
      continue
    }
    let stillAttached = true
    try {
      stillAttached = workspace.sessionIds.includes(id)
    } catch {
      stillAttached = true
    }
    // A Workspace the id was never in is not evidence of a detach, so it never
    // inflates the count; one the id was in and that the getter still lists is
    // not evidence of success either.
    if (wasAttached && !stillAttached) detached.push(String(workspace.id))
  }
  if (failures.length > 0) {
    const detail = failures.map((failure) => `${failure.workspaceId} (${failure.reason})`).join('; ')
    throw codedError(
      'session-delete/registry-unavailable',
      `refusing to delete "${id}": its registry reference could not be dropped in ${failures.length} Workspace(s) — ${detail}. No file was removed, so the Session is untouched; fix the Workspace state and retry.`,
      { sessionId: id, failures }
    )
  }
  return detached
}

/**
 * Inspect one Session's deletion surface without changing anything.
 * @param ctx - host context.
 * @param id - the Session id.
 * @returns the plan for that Session.
 */
export async function planDelete(ctx, id) {
  const sessionId = assertSessionId(id)
  const { home, source } = harnessHome(ctx)
  const sessionsRoot = join(home, 'sessions')
  const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  const cacheRecord = join(cacheRoot, `${sessionId}.json`)
  if (!isInside(home, cacheRecord)) {
    throw codedError('session-delete/bad-request', `refusing to act on "${sessionId}": its projection-cache path escapes the harness home`)
  }
  const dirs = await sessionDirsOf(sessionsRoot, sessionId)
  const sessionDirs = dirs.dirs
  const cacheRecordExists = await pathExists(cacheRecord)
  const files = [...sessionDirs, ...(cacheRecordExists ? [cacheRecord] : [])]
  const registry = ctx.workspaceRegistry
  const totals = await totalBytes(files)
  const sessionsRootExists = await pathExists(sessionsRoot)
  const cacheRootExists = await pathExists(cacheRoot)
  // A loaded Session cannot be deleted (the host holds its writer), so the plan
  // reports that up front: the dialog can warn before the user confirms instead
  // of failing after they do.
  const loaded = ctx.get('sessions')?.get?.(sessionId)
  return {
    sessionId,
    live: loaded !== undefined && loaded !== null,
    harnessHome: home,
    harnessHomeSource: source,
    sessionsRoot,
    cacheRoot,
    cacheRecord,
    sessionDirs,
    cacheRecordExists,
    bytes: totals.bytes,
    unreadable: totals.unreadable,
    byPath: totals.byPath,
    // Neither tree on disk: the storage root this build uses is not the one this
    // plugin resolved, so a deletion must refuse instead of reporting ids-only.
    layoutKnown: sessionsRootExists || cacheRootExists,
    // The scan could not read every project directory, so "no session dirs" is
    // not proof that none exist.
    scanIncomplete: dirs.incomplete,
    wasArchived: registry.archivedSessionIds.includes(sessionId),
    wasPinned: registry.pinnedSessionIds.includes(sessionId)
  }
}

/**
 * How many filesystem probes one sweep may spend.
 *
 * The archived and pinned sets are cleaned opportunistically — inside a deletion
 * and once shortly after startup — so a large set must not turn either into a full
 * scan over every project directory. A rotating cursor (below) keeps the budget
 * from starving the entries behind the first few, which would otherwise never be
 * re-examined.
 */
export const PURGE_BUDGET = 32

/** Where the next sweep starts, so a long set is worked through across runs. */
let purgeCursor = 0

/**
 * Drop archived and pinned markers whose Session no longer exists on disk and is
 * no longer loaded in this host.
 *
 * An archived marker is what keeps a deleted but still-loaded Session hidden from
 * the sidebar, so it must survive while the host holds that Session; a pin left on
 * a Session that no longer exists is simply a dangling reference.
 *
 * It runs inside a deletion and once shortly after startup, so it must stay cheap:
 * loaded ids are filtered from memory before any budget is spent, and only real
 * filesystem probes count against {@link PURGE_BUDGET}. It is also strictly
 * limited to positive existence evidence: with an unresolvable storage layout, or
 * when a scan could not read a project directory, nothing is unarchived.
 * @param ctx - host context.
 * @param home - the already-resolved harness home, so this cannot probe a
 *   different tree than the plan the caller is acting on.
 * @returns the ids whose marker was dropped, split by which set held them.
 */
export async function purgeStaleMarkers(ctx, home) {
  const registry = ctx.workspaceRegistry
  const purged = { archived: [], pinned: [] }
  const root = typeof home === 'string' && home.length > 0 ? home : harnessHome(ctx).home
  const sessionsRoot = join(root, 'sessions')
  const cacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
  // Never unarchive on negative existence evidence from a root this plugin could
  // not resolve: an empty answer there says nothing about the Session.
  if (!(await pathExists(sessionsRoot)) && !(await pathExists(cacheRoot))) return purged

  /**
   * @param id - the candidate marker.
   * @returns whether the host currently holds that Session.
   */
  const isLoaded = (id) => {
    try {
      const value = ctx.get('sessions')?.get?.(id)
      return value !== undefined && value !== null
    } catch {
      return true
    }
  }

  /**
   * Work through one marker set, starting where the last sweep stopped.
   * @param ids - the set's ids, already snapshot.
   * @param kind - which bucket of `purged` a hit lands in.
   * @param drop - the registry call that removes that marker.
   */
  const sweep = async (ids, kind, drop) => {
    const total = ids.length
    if (total === 0) return
    const start = purgeCursor % total
    let examined = 0
    for (let offset = 0; offset < total; offset += 1) {
      const id = ids[(start + offset) % total]
      // Cheap in-memory filter first: a Session the host still holds cannot be
      // cleaned, so it must not consume the probe budget.
      if (isLoaded(id)) continue
      if (examined >= PURGE_BUDGET) break
      examined += 1
      const dirs = await sessionDirsOf(sessionsRoot, id)
      if (dirs.incomplete) continue
      if (dirs.dirs.length > 0) continue
      if ((await probePath(join(cacheRoot, `${id}.json`))) === 'present') continue
      try {
        await drop(id)
        purged[kind].push(id)
      } catch {
        /* leave it for the next run */
      }
    }
    // Advance past what was examined so the next run starts on the entries this
    // one never reached; a run that reached the end wraps to the beginning.
    purgeCursor = (start + Math.max(examined, 1)) % Math.max(total, 1)
  }

  await sweep([...registry.archivedSessionIds].filter(isSessionId), 'archived', (id) => registry.unarchiveSession(id))
  await sweep([...registry.pinnedSessionIds].filter(isSessionId), 'pinned', (id) => registry.unpinSession(id))
  return purged
}

/**
 * The answer to "what is still lying around?", without changing anything.
 *
 * The plugin's destructive face only works when the caller already knows a Session
 * id. This is the read-only counterpart: it reconciles the three places a Session
 * leaves traces — directories under `sessions/`, per-Session projection-cache
 * records, and the workspace registry — and reports the mismatches.
 *
 * Two claims are deliberately hedged, because the host cannot verify them here:
 * a Workspace's `sessionIds` getter is filtered evidence (it drops ids whose
 * recorded cwd no longer resolves), so "no workspace lists it" is not proof of
 * orphanhood; and an unreadable project directory turns "nothing found" into
 * "could not look", which `scanComplete` reports.
 * @param ctx - host context.
 * @param options - optional `limit` (default 20) on how many entries each list may
 *   carry, and therefore on how many recursive byte counts this performs.
 * @returns the reconciliation report, with ids and sizes only (never host paths).
 */
export async function auditStorage(ctx, options = {}) {
  // A small default keeps the walk bounded: every listed entry costs a recursive
  // byte count, and this is a "what is lying around" glance, not a report.
  const requested = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20
  const limit = Math.min(requested, 200)
  const { home, source } = harnessHome(ctx)
  const sessionsRoot = join(home, 'sessions')
  const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')

  const layoutKnown = (await pathExists(sessionsRoot)) || (await pathExists(cacheRoot))
  const sessions = await scanStoredSessions(sessionsRoot)
  const caches = await scanCacheRecords(cacheRoot)

  const registry = ctx.workspaceRegistry
  const memberIds = new Set()
  let workspaceCount = 0
  let membershipReadable = true
  try {
    for (const workspace of registry?.list?.() ?? []) {
      workspaceCount += 1
      try {
        for (const id of workspace.sessionIds) memberIds.add(String(id))
      } catch {
        membershipReadable = false
      }
    }
  } catch {
    membershipReadable = false
  }

  const archived = new Set((registry?.archivedSessionIds ?? []).map(String))
  const pinned = new Set((registry?.pinnedSessionIds ?? []).map(String))
  const sessionsService = ctx.get('sessions')
  const isLoaded = (id) => {
    try {
      const value = sessionsService?.get?.(id)
      return value !== undefined && value !== null
    } catch {
      return false
    }
  }

  const unassigned = []
  let filesOnly = 0
  let liveSessions = 0
  for (const [id, dirs] of sessions.byId) {
    if (isLoaded(id)) liveSessions += 1
    if (!memberIds.has(id)) unassigned.push({ id, dirs })
    if (!caches.byId.has(id)) filesOnly += 1
  }

  const cacheOnly = []
  for (const [id, record] of caches.byId) {
    if (!sessions.byId.has(id)) cacheOnly.push({ id, record })
  }

  // A marker with nothing behind it is exactly what `purgeStaleMarkers` removes;
  // a loaded Session is excluded because the host will not let go of it yet.
  const behindNothing = (id) => !sessions.byId.has(id) && !caches.byId.has(id) && !isLoaded(id)
  const archivedWithoutFiles = [...archived].filter(behindNothing)
  const pinnedWithoutFiles = [...pinned].filter(behindNothing)

  const truncated = unassigned.length > limit
    || cacheOnly.length > limit
    || archivedWithoutFiles.length > limit
    || pinnedWithoutFiles.length > limit

  const unassignedView = []
  for (const entry of unassigned.slice(0, limit)) {
    const record = caches.byId.get(entry.id)
    const totals = await totalBytes(record === undefined ? entry.dirs : [...entry.dirs, record])
    unassignedView.push({
      sessionId: entry.id,
      dirCount: entry.dirs.length,
      bytes: totals.bytes,
      hasCacheRecord: record !== undefined
    })
  }

  const cacheOnlyView = []
  for (const entry of cacheOnly.slice(0, limit)) {
    const totals = await totalBytes([entry.record])
    cacheOnlyView.push({ sessionId: entry.id, bytes: totals.bytes })
  }

  const notes = ['read-only: nothing was changed']
  if (!layoutKnown) {
    notes.push('neither storage root exists, so the storage root this host uses is not the one this plugin resolved')
  }
  if (!sessions.complete) {
    notes.push('at least one project directory could not be read, so this view may be incomplete')
  }
  if (!membershipReadable) {
    notes.push('a workspace membership list could not be read, so "no workspace lists it" is weaker than usual')
  }
  notes.push('a workspace session list is filtered evidence, so an unassigned id is not proof that nothing owns it')

  return {
    harnessHomeSource: source,
    layoutKnown,
    scanComplete: sessions.complete && caches.complete,
    sessionsOnDisk: sessions.byId.size,
    cacheRecords: caches.byId.size,
    workspaceCount,
    liveSessions,
    unassigned: unassignedView,
    cacheOnly: cacheOnlyView,
    filesOnly,
    archivedWithoutFiles: archivedWithoutFiles.slice(0, limit),
    pinnedWithoutFiles: pinnedWithoutFiles.slice(0, limit),
    truncated,
    note: notes.join('; ')
  }
}

/**
 * Session ids with a mutating deletion in flight. The Host serializes the
 * agent-tool path, but the Remote path and a tool call can still overlap (and two
 * browser tabs certainly can), and both would then run the same plan-then-delete
 * sequence against the same paths.
 */
const IN_FLIGHT = new Set()

/**
 * Delete one stored Session: registry references first, then the stored files.
 * A loaded (live) Session is refused only while it is NOT archived: DSH's archive
 * action stops that Session's work first, so an archived Session stays deletable
 * even though the host still holds it in memory. The Remote method adds the
 * `confirm: true` guard; the tool adds the caller-identity guard.
 *
 * Mutating calls for one id are serialized here. A read-only `dryRun` is not
 * blocked: it changes nothing and is the natural way to inspect a deletion that
 * is running.
 * @param ctx - host context.
 * @param options - the target id plus the dryRun / keepFiles switches.
 * @returns the deletion report.
 */
export async function runDelete(ctx, options) {
  const id = assertSessionId(options.sessionId)
  if (options.dryRun === true) return performDelete(ctx, options, id)
  if (IN_FLIGHT.has(id)) {
    throw codedError('session-delete/in-flight', `session "${id}" is already being deleted by another call; wait for it to finish and retry`)
  }
  IN_FLIGHT.add(id)
  try {
    return await performDelete(ctx, options, id)
  } finally {
    IN_FLIGHT.delete(id)
  }
}

/**
 * The deletion itself, called with the in-flight lock already held.
 * @param ctx - host context.
 * @param options - the target id plus the dryRun / keepFiles switches.
 * @param id - the validated Session id.
 * @returns the deletion report.
 */
async function performDelete(ctx, options, id) {
  const dryRun = options.dryRun === true
  const keepFiles = options.keepFiles === true

  const plan = await planDelete(ctx, id)

  // A loaded Session is refused only by calls that would change something — the
  // read-only preview stays available and already reports `plan.live` — and only
  // while it is unarchived. Archiving stops the Session's work in DSH, so an
  // archived Session is deleted without unloading the host first.
  if (!dryRun && plan.live && !plan.wasArchived) {
    throw codedError('session-delete/live', `session "${id}" is still loaded and not archived; archive it in the UI first (archiving stops its work) and retry`)
  }

  const registry = ctx.workspaceRegistry

  if (dryRun) {
    const notes = ['dry run: nothing was changed']
    if (plan.scanIncomplete) {
      notes.push('the sessions root or a project directory could not be read, so this list of session directories may be incomplete')
    }
    if (plan.unreadable > 0) {
      notes.push(`the byte total is a lower bound (${plan.unreadable} unreadable entr${plan.unreadable === 1 ? 'y' : 'ies'})`)
    }
    if (!plan.layoutKnown) {
      // The read-only preview must be as honest as the deletion: with neither
      // storage root present a real delete would refuse instead of freeing 0 B.
      notes.push('neither storage root exists, so a deletion would be refused as an unknown layout (the host may use a different storage root than the one this plugin resolved)')
    }
    return {
      sessionId: id,
      mode: 'dry-run',
      live: plan.live,
      harnessHome: plan.harnessHome,
      harnessHomeSource: plan.harnessHomeSource,
      sessionDirsFound: plan.sessionDirs,
      deletedPaths: [],
      prunedProjectDirs: [],
      cacheRecordDeleted: false,
      detachedFromWorkspaces: [],
      wasArchived: plan.wasArchived,
      wasPinned: plan.wasPinned,
      freedBytes: plan.bytes,
      unreadable: plan.unreadable,
      scanIncomplete: plan.scanIncomplete,
      layoutKnown: plan.layoutKnown,
      note: notes.join('; ')
    }
  }

  if (!plan.layoutKnown) {
    // The resolved roots are logged, never thrown: this error reaches the browser,
    // which must not learn the host storage layout.
    ctx.logger?.warn?.(
      `dsh-plugin-session-delete: layout unknown for "${id}": neither ${plan.sessionsRoot} nor ${plan.cacheRoot} exists (home ${plan.harnessHome}, source ${plan.harnessHomeSource})`
    )
    throw codedError(
      'session-delete/layout-unknown',
      `refusing to delete "${id}": neither the sessions/ root nor the projection-cache root exists under the resolved home (source: ${plan.harnessHomeSource}), so the storage root this host uses is not the one this plugin resolved`
    )
  }

  if (plan.scanIncomplete && plan.sessionDirs.length === 0) {
    // The scan could not read the root, so "no session dirs found" is not
    // evidence of absence — it is an unknown layout, and the same refusal text
    // applies: a deletion must not run on a view it cannot trust.
    throw codedError(
      'session-delete/layout-unknown',
      `refusing to delete "${id}": the sessions/ root or one of its project directories could not be read, so this plugin cannot tell whether the Session still has files (home source: ${plan.harnessHomeSource})`
    )
  }

  const report = {
    sessionId: id,
    mode: 'ids-only',
    harnessHome: plan.harnessHome,
    harnessHomeSource: plan.harnessHomeSource,
    sessionDirsFound: plan.sessionDirs,
    deletedPaths: [],
    prunedProjectDirs: [],
    failedPaths: [],
    cacheRecordDeleted: false,
    detachedFromWorkspaces: [],
    live: plan.live,
    wasArchived: plan.wasArchived,
    wasPinned: plan.wasPinned,
    freedBytes: 0,
    unreadable: plan.unreadable,
    scanIncomplete: plan.scanIncomplete,
    note: ''
  }

  // Registry first: memory and disk move together, and a failure here aborts
  // before any file is touched.
  report.detachedFromWorkspaces = await detachFromWorkspaces(ctx, id)
  // The archived / pinned sets are re-read here instead of trusting the plan: a
  // pin or archive that landed while the user was reading the dialog would
  // otherwise survive the deletion as a reference to a Session with no files.
  report.wasArchived = registry.archivedSessionIds.includes(id)
  report.wasPinned = registry.pinnedSessionIds.includes(id)

  // Past this point the registry writes are follow-ups, not preconditions: the
  // membership reference is already gone, and a pin or marker that cannot be
  // dropped right now is exactly what the sweep cleans up later. Failing the whole
  // call over one of them would leave the files behind while reporting an error —
  // an orphan no UI would ever show.
  /** Follow-ups that failed; reported in `note` instead of thrown. */
  const bookkeeping = []
  try {
    // Unconditional: `unpinSession` is an idempotent no-op for an id that is not
    // pinned, and a pin that landed after the plan must not be left behind.
    await registry.unpinSession(id)
  } catch (error) {
    bookkeeping.push(`the pin could not be dropped (${reasonOf(error)}); the next sweep retries it`)
  }

  // The archive marker is only dropped after the stored files are verified gone;
  // see the clean-run block below the removal loop for why.

  if (keepFiles) {
    // This mode exists to drop references and keep the files, so the marker goes
    // too when nothing else is holding the Session.
    if (report.wasArchived && !plan.live) {
      try {
        await registry.unarchiveSession(id)
      } catch (error) {
        bookkeeping.push(`the archive marker could not be dropped (${reasonOf(error)}); the next sweep retries it`)
      }
    }
    report.mode = 'registry-only'
    report.note = ['keepFiles: stored files were left in place', ...bookkeeping].join('; ')
    return report
  }

  const sizes = new Map(plan.byPath.map((entry) => [entry.path, entry.bytes]))
  const targets = [
    ...plan.sessionDirs.map((path) => ({ path, options: { recursive: true, force: true } })),
    ...(plan.cacheRecordExists ? [{ path: plan.cacheRecord, options: { force: true } }] : [])
  ]

  for (const target of targets) {
    try {
      await rm(target.path, target.options)
    } catch (error) {
      report.failedPaths.push({ path: target.path, reason: reasonOf(error) })
      continue
    }
    // Claim the removal only on verified absence. An unreadable path is neither
    // gone nor present, and a path that survived a successful `rm` was not
    // removed either.
    const state = await probePath(target.path)
    if (state !== 'absent') {
      report.failedPaths.push({
        path: target.path,
        reason: state === 'present' ? 'still present after removal' : 'could not be verified as removed (the path is unreadable)'
      })
      continue
    }
    report.deletedPaths.push(target.path)
    report.freedBytes += sizes.get(target.path) ?? 0
    if (target.path === plan.cacheRecord) report.cacheRecordDeleted = true
  }

  for (const dir of plan.sessionDirs) {
    if (await pruneEmptyParent(dir)) report.prunedProjectDirs.push(dirname(dir))
  }

  // Clean run only. The archive marker is what keeps a deleted-but-still-loaded
  // Session hidden from the sidebar, so dropping it before the files are verified
  // gone would turn a half-deleted Session into a visible, broken row on a partial
  // failure — the one outcome this ordering exists to prevent.
  let swept = { archived: [], pinned: [] }
  let purgeBudgetNote = ''
  if (report.failedPaths.length === 0) {
    if (report.wasArchived && !plan.live) {
      try {
        await registry.unarchiveSession(id)
      } catch (error) {
        bookkeeping.push(`the archive marker could not be dropped (${reasonOf(error)}); the next sweep retries it`)
      }
    }
    const archivedBeforePurge = registry.archivedSessionIds.length
    try {
      swept = await purgeStaleMarkers(ctx, plan.harnessHome)
    } catch (error) {
      bookkeeping.push(`the marker sweep failed (${reasonOf(error)})`)
    }
    if (archivedBeforePurge > PURGE_BUDGET) {
      purgeBudgetNote = `only ${PURGE_BUDGET} of ${archivedBeforePurge} marker(s) were re-examined; the rest are left for the next sweep`
    }
  }

  if (report.deletedPaths.length === 0 && report.failedPaths.length === 0) {
    report.note = 'nothing was found on disk; only registry references, if any, were dropped'
  }
  if (report.wasArchived && plan.live) {
    const kept = 'kept archived: the host still holds this Session in memory, so the sidebar keeps it hidden until it unloads'
    report.note = report.note === '' ? kept : `${report.note}; ${kept}`
  }
  if (swept.archived.length + swept.pinned.length > 0) {
    const dropped = `dropped ${swept.archived.length + swept.pinned.length} stale marker(s) (${swept.archived.length} archived, ${swept.pinned.length} pinned)`
    report.note = report.note === '' ? dropped : `${report.note}; ${dropped}`
  }
  if (bookkeeping.length > 0) {
    const failed = `registry follow-up(s) failed: ${bookkeeping.join('; ')}`
    report.note = report.note === '' ? failed : `${report.note}; ${failed}`
  }
  if (purgeBudgetNote !== '') {
    report.note = report.note === '' ? purgeBudgetNote : `${report.note}; ${purgeBudgetNote}`
  }
  if (report.unreadable > 0) {
    const bound = `the byte total is a lower bound (${report.unreadable} unreadable entr${report.unreadable === 1 ? 'y' : 'ies'})`
    report.note = report.note === '' ? bound : `${report.note}; ${bound}`
  }
  if (report.scanIncomplete) {
    const partial = 'the session-directory scan could not read every project directory, so the freed total covers only what was found'
    report.note = report.note === '' ? partial : `${report.note}; ${partial}`
  }

  if (report.failedPaths.length > 0) {
    // The absolute host paths stay in the host log. Both the message and the coded
    // details cross the wire to the browser, so only counts and reason codes travel.
    ctx.logger?.warn?.(
      `dsh-plugin-session-delete: partial removal for "${id}": ${report.failedPaths.map((entry) => `${entry.path} (${entry.reason})`).join('; ')}`
    )
    const failure = describeRemovalFailures(id, report.failedPaths, targets.length)
    throw codedError('session-delete/partial', failure.message, {
      sessionId: id,
      ...failure.details,
      registryReferencesDropped: true,
      registryFollowUpsFailed: bookkeeping.length
    })
  }

  report.mode = report.deletedPaths.length === 0 ? 'ids-only' : 'files-deleted'
  return report
}
