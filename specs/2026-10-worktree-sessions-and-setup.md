# Worktree 会话与初始化（setup 信任边界）

> 状态：Draft
> 日期：2026-10-13 ｜ 关联 backlog：B-585（worktree 初始化）、B-586（网页新建 worktree 会话）｜ 出处：Orca 对照第三轮（`orca.yaml` `scripts.setup` / `worktree.sharedDirectories` / `.worktreeinclude`、`PersistedTrustedOrcaHooks` 按内容 hash 信任）

## 背景

新建 git worktree 后，用户还得手工把 `.env` 拷过去、装依赖，才能让 agent 在里面跑测试。Orca 在建 worktree 时按仓库配置复制被忽略文件、共享 `node_modules`、跑 setup 脚本，并按脚本内容 hash 记录用户信任。

very-happy 现在只有 Teams 与 Automations（`--worktree`）在 daemon 里建 worktree，网页没有入口；`utils/worktree.ts` 是无调用方的遗留代码，还把用户输入拼进 `machineBash` 的 shell 命令。

仓库里的 setup 脚本是**不可信代码**：仓库可能是刚 clone 的第三方项目，脚本也可能被 agent 自己在分支上改过。如果建 worktree 时自动执行，agent 就能借此在沙箱和权限审批之外运行任意命令。

## 目标

1. **B-585**：daemon 内一个初始化模块，处理所有新建的 worktree，Teams、Automations 和网页三条路径共用：
   - 复制配置里列出的未跟踪文件（默认建议 `.env*`），只接受仓库内的相对路径，拒绝 `..`、绝对路径和指向仓库外的符号链接；
   - 可选：给指定目录建链接（如 `node_modules`），默认关闭；
   - setup 脚本：首次运行或内容 hash 变化时，必须在网页上看到完整脚本和执行位置并明确允许。允许记录按 `(machineId, 仓库根真实路径, 脚本 hash)` 存在 daemon 本地 HAPPY_HOME。没有记录时跳过脚本、只复制文件，会话里显示「setup 未运行 · 查看并允许」。
2. **B-586**：网页「新建对话」弹窗增加「在新 worktree 中」，可以选基础分支、填新分支名（自动生成，可改）、选位置（默认放在仓库旁）。创建后在 worktree 里启动会话并执行 B-585 初始化。会话列表显示 worktree 会话的分支名。行菜单增加「归档并删除 worktree…」，默认的归档不删 worktree；删除前检查未提交改动并二次确认。
3. 旧 CLI 不升级也照常工作：网页按 machine metadata 的能力字段显示该选项，旧 daemon 隐藏并提示升级；新 CLI 连旧 server 正常。

## 非目标

