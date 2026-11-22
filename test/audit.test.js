/**
 * Tests for the read-only audit and the startup archive sweep.
 *
 * The audit is the only part of this plugin that looks at everything and changes
 * nothing, so the assertions are about what it claims: which Session files no
 * workspace lists, which cache records have lost their files, which markers point
 * at nothing — and that the answer never carries a host path.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { auditStorage, PURGE_BUDGET, purgeStaleMarkers, scanStoredSessions } from '../lib/core.js'

const ASSIGNED = 'session-11111111-1111-1111-1111-111111111111'
const UNASSIGNED = 'session-22222222-2222-2222-2222-222222222222'
const OTHER_PROJECT = 'session-33333333-3333-3333-3333-333333333333'
const CACHE_ONLY = 'session-44444444-4444-4444-4444-444444444444'
const GHOST_ARCHIVED = 'session-55555555-5555-5555-5555-555555555555'
const GHOST_PINNED = 'session-66666666-6666-6666-6666-666666666666'

const LOG = 'log\n'
const CACHE = '{"c":1}'
const PROJECT_A = '--C-Users-test-alpha--'
const PROJECT_B = '--D-work-beta--'

/** Whether a path exists. */
async function exists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Build a harness home with every shape the audit is supposed to tell apart.
 * @returns the paths the assertions need.
 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-audit-'))
  const sessionsRoot = join(home, 'sessions')
  const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')

  for (const [project, id] of [
    [PROJECT_A, ASSIGNED],
    [PROJECT_A, UNASSIGNED],
    [PROJECT_B, OTHER_PROJECT]
  ]) {
    const dir = join(sessionsRoot, project, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), LOG)
  }
  // Junk that must not be reported as a stored Session.
  await writeFile(join(sessionsRoot, PROJECT_A, 'notes.txt'), 'x')
  await mkdir(join(sessionsRoot, PROJECT_A, 'bad.name'), { recursive: true })

  await mkdir(cacheRoot, { recursive: true })
  await writeFile(join(cacheRoot, `${ASSIGNED}.json`), CACHE)
  await writeFile(join(cacheRoot, `${CACHE_ONLY}.json`), CACHE)
  await writeFile(join(cacheRoot, 'not-an-id.txt'), 'x')

  return { home, sessionsRoot, cacheRoot }
}

/**
 * Fake host context: one workspace listing ASSIGNED, a couple of markers pointing
 * at nothing, and ASSIGNED reported as loaded.
 */
function makeContext(home, overrides = {}) {
  const workspace = {
    id: 'ws-alpha',
    sessionIds: [ASSIGNED],
    detachSession: async () => {}
  }
  const registry = {
    archivedSessionIds: [GHOST_ARCHIVED, ASSIGNED],
    pinnedSessionIds: [GHOST_PINNED, UNASSIGNED],
    list: () => [workspace],
    unarchiveSession: async (sessionId) => {
      registry.archivedSessionIds = registry.archivedSessionIds.filter((entry) => entry !== sessionId)
    },
    unpinSession: async (sessionId) => {
      registry.pinnedSessionIds = registry.pinnedSessionIds.filter((entry) => entry !== sessionId)
    }
  }
  Object.assign(registry, overrides.registry)
  const loaded = new Set(overrides.loaded ?? [ASSIGNED])
  return {
    ctx: {
      get(name) {
        if (name === 'dshHomePath') return () => home
        if (name === 'sessions') return { get: (sessionId) => (loaded.has(sessionId) ? { id: sessionId } : undefined) }
        return undefined
      },
      workspaceRegistry: registry,
      logger: { warn: () => {}, info: () => {}, debug: () => {} }
    },
    registry
  }
}

test('scanStoredSessions maps every stored id and ignores junk', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })

  const scan = await scanStoredSessions(paths.sessionsRoot)
  assert.equal(scan.complete, true)
  assert.deepEqual([...scan.byId.keys()].sort(), [ASSIGNED, UNASSIGNED, OTHER_PROJECT].sort())
  assert.deepEqual(scan.byId.get(ASSIGNED), [join(paths.sessionsRoot, PROJECT_A, ASSIGNED)])
  assert.equal(scan.byId.has('bad.name'), false)
  assert.equal(scan.byId.has('notes.txt'), false)
})

