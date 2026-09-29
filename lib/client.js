/**
 * Browser half of the DSH delete-session feature: a "鍒犻櫎浼氳瘽" row in the Session
 * "..." menu plus the confirmation dialog it opens.
 *
 * Hand-written in the module-loader bundle format the shell consumes
 * (`window.__ModuleLoader__.load({ id, factory })`), so no build step is
 * involved. React and the UI primitives come from the shell's platform module
 * table.
 *
 * Reaching the host: calls go through the Connection service's own RPC
 * (`connection.rpc.call`), which is the transport every shipped call uses 鈥?same
 * URL shape, same request envelope, same correlation id and auth handling. A
 * hand-rolled fetch would bypass that layer and be rejected by the `/api` trust
 * fence. The browser does NOT mount a fabricated Remote contribution: the host
 * registers the wire contract itself (strict invocation descriptors).
 *
 * @module dsh-session-ui/client
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
        'menu.delete': '鍒犻櫎浼氳瘽鈥?,
        'dialog.title': '姘镐箙鍒犻櫎浼氳瘽',
        'dialog.desc': '銆寋title}銆嶅皢琚案涔呭垹闄わ細浼氳瘽鏃ュ織銆佹姇褰辩紦瀛樿褰曪紝浠ュ強宸ヤ綔鍖烘垚鍛樸€佸綊妗ｄ笌缃《闆嗗悎涓殑寮曠敤銆傛鎿嶄綔涓嶅彲鎭㈠锛屼笖涓嶄繚鐣欏浠姐€?,
        'dialog.plan': '灏嗗垹闄?{dirs} 涓細璇濈洰褰曪紝閲婃斁绾?{size}銆?,
        'dialog.planNone': '纾佺洏涓婂凡鎵句笉鍒拌浼氳瘽鐨勬棩蹇楁枃浠讹紝鍙細娓呯悊娉ㄥ唽琛ㄥ紩鐢ㄣ€?,
        'dialog.archived': '璇ヤ細璇濆綋鍓嶅浜庡綊妗ｇ姸鎬併€?,
        'dialog.cancel': '鍙栨秷',
        'dialog.confirm': '姘镐箙鍒犻櫎',
        'dialog.close': '鍏抽棴',
        'dialog.busy': '姝ｅ湪鍒犻櫎鈥?,
        'dialog.done': '宸插垹闄わ細閲婃斁 {size}锛屾竻鐞?{paths} 涓矾寰勶紝瑙ｉ櫎 {workspaces} 涓伐浣滃尯鍏宠仈銆?,
        'dialog.failed': '鍒犻櫎澶辫触锛歿message}',
        'dialog.live': '璇ヤ細璇濅粛鍦ㄨ繍琛岋紙瀹夸富鎸佹湁鍐欏叆鍙ユ焺锛夈€傝鍏堝湪鐣岄潰涓婂綊妗ｅ畠锛屽啀閲嶅惎 dsh web锛岀劧鍚庨噸璇曘€?,
        'dialog.noRemote': '瀹夸富杩滅 sessionDelete 涓嶅彲鐢細璇风‘璁?dsh-session-admin 鎻掍欢宸叉寕杞斤紝鐒跺悗閲嶅惎 dsh web銆?
      },
      en: {
        'menu.delete': 'Delete session鈥?,
        'dialog.title': 'Delete session permanently',
        'dialog.desc': '"{title}" will be deleted for good: its Session log, its projection-cache record, and every reference in workspace membership, archived, and pinned sets. This is irreversible and keeps no backup.',
        'dialog.plan': 'Removes {dirs} session dir(s), freeing about {size}.',
        'dialog.planNone': 'No Session files were found on disk; only registry references will be dropped.',
        'dialog.archived': 'This session is currently archived.',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete permanently',
        'dialog.close': 'Close',
        'dialog.busy': 'Deleting鈥?,
        'dialog.done': 'Deleted: {size} freed, {paths} path(s) removed, {workspaces} workspace link(s) dropped.',
        'dialog.failed': 'Deletion failed: {message}',
        'dialog.live': 'This session is still live (the host holds its writer). Archive it, restart dsh web, then retry.',
        'dialog.noRemote': 'The host sessionDelete remote is unavailable: check that the dsh-session-admin plugin is mounted, then restart dsh web.'
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

    function remoteError(raw) {
      const message = typeof raw?.message === 'string' && raw.message.length > 0 ? raw.message : 'remote call failed'
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
     * @returns the endpoint value.
     */
    async function callRemote(ctx, method, args) {
      const connection = ctx.get('connection')
      if (connection === undefined || connection.rpc === undefined || typeof connection.rpc.call !== 'function') {
        const error = new Error('the client connection is unavailable')
        error.rpcError = { code: null }
        throw error
      }
      const result = await connection.rpc.call('/api', `${NAMESPACE}/${method}`, { args: CALLS[method].wire(args) }, undefined)
      return unwrap(result)
    }

    // ---- one module-level store shared by the menu row and the dialog -------
    const store = {
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
      return {
        useStore,
        async open(sessionId, displayTitle) {
          setStore({ request: { sessionId, displayTitle }, plan: null, phase: 'loading', report: null, errorCode: null, errorMessage: null })
          try {
            const plan = await callRemote(ctx, 'planDelete', { sessionId })
            if (store.request?.sessionId === sessionId) setStore({ plan, phase: 'confirm' })
          } catch (reason) {
            if (store.request?.sessionId === sessionId) {
              setStore({ phase: 'error', errorCode: codeOf(reason), errorMessage: messageOf(reason) })
            }
          }
        },
        close() {
          setStore({ request: null, plan: null, phase: 'idle', report: null, errorCode: null, errorMessage: null })
        },
        async confirm() {
          const request = store.request
          if (request === null) return
          setStore({ phase: 'busy', errorCode: null, errorMessage: null })
          try {
            const report = await callRemote(ctx, 'deleteSession', { sessionId: request.sessionId, confirm: true })
            setStore({ phase: 'done', report })
            try {
              await ctx.get('sessions')?.refresh?.()
            } catch {
              /* the row disappears on the next list refresh anyway */
            }
          } catch (reason) {
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

      const body = []
      if (state.plan !== null) {
        body.push(React.createElement(
          'div',
          { key: 'plan' },
          state.plan.dirCount > 0
            ? t('dialog.plan', { dirs: state.plan.dirCount, size: formatBytes(state.plan.bytes) })
            : t('dialog.planNone')
        ))
        if (state.plan.wasArchived === true) {
          body.push(React.createElement('div', { key: 'archived' }, t('dialog.archived')))
        }
      }
      if (busy) {
        body.push(React.createElement('div', { key: 'busy', role: 'status' }, t('dialog.busy')))
      }
      if (state.phase === 'error') {
        // Show the host's own words whenever there are any: masking a real
        // failure behind a generic hint is how a wrong diagnosis starts.
        const message = state.errorMessage
        const text = state.errorCode === 'session-delete/live'
          ? t('dialog.live')
          : typeof message === 'string' && message.length > 0
            ? t('dialog.failed', { message })
            : t('dialog.noRemote')
        body.push(React.createElement('div', { key: 'error', role: 'alert', style: { color: '#e5484d' } }, text))
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
          { variant: 'outline', disabled: busy, onClick: () => del.close() },
          done ? t('dialog.close') : t('dialog.cancel')
        ),
        !done && React.createElement(
          P.Button,
          {
            variant: 'outline',
            disabled: busy || state.phase === 'loading',
            style: { color: '#e5484d' },
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
        ctx.logger?.warn?.(`dsh-session-ui: locale registration failed: ${String(error?.message ?? error)}`)
      }

      const api = createApi(ctx)

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-delete-dialog',
        locale: NS,
        inject: () => ({ del: api })
      }, DeleteSessionDialog))

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-delete',
        order: 450,
        locale: NS,
        inject: () => ({ del: api })
      }, DeleteSessionMenuItem))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