- 不兼容读取 `orca.yaml`。CLI 没有 YAML 依赖，引入新依赖或手写 YAML 子集解析器的风险都高于收益；`.worktreeinclude` 也不读。可迁移的字段在下文给出对照，用户手工改成 JSON 即可。
- 不做 archive 脚本、默认终端 tab、VM recipe 等 Orca 的其它 hook。
- 不在网页里编辑 `.veryhappy/worktree.json`（它是仓库文件，从仓库里改）。
- setup 不与 agent 启动串行：Orca 默认 `start-immediately`，这里同样并行，也不提供 `wait-for-setup`。
- 原生 Windows 上不跑 `#!` 脚本（Orca 会改用 Git Bash，这里只明确拒绝并提示），也不支持 WSL 路径。
- 不加 Prisma migration，server 无改动。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Teams 和 Automations 共用 `prepareTeamWorktree(home, repo, id)`，worktree 建在 `HAPPY_HOME/teams/worktrees/<id>`，分支 `codex/team-<id>`，注释写明「no uncommitted input copying」 | `packages/happy-cli/src/daemon/teams/worktree.ts:10-31` |
| Teams worker 调用它，再用 `resource.directory` spawn | `packages/happy-cli/src/daemon/teams/worker.ts:80-86` |
| Automations 的 `action.worktree` 通过 `deps.prepareWorktree ?? prepareTeamWorktree` 调用，id 为 `auto-<runId>` | `packages/happy-cli/src/daemon/automations/runner.ts:152,321-323` |
| CLI 里没有其它 `worktree add` | `grep -rn "worktree', 'add'" packages/happy-cli/src` 只命中上面一处 |
| 网页 `utils/worktree.ts` 无调用方，用 `machineBash` 拼 `git worktree add -b ${name} ${path}` 和 `git worktree remove ... --force` | `packages/happy-web-v2/src/utils/worktree.ts:65-85,163-167` |
| 新建对话弹窗：机器、目录、agent、首条指令，`pendingSessions.create({machineId, path, ...})` 乐观打开 | `packages/happy-web-v2/src/screens/sessions/NewSessionModal.tsx:173-190` |
| spawn RPC 的参数（无 worktree 字段） | `packages/happy-web-v2/src/sync/ops.ts:302-336`、`packages/happy-cli/src/api/apiMachine.ts:479` |
| 机器级 RPC 模块在 `ApiMachineClient` 构造函数里注册（fs、todo 同此模式） | `packages/happy-cli/src/api/apiMachine.ts:349-356` |
| 旧 daemon 对未知 machine RPC 返回普通的 `{error:'Method not found'}`，网页必须显式检查 | `packages/happy-web-v2/src/sync/ops.ts:262-269`（B-276 注释）、AGENTS 铁律 17 |
| machine metadata 的能力字段沿用 `teamsVersion` 模式：daemon 启动后用 `updateMachineMetadata(current => ({...current, teamsVersion: 1, ...}))` 发布（服务器上已有的机器行在注册时不会被覆盖） | `packages/happy-cli/src/daemon/run.ts:1990-1994` |
| 网页 `MachineMetadataSchema` 是 `z.object`，未声明的键会被剥掉，新增能力字段必须写进 schema | `packages/happy-web-v2/src/sync/storageTypes.ts:275-307`、`sync/encryption/machineEncryption.ts:47` |
| 会话 metadata 由 wrapper 写入：Claude 在 `runClaude.ts` 自己构造，其他 runner 走 `createSessionMetadata` | `packages/happy-cli/src/claude/runClaude.ts:204-241`、`packages/happy-cli/src/utils/createSessionMetadata.ts:129-160` |
| 判断 linked worktree 的纯 FS 逻辑已有：`.git` 是文件，内容为 `gitdir: <main>/.git/worktrees/<name>` | `packages/happy-cli/src/sessions/repoIdentity.ts:35-58` |
| 侧栏副标题为 `host · agent · path` | `packages/happy-web-v2/src/utils/sessionUtils.ts:159-166` |
| 归档从 B-566 起是带撤销窗口的延迟提交，没有确认框 | `packages/happy-web-v2/src/app/rowActions.ts:113-167` |
| 行菜单是数据驱动的 `MenuItemDef[]`，可以追加（`kill-attached` 先例） | `packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:1296-1385,1534-1546` |
| 进程组 kill 先例：POSIX 用 `detached` + `process.kill(-pid)`，Windows 用 `taskkill /T /F` | `packages/happy-cli/src/daemon/automations/script.ts:49-57`、`packages/happy-cli/src/update/npmInstall.ts:33-40` |
| 网页本来就能通过 `bash` machine RPC 在机器上执行任意命令 | `packages/happy-web-v2/src/sync/ops.ts`（`machineBash`） |

## 设计

### 1. 仓库配置 `.veryhappy/worktree.json`

从**来源 checkout**（用户选的目录的 git toplevel，也是复制文件的来源）读取，不从新 worktree 读：未提交的本地配置可以生效，而且复制来源本来就是这个 checkout。

```json
{
  "copy": [".env", ".env.*", "apps/web/.env.local"],
  "link": ["node_modules"],
  "setup": "pnpm install --frozen-lockfile",
  "setupWindows": "pnpm install --frozen-lockfile",
  "setupTimeoutMinutes": 10
}
```

