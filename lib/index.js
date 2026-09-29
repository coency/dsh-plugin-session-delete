/**
 * dsh-session-delete — host half.
 *
 * DeepSeek Harness deliberately ships no Session deletion: archiving is the
 * terminal in-app state, and cleaning stored Sessions is documented out-of-band
 * maintenance. This plugin automates that maintenance from inside the host
 * process, in the sanctioned order — registry state first (through the workspace
 * domain write chain, so host memory and disk stay equal and no stale id can
 * ever be written back), stored files second. `./core.js` owns that order and is
 * shared by both faces below.
 *
 * One module carries the whole host side:
 *
 *  - the model-facing `session_delete` tool, registered into the tools registry;
 *  - the `sessionDelete` Typert Remote service (`planDelete` / `deleteSession`)
 *    that the browser half calls through the Connection transport.
 *
 * Two contract facts shape this file. Plain ESM has no decorator syntax, so the
 * `Remote()` markers are written directly onto the prototype with the protocol's
 * own descriptor key and shape — exactly what the compiler emits for shipped
 * controllers, and what the gateway derives descriptors from in SRC fallback. And
 * because the gateway validates `payload.args` against the resolved descriptor,
 * the wire contract is registered explicitly (`src-json` codecs need no generated
 * zod schema). Method parameters stay positional identifiers: SRC derivation
 * parses the function source and forbids destructuring.
 *
 * @module dsh-session-delete
 */

import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runDelete, planDelete, harnessHome, pathExists } from './core.js'

// ── Typert protocol ─────────────────────────────────────────────────────────

/**
 * Resolve the Typert protocol. A bare specifier goes through the same runtime
 * resolution the host's own plugins use — same module instance, same `Service`
 * class identity — and only falls back to the running installation's copy when
 * that resolution fails.
 * @returns the protocol exports this module needs.
 */
async function loadProtocol() {
  try {
    return await import('@deepseek-ai/dsh-typert-protocol')
  } catch {
    /* fall through to the installation-anchored resolution */
  }
  const anchor = process.argv[1]
  if (anchor) {
    try {
      const require = createRequire(anchor)
      return require(require.resolve('@deepseek-ai/dsh-typert-protocol'))
    } catch {
      /* fall through to the degraded base */
    }
  }
  return {}
}

const protocol = await loadProtocol()
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Cordis service key and wire namespace; the browser calls `/api/sessionDelete/<method>`. */
const SERVICE_KEY = 'sessionDelete'

const Base = typeof protocol.TypertRemoteService === 'function'
  ? protocol.TypertRemoteService
  : class {
    constructor(ctx, serviceKey) {
      this.ctx = ctx
      this.name = serviceKey
    }
  }

/**
 * Build the error the browser receives: a coded `RemoteError` when the protocol
 * is available, a plain error otherwise.
 * @param code - the wire error code the client branches on.
 * @param message - the human-readable reason.
 * @returns the error to throw.
 */
function fail(code, message, details) {
  const payload = details === undefined ? {} : details
  if (typeof protocol.RemoteError === 'function') return new protocol.RemoteError(code, message, payload)
  const error = new Error(message)
  error.code = code
  error.details = payload
  return error
}

/**
 * Validate one wire Session id. Ordinary Sessions are named `session-<uuid>`;
 * subagent Session directories carry a bare uuid, so both spellings pass.
 * @param sessionId - the Remote argument.
 * @returns the validated id.
 */
function sessionIdOf(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw fail('session-delete/bad-request', 'sessionId must be a stored Session id')
  }
  return sessionId
}

// ── wire contract ───────────────────────────────────────────────────────────

/** `src-json` codecs: the wire contract is plain JSON, so no generated schema factory is needed. */
const SRC_JSON = Object.freeze({ mode: 'src-json' })

