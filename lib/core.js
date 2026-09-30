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
 * Resolve the harness home from the environment, as
 * `@deepseek-ai/dsh-home-paths` does when nothing is configured explicitly.
 * @returns the absolute harness home.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv.trim()))
  return join(homedir(), '.dsh')
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

/** An error the wire and the tool face can branch on without reading prose. */
export function codedError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
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
    if (children.some((child) => child.name === id)) found.push(candidate)
  }
  return { dirs: found, incomplete }
}

/** Deepest level `totalBytes` descends; a deeper tree is reported, never guessed at. */
const MAX_BYTES_DEPTH = 64

/**
 * Recursive byte total, per top-level path.
 *
 * Unreadable entries are counted as zero but reported, because a locked file or
 * an unreadable directory must not turn into a confident "0 bytes freed" claim.
 * `lstat` is used throughout: a junction or symlink is neither followed (which
 * could walk outside the Session and inflate the total) nor counted as a regular
 * file, and recursion is bounded so a link cycle can never hang the dialog.
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
   */
  const visit = async (candidate, depth) => {
    let info
    try {
      info = await lstat(candidate)
    } catch {
      unreadable += 1
      return
    }
    if (info.isSymbolicLink()) {
      // Junctions and symlinks are skipped, not followed and not counted.
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
        children = await readdir(candidate)
      } catch {
        unreadable += 1
        return
      }
      for (const child of children) await visit(join(candidate, child), depth + 1)
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
        reason: String(error?.code ?? error?.message ?? error)
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
 * Drop archived-set references whose Session no longer exists on disk and is no
 * longer loaded in this host. An archived marker is exactly what keeps a deleted
 * but still-loaded Session hidden from the sidebar, so it must survive while the
 * host holds that Session and be removed afterwards.
 *
 * This runs inside a deletion, so it must stay cheap: one directory scan plus one
 * probe per archived id instead of a full `planDelete` (which walks every log
 * file recursively). It is also strictly limited to positive existence evidence:
 * with an unresolvable storage layout, or when a scan could not read a project
 * directory, nothing is unarchived.
 * @param ctx - host context.
 * @param home - the already-resolved harness home, so this cannot probe a
 *   different tree than the plan the caller is acting on.
 * @returns the ids whose stale marker was dropped.
 */
export async function purgeStaleArchives(ctx, home) {
  const registry = ctx.workspaceRegistry
  const purged = []
  const root = typeof home === 'string' && home.length > 0 ? home : harnessHome(ctx).home
  const sessionsRoot = join(root, 'sessions')
  const cacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
  // Never unarchive on negative existence evidence from a root this plugin could
  // not resolve: an empty answer there says nothing about the Session.
  if (!(await pathExists(sessionsRoot)) && !(await pathExists(cacheRoot))) return purged
  for (const id of [...registry.archivedSessionIds]) {
    if (!isSessionId(id)) continue
    const loaded = ctx.get('sessions')?.get?.(id)
    if (loaded !== undefined && loaded !== null) continue
    const dirs = await sessionDirsOf(sessionsRoot, id)
    if (dirs.incomplete) continue
    if (dirs.dirs.length > 0) continue
    if ((await probePath(join(cacheRoot, `${id}.json`))) === 'present') continue
    try {
      await registry.unarchiveSession(id)
      purged.push(id)
    } catch {
      /* leave it for the next run */
    }
  }
  return purged
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
    throw codedError(
      'session-delete/layout-unknown',
      `refusing to delete "${id}": neither ${plan.sessionsRoot} nor ${plan.cacheRoot} exists, so the storage root this host uses (home source: ${plan.harnessHomeSource}) is not the one this plugin resolved`
    )
  }

  if (plan.scanIncomplete && plan.sessionDirs.length === 0) {
    // The scan could not read the root, so "no session dirs found" is not
    // evidence of absence — it is an unknown layout, and the same refusal text
    // applies: a deletion must not run on a view it cannot trust.
    throw codedError(
      'session-delete/layout-unknown',
      `refusing to delete "${id}": the sessions root or a project directory under ${plan.sessionsRoot} could not be read, so this plugin cannot tell whether the Session still has files (home source: ${plan.harnessHomeSource})`
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
  const archivedNow = registry.archivedSessionIds.includes(id)
  const pinnedNow = registry.pinnedSessionIds.includes(id)
  report.wasArchived = archivedNow
  report.wasPinned = pinnedNow
  // An archived Session keeps its marker while the host still holds it in memory:
  // the sidebar hides archived rows by default, so the deleted row disappears at
  // once instead of reappearing as an ungrouped stray. `purgeStaleArchives` drops
  // the marker once the Session is no longer loaded.
  if (archivedNow && !plan.live) await registry.unarchiveSession(id)
  const purgedStaleArchives = await purgeStaleArchives(ctx, plan.harnessHome)
  // Unconditional: `unpinSession` is an idempotent no-op for an id that is not
  // pinned, and a pin that landed after the plan must not be left behind.
  await registry.unpinSession(id)

  if (keepFiles) {
    report.mode = 'registry-only'
    report.note = 'keepFiles: registry references were dropped, stored files were left in place'
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
      report.failedPaths.push({ path: target.path, reason: String(error?.code ?? error?.message ?? error) })
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

  if (report.deletedPaths.length === 0 && report.failedPaths.length === 0) {
    report.note = 'nothing was found on disk; only registry references, if any, were dropped'
  }
  if (report.wasArchived && plan.live) {
    const kept = 'kept archived: the host still holds this Session in memory, so the sidebar keeps it hidden until it unloads'
    report.note = report.note === '' ? kept : `${report.note}; ${kept}`
  }
  if (purgedStaleArchives.length > 0) {
    const dropped = `dropped ${purgedStaleArchives.length} stale archived reference(s)`
    report.note = report.note === '' ? dropped : `${report.note}; ${dropped}`
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
    // The coded details carry counts and reasons, never the absolute host paths
    // the failures were observed at: the browser face must not learn the layout.
    // The human-readable message stays as it was.
    const detail = report.failedPaths.map((entry) => `${entry.path} (${entry.reason})`).join('; ')
    throw codedError(
      'session-delete/partial',
      `deleted ${report.deletedPaths.length} of ${targets.length} path(s) for "${id}"; these could not be removed: ${detail}. Registry references were already dropped, so retrying is safe.`,
      {
        sessionId: id,
        deletedPathCount: report.deletedPaths.length,
        failedPathCount: report.failedPaths.length,
        totalPathCount: targets.length,
        failedReasons: report.failedPaths.map((entry) => entry.reason),
        registryReferencesDropped: true
      }
    )
  }

  report.mode = report.deletedPaths.length === 0 ? 'ids-only' : 'files-deleted'
  return report
}