| 字段 | 语义 | 校验 |
|---|---|---|
| `copy` | 相对路径或 glob（`*`/`?` 只在单段内匹配，不支持 `**`），只复制**文件** | 拒绝绝对路径、盘符、`..` 段、空段、NUL；最多 64 条 |
| `link` | 相对目录，在新 worktree 里建指向来源的链接 | 同上；最多 16 条；来源必须是来源 checkout 内的真实目录 |
| `setup` | POSIX 脚本正文（macOS/Linux） | ≤ 32 KB |
| `setupWindows` | 原生 Windows 用的 cmd 正文，没有时回退到 `setup` | ≤ 32 KB |
| `setupTimeoutMinutes` | 默认 10，范围 1–60 | 超出范围按边界截断 |

- **没有配置文件时**：网页创建的 worktree 默认 `copy: [".env*"]`（只匹配仓库根），不建链接、不跑 setup。Teams 和 Automations 不用这个默认值，只认仓库里显式写的配置：它们原先承诺「不复制未提交内容」，不能因为升级就悄悄把 `.env` 带进 agent 的 worktree。
- 配置文件本身用 lstat 检查：是指向仓库外的符号链接、大于 64 KB 或 JSON 非法时整份忽略，并把错误写进初始化结果（网页可见）。不半解析。
- Orca 对照：`scripts.setup` 对应 `setup`，`worktree.sharedDirectories` 对应 `link`，`.worktreeinclude` 对应 `copy`。

### 2. 初始化模块（CLI `src/worktree/`）

纯函数和 IO 分开，方便测试：

- `config.ts`（纯）：解析与校验配置，`isSafeRelativePattern`，`globSegmentToRegExp`。
- `copy.ts`：展开 pattern。对每个匹配项先 lstat；符号链接取 realpath，结果必须在来源根的 realpath 之内，否则跳过并记 `outside-repo`。只复制普通文件：目标已存在就跳过（被跟踪的文件 checkout 时已经在了），目标父目录的 realpath 必须在 worktree 的 realpath 之内（防止被跟踪的符号链接目录把写入引到仓库外），用 `COPYFILE_EXCL` 写。上限为单文件 10 MB、总量 50 MB、最多 200 个文件，超出的记 `skipped` 并说明原因。
- `link.ts`：目标不存在时才建；POSIX 用 `symlink(dir)`，Windows 用 `junction`（不需要权限，参考 Orca `worktreeSymlinkTypeCandidates`）。
- `setupRunner.ts`：选择 runner 并执行（见 §4）。
- `store.ts`：approvals 和 worktree 登记表的持久化（见 §3）。
- `initialize.ts`：`initializeWorktree({ source, worktree, branch, baseRef, origin, machineId })`。依次复制、链接，再判定 setup：
  - 没有脚本：`none`；
  - 有允许记录：立即在后台开始运行，状态 `running`；
  - 没有允许记录：`needs-approval`。
  函数在复制和链接做完后就返回，不等脚本结束。

接入点：
- Teams 和 Automations：`prepareTeamWorktree` 在**新建**分支里（不包括复用已有目录）`git worktree add` 之后调用 `initializeWorktree({origin: 'teams'|'automation'})`。只用显式配置；没有允许记录就不跑脚本。初始化出错只记日志和登记表，不让 worktree 创建失败。
- 网页：新 RPC `worktree-create`（§5）创建后调用 `origin: 'web'`。

### 3. 信任记录与登记表（daemon 本地，不进 server）

目录 `HAPPY_HOME/worktree-setup/`，权限 0700，文件 0600：

- `approvals.json`：`{ version: 1, approvals: [{ machineId, repoRoot, hash, approvedAt }] }`。`repoRoot` 是来源 checkout toplevel 的 `realpath`；`hash` 是**最终交给 runner 的脚本正文**（按平台选中的 `setup` 或 `setupWindows`，原样 UTF-8 字节，不做换行规范化）的 sha256。另存一份 `runner` 字段（`posix-sh` / `shebang` / `cmd`）：同一段文本换一种解释器就是另一份代码，所以 runner 也参与 hash，`hash = sha256(runner + "\0" + script)`。上限 500 条，超出时淘汰最旧的。
- `worktrees.json`：以 worktree 的 realpath 为键，值为 `{ repoRoot, branch, baseRef, origin, createdAt, copied[], linked[], skipped[], configError?, setup: { state, hash?, runner?, runId?, startedAt?, endedAt?, exitCode?, message? } }`。`state` 取值：`none | needs-approval | declined | running | succeeded | failed | timed-out | interrupted | unsupported`。上限 500 条。
- `runs/<runId>/`：`setup.sh`、`setup`（带 `#!` 的脚本）或 `setup.cmd`（**被允许的那份字节**），以及 `output.log`（stdout 和 stderr 直接写入文件 fd，日志在磁盘上完整保留）。只保留最新的 100 个运行目录，正在运行的不删。