/** The explicit host-face wire contract, validated before every call. */
const INVOCATIONS = Object.freeze([
  Object.freeze({
    id: 'dsh-session-delete#sessionDelete/planDelete',
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method: 'planDelete',
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([
      Object.freeze({ name: 'sessionId', wire: 'sessionId', source: 'json', codec: SRC_JSON })
    ]),
    result: SRC_JSON
  }),
  Object.freeze({
    id: 'dsh-session-delete#sessionDelete/deleteSession',
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method: 'deleteSession',
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([
      Object.freeze({ name: 'sessionId', wire: 'sessionId', source: 'json', codec: SRC_JSON }),
      Object.freeze({ name: 'confirm', wire: 'confirm', source: 'json', codec: SRC_JSON })
    ]),
    result: SRC_JSON
  })
])

/** Outcome of the explicit host-face wire registration, reported by the self-check. */
let STRICT_REGISTRATION = 'unavailable'

/**
 * Register the host-face contribution. Failure is logged and ignored: the
 * gateway can still derive a descriptor from the prototype markers, and a
 * registration problem must never take the host composition down.
 * @param ctx - owning Cordis context.
 */
function registerInvocations(ctx) {
  try {
    const typert = ctx.typert
    if (typert === undefined || typeof typert.register !== 'function') {
      STRICT_REGISTRATION = 'unavailable'
      return
    }
    typert.register({
      package: 'dsh-session-delete',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: INVOCATIONS
    })
    STRICT_REGISTRATION = 'accepted'
  } catch (error) {
    STRICT_REGISTRATION = 'rejected'
    ctx.logger?.warn?.(`dsh-session-delete: strict invocation registration was rejected, the gateway will derive the descriptor instead: ${String(error?.message ?? error)}`)
  }
}

/** Remote methods this service exports. */
const REMOTE_METHODS = Object.freeze(['planDelete', 'deleteSession'])

/** Which route put the markers on the prototype: `protocol`, `hardcoded`, or `none`. */
let MARKER_SOURCE = 'none'

/**
 * Mark the Remote methods on the prototype.
 *
 * The marker descriptor is the gateway's discovery surface, so its stored
 * `version` must be whatever the installed protocol expects. Calling the
 * protocol's own decorator entry (`Remote(name, context)`) reuses its private
 * `mark()` implementation, which writes the current version; only when that API
 * is missing does this fall back to the documented version-1 descriptor.
 * A descriptor this code cannot write never leaves `MARKER_SOURCE` at `none`,
 * which the self-check reports.
 * @param Class - the service class to mark.
 * @returns whether a marker descriptor is in place.
 */
function installRemoteMarkers(Class) {
  const Remote = protocol.Remote
  if (typeof Remote === 'function') {
    try {
      for (const method of REMOTE_METHODS) {
        const initializers = []
        Remote(undefined, {
          kind: 'method',
          name: method,
          static: false,
          private: false,
          access: {
            has: (target) => method in target,
            get: (target) => target[method]
          },
          addInitializer: (initializer) => {
            initializers.push(initializer)
          }
        })
        for (const initializer of initializers) initializer.call(Object.create(Class.prototype))
      }
      MARKER_SOURCE = 'protocol'
      return true
    } catch {
      MARKER_SOURCE = 'none'
    }
  }
  try {
    Object.defineProperty(Class.prototype, REMOTE_METHOD_DESCRIPTOR, {
      configurable: true,
      value: Object.freeze({
        version: 1,
        methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({
          method,
          invocation: Object.freeze({ kind: 'direct' })
        })))
      })
    })
    MARKER_SOURCE = 'hardcoded'
    return true
  } catch {
    MARKER_SOURCE = 'none'
    return false
  }
}

// ── model-facing tool ───────────────────────────────────────────────────────

/**
 * Resolve the real `defineTool` from the running dsh installation synchronously,
 * so registration stays synchronous. `require(esm)` needs Node >= 22.12; without
 * it the local DSL conversion below is used, and if neither works the tool is
 * simply not registered — plugin loading never throws.
 * @returns the `defineTool` implementation, or null.
 */
function loadDefineTool() {
  const anchor = process.argv[1]
  if (anchor) {
    try {
      const require = createRequire(anchor)
      const resolved = require.resolve('@deepseek-ai/dsh-tools')
      const mod = require(resolved)
      if (typeof mod?.defineTool === 'function') return mod.defineTool
    } catch {
      /* fall through to the local converter */
    }
  }
  return null
}

