# dsh-session-delete

中文 | [English](README.en.md)

给 **DeepSeek Harness (DSH)** 补上它官方不提供的**删除会话**能力：把"删除一个已存储会话"做成
运行在宿主进程内、走官方写链的正规能力——而不是外部脚本手改 `~/.dsh`。

> DSH 本身只提供**归档**；清理已存储会话被官方文档归为"带外维护"（out-of-band maintenance）。
> 本插件把这件事自动化，并且顺序正确：**先经 domain 写链摘除注册表引用，再删存储文件**，
> 因此不会出现"内存把已删 id 写回文件"的脏数据。

## 两个入口

| 入口 | 面向 | 说明 |
|---|---|---|
| **侧栏菜单** | 人 | 会话行 `...` 菜单 → 「删除会话…」→ 确认框（显示目标、可释放大小、"不可恢复"警告） |
| **`session_delete` 工具** | 模型/agent | 让 agent 直接删除；支持 `dryRun` 预览、`keepFiles` 只摘引用 |

两者共用同一份删除核心，永不漂移。

## 安装

```bash
dsh plugin --profile web add github:coency/dsh-session-delete
```

本包声明了 `dsh.bundle.patch`，插件管理器会把它作为组合包安装并默认启用。

安装完成后启动（或重启）Web 界面：

```bash
dsh web
```

### 方式二：在 Web 界面里安装

1. 打开 DSH Web 界面，左侧栏点 **插件**；
2. 点 **添加插件**，在输入框填入 Git 地址：`github:coency/dsh-session-delete`（可钉版本：`github:coency/dsh-session-delete#v0.2.0`）；
3. 点 **安装**，等 Host 读出包信息并完成安装后，点 **立即启用**（这一步不能省：直接关闭对话框会保持"已安装但未启用"，不会挂载）；
4. 回到终端重启 `dsh web`（若 profile 是 `patchReload: live` 则当场生效）。

## 用法

**侧栏**：鼠标悬停任意会话行 → `...` → 「删除会话…」→ 确认框里会实时向宿主查询"将删除几个目录、
释放多少空间"，点「永久删除」才真正执行。

**工具**：直接让 agent"删掉某个会话"。或显式调用：

```jsonc
// 预览（不删任何东西）
{ "sessionId": "session-2d79a3ce-569d-4193-b14b-f718a998f7ee", "dryRun": true }
// 只摘注册表引用、保留日志文件
{ "sessionId": "…", "keepFiles": true }
```

**自检工具** `session_delete_selfcheck`（只读、不改任何东西）：升级 DSH 之后跑一次，它会报告插件依赖的
各项宿主契约是否仍然成立——标记写入路径、显式 wire 注册、`defineTool` 解析、工具注册表、工作区注册表方法
（`detachSession` / `unarchiveSession` / `unpinSession`）、会话与投影缓存的存储布局，以及插件/dsh/Node/平台
版本和一句话结论。

**会被拒绝的情况**：

- 正在执行本次调用的那个会话（不能自删）；
- 宿主内存中仍处于活动状态（持有写句柄）的会话 → 先归档它，再重启 `dsh web`。

## 删除到底做了什么

1. **先动注册表**（经 workspace domain 写链，内存与磁盘同时更新）：
   `Workspace.detachSession(id)` → `workspaceRegistry.unarchiveSession(id)` / `unpinSession(id)`。
2. **再删文件**：`$DSH_HOME/sessions/<project>/<id>/` 与投影缓存记录
   `$DSH_HOME/storages/session_projcache/sessions/<id>.json`；项目目录空了顺手删掉。

**不可恢复，不保留备份。**

## 版本兼容与升级检查

**先说清楚**：本插件依赖 DSH 的**内部约定**（不是公开的插件 API）。已在 **dsh 0.1.7-rc.2**（Web profile、
Node v24.14.1、Windows）实测通过——侧栏删除与工具删除都真实删掉了会话。DSH 处于 rc 阶段，内部约定会变，
所以升级后可能出现四种结局：

| 结局 | 症状 | 判断 |
|---|---|---|
| ① 完全可用 | 无异常 | `session_delete_selfcheck` 报 `ok` + 侧栏有菜单项 |
| ② 宿主可用、侧栏入口消失 | 菜单里没有「删除会话…」，但 agent 仍能删 | 只有浏览器半侧受影响（slot 改名时 `slots.inject` 会静默等待，不报错） |
| ③ 单侧失效 | 工具不存在，或点菜单报"远端不可用" | 弹窗/工具错误里会给原始原因 |
| ④ 彻底不可用 | 插件加载报错 | 见下方"最坏情况已消除" |

**升级后 30 秒自检**：