写入都在 daemon 进程内串行进行，先写临时文件再 rename。daemon 启动时，登记为 `running` 但 pid 已不在的记录改为 `interrupted`。

**TOCTOU**：网页允许时带上它看到的 hash。daemon 重新读配置、重新算 hash，不一致就拒绝（`script-changed`，网页刷新后重新展示）。一致时写入允许记录，并把这次读到的字节写进 `runs/<id>/` 执行，之后仓库里的文件再改也影响不到这次运行。

### 4. 脚本执行

- **cwd**：新 worktree。**stdin**：ignore。
- **环境变量**：继承 daemon 的环境，去掉所有 `HAPPY_*`、`VH_*` 键（daemon 和 Teams 的内部变量与凭据路径），只额外加 `VERY_HAPPY_WORKTREE_PATH`、`VERY_HAPPY_ROOT_PATH` 两个路径。不注入任何 token。
- **POSIX**：脚本以 `#!` 开头时 runner 为 `shebang`，写文件、chmod 0700 后直接 exec；否则 runner 为 `posix-sh`，执行 `/bin/sh -e script.sh`。用 `detached: true` 让脚本自成进程组；超时、取消和 daemon 退出时先对 `-pgid` 发 SIGTERM，10 秒后发 SIGKILL。
- **原生 Windows**：读 `setupWindows ?? setup`。以 `#!` 开头时状态记为 `unsupported`，说明「Windows 上 `#!` 脚本需要 POSIX shell，请提供 setupWindows」，不执行（与 Orca 拒绝 cmd 运行 `#!` 的理由相同：在 cmd 里跑一半比不跑更糟）。否则按 Orca 的 `buildWindowsRunnerScript` 生成 `.cmd`：`@echo off` + `setlocal EnableExtensions DisableDelayedExpansion`，每行 `call <line>` 后接 `if errorlevel 1 exit /b %errorlevel%`；用 `cmd.exe /d /c <runner 路径>` 以 argv 方式启动（不拼自由文本），`windowsHide: true`；停止时用 `taskkill /PID <pid> /T /F`。**支持范围**：Windows 上的代码路径都有单测覆盖，没有在 Windows 真机跑过；至少保证不崩，出错时状态是可读的 `failed`/`unsupported`。
- **超时**：`setupTimeoutMinutes`，默认 10 分钟，到点状态记为 `timed-out` 并杀整个进程组。
- **输出上限**：日志超过 20 MB 即杀进程组，状态 `failed` 并标 `truncated`。
- daemon 停止（`cleanupAndShutdown`）时杀掉所有运行中的 setup，状态记为 `interrupted`，下次启动不会自动重跑。daemon 被硬杀时的孤儿进程组见 T6。

### 5. 机器 RPC（新方法；旧 daemon 返回 `Method not found`）

都注册在 `ApiMachineClient` 构造函数里（`registerWorktreeHandlers`），走 machine key 加密。所有路径参数都要求是绝对路径；出错时抛带稳定 code 的 Error，由 RpcHandlerManager 编码成 `{error}`。

