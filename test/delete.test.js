/**
 * End-to-end tests for the deletion core against a real throwaway harness home.
 *
 * No production code is stubbed: a temporary `$DSH_HOME` is built on disk and a
 * minimal fake host context (home resolver, workspace registry, session lookup) is
 * passed in, so the tests exercise the same readdir/lstat/rm/rmdir path the plugin
 * uses. What they pin down is the behaviour that matters for a delete: the order
 * of registry vs files, what is claimed as freed, which refusals fire, and that a
 * shared project directory is never taken down with a sibling Session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { planDelete, runDelete } from '../lib/core.js'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_ID = 'session-99999999-8888-7777-6666-555555555555'
const PROJECT_SEGMENT = '--C-Users-test-project--'

const LOG_BODY = 'log line one\nlog line two\n'
const CACHE_BODY = '{"projection":true}'
const SIBLING_BODY = 'sibling log\n'

/** Whether a path exists, regardless of type. */
async function exists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Build a throwaway harness home with one stored Session.
 * @param options - `withSibling` adds a second Session in the same project
 *   directory; `cache: false` omits the projection-cache record.
 * @returns the paths the assertions need.
 */
async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-delete-'))
  const sessionsRoot = join(home, 'sessions')
  const projectDir = join(sessionsRoot, PROJECT_SEGMENT)
  const sessionDir = join(projectDir, SESSION_ID)
  const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  const cacheRecord = join(cacheRoot, `${SESSION_ID}.json`)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), LOG_BODY)

  if (options.withSibling === true) {
    await mkdir(join(projectDir, OTHER_ID), { recursive: true })
    await writeFile(join(projectDir, OTHER_ID, 'session.v4.jsonl.zstd'), SIBLING_BODY)
  }
  if (options.cache === 'directory') {
    // A directory where the cache *record* is expected makes the non-recursive
    // `rm` fail without needing a privilege the test account may not have.
    await mkdir(join(cacheRecord, 'inner'), { recursive: true })
    await writeFile(join(cacheRecord, 'inner', 'x.json'), '{}')
  } else if (options.cache !== false) {
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(cacheRecord, CACHE_BODY)
  }

  return { home, sessionsRoot, projectDir, sessionDir, cacheRoot, cacheRecord }
}

/**
 * Minimal host context: the plugin only needs a home resolver, the workspace
 * registry, the loaded-Session lookup and a logger.
 * @param home - the harness home this context reports.
 * @param options - `sessionIds` seeds the single workspace's membership,
 *   `archived` / `pinned` seed those sets, `loaded` marks ids as held by the host.
 * @returns the context plus the fakes the assertions inspect.
 */
function makeContext(home, options = {}) {
  const workspace = {
    id: 'ws-alpha',
    sessionIds: [...(options.sessionIds ?? [])],
    async detachSession(sessionId) {
      workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== sessionId)
    }
  }
  const registry = {
    archivedSessionIds: [...(options.archived ?? [])],
    pinnedSessionIds: [...(options.pinned ?? [])],
    list: () => [workspace],
    async unarchiveSession(sessionId) {
      registry.archivedSessionIds = registry.archivedSessionIds.filter((entry) => entry !== sessionId)
    },
    async unpinSession(sessionId) {
      registry.pinnedSessionIds = registry.pinnedSessionIds.filter((entry) => entry !== sessionId)
    }
  }
  Object.assign(registry, options.registry)
  if (options.failUnpin === true) {
    registry.unpinSession = async () => {
      throw Object.assign(new Error('registry write failed'), { code: 'EWRITE' })
    }
  }
  const loaded = new Set(options.loaded ?? [])
  const warnings = []
  const sessions = {
    get: (sessionId) => (loaded.has(sessionId) ? { id: sessionId } : undefined)
  }
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'sessions') return sessions
      return undefined
    },
    workspaceRegistry: registry,
    logger: { warn: (line) => warnings.push(String(line)), debug: () => {} }
  }
  return { ctx, registry, workspace, warnings }
}

test('plan reports the directories, the byte total and the layout', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home, { sessionIds: [SESSION_ID] })

  const plan = await planDelete(ctx, SESSION_ID)
  assert.deepEqual(plan.sessionDirs, [paths.sessionDir])
  assert.equal(plan.cacheRecordExists, true)
  assert.equal(plan.bytes, Buffer.byteLength(LOG_BODY) + Buffer.byteLength(CACHE_BODY))
  assert.equal(plan.unreadable, 0)
  assert.equal(plan.layoutKnown, true)
  assert.equal(plan.scanIncomplete, false)
  assert.equal(plan.live, false)
  assert.equal(plan.wasArchived, false)
  assert.equal(plan.wasPinned, false)

  // A plan is read-only by contract.
  assert.equal(await exists(paths.sessionDir), true)
  assert.equal(await exists(paths.cacheRecord), true)
})

