/**
 * Loads the host half outside DSH and exercises the startup probe.
 *
 * `lib/index.js` degrades deliberately when it cannot resolve the DSH protocol or
 * `defineTool`, which is what makes this file testable at all: the module loads,
 * registers both tools through the local schema fallback, and the probe runs off
 * the composition path. The expectations below are therefore about behaviour, not
 * about a working host — the probe must always run, never throw, and name every
 * contract that drifted.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import SessionDelete, { __debug } from '../lib/index.js'

/**
 * Fake host context: a home resolver, a tools registry that records names, and a
 * one-workspace registry. No `typert`, which is the degraded path.
 */
function makeContext(home, registered) {
  return {
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    tools: { register: (definition) => registered.push(definition) },
    workspaceRegistry: {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      list: () => [{ id: 'ws-alpha', sessionIds: [], detachSession: async () => {} }]
    },
    logger: { warn: () => {}, debug: () => {} }
  }
}

/** Let the probe's `setTimeout(…, 0)` callback run. */
async function settle() {
  await new Promise((resolve) => { setTimeout(resolve, 25) })
}

test('the host half loads, registers every tool and runs the startup probe', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-startup-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, 'sessions'), { recursive: true })
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })

  const registered = []
  const service = new SessionDelete(makeContext(home, registered))
  assert.equal(service.name, 'sessionDelete')
  assert.deepEqual(
    registered.map((definition) => definition?.name),
    ['session_delete', 'session_delete_selfcheck', 'session_delete_audit']
  )

  await settle()
  const verdict = __debug.startupCheck
  assert.equal(typeof verdict, 'string')
  // Without the host protocol the probe must name each degraded contract…
  assert.match(verdict, /Remote markers written by "hardcoded"/)
  assert.match(verdict, /strict wire registration "unavailable"/)
  assert.match(verdict, /defineTool not resolvable/)
  // …but the storage layout is present here, so it must not be reported.
  assert.equal(verdict.includes('neither storage root'), false)
})

test('the startup probe reports a moved storage layout', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-startup-empty-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })

  const registered = []
  new SessionDelete(makeContext(home, registered))
  await settle()
  assert.match(__debug.startupCheck, /neither storage root exists/)
})

test('the audit tool executes and renders without touching anything', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-audit-tool-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, 'sessions'), { recursive: true })
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })

  const registered = []
  new SessionDelete(makeContext(home, registered))
  const tool = registered.find((definition) => definition?.name === 'session_delete_audit')
  assert.notEqual(tool, undefined)

  const value = await tool.execute({}, {})
  assert.equal(value.sessionsOnDisk, 0)
  assert.equal(value.layoutKnown, true)
  const rendered = tool.output.render({}, value)
  const text = rendered.map((block) => block.text).join(' ')
  assert.match(text, /0 stored Session/)
  assert.match(text, /read-only/)
})

test('the delete tool refuses to delete the Session that is calling it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sd-self-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  await mkdir(join(home, 'sessions'), { recursive: true })
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })

  const registered = []
  new SessionDelete(makeContext(home, registered))
  const tool = registered.find((definition) => definition?.name === 'session_delete')
  assert.notEqual(tool, undefined)

  // The guard reads `exec.agent.id`; if that field ever disappears the guard goes
  // silent, so pin the behaviour rather than the implementation.
  await assert.rejects(
    tool.execute({ sessionId: 'session-self' }, { agent: { id: 'session-self' } }),
    /refuses to delete the Session running this call/
  )
})