const DEFINE_TOOL = loadDefineTool()

/**
 * Minimal author-DSL → JSON Schema conversion covering the shapes this plugin
 * declares. Used only when `defineTool` cannot be resolved.
 * @param spec - author value-schema spec (per-property `required: true`, `items`, `enum`).
 * @returns the equivalent JSON Schema node.
 */
function toJsonSchema(spec) {
  const node = { type: spec.type }
  if (spec.description !== undefined) node.description = spec.description
  if (spec.enum !== undefined) node.enum = spec.enum
  if (spec.items !== undefined) node.items = toJsonSchema(spec.items)
  if (spec.properties !== undefined) {
    node.properties = {}
    const required = []
    for (const [key, child] of Object.entries(spec.properties)) {
      node.properties[key] = toJsonSchema(child)
      if (child.required === true) required.push(key)
    }
    node.required = required
    node.additionalProperties = spec.additionalProperties !== false
  }
  return node
}

/**
 * Minimal argument check for the fallback path. The real `defineTool` validates
 * against the JSON Schema; without this the fallback would silently accept a
 * missing or wrongly-typed `sessionId`.
 * @param parameters - the author parameter specs.
 * @param args - the incoming arguments.
 * @returns the arguments once validated.
 */
function validateFallbackArgs(parameters, args) {
  const value = args !== null && typeof args === 'object' ? args : {}
  for (const [key, spec] of Object.entries(parameters)) {
    const given = value[key]
    if (spec.required === true && (given === undefined || given === null)) {
      throw new Error(`argument "${key}" is required`)
    }
    if (given === undefined || given === null) continue
    const expected = spec.type
    const ok = expected === 'string' ? typeof given === 'string'
      : expected === 'boolean' ? typeof given === 'boolean'
        : expected === 'number' ? typeof given === 'number'
          : expected === 'integer' ? Number.isInteger(given)
            : expected === 'array' ? Array.isArray(given)
              : true
    if (!ok) throw new Error(`argument "${key}" must be of type ${expected}`)
  }
  return value
}

/**
 * Register-ready definition with the same shape `defineTool` produces.
 * @param options - author definition.
 * @returns the definition handed to `ctx.tools.register`.
 */
function fallbackDefine(options) {
  const properties = {}
  const required = []
  for (const [key, child] of Object.entries(options.parameters)) {
    properties[key] = toJsonSchema(child)
    if (child.required === true) required.push(key)
  }
  return {
    name: options.name,
    description: options.description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: toJsonSchema(options.output.schema),
      render: (args, value) => options.output.render(args, value)
    },
    execute: (args, exec) => options.execute(validateFallbackArgs(options.parameters, args), exec),
    ...(options.presentCall ? { presentCall: (args) => options.presentCall(args) } : {})
  }
}

/** Build the definition through the real `defineTool`, else the local fallback. */
function define(options) {
  return DEFINE_TOOL ? DEFINE_TOOL(options) : fallbackDefine(options)
}

const TOOL_DESCRIPTION = [
  'Permanently delete one stored Session: its log files, its projection-cache record, and every registry reference (workspace membership, archived/pinned sets).',
  'Use it only when the user explicitly asks to delete a Session or to clean up leftovers; archiving inside the UI is the reversible alternative.',
  'This is irreversible and keeps no backup. The Session must not be live: archive it and restart dsh first. The calling Session cannot delete itself.',
  'Pass dryRun to inspect what would be removed before changing anything.'
].join(' ')

/**
 * Tool body: the shared core plus the caller-identity guard, which only the
 * agent-facing face needs (an RPC caller is never the Session being deleted).
 * @param ctx - host context.
 * @param args - tool arguments.
 * @param exec - tool execution context.
 * @returns the deletion report.
 */