test('dry run changes nothing and says so', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry, workspace } = makeContext(paths.home, {
    sessionIds: [SESSION_ID],
    pinned: [SESSION_ID]
  })

  const report = await runDelete(ctx, { sessionId: SESSION_ID, dryRun: true })
  assert.equal(report.mode, 'dry-run')
  assert.equal(report.deletedPaths.length, 0)
  assert.equal(report.detachedFromWorkspaces.length, 0)
  assert.equal(report.freedBytes, Buffer.byteLength(LOG_BODY) + Buffer.byteLength(CACHE_BODY))
  assert.match(report.note, /dry run/)

  assert.equal(await exists(paths.sessionDir), true)
  assert.equal(await exists(paths.cacheRecord), true)
  assert.deepEqual(workspace.sessionIds, [SESSION_ID])
  assert.deepEqual(registry.pinnedSessionIds, [SESSION_ID])
})

test('deletion removes the files, the cache record, the references and the empty parent', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry, workspace } = makeContext(paths.home, {
    sessionIds: [SESSION_ID],
    pinned: [SESSION_ID]
  })

  const report = await runDelete(ctx, { sessionId: SESSION_ID })
  assert.equal(report.mode, 'files-deleted')
  assert.equal(report.sessionDirsFound.length, 1)
  assert.equal(report.deletedPaths.length, 2)
  assert.equal(report.freedBytes, Buffer.byteLength(LOG_BODY) + Buffer.byteLength(CACHE_BODY))
  assert.equal(report.cacheRecordDeleted, true)
  assert.deepEqual(report.detachedFromWorkspaces, ['ws-alpha'])
  assert.deepEqual(report.prunedProjectDirs, [paths.projectDir])

  assert.equal(await exists(paths.sessionDir), false)
  assert.equal(await exists(paths.cacheRecord), false)
  assert.equal(await exists(paths.projectDir), false)
  assert.deepEqual(workspace.sessionIds, [])
  assert.deepEqual(registry.pinnedSessionIds, [])
})

test('keepFiles drops registry references and leaves the bytes in place', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, workspace } = makeContext(paths.home, { sessionIds: [SESSION_ID] })

  const report = await runDelete(ctx, { sessionId: SESSION_ID, keepFiles: true })
  assert.equal(report.mode, 'registry-only')
  assert.equal(report.deletedPaths.length, 0)
  assert.equal(report.freedBytes, 0)
  assert.match(report.note, /keepFiles/)
  assert.deepEqual(workspace.sessionIds, [])
  assert.equal(await exists(paths.sessionDir), true)
  assert.equal(await exists(paths.cacheRecord), true)
})

test('a sibling Session keeps the shared project directory alive', async (t) => {
  const paths = await fixture({ withSibling: true })
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home, { sessionIds: [SESSION_ID] })

  const report = await runDelete(ctx, { sessionId: SESSION_ID })
  assert.deepEqual(report.prunedProjectDirs, [])
  assert.equal(await exists(paths.projectDir), true)
  assert.equal(await exists(join(paths.projectDir, OTHER_ID, 'session.v4.jsonl.zstd')), true)
  assert.equal(await exists(paths.sessionDir), false)
})

test('an unknown storage layout is refused and the refusal leaks no host path', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-empty-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  const { ctx, warnings } = makeContext(home, { sessionIds: [SESSION_ID] })

  await assert.rejects(runDelete(ctx, { sessionId: SESSION_ID }), (error) => {
    assert.equal(error.code, 'session-delete/layout-unknown')
    assert.equal(error.message.includes(home), false)
    assert.equal(error.message.includes(tmpdir()), false)
    return true
  })
  // The operator still gets the resolved roots, in the host log.
  assert.equal(warnings.some((line) => line.includes(home)), true)
})

test('a loaded, unarchived Session is refused', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home, { sessionIds: [SESSION_ID], loaded: [SESSION_ID] })

  await assert.rejects(runDelete(ctx, { sessionId: SESSION_ID }), (error) => error.code === 'session-delete/live')
  assert.equal(await exists(paths.sessionDir), true)
})

