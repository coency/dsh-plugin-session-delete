/**
 * Shared Session-deletion core for the `dsh-session-delete` plugin.
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
 * @module dsh-session-delete/core
 */

import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'

/**
 * Resolve the harness home from the environment, as
 * `@deepseek-ai/dsh-home-paths` does when nothing is configured explicitly.
 * @returns the absolute harness home.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve the harness home the way this host actually uses it. The boot layer
 * provides `dshHomePath` (which honours an explicitly configured home, unlike
 * the environment variable alone), so that service wins when present.
 * @param ctx - host context.
 * @returns the home plus which source answered.
 */
export function harnessHome(ctx) {
  try {
    const provided = ctx?.get?.('dshHomePath')
    if (typeof provided === 'string' && provided.trim().length > 0) {
      return { home: resolve(provided.trim()), source: 'ctx.dshHomePath' }
    }
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { home: resolve(fromEnv.trim()), source: 'DSH_HOME' }
  }
  return { home: join(homedir(), '.dsh'), source: '~/.dsh' }
}

/** Whether a path exists. */
export async function pathExists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

/** An error the wire and the tool face can branch on without reading prose. */
export function codedError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
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
  if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9_-]+$/.test(id)) {
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
 * @param sessionsRoot - the harness `sessions` directory.
 * @param id - the Session id.
 * @returns absolute session directories that exist.
 */
export async function sessionDirsOf(sessionsRoot, id) {
  const found = []
  assertSessionId(id)
  const root = resolve(sessionsRoot)
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, id)
    if (!isInside(root, candidate)) continue
    if (await pathExists(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Recursive byte total, per top-level path.
 *
 * Unreadable entries are counted as zero but reported, because a locked file or
 * an unreadable directory must not turn into a confident "0 bytes freed" claim.
 * @param paths - top-level paths to measure.
 * @returns the total, the number of unreadable entries, and the per-path totals.
 */
export async function totalBytes(paths) {
  let bytes = 0
  let unreadable = 0
  const byPath = []

  const visit = async (candidate) => {
    let info
    try {
      info = await stat(candidate)
    } catch {
      unreadable += 1
      return 0
    }
    if (!info.isDirectory()) {
      bytes += info.size
      return info.size
    }
    let children = []
    try {
      children = await readdir(candidate)
    } catch {
      unreadable += 1
      return 0
    }
    let subtree = 0
    for (const child of children) subtree += await visit(join(candidate, child))
    return subtree
  }

  for (const candidate of paths) {
    const before = bytes
    await visit(candidate)
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
 * @param ctx - host context.
 * @param id - the Session id.
 * @returns the ids of the Workspaces the Session was detached from.
 */
export async function detachFromWorkspaces(ctx, id) {
  const detached = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    try {
      await workspace.detachSession(id)
    } catch {
      /* fall through to the verification below */
    }
    let stillAttached = true
    try {
      stillAttached = workspace.sessionIds.includes(id)
    } catch {
      stillAttached = true
    }
    if (!stillAttached) detached.push(String(workspace.id))
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
  const sessionDirs = await sessionDirsOf(sessionsRoot, sessionId)
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
    wasArchived: registry.archivedSessionIds.includes(sessionId),
    wasPinned: registry.pinnedSessionIds.includes(sessionId)
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
 * Refuses a Session that is live in this host process. The Remote method adds the
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

  // A loaded Session is refused only by calls that would change something: the
  // read-only preview stays available and already reports `plan.live`.
  if (!dryRun && plan.live) {
    throw codedError('session-delete/live', `session "${id}" is live in this host process (open writer); archive it and restart dsh web before deleting`)
  }

  const registry = ctx.workspaceRegistry

  if (dryRun) {
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
      note: plan.unreadable > 0
        ? `dry run: nothing was changed; the byte total is a lower bound (${plan.unreadable} unreadable entr${plan.unreadable === 1 ? 'y' : 'ies'})`
        : 'dry run: nothing was changed'
    }
  }

  if (!plan.layoutKnown) {
    throw codedError(
      'session-delete/layout-unknown',
      `refusing to delete "${id}": neither ${plan.sessionsRoot} nor ${plan.cacheRoot} exists, so the storage root this host uses (home source: ${plan.harnessHomeSource}) is not the one this plugin resolved`
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
    wasArchived: plan.wasArchived,
    wasPinned: plan.wasPinned,
    freedBytes: 0,
    unreadable: plan.unreadable,
    note: ''
  }

  // Registry first: memory and disk move together, and a failure here aborts
  // before any file is touched.
  report.detachedFromWorkspaces = await detachFromWorkspaces(ctx, id)
  if (report.wasArchived) await registry.unarchiveSession(id)
  if (report.wasPinned) await registry.unpinSession(id)

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
      // Claim the removal only once it is observable.
      if (await pathExists(target.path)) {
        report.failedPaths.push({ path: target.path, reason: 'still present after removal' })
        continue
      }
      report.deletedPaths.push(target.path)
      report.freedBytes += sizes.get(target.path) ?? 0
      if (target.path === plan.cacheRecord) report.cacheRecordDeleted = true
    } catch (error) {
      report.failedPaths.push({ path: target.path, reason: String(error?.code ?? error?.message ?? error) })
    }
  }

  for (const dir of plan.sessionDirs) {
    if (await pruneEmptyParent(dir)) report.prunedProjectDirs.push(dirname(dir))
  }

  if (report.deletedPaths.length === 0 && report.failedPaths.length === 0) {
    report.note = 'nothing was found on disk; only registry references, if any, were dropped'
  }
  if (report.unreadable > 0) {
    const bound = `the byte total is a lower bound (${report.unreadable} unreadable entr${report.unreadable === 1 ? 'y' : 'ies'})`
    report.note = report.note === '' ? bound : `${report.note}; ${bound}`
  }

  if (report.failedPaths.length > 0) {
    report.mode = 'partial'
    const detail = report.failedPaths.map((entry) => `${entry.path} (${entry.reason})`).join('; ')
    throw codedError(
      'session-delete/partial',
      `deleted ${report.deletedPaths.length} of ${targets.length} path(s) for "${id}"; these could not be removed: ${detail}. Registry references were already dropped, so retrying is safe.`,
      {
        sessionId: id,
        deletedPaths: report.deletedPaths,
        failedPaths: report.failedPaths,
        registryReferencesDropped: true
      }
    )
  }

  report.mode = report.deletedPaths.length === 0 ? 'ids-only' : 'files-deleted'
  return report
}