| 方法 | 参数 | 返回 |
|---|---|---|
| `worktree-info` | `{ path }` | `{ repoRoot, currentBranch, branches[≤200], defaultParent, config: { source: 'file'\|'default'\|'invalid', copy[], link[], hasSetup, setupApproved, error? } }` |
| `worktree-create` | `{ path, branch, baseRef, location }` | `{ worktreePath, branch, baseRef, init: { copied, linked, skipped, configError?, setup: { state, … } } }` |
| `worktree-setup-status` | `{ path }` | `{ tracked: false }` 或 `{ tracked: true, origin, branch, repoRoot, setup: {...}, pending?: { script, hash, runner, cwd, repoRoot, changedSinceApproval } }` |
| `worktree-setup-approve` | `{ path, hash }` | hash 不一致：`{error:'script-changed'}`；否则写入允许记录、开始运行，返回同 status |
| `worktree-setup-decline` | `{ path }` | 状态改为 `declined`（之后仍可从横幅重新打开并允许） |
| `worktree-setup-log` | `{ path, offset? }` | `{ text (≤64 KB), offset, size, done }` |
| `worktree-inspect` | `{ path }` | `{ removable, reason?, branch, dirty: string[≤50], dirtyCount }`：只统计**非初始化产物**的改动 |
| `worktree-remove` | `{ path, discardChanges }` | 有改动且 `discardChanges !== true` 时返回 `{error:'dirty'}`；否则删除 |

创建（`worktree-create`）：
- `branch` 用 `git check-ref-format --branch` 校验，并要求它的输出与输入**完全一致**（`--branch` 会展开 `@{-1}` 之类的简写）；分支不能已存在；`baseRef` 必须能 `rev-parse --verify <ref>^{commit}`。
- `location` 必须是绝对路径且不存在，父目录存在或可以创建，并且不在来源 checkout 内部（避免嵌套在仓库里出现未跟踪目录）。默认 `location = <repoRoot 的父目录>/<repo 名>.worktrees/<分支名中 / 换成 ->`。
- 执行 `git worktree add -b <branch> <location> <baseRef>`，用 argv 方式（不经 shell），超时 25 秒（relay RPC 上限 30 秒）。失败或超时会清理残留：删除半成品 worktree、`worktree prune`、删除本次新建的分支（调用前已确认它不存在）。
- 重试幂等：若同一 location 已登记为同仓库、同分支的 web worktree（上次 RPC 应答丢了），直接返回该结果（`reused: true`），不报 `branch-exists`。
- 初始化先登记再复制/链接；任一步失败只记 `initError`（网页 toast + 会话横幅显示「初始化部分失败」），worktree 仍可删除。

删除（`worktree-remove`）：
- 只删登记表里 `origin === 'web'` 且仍是 linked worktree 的目录（不是主 checkout，`git worktree list` 里有它）。Teams 和 Automations 的 worktree 由它们自己的收尾逻辑管理。
- 改动判定：`git status --porcelain=v1 -z --untracked-files=all`，减去登记表里的 `copied` 和 `linked` 路径。setup 生成的未跟踪文件（且没有被 gitignore）**算作改动**，因为删除后同样找不回。
- 删除顺序：先 unlink 我们建的链接（防止递归删除时进入链接目标），再执行 `git worktree remove --force <path>`。分支**保留**，提交不会丢；网页文案写明「分支 X 会保留」。

### 6. 会话 metadata：`worktree`

wrapper 启动时用纯 FS（复用 `repoIdentity` 的判断）检查 cwd 的 toplevel：如果 `.git` 是指向 `<common>/worktrees/<name>` 的文件，就读 `<gitdir>/HEAD` 里的 `ref: refs/heads/<branch>`，写入 `metadata.worktree = { branch, root }`（detached HEAD 时 `branch` 为 null）。这是启动时的快照，会话中途切分支不会更新（风险 5）。Claude（`runClaude.ts`）和其它 runner（`createSessionMetadata`）都写。

网页：`MetadataSchema` 增加 `worktree: z.object({ branch: z.string().nullable().optional(), root: z.string().optional() }).passthrough().nullable().optional().catch(undefined)`。侧栏副标题在路径后追加 `⎇ <branch>`。

### 7. 网页