test('a loaded but archived Session is deleted and keeps its marker', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry } = makeContext(paths.home, {
    sessionIds: [SESSION_ID],
    loaded: [SESSION_ID],
    archived: [SESSION_ID]
  })

  const report = await runDelete(ctx, { sessionId: SESSION_ID })
  assert.equal(report.wasArchived, true)
  assert.equal(report.live, true)
  assert.equal(await exists(paths.sessionDir), false)
  // The marker is what keeps the deleted row hidden while the host holds it.
  assert.deepEqual(registry.archivedSessionIds, [SESSION_ID])
  assert.match(report.note, /kept archived/)
})

test('an unloaded archived Session loses its marker after a clean deletion', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry } = makeContext(paths.home, {
    sessionIds: [SESSION_ID],
    archived: [SESSION_ID]
  })

  const report = await runDelete(ctx, { sessionId: SESSION_ID })
  assert.equal(report.wasArchived, true)
  assert.equal(await exists(paths.sessionDir), false)
  assert.deepEqual(registry.archivedSessionIds, [])
})

test('two overlapping deletions of one Session are serialized', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home, { sessionIds: [SESSION_ID] })

  const first = runDelete(ctx, { sessionId: SESSION_ID })
  const second = runDelete(ctx, { sessionId: SESSION_ID })
  await assert.rejects(second, (error) => error.code === 'session-delete/in-flight')

  const report = await first
  assert.equal(report.mode, 'files-deleted')
  assert.equal(await exists(paths.sessionDir), false)
})

test('a path-traversal id is refused before anything is touched', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home, { sessionIds: [SESSION_ID] })

  for (const id of ['../escape', '..\\escape', 'a/b', '..']) {
    await assert.rejects(runDelete(ctx, { sessionId: id }), (error) => error.code === 'session-delete/bad-request')
  }
  assert.equal(await exists(paths.sessionDir), true)
})

test('a partial failure keeps the marker, stays retryable and leaks no host path', async (t) => {
  const paths = await fixture({ cache: 'directory' })
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry, workspace, warnings } = makeContext(paths.home, {
    sessionIds: [SESSION_ID],
    archived: [SESSION_ID]
  })

  await assert.rejects(runDelete(ctx, { sessionId: SESSION_ID }), (error) => {
    assert.equal(error.code, 'session-delete/partial')
    // The browser must not learn the storage layout, in the message or the payload.
    assert.equal(error.message.includes(paths.home), false)
    assert.equal(error.message.includes(tmpdir()), false)
    assert.equal(JSON.stringify(error.details).includes(paths.home), false)
    assert.equal(error.details.deletedPathCount, 1)
    assert.equal(error.details.failedPathCount, 1)
    assert.equal(error.details.registryReferencesDropped, true)
    return true
  })

  // Files: the Session's own directory went, the stubborn record stayed.
  assert.equal(await exists(paths.sessionDir), false)
  assert.equal(await exists(paths.cacheRecord), true)
  // Registry references were already dropped, so a retry is safe.
  assert.deepEqual(workspace.sessionIds, [])
  // The marker survives a partial run: a half-deleted Session must stay hidden.
  assert.deepEqual(registry.archivedSessionIds, [SESSION_ID])
  // The operator still gets the offending path, in the host log only.
  assert.equal(warnings.some((line) => line.includes(paths.cacheRecord)), true)
})

test('an entry that only borrows the id as a name is not a Session', async (t) => {
  const paths = await fixture({ cache: false })
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  await rm(paths.sessionDir, { recursive: true, force: true })
  await writeFile(join(paths.projectDir, SESSION_ID), 'stray')

  const { ctx } = makeContext(paths.home, { sessionIds: [SESSION_ID] })
  const plan = await planDelete(ctx, SESSION_ID)
  assert.deepEqual(plan.sessionDirs, [], 'a file must not be counted as a Session directory')
  assert.equal(plan.bytes, 0)

  const report = await runDelete(ctx, { sessionId: SESSION_ID })
  assert.equal(report.mode, 'ids-only')
  // Deleting a name that only looks like a Session must leave that file alone.
  assert.equal(await exists(join(paths.projectDir, SESSION_ID)), true)
})

test('a registry follow-up failure does not turn a completed deletion into an error', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry } = makeContext(paths.home, {
    sessionIds: [SESSION_ID],
    pinned: [SESSION_ID],
    failUnpin: true
  })

  const report = await runDelete(ctx, { sessionId: SESSION_ID })
  assert.equal(report.mode, 'files-deleted')
  assert.match(report.note, /pin could not be dropped/)
  assert.equal(await exists(paths.sessionDir), false)
  // The pin survives for the next sweep instead of failing the whole call.
  assert.deepEqual(registry.pinnedSessionIds, [SESSION_ID])
})