test('the audit reconciles files, cache records and registry markers', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home)

  const report = await auditStorage(ctx)
  assert.equal(report.layoutKnown, true)
  assert.equal(report.scanComplete, true)
  assert.equal(report.sessionsOnDisk, 3)
  assert.equal(report.cacheRecords, 2)
  assert.equal(report.workspaceCount, 1)
  assert.equal(report.liveSessions, 1)

  assert.deepEqual(report.unassigned.map((entry) => entry.sessionId).sort(), [UNASSIGNED, OTHER_PROJECT].sort())
  for (const entry of report.unassigned) {
    assert.equal(entry.dirCount, 1)
    assert.equal(entry.bytes, Buffer.byteLength(LOG))
    assert.equal(entry.hasCacheRecord, false)
  }

  assert.deepEqual(report.cacheOnly, [{ sessionId: CACHE_ONLY, bytes: Buffer.byteLength(CACHE) }])
  // B and C have no record; ASSIGNED has both.
  assert.equal(report.filesOnly, 2)

  // A marker is reported only when nothing at all is behind it: ASSIGNED has files,
  // UNASSIGNED has files, and the ghosts have nothing.
  assert.deepEqual(report.archivedWithoutFiles, [GHOST_ARCHIVED])
  assert.deepEqual(report.pinnedWithoutFiles, [GHOST_PINNED])
  assert.equal(report.truncated, false)
  assert.match(report.note, /read-only/)

  // No absolute host path may appear anywhere in the report.
  assert.equal(JSON.stringify(report).includes(paths.home), false)
  assert.equal(JSON.stringify(report).includes(tmpdir()), false)

  // And it really is read-only.
  assert.equal(await exists(join(paths.sessionsRoot, PROJECT_A, ASSIGNED)), true)
  assert.equal(await exists(join(paths.cacheRoot, `${CACHE_ONLY}.json`)), true)
})

test('the audit honours its limit and says when it truncated', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx } = makeContext(paths.home)

  const report = await auditStorage(ctx, { limit: 1 })
  assert.equal(report.unassigned.length, 1)
  assert.equal(report.truncated, true)
  assert.equal(report.sessionsOnDisk, 3)
})

test('an unreadable storage layout is reported instead of guessed at', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-audit-empty-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  const { ctx } = makeContext(home, { loaded: [] })

  const report = await auditStorage(ctx)
  assert.equal(report.layoutKnown, false)
  assert.equal(report.sessionsOnDisk, 0)
  assert.match(report.note, /neither storage root exists/)
})

test('the sweep drops archived and pinned markers with nothing behind them', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  const { ctx, registry } = makeContext(paths.home)

  const purged = await purgeStaleMarkers(ctx, paths.home)
  assert.deepEqual(purged.archived, [GHOST_ARCHIVED])
  assert.deepEqual(purged.pinned, [GHOST_PINNED])
  assert.equal(purged.cacheRecords, 0)
  // ASSIGNED still holds files, so its marker must survive the sweep; UNASSIGNED
  // does too, so its pin must survive as well.
  assert.deepEqual(registry.archivedSessionIds, [ASSIGNED])
  assert.deepEqual(registry.pinnedSessionIds, [UNASSIGNED])
})

test('the sweep removes an orphan cache record instead of keeping its marker', async (t) => {
  const paths = await fixture()
  t.after(async () => { await rm(paths.home, { recursive: true, force: true }) })
  // CACHE_ONLY has a projection-cache record but no stored directory, which is the
  // state a deleted-but-still-held Session can leave behind.
  const { ctx, registry } = makeContext(paths.home, {
    registry: { archivedSessionIds: [CACHE_ONLY, GHOST_ARCHIVED] }
  })

  const purged = await purgeStaleMarkers(ctx, paths.home)
  assert.deepEqual([...purged.archived].sort(), [CACHE_ONLY, GHOST_ARCHIVED].sort())
  assert.equal(purged.cacheRecords, 1)
  assert.equal(await exists(join(paths.cacheRoot, `${CACHE_ONLY}.json`)), false)
  assert.deepEqual(registry.archivedSessionIds, [])
})

test('the sweep works through a set larger than its budget', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-budget-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  // Both roots exist but are empty: every marker therefore points at nothing.
  await mkdir(join(home, 'sessions'), { recursive: true })
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })

  const ids = Array.from({ length: 40 }, (_, index) => `session-bulk-${String(index).padStart(2, '0')}`)
  const registry = {
    archivedSessionIds: [...ids],
    pinnedSessionIds: [],
    list: () => [],
    unarchiveSession: async (sessionId) => {
      registry.archivedSessionIds = registry.archivedSessionIds.filter((entry) => entry !== sessionId)
    },
    unpinSession: async () => {}
  }
  const ctx = {
    get: (name) => (name === 'dshHomePath' ? () => home : undefined),
    workspaceRegistry: registry,
    logger: { warn: () => {}, info: () => {}, debug: () => {} }
  }

  const first = await purgeStaleMarkers(ctx, home)
  assert.equal(first.archived.length, PURGE_BUDGET, 'one run must stop at the budget')
  assert.equal(registry.archivedSessionIds.length, 40 - PURGE_BUDGET)

  // The cursor continues past what the first run examined, so nothing starves.
  const second = await purgeStaleMarkers(ctx, home)
  assert.equal(second.archived.length, 40 - PURGE_BUDGET)
  assert.deepEqual(registry.archivedSessionIds, [])

  const third = await purgeStaleMarkers(ctx, home)
  assert.equal(third.archived.length, 0)
})