- **能力判定**（铁律 14 的机器级版本）：`machine.metadata.worktreeVersion === 1` 时才可选「在新 worktree 中」，否则禁用并提示「这台机器的 CLI 版本过旧，升级后可用」。RPC 返回 `Method not found`（比如机器降级后 metadata 里还留着旧字段）时显示同一提示，并回退到普通创建。
- **NewSessionModal**：目录输入下方加一个勾选框。勾选后用 `worktree-info` 加载（防抖 400ms），展开三项：基础分支 `<select>`（默认当前分支）、新分支（默认 `vh/<形容词>-<名词>`）、位置（随分支名自动生成，用户手动改过后不再跟随），下面一行摘要「复制 .env* · setup：需要确认 / 已允许 / 无」。点「创建」后先 `worktree-create`（按钮禁用，200ms 后显示「正在创建 worktree…」），成功后用 `worktreePath` 调 `pendingSessions.create` 并跳转；失败时在弹窗内显示错误，弹窗保持打开。
- **`WorktreeSetupBanner`**（挂在会话页的横幅区，和其它横幅同一位置）：条件为会话有 `metadata.worktree`、机器支持、`worktree-setup-status` 返回 tracked。按状态显示：
  - `needs-approval`：「setup 未运行 · 查看并允许」；
  - `running`：「setup 运行中 · 查看输出」，每 3 秒轮询；
  - `failed`/`timed-out`/`interrupted`/`unsupported`：「setup 失败 · 查看输出」；
  - `succeeded`：「setup 已完成 · 查看输出」，可关闭；
  - `declined`：「setup 已跳过 · 查看」。
- **确认弹窗**（复用 `ns-card` 弹窗结构）：展示仓库、执行位置（cwd）、runner（`/bin/sh -e` / 直接执行 / `cmd.exe`）、超时、hash 前 12 位、完整脚本（mono、等宽滚动区），脚本变更时显示「脚本自上次允许后已变更」。按钮：「不运行」（安静）和「允许并运行」（ink 主按钮）。打开弹窗时焦点落在弹窗容器上，不落在任何按钮上：Esc 可以退出，Enter 不会确认，长弹窗也不会被滚到底部。脚本区保持自身高度（最高 40dvh），由弹窗整体滚动；触屏下按钮高 44px。
- **输出抽屉**：输出在弹窗里以只读 mono 区显示，按 offset 增量拉取，到底后停止。
- **「归档并删除 worktree…」**（行菜单，在归档项后面；只在会话有 `metadata.worktree`、未归档、机器支持时出现）：先 `worktree-inspect`。
  - 不可删时提示原因（例如「这个 worktree 由团队/自动化创建，由它们收尾」）。
  - 干净时用 `Modal.confirm`（destructive）确认，文案为「删除目录 X，分支 Y 保留」。
  - 有改动时再弹第二次 destructive 确认，列出前 10 个文件和总数，`discardChanges: true`。
  - 确认后先 `archiveSessionNow`（不走撤销窗口，删除不可撤销），再 `worktree-remove`。删除失败时会话已归档，弹出原因和路径，用户可以手动处理。

### 被否方案

- **在 `spawn-happy-session` 加 `worktree` 字段**：旧 daemon 会忽略未知字段，直接在基础目录里起会话，用户以为隔离了其实没有，这是静默错误。拆成独立 RPC 后，旧 daemon 会明确返回 `Method not found`。
- **允许记录存 server/settings**：一旦网页或 server 被攻破，就能远程把任意脚本标记为可信；放在本机 HAPPY_HOME，「信任」也就只属于这台机器。
- **按仓库整体信任（Orca 的 `all`）**：仓库内容会变，只认 hash 更安全，代价是脚本每次修改都要重新确认。

## 威胁模型