async function runTool(ctx, args, exec) {
  // Validate exactly like the Remote face does: the id becomes a path segment
  // inside `core.js`, and the tool-parameter DSL has no `pattern` keyword, so the
  // schema cannot carry this constraint.
  const id = sessionIdOf(String(args.sessionId))
  // `Agent.id` is the public field; `session` is the runtime class's own handle.
  const callerId = String(exec?.agent?.id ?? exec?.agent?.session?.id ?? '')
  if (callerId !== '' && callerId === id) {
    throw new Error('session_delete refuses to delete the Session running this call; archive it, restart dsh, then delete it from another Session')
  }
  const report = await runDelete(ctx, { sessionId: id, dryRun: args.dryRun === true, keepFiles: args.keepFiles === true })
  // The model face gets counts, never host paths: the Remote face trims them too.
  return {
    sessionId: report.sessionId,
    mode: report.mode,
    harnessHomeSource: report.harnessHomeSource,
    sessionDirsFound: report.sessionDirsFound.length,
    deletedPaths: report.deletedPaths.length,
    prunedProjectDirs: report.prunedProjectDirs.length,
    cacheRecordDeleted: report.cacheRecordDeleted,
    detachedFromWorkspaces: report.detachedFromWorkspaces,
    freedBytes: report.freedBytes,
    unreadable: report.unreadable,
    note: report.note
  }
}

/**
 * Register `session_delete`. Registration failure is logged instead of thrown so
 * a broken definition can never take the host composition down.
 * @param ctx - host context.
 */
function registerTool(ctx) {
  try {
    if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') return
    ctx.tools.register(define({
      name: 'session_delete',
      description: TOOL_DESCRIPTION,
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description: 'The stored Session id to delete, for example "session-2d79a3ce-569d-4193-b14b-f718a998f7ee" (letters, digits, "_" and "-" only).'
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what would be removed without changing anything.'
        },
        keepFiles: {
          type: 'boolean',
          description: 'Drop registry references but keep the stored log files on disk.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', required: true },
            mode: { type: 'string', required: true, description: 'dry-run | files-deleted | ids-only | registry-only' },
            harnessHomeSource: { type: 'string', required: true },
            sessionDirsFound: { type: 'integer', required: true },
            deletedPaths: { type: 'integer', required: true },
            prunedProjectDirs: { type: 'integer', required: true },
            cacheRecordDeleted: { type: 'boolean', required: true },
            detachedFromWorkspaces: { type: 'array', required: true, items: { type: 'string' } },
            freedBytes: { type: 'integer', required: true },
            unreadable: { type: 'integer', required: true },
            note: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.mode === 'dry-run'
            ? `Dry run for ${value.sessionId}: ${value.sessionDirsFound} session dir(s), ${value.freedBytes} bytes reclaimable.`
            : `Deleted ${value.sessionId} (${value.mode}): ${value.deletedPaths} path(s) removed, ${value.freedBytes} bytes freed, ${value.prunedProjectDirs} emptied project dir(s) pruned, detached from ${value.detachedFromWorkspaces.length} workspace(s).`
        }]
      },
      execute: (args, exec) => runTool(ctx, args, exec),
      presentCall: (args) => ({
        card: 'generic',
        title: 'Delete session',
        kind: 'other',
        rawInput: args
      })
    }))
  } catch (error) {
    ctx.logger?.warn?.(`dsh-session-delete: session_delete was not registered: ${String(error?.message ?? error)}`)
  }
}

// ── read-only compatibility self-check ──────────────────────────────────────

/** Version of this plugin's own package.json. */
function pluginVersion() {
  try {
    return createRequire(import.meta.url)('../package.json').version
  } catch {
    return 'unknown'
  }
}

/** The DSH build this process runs on, read from the tools package it resolves. */
function dshVersion() {
  const anchor = process.argv[1]
  if (anchor) {
    try {
      return createRequire(anchor)('@deepseek-ai/dsh-tools/package.json').version
    } catch {
      /* fall through */
    }
  }
  return 'unknown'
}

/**
 * Report every host contract this plugin depends on that a DSH upgrade could
 * move: the Remote marker route, the wire registration, the tools registry, the
 * workspace-registry methods, and the storage layout. Read-only, never throws.
 * @param ctx - host context.
 * @returns the flat report handed to the model.
 */
