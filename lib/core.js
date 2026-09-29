/**
 * Shared Session-deletion core for the `dsh-session-tools` plugin package.
 *
 * Both faces of the package — the agent-facing `session_delete` tool and the
 * browser-facing delete RPC — funnel through {@link runDelete}, so the
 * sanctioned order exists exactly once:
 *
 *   1. registry state through the workspace domain write chain
 *      (`Workspace.detachSession`, `unarchiveSession`, `unpinSession`), which
 *      keeps host memory and disk equal and leaves no stale id behind;
 *   2. stored files (`sessions/<project>/<id>/` and the projection-cache
 *      record) plus the emptied project directory.
 *
 * @module dsh-session-tools/core
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

/**
 * Resolve the harness home exactly as `@deepseek-ai/dsh-home-paths` does for the
 * default deployment: a non-blank `$DSH_HOME`, else `~/.dsh`.
 * @returns the absolute harness home.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
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

/**
 * Session directories for one id. The project segment is the escaped cwd, so the
 * id is located by scanning rather than by re-deriving the escaping rule.
 * @param sessionsRoot - the harness `sessions` directory.
 * @param id - the Session id.
 * @returns absolute session directories that exist.
 */
export async function sessionDirsOf(sessionsRoot, id) {
  const found = []
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, id)
    if (await pathExists(candidate)) found.push(candidate)
  }
  return found
}

/** Recursive byte total of the given paths; unreadable entries count as zero. */
export async function totalBytes(paths) {
  let total = 0
  const visit = async (candidate) => {
    let info
    try {
      info = await stat(candidate)
    } catch {
      return
    }
    if (!info.isDirectory()) {
      total += info.size
      return
    }
    let children = []
    try {
      children = await readdir(candidate)
    } catch {
      return
    }
    for (const child of children) await visit(join(candidate, child))
  }
  for (const candidate of paths) await visit(candidate)
  return total
}

/** Remove a session directory's project parent when the last Session left it. */
export async function pruneEmptyParent(sessionDir) {
  const parent = dirname(sessionDir)
  try {
    if ((await readdir(parent)).length === 0) await rm(parent, { recursive: true, force: true })
  } catch {
    /* a shared or missing project directory stays */
  }
}

/**
 * Drop every registry reference to one Session through the domain write chain.
 * @param ctx - host context.
 * @param id - the Session id.
 * @returns the ids of the Workspaces the Session was detached from.
 */
export async function detachFromWorkspaces(ctx, id) {
  const detached = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    let accounted = false
    try {
      accounted = workspace.sessionIds.includes(id)
    } catch {
      accounted = false
    }
    if (!accounted) continue
    await workspace.detachSession(id)
    detached.push(String(workspace.id))
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
  const home = dshHome()
  const sessionsRoot = join(home, 'sessions')
  const cacheRecord = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  const sessionDirs = await sessionDirsOf(sessionsRoot, id)
  const cacheRecordExists = await pathExists(cacheRecord)
  const files = [...sessionDirs, ...(cacheRecordExists ? [cacheRecord] : [])]
  const registry = ctx.workspaceRegistry
  return {
    sessionId: id,
    harnessHome: home,
    sessionsRoot,
    cacheRecord,
    sessionDirs,
    cacheRecordExists,
    bytes: await totalBytes(files),
    wasArchived: registry.archivedSessionIds.includes(id),
    wasPinned: registry.pinnedSessionIds.includes(id)
  }
}

/**
 * Delete one stored Session. Refuses a Session that is live in this host process;
 * callers add their own caller-identity guard.
 * @param ctx - host context.
 * @param options - target id plus the dryRun / keepFiles switches.
 * @returns the deletion report.
 */
export async function runDelete(ctx, options) {
  const id = String(options.sessionId)
  const dryRun = options.dryRun === true
  const keepFiles = options.keepFiles === true

  const live = ctx.get('sessions')?.get?.(id)
  if (live !== undefined && live !== null) {
    throw new Error(`session "${id}" is live in this host process (open writer); archive it and restart dsh web before deleting`)
  }

  const plan = await planDelete(ctx, id)
  const registry = ctx.workspaceRegistry

  const report = {
    sessionId: id,
    mode: dryRun ? 'dry-run' : plan.sessionDirs.length === 0 && !plan.cacheRecordExists ? 'ids-only' : 'deleted',
    harnessHome: plan.harnessHome,
    sessionDirsFound: plan.sessionDirs,
    deletedPaths: [],
    cacheRecordDeleted: false,
    detachedFromWorkspaces: [],
    wasArchived: plan.wasArchived,
    wasPinned: plan.wasPinned,
    freedBytes: 0,
    note: ''
  }

  if (dryRun) {
    report.freedBytes = plan.bytes
    report.note = 'dry run: nothing was changed'
    return report
  }

  report.detachedFromWorkspaces = await detachFromWorkspaces(ctx, id)
  if (report.wasArchived) await registry.unarchiveSession(id)
  if (report.wasPinned) await registry.unpinSession(id)

  if (keepFiles) {
    report.note = 'keepFiles: registry references were dropped, stored files were left in place'
    return report
  }

  report.freedBytes = plan.bytes
  for (const dir of plan.sessionDirs) {
    await rm(dir, { recursive: true, force: true })
    report.deletedPaths.push(dir)
  }
  if (plan.cacheRecordExists) {
    await rm(plan.cacheRecord, { force: true })
    report.cacheRecordDeleted = true
    report.deletedPaths.push(plan.cacheRecord)
  }
  for (const dir of plan.sessionDirs) await pruneEmptyParent(dir)
  if (report.deletedPaths.length === 0) {
    report.note = 'nothing was found on disk; only registry references, if any, were dropped'
  }
  return report
}