| # | 威胁 | 场景 | 缓解 |
|---|---|---|---|
| T1 | 仓库脚本自动执行 | clone 来的第三方仓库或 PR 分支里的 `.veryhappy/worktree.json` 写了恶意 setup | 没有允许记录就不执行；允许前展示完整脚本、cwd 和 runner |
| T2 | agent 提权 | 沙箱或权限模式下的 agent 改写 setup 入口脚本，或改写入口会执行的**仓库文件**（`package.json` scripts、`scripts/setup.sh`、postinstall），等下次建 worktree 时在沙箱外执行 | **确认的是入口，不是仓库内容**：hash 只绑定入口文本，改入口一个字节就要重新确认；但 `pnpm install`、`./scripts/x.sh` 实际执行的仓库文件不在 hash 内，agent 改了它们**不会**触发重新确认（残余风险，已接受，弹窗醒目写明）。另外：Teams/Automations 遇到未确认的脚本一律不跑；确认只能在网页上做；沙箱（`buildSandboxRuntimeConfig`）无条件 denyWrite `HAPPY_HOME/worktree-setup`，即使 `workspaceRoot` 覆盖 `~`，agent 也写不了允许记录和已允许的运行快照。弹窗同时写明：允许后，这台机器上团队/自动化为该仓库建的 worktree 也会自动运行同一脚本 |
| T3 | 确认后被替换（TOCTOU） | 用户看到 A，执行时变成了 B | approve 带上 hash，daemon 重新算 hash 比对；执行的是快照到 `runs/` 的那份字节 |
| T4 | 路径穿越与符号链接逃逸 | `copy: ["../../.ssh/id_rsa"]`、`.env` 链到 `/etc/shadow`、被跟踪的符号链接目录把写入引到仓库外 | 校验 pattern；来源 realpath 必须在仓库内；目标父目录 realpath 必须在 worktree 内；`COPYFILE_EXCL` 不覆盖已有文件；有大小和数量上限 |
| T5 | 凭据泄露给脚本 | daemon 环境里的 `HAPPY_*` / `VH_TEAM_SCOPE_FILE` | 剥掉 `HAPPY_*`、`VH_*`；不注入 token |
| T6 | 失控进程 | 脚本 fork 出后台进程、一直挂着、或刷爆日志 | 进程组/`taskkill /T`；有超时；输出超过 20 MB 即杀进程组并标 `truncated`；daemon 退出时清理；daemon 被 SIGKILL 后，下次启动对被中断的记录，只有当该 pid 的命令行仍含这次运行的脚本路径（`HAPPY_HOME/worktree-setup/runs/<runId>/`）时才 kill 其进程组（pid 被复用则不动；组长已退出、只剩子进程的组无法证明归属，不动）；stdin 关闭 |
| T7 | 允许记录被篡改或伪造 | 网页、server 或 relay 被攻破 | 允许记录只存本机 0600 文件。**已接受的残余风险**：攻破网页本来就能调用 `bash` RPC 执行任意命令，所以 setup 确认防的不是被攻破的网页，而是 T1/T2（防止 setup 被静默执行）。确认弹窗的价值在于「给人看清楚」，不是额外加一层身份校验 |
| T8 | 误删数据 | 归档时删除带未提交改动的 worktree；或确认之后又有新改动 | 默认不删；只删网页创建的；检查改动并二次确认；保留分支。确认的是一份改动指纹（路径 + 大小 + mtime）：执行前网页再 inspect 一次，daemon 删除时再比一次，不一致就要求重新确认。**残余窗口**：daemon 最后一次比对到 `git worktree remove` 之间（毫秒级）的编辑仍会丢，已接受 |
| T11 | 不可见字符 | 脚本里的双向控制符、零宽字符、裸 `\r` 让显示内容与执行内容不一致（Trojan Source） | 弹窗把这些字符显示成 `U+XXXX` 标记并给出警告 |
| T12 | link 逃逸 | `link` 条目的中间段是符号链接（`a -> ../outside`，条目 `a/b`） | 对来源取 realpath，必须在仓库内；链接目标用 realpath 结果；含 `.git` 段的条目跳过 |
| T9 | 共享 `node_modules` 双向污染 | worktree 里装依赖改到了主 checkout 的依赖 | `link` 默认关闭；网页摘要显式写出「链接：node_modules」；文档说明风险 |
| T10 | 日志泄密 | setup 输出里打印了密钥 | 日志只在本机，经 machine key 加密的 RPC 按需读取，不进 server 持久化 |

## 兼容矩阵与发布顺序

新增内容：machine metadata `worktreeVersion?: 1`；session metadata `worktree?: {branch, root}`；8 个新机器 RPC。spawn RPC **没有新增参数**；没有新增 server 字段。