async function buildSelfCheck(ctx) {
  const { home, source } = harnessHome(ctx)
  const sessionsRoot = join(home, 'sessions')
  const projcacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  const registry = ctx.workspaceRegistry

  const registryApi = []
  if (registry !== undefined) {
    for (const method of ['list', 'get', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
      if (typeof registry[method] === 'function') registryApi.push(method)
    }
  }

  let detachSession = 'n/a (no workspace)'
  try {
    const first = typeof registry?.list === 'function' ? registry.list()[0] : undefined
    if (first !== undefined) detachSession = typeof first.detachSession === 'function' ? 'present' : 'MISSING'
  } catch {
    detachSession = 'error'
  }

  let sessionsRootExists = false
  let sessionCount = 0
  try {
    sessionsRootExists = await pathExists(sessionsRoot)
    if (sessionsRootExists) {
      for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        try {
          for (const child of await readdir(join(sessionsRoot, project.name), { withFileTypes: true })) {
            if (child.isDirectory()) sessionCount += 1
          }
        } catch {
          /* unreadable project directory */
        }
      }
    }
  } catch {
    /* probe only */
  }

  let projcacheRootExists = false
  try {
    projcacheRootExists = await pathExists(projcacheRoot)
  } catch {
    /* probe only */
  }

  const issues = []
  if (MARKER_SOURCE !== 'protocol') issues.push(`Remote markers written by "${MARKER_SOURCE}"`)
  if (STRICT_REGISTRATION !== 'accepted') issues.push(`strict wire registration "${STRICT_REGISTRATION}"`)
  if (DEFINE_TOOL === null) issues.push('defineTool not resolvable, local schema fallback in use')
  if (!sessionsRootExists) issues.push('sessions root missing, storage layout may have moved')
  if (!projcacheRootExists) issues.push('projection-cache root missing, records would be left behind')
  if (detachSession === 'MISSING') issues.push('Workspace.detachSession missing, registry cleanup unavailable')
  if (registry === undefined) issues.push('workspaceRegistry unavailable')

  return {
    pluginVersion: pluginVersion(),
    dshVersion: dshVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    harnessHome: home,
    harnessHomeSource: source,
    sessionsRootExists,
    projcacheRootExists,
    sessionCount,
    markerSource: MARKER_SOURCE,
    strictRegistration: STRICT_REGISTRATION,
    defineToolResolved: DEFINE_TOOL !== null,
    toolsRegistry: typeof ctx.tools?.register === 'function',
    registryApi,
    detachSession,
    serviceKey: SERVICE_KEY,
    endpoints: INVOCATIONS.map((invocation) => `${invocation.namespace}/${invocation.method}`),
    verdict: issues.length === 0
      ? 'ok — every host contract this plugin uses is present'
      : `check: ${issues.join('; ')}`
  }
}

/**
 * Register the read-only `session_delete_selfcheck` tool. Registration failure is
 * logged instead of thrown, like the delete tool.
 * @param ctx - host context.
 */
