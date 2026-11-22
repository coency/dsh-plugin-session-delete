/**
 * Unit tests for the safety-critical predicates in `lib/core.js`.
 *
 * These are the rules a deletion rests on, and they are pure enough to pin down
 * without a host: the Session-id charset (which is what makes path traversal
 * impossible), the containment fallback, the tilde expansion, the tri-state path
 * probe, and the promise that a coded failure never carries a host path.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  assertSessionId,
  describeRemovalFailures,
  expandHomePath,
  isInside,
  isSessionId,
  probePath,
  totalBytes
} from '../lib/core.js'

const GOOD_IDS = [
  'session-2d79a3ce-569d-4193-b14b-f718a998f7ee',
  // Subagent Session directories are bare UUIDs.
  'd690b90e-73d6-47d5-b7f0-80c6e79ae11f',
  'session-ok_INT-1'
]

const BAD_IDS = [
  '',
  '..',
  '../escape',
  '..\\escape',
  'a/b',
  'a\\b',
  'C:',
  '.',
  'a b',
  'a.b',
  'session-\u0000',
  // A stringified non-id must never be treated as one.
  'undefined',
  'null'
]

test('accepts both Session id spellings', () => {
  for (const id of GOOD_IDS) {
    assert.equal(assertSessionId(id), id)
    assert.equal(isSessionId(id), true)
  }
})

test('rejects anything that cannot be a safe path segment', () => {
  for (const id of BAD_IDS) {
    assert.throws(() => assertSessionId(id), (error) => {
      assert.equal(error.code, 'session-delete/bad-request')
      return true
    }, `expected "${id}" to be refused`)
    assert.equal(isSessionId(id), false)
  }
})

test('rejects non-string ids without coercing them', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.throws(() => assertSessionId(value), (error) => error.code === 'session-delete/bad-request')
    assert.equal(isSessionId(value), false)
  }
})

test('isInside keeps look-alike siblings out', () => {
  assert.equal(isInside('/home/u/.dsh', '/home/u/.dsh'), true)
  assert.equal(isInside('/home/u/.dsh', '/home/u/.dsh/sessions/x'), true)
  assert.equal(isInside('/home/u/.dsh', '/home/u/.dsh2/x'), false)
  assert.equal(isInside('/home/u/.dsh', '/home/u/.dsh/../evil'), false)
})

test('expandHomePath expands only the tilde prefixes DSH supports', () => {
  const home = expandHomePath('~')
  assert.equal(expandHomePath('~/a'), join(home, 'a'))
  assert.equal(expandHomePath('~\\a'), join(home, 'a'))
  // A tilde that is not a prefix is a literal path character.
  assert.equal(expandHomePath('/tmp/~x'), '/tmp/~x')
  assert.equal(expandHomePath('~other/a'), '~other/a')
})

test('probePath separates "absent" from "could not look"', async () => {
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  assert.equal(await probePath('x', async () => { throw missing }), 'absent')
  assert.equal(await probePath('x', async () => { throw denied }), 'unknown')
  assert.equal(await probePath('x', async () => ({ size: 1 })), 'present')
})

test('describeRemovalFailures keeps host paths out of the wire payload', () => {
  const secret = join('C:\\', 'Users', 'someone', '.dsh', 'sessions', '--proj--', 'session-x')
  const failure = describeRemovalFailures('session-x', [
    { path: secret, reason: 'EBUSY', kind: 'session-dir' },
    { path: `${secret}.json`, reason: 'EPERM', kind: 'cache-record' }
  ], 3)

  assert.equal(failure.message.includes(secret), false)
  assert.equal(failure.message.includes('.dsh'), false)
  assert.equal(failure.message.includes('EBUSY'), true)
  assert.equal(failure.message.includes('EPERM'), true)
  // What travels is the kind of thing left behind, never where it lives.
  assert.equal(failure.message.includes('1 session directory'), true)
  assert.equal(failure.message.includes('1 cache record'), true)
  assert.deepEqual(failure.details.failedKinds, { 'session-dir': 1, 'cache-record': 1 })
  assert.equal(failure.details.deletedPathCount, 1)
  assert.equal(failure.details.failedPathCount, 2)
  assert.equal(failure.details.totalPathCount, 3)
  assert.equal(JSON.stringify(failure.details).includes(secret), false)
})

test('totalBytes counts real bytes and never follows a link out of the tree', async (t) => {
  // The link target lives outside the measured tree, which is the case that
  // matters: a session directory that links to something large elsewhere.
  const root = await mkdtemp(join(tmpdir(), 'dsh-sd-bytes-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-sd-bytes-out-'))
  t.after(async () => {
    // Removing a parent that contains both a junction and its target is not
    // portable (the walk order decides whether the empty junction can be removed),
    // so the link goes first — `rmdir` removes the reparse point only.
    try { await rmdir(join(root, 'session', 'link')) } catch { /* never created */ }
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const inside = join(root, 'session')
  await mkdir(inside, { recursive: true })
  await mkdir(join(outside, 'deep'), { recursive: true })
  await writeFile(join(inside, 'log.jsonl'), 'abcd')
  await writeFile(join(outside, 'deep', 'big.bin'), 'x'.repeat(4096))

  let linked = true
  try {
    await symlink(outside, join(inside, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    // Symlink creation needs a privilege this account may not have; the rest of
    // the assertion still holds without it.
    linked = false
  }

  const totals = await totalBytes([inside])
  assert.equal(totals.bytes, 4, 'the 4 KiB behind the link must not be counted')
  if (linked) {
    assert.equal(totals.unreadable, 1, 'a skipped link is reported, not silently ignored')
  }
})
