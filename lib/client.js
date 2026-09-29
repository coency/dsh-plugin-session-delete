/**
 * Browser half of the DSH delete-session feature: a "删除会话" row in the Session
 * "..." menu plus the confirmation dialog it opens.
 *
 * Hand-written in the module-loader bundle format the shell consumes
 * (`window.__ModuleLoader__.load({ id, factory })`), so no build step is
 * involved. React and the UI primitives come from the shell's platform module
 * table.
 *
 * Reaching the host: calls go through the Connection service's own RPC
 * (`connection.rpc.call`), which is the transport every shipped call uses — same
 * URL shape, same request envelope, same correlation id and auth handling. A
 * hand-rolled fetch would bypass that layer and be rejected by the `/api` trust
 * fence. The browser does NOT mount a fabricated Remote contribution: the host
 * registers the wire contract itself (strict invocation descriptors).
 *
 * Confirmation contract, enforced as state rather than as click order:
 *
 *  - the destructive call is reachable only from phase `confirm`, i.e. after the
 *    host has actually reported a plan — a failed plan can never be confirmed;
 *  - the in-flight destructive call owns the dialog: closing (Escape, backdrop,
 *    Cancel) is refused while `busy`, so its outcome is always rendered;
 *  - the plan request carries an AbortSignal and is aborted by a newer request or
 *    by closing; the destructive call deliberately carries none, because a
 *    cancelled delete would leave the outcome unknown;
 *  - every request stamps a token, and nothing is written to the store after an
 *    await unless that token is still current.
 *
 * @module dsh-session-delete/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const reactNamespace = require('react')
    const React = reactNamespace.default ?? reactNamespace
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-session-delete'
    const NAMESPACE = 'sessionDelete'

    const DICTIONARIES = {
      zh: {
        'menu.delete': '删除会话…',
        'dialog.title': '永久删除会话',
        'dialog.desc': '「{title}」将被永久删除：会话日志、投影缓存记录，以及工作区成员、归档与置顶集合中的引用。此操作不可恢复，且不保留备份。',
        'dialog.plan': '将删除 {dirs} 个会话目录，释放约 {size}。',
        'dialog.planNone': '磁盘上已找不到该会话的日志文件，只会清理注册表引用。',
        'dialog.planCacheOnly': '磁盘上已无该会话的目录，但它的投影缓存记录会被删除。',
        'dialog.archived': '该会话当前处于归档状态。',
        'dialog.cancel': '取消',
        'dialog.confirm': '永久删除',
        'dialog.close': '关闭',
        'dialog.busy': '正在删除…',
        'dialog.done': '已删除：释放 {size}，清理 {paths} 个路径，解除 {workspaces} 个工作区关联。',
        'dialog.failed': '删除失败：{message}',
        'dialog.detail': '宿主原话：{message}',
        'dialog.live': '该会话仍在运行，且尚未归档。请先在界面上归档它（归档会停掉它的工作），然后再删除——不需要重启 dsh web。',
        'dialog.inFlight': '该会话正在被删除：请等当前这次删除结束，再重试。',
        'dialog.noRemote': '宿主远端 sessionDelete 不可用：请确认 dsh-session-delete 插件已挂载，然后重启 dsh web。',
        'dialog.noConnection': '客户端连接不可用：请刷新页面后重试。',
        'error.unknown': '宿主未给出原因'
      },
      en: {
        'menu.delete': 'Delete session…',
        'dialog.title': 'Delete session permanently',
        'dialog.desc': '"{title}" will be deleted for good: its Session log, its projection-cache record, and every reference in workspace membership, archived, and pinned sets. This is irreversible and keeps no backup.',
        'dialog.plan': 'Removes {dirs} session dir(s), freeing about {size}.',
        'dialog.planNone': 'No Session files were found on disk; only registry references will be dropped.',
        'dialog.planCacheOnly': 'No Session directory is left on disk, but the projection-cache record for this Session will be deleted.',
        'dialog.archived': 'This session is currently archived.',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete permanently',
        'dialog.close': 'Close',
        'dialog.busy': 'Deleting…',
        'dialog.done': 'Deleted: {size} freed, {paths} path(s) removed, {workspaces} workspace link(s) dropped.',
        'dialog.failed': 'Deletion failed: {message}',
        'dialog.detail': 'The host said: {message}',
        'dialog.live': 'This session is still loaded and not archived. Archive it in the UI first (archiving stops its work), then delete it — no restart is needed.',
        'dialog.inFlight': 'This Session is already being deleted: wait for that call to finish, then retry.',
        'dialog.noRemote': 'The host sessionDelete remote is unavailable: check that the dsh-session-delete plugin is mounted, then restart dsh web.',
        'dialog.noConnection': 'The client connection is unavailable: refresh the page and try again.',
        'error.unknown': 'the host gave no reason'
      }
    }

    // ---- host access -------------------------------------------------------
    /** Wire arguments per method; the host validates exactly these fields. */
    const CALLS = {
      planDelete: {
        wire: (args) => ({ sessionId: args.sessionId })
      },
      deleteSession: {
        wire: (args) => ({ sessionId: args.sessionId, confirm: args.confirm === true })
      }
    }

    /** Error codes the dialog renders a dedicated hint for. */
    const NO_CONNECTION = 'client/no-connection'
    const NO_REMOTE = ['gateway/invocation-unavailable', 'gateway/service-unavailable']
    const LIVE = 'session-delete/live'
    const IN_FLIGHT = 'session-delete/in-flight'

    function remoteError(raw) {
      const message = typeof raw?.message === 'string' ? raw.message : ''
      const error = new Error(message)
      error.rpcError = { code: typeof raw?.code === 'string' ? raw.code : null }
      return error
    }

    function unwrap(result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true) return result.value
        throw remoteError(result.error)
      }
      return result
    }

    /**
     * Call one host endpoint over the shipped Connection transport.
     * @param ctx - client context.
     * @param method - `sessionDelete` method name.
     * @param args - tool-level arguments.
     * @param signal - optional AbortSignal for a cancelable (read-only) call.
     * @returns the endpoint value.
     */
    async function callRemote(ctx, method, args, signal) {
      const connection = ctx.get('connection')
      if (connection === undefined || connection.rpc === undefined || typeof connection.rpc.call !== 'function') {
        const error = new Error('')
        error.rpcError = { code: NO_CONNECTION }
        throw error
      }
      const result = await connection.rpc.call('/api', `${NAMESPACE}/${method}`, { args: CALLS[method].wire(args) }, signal)
      return unwrap(result)
    }

    // ---- one module-level store shared by the menu row and the dialog -------
    const store = {
      token: 0,
      abort: null,
      request: null,
      plan: null,
      phase: 'idle',
      report: null,
      errorCode: null,
      errorMessage: null
    }
    const listeners = new Set()

    function setStore(next) {
      Object.assign(store, next)
      for (const listener of Array.from(listeners)) listener()
    }

    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return store
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    function codeOf(reason) {
      const code = reason?.rpcError?.code
      return typeof code === 'string' ? code : null
    }

    function messageOf(reason) {
      return reason instanceof Error ? reason.message : String(reason)
    }

    // ---- the injected face shared by both registrations ---------------------
    function createApi(ctx) {
      let sequence = 0
      return {
        useStore,
        async open(sessionId, displayTitle) {
          // A newer request invalidates whatever the previous one may still do.
          store.abort?.abort?.()
          const token = ++sequence
          const abort = new AbortController()
          setStore({
            token,
            abort,
            request: { sessionId, displayTitle },
            plan: null,
            phase: 'loading',
            report: null,
            errorCode: null,
            errorMessage: null
          })
          try {
            const plan = await callRemote(ctx, 'planDelete', { sessionId }, abort.signal)
            if (store.token !== token) return
            setStore({ plan, phase: 'confirm' })
          } catch (reason) {
            if (store.token !== token) return
            setStore({ phase: 'error', errorCode: codeOf(reason), errorMessage: messageOf(reason) })
          }
        },
        close() {
          // Refused while the irreversible call is in flight: its outcome must be
          // rendered instead of swallowed by a closed dialog.
          if (store.phase === 'busy') return
          store.abort?.abort?.()
          setStore({
            token: ++sequence,
            abort: null,
            request: null,
            plan: null,
            phase: 'idle',
            report: null,
            errorCode: null,
            errorMessage: null
          })
        },
        async confirm() {
          const request = store.request
          // Only a request that actually reached a plan may be confirmed: the
          // loading and error phases must never reach the destructive call.
          if (request === null || store.phase !== 'confirm') return
          const token = store.token
          setStore({ phase: 'busy', errorCode: null, errorMessage: null })
          try {
            // No AbortSignal on purpose: cancelling a delete would leave the
            // outcome unknown, which is worse than waiting for the answer.
            const report = await callRemote(ctx, 'deleteSession', { sessionId: request.sessionId, confirm: true }, undefined)
            if (store.token !== token) return
            setStore({ phase: 'done', report })
            try {
              // The sidebar's workspace tree follows the host's workspace snapshot
              // stream, so detaching already removes the row; this call covers the
              // Session list itself (titles and ordering).
              await ctx.get('sessions')?.refresh?.()
            } catch {
              /* the next stream snapshot or list refresh covers it anyway */
            }
          } catch (reason) {
            if (store.token !== token) return
            setStore({ phase: 'error', errorCode: codeOf(reason), errorMessage: messageOf(reason) })
          }
        }
      }
    }

    // ---- the Session "..." menu row ----------------------------------------
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, del, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return React.createElement(
        P.MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          icon: React.createElement(P.IconTrashOutlineRegular, null),
          onSelect: () => {
            setMenuOpen(false)
            void del.open(sessionId, displayTitle)
          }
        },
        t('menu.delete')
      )
    }

    // ---- the confirmation dialog -------------------------------------------
    function DeleteSessionDialog({ del, t }) {
      const state = del.useStore()
      const request = state.request
      const busy = state.phase === 'busy'
      const done = state.phase === 'done'
      const open = request !== null && state.phase !== 'idle'

      // Danger colour comes from the theme token the shipped destructive UI uses,
      // with a literal fallback for themes that do not define it.
      const danger = { color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
      const muted = { opacity: 0.75, marginTop: '4px' }

      const body = []
      if (state.plan !== null) {
        body.push(React.createElement(
          'div',
          { key: 'plan' },
          state.plan.dirCount > 0
            ? t('dialog.plan', { dirs: state.plan.dirCount, size: formatBytes(state.plan.bytes) })
            : state.plan.cacheRecordExists === true
              ? t('dialog.planCacheOnly')
              : t('dialog.planNone')
        ))
        if (state.plan.wasArchived === true) {
          body.push(React.createElement('div', { key: 'archived' }, t('dialog.archived')))
        }
      }
      if (state.plan !== null && state.plan.live === true && state.plan.wasArchived !== true) {
        // Warn before the irreversible step: the host refuses a loaded, unarchived
        // Session, so the user learns it here instead of after confirming. An
        // archived Session needs no warning: its work is already stopped.
        body.push(React.createElement('div', { key: 'live', role: 'alert', style: danger }, t('dialog.live')))
      }
      if (busy) {
        body.push(React.createElement('div', { key: 'busy', role: 'status' }, t('dialog.busy')))
      }
      if (state.phase === 'error') {
        // The host's own words stay visible; the hint only adds what they cannot
        // say (a missing remote, a dead connection, a live Session).
        const message = typeof state.errorMessage === 'string' && state.errorMessage.length > 0
          ? state.errorMessage
          : t('error.unknown')
        const code = state.errorCode
        const hint = code === LIVE
          ? t('dialog.live')
          : code === IN_FLIGHT
            ? t('dialog.inFlight')
            : code === NO_CONNECTION
              ? t('dialog.noConnection')
              : NO_REMOTE.includes(code)
                ? t('dialog.noRemote')
                : null
        body.push(React.createElement(
          'div',
          { key: 'error', role: 'alert', style: danger },
          hint === null ? t('dialog.failed', { message }) : hint
        ))
        if (hint !== null) {
          body.push(React.createElement('div', { key: 'error-detail', style: muted }, t('dialog.detail', { message })))
        }
      }
      if (done && state.report !== null) {
        body.push(React.createElement('div', { key: 'done', role: 'status' }, t('dialog.done', {
          size: formatBytes(state.report.freedBytes),
          paths: state.report.deletedPaths.length,
          workspaces: state.report.detachedFromWorkspaces.length
        })))
      }

      const footer = React.createElement(
        React.Fragment,
        null,
        React.createElement(
          P.Button,
          {
            variant: 'outline',
            disabled: busy,
            'data-modal-autofocus': true,
            onClick: () => del.close()
          },
          done ? t('dialog.close') : t('dialog.cancel')
        ),
        !done && React.createElement(
          P.Button,
          {
            variant: 'outline',
            // Reachable only from a plan the user has seen, and never for a loaded,
            // unarchived Session the host would refuse anyway.
            disabled: state.phase !== 'confirm' || (state.plan !== null && state.plan.live === true && state.plan.wasArchived !== true),
            style: danger,
            onClick: () => void del.confirm()
          },
          t('dialog.confirm')
        )
      )

      return React.createElement(
        P.Modal,
        {
          open,
          onClose: () => del.close(),
          closeLabel: t('dialog.close'),
          title: t('dialog.title'),
          description: request === null ? '' : t('dialog.desc', { title: request.displayTitle }),
          footer
        },
        body
      )
    }

    // ---- plugin ------------------------------------------------------------
    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      try {
        ctx.locale.register(NS, DICTIONARIES)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-session-delete: locale registration failed: ${String(error?.message ?? error)}`)
      }

      const api = createApi(ctx)

      // Each contribution is isolated: a conflicting entry id (or any setup
      // throw) must cost that one registration, not the whole plugin.
      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete-dialog',
          locale: NS,
          inject: () => ({ del: api })
        }, DeleteSessionDialog))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-session-delete: dialog registration failed: ${String(error?.message ?? error)}`)
      }

      try {
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-delete',
          order: 450,
          locale: NS,
          inject: () => ({ del: api })
        }, DeleteSessionMenuItem))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-session-delete: menu row registration failed: ${String(error?.message ?? error)}`)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