1. 让 agent 跑 `session_delete_selfcheck` → `verdict` 为 `ok` 即宿主契约齐全；
2. 看侧栏会话行 `...` 里有没有「删除会话…」；
3. 真删一条小会话，看结果里的"清理 N 个路径"——**N ≥ 2**（会话目录 + 缓存记录）才算磁盘也清了；若为 0，
   说明存储布局变了、文件没被清掉（注册表引用仍会被正确摘除）。

**依赖清单（按风险排序）**：客户端 slot 键与 props（只影响侧栏入口）> `dsh-client-modules` 的 bundle 形态
（只影响浏览器半侧）> Typert 协议的标记描述符版本与 `ctx.typert.register` 校验（只影响 RPC）> 存储布局
（只影响磁盘清除）> 工作区注册表方法名（改名则删除直接报错，且**在删数据前中止**）> `dsh-tools` 的
`defineTool` DSL（有本地兜底，最差只丢工具）。

**最坏情况已消除**：0.1.0 把 Remote 标记描述符硬编码为 `version: 1`，若协议升级到 v2 且不再接受 v1，网关扫描
我的服务时会抛错，可能连累**整个 `/api`**。0.2.0 改为**调用协议自己的 `Remote(name, context)` 入口**写标记，
版本跟随当前安装的协议；该 API 不可用时才退回 v1 描述符，并把实际路径报告在自检里（`markerSource`）。

**其他**：

- 刻意**不声明任何 DSH peer 依赖**：`dsh plugin add` 会在安装前校验声明的 peer，写死版本会让未来版本必须逐个
  走"版本豁免"，反而抬高安装门槛。若你的 DSH 在安装时被兼容性检查拦下，用
  `dsh plugin --profile web version-exemptions` 查看运行版本，再按提示 `allow-version`。
- 若升级后确实失效，通常只是**几行**的问题（slot 键名、描述符版本、存储路径），可以对着新版 DSH 的包源码直接修。

## 卸载

```bash
dsh plugin --profile web remove dsh-session-delete
```

数据不会被恢复：已删除的会话就是删除了。

## 已知限制

- **删除不可恢复**、不做备份（这是刻意的：备份会让"删除"变成两处存储状态）。
- **活动会话删不掉**：DSH 的日志写句柄由活会话持有；正确姿势是先归档、重启 `dsh web`、再删。
- **子代理会话**的目录名是裸 UUID（不含 `session-` 前缀），本插件的 id 校验同时接受两种拼写。
- **投影缓存里可能残留引用**：例如父会话的子代理目录里会留下 `childId` 记录（只是 id，非会话数据）。
- **宿主插件不受工作区沙箱限制**：它能删 `$DSH_HOME` 下的文件——这正是本功能的前提，代码很短、可审计。

## 开发说明（改代码前必读）

> 仅为本地迭代用：把一个隔离的测试 profile 建在临时 home 里，避免污染你日常使用的 profile。
> 这不是给用户的安装方式。

```bash
export DSH_HOME=/tmp/dsh-test
dsh --profile webtest --from-default-profile web --dump-config   # 先组合出 profile，不启服务
dsh plugin --profile webtest add /path/to/checkout               # 装本地检出
dsh --profile webtest --dump-config | grep session-delete        # 确认 bundle patch 的行已生效
```

DSH 的插件加载有几个会让人反复踩的缓存：

1. **只改加载行的 `name` 不会让宿主重新导入模块**——要改**条目 id**（并配一个新文件名）。
2. **`dsh-client-modules` 对"这个包不是客户端包"的判定永久缓存**：一个包在声明 `dsh.client`
   之前被扫过，就再也不会产生浏览器 bundle，直到重启。
3. **一个包只能有一个客户端半侧来源**：两行指向同一个声明了 `dsh.client` 的包会直接组合失败
   —— 这就是本插件是"一个包 + 一行"的原因。
4. **`?query` 形式的 specifier 不可用**：loader 会把 `?` 百分号编码进文件名，导入报
   `ERR_MODULE_NOT_FOUND`。缓存失效只能靠改文件名或条目 id。
5. **客户端 bundle 在组合时被快照**：改了 `lib/client.js` 而条目没变，浏览器拿到的还是旧 bundle
   （除非 `pnpm run dev:web` 在跑）。
6. **不要从浏览器伪造 Typert contribution**：描述符一旦与宿主契约不一致，网关会以
   `args fields do not match the descriptor` 拒绝，且很难定位来源。wire 契约应由宿主显式注册
   （本插件用 `ctx.typert.register({face:'host', …})` + `src-json` codec，零生成、零构建）。
7. **客户端必须走连接层**：`connection.rpc.call('/api', '<ns>/<method>', { args })`。手搓
   `fetch('/api/…')` 会被信任围栏以 `401 + 纯文本 unauthorized` 拒绝，而纯文本会让
   `response.json()` 抛错，很容易被错误处理掩盖成"远端不可用"。

## 许可

MIT。
