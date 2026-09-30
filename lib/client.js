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
 * @module dsh-plugin-session-delete/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const reactNamespace = require('react')
    const React = reactNamespace.default ?? reactNamespace
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-plugin-session-delete'
    const NAMESPACE = 'sessionDelete'

    const DICTIONARIES = {
      zh: {
        'menu.delete': '删除会话…',
        'dialog.title': '永久删除会话',
        'dialog.desc': '「{title}」将被永久删除：会话日志、投影缓存记录，以及工作区成员、归档与置顶集合中的引用。此操作不可恢复，且不保留备份。',
        'dialog.descLoading': '正在向宿主查询「{title}」将被删除的内容…',
        'dialog.descError': '没有删除任何内容：「{title}」的删除计划未能取得。',
        'dialog.descDone': '「{title}」的删除结果。',
        'dialog.plan': '将删除 {dirs} 个会话目录，释放约 {size}。',
        'dialog.planNone': '磁盘上已找不到该会话的日志文件，只会清理注册表引用。',
        'dialog.planCacheOnly': '磁盘上已无该会话的目录，但它的投影缓存记录会被删除。',
        'dialog.archived': '该会话当前处于归档状态。',
        'dialog.cancel': '取消',
        'dialog.confirm': '永久删除',
        'dialog.retry': '重试',
        'dialog.close': '关闭',
        'dialog.busy': '正在删除…',
        'dialog.loading': '正在读取删除计划…',
        'dialog.done': '已删除：释放 {size}，清理 {paths} 个路径，解除 {workspaces} 个工作区关联。',
        'dialog.failed': '删除失败：{message}',
        'dialog.detail': '宿主原话：{message}',
        'dialog.confirmDisabledLive': '该会话仍在运行且尚未归档：请先归档，然后再删除。',
        'dialog.confirmDisabledWaiting': '正在读取删除计划：拿到计划后按钮才会可用。',
        'dialog.closeBlocked': '这次删除仍在进行：结果会显示在这里，所以现在还不能关闭。',
        'dialog.closeAllowedAfterTimeout': '已经等待超过 90 秒，现在可以关闭了；删除在宿主上继续进行，它的结果无法再显示。',
        'dialog.closeTimedOut': '已经等待超过 90 秒：删除在宿主上继续进行，它的结果无法再显示。',
        'dialog.live': '该会话仍在运行，且尚未归档。请先在界面上归档它（归档会停掉它的工作），然后再删除——不需要重启 dsh web。',
        'dialog.liveArchived': '该会话仍加载在宿主内存中：删除后会从侧栏隐藏（默认不显示已归档），宿主重启后彻底消失。',
        'dialog.inFlight': '该会话正在被删除：请等当前这次删除结束，再重试。',
        'dialog.layoutUnknown': '宿主无法确认自己的存储根目录：这次 0 个路径的结果不可信，DSH 数据目录可能配置成了另一个位置。',
        'dialog.partial': '部分路径未能删除：注册表引用已经清理完毕，重试是安全的。',
        'dialog.noRemote': '宿主远端 sessionDelete 不可用：请确认 dsh-plugin-session-delete 插件已挂载，然后重启 dsh web。',
        'dialog.noConnection': '客户端连接不可用：请刷新页面后重试。',
        'error.unknown': '宿主未给出原因',
        'size.b': 'B',
        'size.kb': 'KB',
        'size.mb': 'MB',
        'size.gb': 'GB'
      },
      en: {
        'menu.delete': 'Delete session…',
        'dialog.title': 'Delete session permanently',
        'dialog.desc': '"{title}" will be deleted for good: its Session log, its projection-cache record, and every reference in workspace membership, archived, and pinned sets. This is irreversible and keeps no backup.',
        'dialog.descLoading': 'Asking the host what deleting "{title}" will remove…',
        'dialog.descError': 'Nothing was deleted: the delete plan for "{title}" could not be obtained.',
        'dialog.descDone': 'The outcome of deleting "{title}".',
        'dialog.plan': 'Removes {dirs} session dir(s), freeing about {size}.',
        'dialog.planNone': 'No Session files were found on disk; only registry references will be dropped.',
        'dialog.planCacheOnly': 'No Session directory is left on disk, but the projection-cache record for this Session will be deleted.',
        'dialog.archived': 'This session is currently archived.',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete permanently',
        'dialog.retry': 'Retry',
        'dialog.close': 'Close',
        'dialog.busy': 'Deleting…',
        'dialog.loading': 'Reading the delete plan…',
        'dialog.done': 'Deleted: {size} freed, {paths} path(s) removed, {workspaces} workspace link(s) dropped.',
        'dialog.failed': 'Deletion failed: {message}',
        'dialog.detail': 'The host said: {message}',
        'dialog.confirmDisabledLive': 'This Session is still loaded and not archived: archive it first, then delete it.',
        'dialog.confirmDisabledWaiting': 'The delete plan is still being read: this button becomes available once it arrives.',
        'dialog.closeBlocked': 'This deletion is still running: its outcome will appear here, so the dialog cannot be closed yet.',
        'dialog.closeAllowedAfterTimeout': 'More than 90 seconds have passed, so closing is allowed again; the deletion keeps running on the host and its outcome can no longer be displayed.',
        'dialog.closeTimedOut': 'More than 90 seconds have passed: the deletion keeps running on the host and its outcome can no longer be displayed.',
        'dialog.live': 'This session is still loaded and not archived. Archive it in the UI first (archiving stops its work), then delete it — no restart is needed.',
        'dialog.liveArchived': 'This Session is still loaded in the host: after deletion it stays out of the sidebar (archived rows are hidden by default) and disappears for good when the host restarts.',
        'dialog.inFlight': 'This Session is already being deleted: wait for that call to finish, then retry.',
        'dialog.layoutUnknown': 'The host could not confirm its own storage root: a 0-path result cannot be trusted here, because the DSH home may be configured somewhere else.',
        'dialog.partial': 'Some paths could not be removed: the registry references were already dropped, so retrying is safe.',
        'dialog.noRemote': 'The host sessionDelete remote is unavailable: check that the dsh-plugin-session-delete plugin is mounted, then restart dsh web.',
        'dialog.noConnection': 'The client connection is unavailable: refresh the page and try again.',
        'error.unknown': 'the host gave no reason',
        'size.b': 'B',
        'size.kb': 'KB',
        'size.mb': 'MB',
        'size.gb': 'GB'
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
    const LAYOUT_UNKNOWN = 'session-delete/layout-unknown'
    const PARTIAL = 'session-delete/partial'

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
      const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
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
      errorMessage: null,
      // Set while the user tried to close during a deletion; cleared on the next
      // `confirm`, `close`, or `open`, so it never describes a stale attempt.
      closeBlocked: false,
      // Timestamp the destructive call entered `busy`, or null. Kept in the store
      // so a remount can still tell how long the deletion has been running.
      busySince: null
    }
    const listeners = new Set()

    /**
     * How long a deletion may block closing. After this the outcome can no longer
     * be rendered — the user is told that instead of being trapped in the dialog,
     * while the host keeps deleting.
     */
    const CLOSE_BLOCK_TIMEOUT_MS = 90_000

    /** Whether the user gave up waiting on an in-flight deletion. */
    function closeTimedOut() {
      return store.phase === 'busy'
        && typeof store.busySince === 'number'
        && Date.now() - store.busySince >= CLOSE_BLOCK_TIMEOUT_MS
    }

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

    /** Format a byte count with units from the dictionary; handles GB. */
    function formatBytes(bytes, t) {
      const [b, kb, mb, gb] = [t('size.b'), t('size.kb'), t('size.mb'), t('size.gb')]
      if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${b}`
      if (bytes < 1024) return `${bytes} ${b}`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${kb}`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} ${mb}`
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ${gb}`
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

      async function open(sessionId, displayTitle) {
        // A deletion already in flight owns the dialog: reopening now would
        // discard its outcome, and a re-click on the same id is no different.
        if (store.phase === 'busy') return
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
          errorMessage: null,
          closeBlocked: false,
          busySince: null
        })
        try {
          const plan = await callRemote(ctx, 'planDelete', { sessionId }, abort.signal)
          if (store.token !== token) return
          setStore({ plan, phase: 'confirm' })
        } catch (reason) {
          if (store.token !== token) return
          setStore({ phase: 'error', errorCode: codeOf(reason), errorMessage: messageOf(reason) })
        }
      }

      function close() {
        // Refused while the irreversible call is in flight: its outcome must be
        // rendered instead of swallowed by a closed dialog. The refusal is
        // visible, and it expires — after that the delete continues on the host
        // and the outcome is explicitly given up rather than lost silently.
        if (store.phase === 'busy' && !closeTimedOut()) {
          setStore({ closeBlocked: true })
          return
        }
        store.abort?.abort?.()
        setStore({
          token: ++sequence,
          abort: null,
          request: null,
          plan: null,
          phase: 'idle',
          report: null,
          errorCode: null,
          errorMessage: null,
          closeBlocked: false,
          busySince: null
        })
      }

      async function confirm() {
        const request = store.request
        // Only a request that actually reached a plan may be confirmed: the
        // loading and error phases must never reach the destructive call.
        if (request === null || store.phase !== 'confirm') return
        const token = store.token
        setStore({ phase: 'busy', errorCode: null, errorMessage: null, closeBlocked: false, busySince: Date.now() })
        try {
          // No AbortSignal on purpose: cancelling a delete would leave the
          // outcome unknown, which is worse than waiting for the answer.
          const report = await callRemote(ctx, 'deleteSession', { sessionId: request.sessionId, confirm: true }, undefined)
          if (store.token !== token) return
          setStore({ phase: 'done', report, busySince: null })
          try {
            // The sidebar's workspace tree follows the host's workspace snapshot
            // stream, so detaching already removes the row; this call covers the
            // Session list itself (titles and ordering).
            await (typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined)?.refresh?.()
          } catch {
            /* the next stream snapshot or list refresh covers it anyway */
          }
        } catch (reason) {
          if (store.token !== token) return
          setStore({ phase: 'error', errorCode: codeOf(reason), errorMessage: messageOf(reason), busySince: null })
        }
      }

      function retry() {
        // The error phase keeps the request, so a transient failure (a busy host,
        // a dead connection) can be retried without reopening the menu.
        const request = store.request
        if (request === null) return
        void open(request.sessionId, request.displayTitle)
      }

      return { useStore, open, close, confirm, retry }
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
      const phase = state.phase
      const busy = phase === 'busy'
      const done = phase === 'done'
      const open = request !== null && phase !== 'idle'
      const closeTimedOut = busy
        && typeof state.busySince === 'number'
        && Date.now() - state.busySince >= CLOSE_BLOCK_TIMEOUT_MS
      const confirmBlockedLive = state.plan !== null && state.plan.live === true && state.plan.wasArchived !== true

      // The 90-second escape hatch has to arrive on its own: nothing else
      // re-renders the dialog while the destructive call is pending. The store
      // timestamp (not component state) decides, so a remount still schedules it.
      const [, setTimeoutTick] = React.useState(0)
      const busySince = state.busySince
      React.useEffect(() => {
        if (phase !== 'busy' || typeof busySince !== 'number') return undefined
        const remaining = CLOSE_BLOCK_TIMEOUT_MS - (Date.now() - busySince)
        const timer = setTimeout(() => setTimeoutTick((n) => n + 1), Math.max(0, remaining) + 50)
        // Leaving `busy` (or a new deletion) clears the pending timer.
        return () => clearTimeout(timer)
      }, [phase, busySince])

      // Danger colour comes from the theme token the shipped destructive UI uses,
      // with a literal fallback for themes that do not define it.
      const danger = { color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
      const muted = { opacity: 0.75, marginTop: '4px' }

      const body = []
      if (phase === 'loading') {
        body.push(React.createElement('div', { key: 'loading', role: 'status' }, t('dialog.loading')))
      }
      if (state.plan !== null) {
        body.push(React.createElement(
          'div',
          { key: 'plan' },
          state.plan.dirCount > 0
            ? t('dialog.plan', { dirs: state.plan.dirCount, size: formatBytes(state.plan.bytes, t) })
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
      if (state.plan !== null && state.plan.live === true && state.plan.wasArchived === true) {
        // Loaded but already archived: deletion is allowed (archiving stopped its
        // work) and the archived marker keeps the row hidden until it unloads.
        body.push(React.createElement('div', { key: 'live-archived', role: 'status', style: muted }, t('dialog.liveArchived')))
      }
      if (busy) {
        body.push(React.createElement('div', { key: 'busy', role: 'status' }, t('dialog.busy')))
      }
      if (busy && state.closeBlocked === true && !closeTimedOut) {
        // The refused close is never silent: the user is told why, and that the
        // result will land here.
        body.push(React.createElement('div', { key: 'close-blocked', role: 'status', style: muted }, t('dialog.closeBlocked')))
      }
      if (busy && closeTimedOut) {
        body.push(React.createElement(
          'div',
          { key: 'close-timeout', role: 'status', style: muted },
          state.closeBlocked === true ? t('dialog.closeAllowedAfterTimeout') : t('dialog.closeTimedOut')
        ))
      }
      if (phase === 'error') {
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
            : code === LAYOUT_UNKNOWN
              ? t('dialog.layoutUnknown')
              : code === PARTIAL
                ? t('dialog.partial')
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
        const report = state.report
        body.push(React.createElement('div', { key: 'done', role: 'status' }, t('dialog.done', {
          size: formatBytes(report.freedBytes, t),
          paths: Array.isArray(report.deletedPaths)
            ? report.deletedPaths.length
            : Number.isFinite(report.deletedPathCount) ? report.deletedPathCount : 0,
          workspaces: Array.isArray(report.detachedFromWorkspaces) ? report.detachedFromWorkspaces.length : 0
        })))
      }

      const footer = React.createElement(
        React.Fragment,
        null,
        React.createElement(
          P.Button,
          {
            variant: 'outline',
            disabled: busy && !closeTimedOut,
            'data-modal-autofocus': true,
            onClick: () => del.close()
          },
          done ? t('dialog.close') : t('dialog.cancel')
        ),
        phase === 'error' && React.createElement(
          P.Button,
          { variant: 'outline', onClick: () => del.retry() },
          t('dialog.retry')
        ),
        !done && React.createElement(
          P.Button,
          {
            variant: 'outline',
            // Reachable only from a plan the user has seen, and never for a loaded,
            // unarchived Session the host would refuse anyway. The disabled button
            // mirrors its reason in `title`; the same reason is already visible in
            // the dialog body, which is what assistive tech reads.
            disabled: phase !== 'confirm' || confirmBlockedLive,
            title: confirmBlockedLive ? t('dialog.confirmDisabledLive') : t('dialog.confirmDisabledWaiting'),
            style: danger,
            onClick: () => void del.confirm()
          },
          t('dialog.confirm')
        )
      )

      // Phase-driven: only the `confirm` phase may claim the Session is about to
      // be permanently deleted. Every other phase needs a description that
      // leaves the "will be deleted" claim to the phase where it is still true.
      let description = ''
      if (request !== null) {
        const title = request.displayTitle
        description = phase === 'confirm'
          ? t('dialog.desc', { title })
          : phase === 'loading'
            ? t('dialog.descLoading', { title })
            : phase === 'done' ? t('dialog.descDone', { title }) : t('dialog.descError', { title })
      }

      return React.createElement(
        P.Modal,
        {
          open,
          onClose: () => del.close(),
          closeLabel: t('dialog.close'),
          title: t('dialog.title'),
          description,
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
        ctx.logger?.warn?.(`dsh-plugin-session-delete: locale registration failed: ${String(error?.message ?? error)}`)
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
        ctx.logger?.warn?.(`dsh-plugin-session-delete: dialog registration failed: ${String(error?.message ?? error)}`)
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
        ctx.logger?.warn?.(`dsh-plugin-session-delete: menu row registration failed: ${String(error?.message ?? error)}`)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