function registerSelfCheckTool(ctx) {
  try {
    if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') return
    ctx.tools.register(define({
      name: 'session_delete_selfcheck',
      description: [
        'Read-only compatibility self-check for the session-delete plugin.',
        'Reports whether the host contracts it depends on still match this DSH build: the Remote marker route, the explicit wire registration, the tools registry, the workspace-registry methods, and the session storage layout.',
        'Run it after a DSH upgrade, or whenever delete or dry-run calls behave unexpectedly. It changes nothing.'
      ].join(' '),
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pluginVersion: { type: 'string', required: true },
            dshVersion: { type: 'string', required: true },
            nodeVersion: { type: 'string', required: true },
            platform: { type: 'string', required: true },
            harnessHome: { type: 'string', required: true },
            harnessHomeSource: { type: 'string', required: true },
            sessionsRootExists: { type: 'boolean', required: true },
            projcacheRootExists: { type: 'boolean', required: true },
            sessionCount: { type: 'integer', required: true },
            markerSource: { type: 'string', required: true },
            strictRegistration: { type: 'string', required: true },
            defineToolResolved: { type: 'boolean', required: true },
            toolsRegistry: { type: 'boolean', required: true },
            registryApi: { type: 'array', required: true, items: { type: 'string' } },
            detachSession: { type: 'string', required: true },
            serviceKey: { type: 'string', required: true },
            endpoints: { type: 'array', required: true, items: { type: 'string' } },
            verdict: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.verdict} — plugin ${value.pluginVersion} on dsh ${value.dshVersion} / node ${value.nodeVersion}, markers "${value.markerSource}", wire "${value.strictRegistration}", ${value.sessionCount} session(s) visible.`
        }]
      },
      execute: () => buildSelfCheck(ctx),
      presentCall: () => ({
        card: 'generic',
        title: 'Session-delete self-check',
        kind: 'other',
        rawInput: {}
      })
    }))
  } catch (error) {
    ctx.logger?.warn?.(`dsh-session-delete: session_delete_selfcheck was not registered: ${String(error?.message ?? error)}`)
  }
}

// ── Remote service ──────────────────────────────────────────────────────────

/** Host service backing both the tool above and the sidebar delete dialog. */
class SessionDelete extends Base {
  static inject = ['tools', 'typert', 'workspaceRegistry']

  /**
   * @param ctx - owning Cordis context.
   */
  constructor(ctx) {
    super(ctx, SERVICE_KEY)
    registerInvocations(ctx)
    registerTool(ctx)
    registerSelfCheckTool(ctx)
  }

  /**
   * Report what deleting one Session would remove, without changing anything.
   * @param sessionId - the stored Session id.
   * @returns the trimmed plan for the dialog (no absolute paths).
   */
  async planDelete(sessionId) {
    const id = sessionIdOf(sessionId)
    const plan = await planDelete(this.ctx, id)
    return {
      sessionId: id,
      bytes: plan.bytes,
      dirCount: plan.sessionDirs.length,
      cacheRecordExists: plan.cacheRecordExists,
      wasArchived: plan.wasArchived,
      wasPinned: plan.wasPinned
    }
  }

  /**
   * Delete one stored Session. Requires an explicit `confirm: true` so an
   * accidental call can never destroy history.
   * @param sessionId - the stored Session id.
   * @param confirm - must be true.
   * @returns the trimmed deletion report.
   */
  async deleteSession(sessionId, confirm) {
    const id = sessionIdOf(sessionId)
    if (confirm !== true) {
      throw fail('session-delete/unconfirmed', 'deleteSession requires confirm: true')
    }
    let report
    try {
      report = await runDelete(this.ctx, { sessionId: id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof error?.code === 'string' ? error.code : null
      if (code === 'session-delete/live' || message.includes('is live in this host process')) {
        throw fail('session-delete/live', message)
      }
      // Every other coded refusal keeps its own code and details so the client can
      // branch on it: in-flight, partial, layout-unknown, bad-request.
      if (typeof code === 'string' && code.startsWith('session-delete/')) {
        throw fail(code, message, error?.details)
      }
      throw fail('session-delete/failed', message)
    }
    return {
      sessionId: report.sessionId,
      mode: report.mode,
      freedBytes: report.freedBytes,
      deletedPaths: report.deletedPaths,
      detachedFromWorkspaces: report.detachedFromWorkspaces
    }
  }
}

// Discovery surface: prefer the protocol's own marker writer, whose version
// tracking follows the installed protocol; fall back to the documented v1
// descriptor. `__debug.markerSource` reports which route was taken.
installRemoteMarkers(SessionDelete)

export default SessionDelete

/** Diagnostic surface for install verification and the self-check tool. */
export const __debug = {
  serviceKey: SERVICE_KEY,
  endpoints: INVOCATIONS.map((invocation) => `${invocation.namespace}/${invocation.method}`),
  wires: INVOCATIONS.map((invocation) => invocation.parameters.map((parameter) => parameter.wire)),
  get defineToolResolved() {
    return DEFINE_TOOL !== null
  },
  get markerSource() {
    return MARKER_SOURCE
  },
  get strictRegistration() {
    return STRICT_REGISTRATION
  }
}