| CLI（daemon+wrapper） | server | web | 行为 |
|---|---|---|---|
| 旧 | 新/旧 | 新 | metadata 里没有 `worktreeVersion`，「在新 worktree 中」禁用并提示升级；普通创建、归档不受影响；没有 `metadata.worktree`，不显示分支和横幅 |
| 旧（降级前发布过 `worktreeVersion`） | 任意 | 新 | 勾选后 `worktree-info` 返回 `Method not found`，网页显示升级提示，弹窗保持在普通模式，不会在基础目录误建会话 |
| 新 | 新/旧 | 旧 | 旧网页的 zod schema 会剥掉 `worktreeVersion`/`worktree`，界面不变；Teams 和 Automations 照常建 worktree，并按显式配置复制和链接，脚本没有允许记录就不跑（旧网页无法确认，所以永远不跑，安全侧） |
| 新 | 旧 | 新 | server 不解析 metadata（加密 blob），也不认识机器 RPC 方法（只做转发），功能完整 |
| 新 | 新 | 新 | 功能完整 |
| 新 wrapper + 旧 daemon | — | 新 | wrapper 写 `metadata.worktree`，会显示分支；机器没有 `worktreeVersion`，不显示横幅和删除菜单 |

发布顺序：server/web 先发（纯网页改动，向后兼容旧 CLI），CLI 后发。回滚：网页回滚后新 CLI 的字段被忽略；CLI 回滚后 `worktree-*` 返回 `Method not found`，网页降级显示提示。`HAPPY_HOME/worktree-setup/` 留在磁盘上，旧 CLI 不读。

## 风险

1. **`git worktree add` 在大仓库上超过 25 秒**：RPC 超时，但 worktree 可能已经建好。缓解：网页提示「创建超时，worktree 可能已建好」，并给出路径；再次创建时撞上已存在的路径或分支会明确报错，不会覆盖。接受。
2. **setup 与 agent 并行**：agent 可能在依赖装好前就跑测试。接受（与 Orca 默认一致），横幅会显示进行中。
3. **默认复制 `.env*`**：可能把生产密钥复制进新目录。缓解：只在网页路径、没有配置时生效；摘要里写明；复制的是同一台机器、同一用户已经能读到的文件。
4. **Windows 未经真机验证**：runner 生成和进程树 kill 只有单测。spec 明确了支持范围，留到真机验证。
5. **分支名是启动快照**：会话里 `git switch` 后侧栏显示的还是旧分支。接受；以后由 git 状态轮询更新。
6. **登记表上限 500**：被淘汰的旧 worktree 在网页上不能再「删除」，只能手动处理。接受。
7. **共享热区**：`apiMachine.ts`（加 1 行注册）、`daemon/run.ts`（加能力字段、停止 setup 各 1 行）、`Sidebar.tsx`（追加菜单项）、`storageTypes.ts`（加 schema 字段）、`SessionDetailScreen.tsx`（挂横幅 1 行），都是追加式改动。

## 验收标准

- [x] CLI 单测：配置校验（`..`、绝对路径、盘符、glob）；复制时的符号链接逃逸与目标父目录逃逸；大小和数量上限；hash 绑定 runner；approve 时 hash 不一致被拒；未确认时不执行；Teams/Automations 不用默认 `.env*`；runner 选择（posix-sh/shebang/cmd、Windows 拒绝 `#!`）；`.cmd` 生成；超时后进程组被杀；环境变量剥离；`worktree-remove` 遇到改动时拒绝、只删 web 来源、保留分支；`metadata.worktree` 的识别。
- [x] 网页单测：能力判定（无字段/有字段/`Method not found`）；默认位置和分支名生成；状态到横幅文案的映射；schema 保留 `worktreeVersion`/`worktree`；副标题追加分支名。
- [x] 实跑（独立 HAPPY_HOME_DIR、临时 git 仓库）：创建 → 复制 `.env` → needs-approval → 允许 → 运行成功 → 日志可读；改脚本 → 新 worktree 需要再次确认；拒绝 → 只复制了文件。
- [x] 真浏览器 1280/390 × 亮/暗：新建 worktree 会话、首次确认脚本、hash 变化后再次确认、拒绝后只复制了文件。
- [x] 门禁：cli build + `--version`，相关 vitest；web tsc/vitest/vite build；design lint；gitleaks。

## 留真机验证项

- 原生 Windows：`.cmd` runner、`taskkill /T`、junction 链接（V-，Windows 机器）。
- 手机触屏上确认弹窗中长脚本的滚动和可读性（浏览器 390 coarse 已经验过布局，触屏惯性滚动留到真机）。
