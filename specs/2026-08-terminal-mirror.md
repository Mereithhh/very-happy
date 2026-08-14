# 终端 Claude 结构化镜像视图（terminal mirror）

> 状态：Final（v3——两轮对抗性 review：R1 修 2 BLOCKING+4 MUST-FIX；R2 修 v2 自引入的
> 截断×resume 去重矛盾 + localId 公式 + M-1~M-4）
> 日期：2026-08-15 ｜ 关联 backlog：B-105 ｜ 出处：Owner 想法 → 调研 agent 报告 → reviewer agent 两轮证伪修订

## 背景

web 终端里跑的 claude TUI 只有 xterm 像素流：可读性受终端渲染约束、复制困难、
长输出回看费劲。目标：读到对话内容后用现有聊天渲染管线提供**可切换的只读
结构化视图**。

## 目标

- 终端页可在 xterm ↔ 结构化视图间**随时来回切换**（一期 toggle，不做双栏——见 N1）；
  切换必须无损（xterm 侧 tmux 会话始终活着，结构化只是另一面镜子）。
- **移动端是首要场景**（Owner 明确：手机上 TUI 渲染体验差，结构化视图是主要收益面）：
  toggle 在移动端必须一眼可达（header 级入口，不藏菜单）；切换状态按终端记忆
  （localSettings，设备本地——手机常驻结构化、桌面常驻 xterm 是预期形态）。
- 结构化视图复用现有 ChatList/MessageView 全部渲染能力（工具特化/复制/thinking）。
- 用户在终端手敲的 claude、resume/compact/fork 均被镜像；镜像严格只读。
- 对现有会话体系零污染（侧栏/看板/通知/语音助手都不把镜像当普通会话）。

## 非目标

- 镜像不可交互（不发消息、不批权限）；要交互=回 xterm 或用 happy 开正式会话。
- 一期不做双栏并排（xterm FitAddon 挤压是铁律 6 惯性坑区）。
- 不做 API 拦截流派（claude-trace/claude-tap 式 proxy——对手敲场景侵入过大）。

## 现状事实（代码已确认，含 reviewer 逐条 verdict）

| 事实 | 位置 | verdict |
|---|---|---|
| mapper 输入=transcript JSONL 行（RawJSONLines）输出=SessionEnvelope；web reducer 吃 envelope（注意 web 是**自己复制的 zod schema**，不 import happy-wire，协议改动要同步两处） | `happy-cli/src/claude/utils/sessionProtocolMapper.ts:1-25`、`apiSession.ts:506-515`、web `sync/reducer/reducer.ts:131-162` | 属实 |
| SDK 路径先经 SDKToLogConverter 转 JSONL 行再进同一 mapper | `claudeRemoteLauncher.ts:126,195` | 属实 |
| 「JSONL 全量→envelope」的生产先例=**local launcher**（全量转发仅屏蔽 summary）+ fork backfill；remote 模式 scanner 只转发 user 行 | `claudeLocalLauncher.ts:12-21`、`runClaude.ts:286-300,409-431` | 属实（先例比初版 spec 说的窄） |
| scanner：多文件续接、uuid 去重（resume 重写 sessionId 但保 uuid）、`treatExistingAsProcessed`、missing-file 60s 放弃+deadSessions 黑名单；resume/compact 接管靠**调用方**在 hook 回调里 `onNewSession` | `sessionScanner.ts:62-135,202-214` | 属实 |
| daemon 持有 credentials+machineId 且有 ApiClient，但**从未自己建过 session、从未 host 过 ApiSessionClient**（assistantSpawn 是 spawn 子进程让 CLI 自建，不是先例）；outbox 纯内存 | `daemon/run.ts:169,756,1082`、`apiSession.ts:454-501` | 有偏差→本 spec 已按此设计 |
| `getOrCreateSession` 每次 mint 新 key，server 对已存在 tag 保留**首个** dataEncryptionKey——固定 tag 复用=解密失配（B-051 事故墓碑） | `runClaude.ts:129-136` 注释 | 属实（B2 由来） |
| 会话加密无阻断：dataKey 变体把 session key 加密给账号 publicKey，web 持账号私钥可解 | `api/api.ts:41-53` | 属实 |
| daemon 侧会话持久化先例：`persistSession`（PersistedSession 含 encryptionKey/variant/seq） | `persistence.ts:410` | 属实（B2 解法载体） |
| hook 基建是 per-runClaude-process（随机端口、per-pid `--settings` 注入、进程退出即 stop）；forwarder 只认 argv 端口、无 env 逻辑——全局 hook+daemon 常驻端点是**仿写不是复用** | `startHookServer.ts:151`、`generateHookSettings.ts:25-30`、`session_hook_forwarder.cjs:13-17` | 有偏差→工作量按仿写计 |
| tmux `-e` 注入先例（≥3.2 gated、create-only）；**set-environment 只作用于新建 pane**，存量终端里已运行的 shell 拿不到 | `webTerminal.ts:657,659-671,1296-1300` | 属实（M3：存量终端只有 cwd 降级） |
| classifyPane 识别 claude 但 `looksLikeClaudeCommand` 把 node/版本号 argv0 都算——只配当降级信号 | `webTerminal.ts:510,546-556` | 属实 |
| server 消息幂等：`@@unique([sessionId, localId])` + v3 批量 POST 重放零副作用 + `GET /v3` after_seq 分页；但 CLI 现在 localId=randomUUID（重放不幂等）；v1 GET 有 150 条硬 cap 别用 | `schema.prisma:126-139`、`v3SessionRoutes.ts:117-235`、`apiSession.ts:495`、`sessionRoutes.ts:333` | 属实（M1 由来） |
| web presence=server `active` bool 无心跳；AgentInput.canSend 不看 presence；未知 flavor 被 normalizeAgentKey 归一成 claude（菜单全可点）；board「等我看」用 `presence==='online'` | `storage.ts:59`、`AgentInput.tsx:218`、`agentDefaults.ts:41-46`、`boardItems.ts:175-179` | 属实（B1 由来） |
| 隐藏会话过滤先例 isAssistantSession：web 8 个 call site + 2 条无过滤 lane（useAllSessions、feed 通知）+ cli `sessions_list` 只标注不过滤；该文件注释已预留拓宽为通用 predicate 的形状 | `storage.ts:272,508,1527,1636`、`sidebarRows.ts:22`、`boardItems.ts:237,385`、`MachineScreen.tsx:55`、`CommandPalette.tsx:251`、`sync.ts:2765`、`assistantTools.ts:71` | 属实（B1 解法） |
| Owner 真实数据：`~/.claude/projects` 529MB / 535 jsonl / 最大 44MB≈10900 行；44MB 全量 read+parse ≈107ms 主线程；daemon 同一事件循环还中继所有 PTY | 实测 | 属实（M2 由来） |
| mapper 顺带产出 usage 上报与 summary→metadata（镜像免费获得 context meter；自动标题要显式接 titleGenerator，不是自动有） | `apiSession.ts:517-534`、`runClaude.ts:420-430` | 属实 |

## 设计（决策全部落死）

### 绑定：全局 SessionStart hook（主）+ tmux env（身份）+ cwd 推断（降级）

- `happy install-terminal-hooks` 显式命令：往用户 `~/.claude/settings.json` 写
  **SessionStart + SessionEnd 两个 hook**（成对安装、成对 `--remove`；M-1——
  生命周期主路径依赖 SessionEnd）。hook 脚本是**新写的** forwarder 变体：
  先判 `HAPPY_MANAGED` 已设即静默退出（见双份上传防护），再判 `VH_TERMINAL_ID`
  未设即静默退出；否则读 daemon 控制端口（`daemon.state.json.httpPort`，现成载体）
  POST `{hook_event_name, session_id, transcript_path, cwd, source, terminalId: $VH_TERMINAL_ID}`，
  daemon 端点按 `hook_event_name` 分发。
- daemon 在 tmux create 时 `-e VH_TERMINAL_ID=<id>` **并同时 `-e
  VH_HAPPY_HOME_DIR=<configuration.happyHomeDir>`**（照 CLAUDE_CLASSIC_RENDERER_ENV
  位置，≥3.2 gated；后者是风险 7 的落实——forwarder 用它定位创建该终端的 daemon
  变体的 `daemon.state.json`，dev/stable 双 daemon 并行时不产生跨变体孤儿绑定）。
  **存量终端（daemon 升级前建的）不补注**——set-environment
  只影响新 pane，如实降级到 cwd 推断（UI 标「推断绑定」；v1 实现只做 env 主路径，
  cwd 推断降级列为 v2——见「实施裁剪」）。
- **双份上传防护（M-2，主防线=确定性 env 标记）**：happy 自己启动 claude 时经
  `claudeEnvVars` 注入 `HAPPY_MANAGED=1`——**注入必须在 runClaude 组装
  claudeEnvVars 处（local 与 SDK/remote 两路共用）**，两路透传点均已验证：
  `claudeLocal.ts:260-263`、`claudeRemote.ts:80-83`+`sdk/query.ts:74-81`（只改
  local 一路会让 remote 模式的双份上传漏回来——MF-2）。forwarder 见之即退，
  确定性挡掉「vh 终端里跑 `happy`」场景。
  「查 tracked sessions 的 claudeSessionId」只作兜底（它有结构性竞态：claude 分配
  session id 发生在 session webhook 之后，`assistantSpawn.ts:59-67` 注释为证，
  hook 到达时 daemon 大概率还不知道该 id）。
- claude 自身的 per-process hook（happy 启动的会话）与全局 hook 共存：claude 会同时
  执行 user settings 与 --settings 两组 hook，各自投递，端口不同无冲突。
- Owner 部署注意：`~/.claude/*` 归 chezmoi 管，hook 配置须进 chezmoi 源否则被 apply 覆盖。

### 影子会话与 key 管理（B2）

- daemon 收到绑定（source=startup）→ `getOrCreateSession`（**随机 tag**，绝不固定 tag
  复用）建影子会话，metadata：`flavor:'terminal-mirror'` + `terminalId` + `path`(cwd)
  + `machineId` + `claudeSessionId`。
- **持久化走 persistSession 先例**：encryptionKey/tag/seq 落
  `~/.happy/`（PersistedSession），daemon 重启后 reconnect 形态复用同一影子会话
  （不 mint 新 key——B-051 雷区护栏）。持久化记录以 terminalId+claudeSessionId 索引。
- **复用规则（M4②拍板）**：source=resume/compact/fork 且能续上已有镜像（同 terminal、
  hook 给的旧 transcript 链）→ 复用同一影子会话（scanner `onNewSession` 续接新文件，
  **必须带 `treatExistingAsProcessed`**——新文件的历史前缀视为「盘上已有=server 已有」，
  现成先例 `runClaude.ts:460`；镜像做过 backfill 截断，uuid 去重集不完整，
  靠它跳前缀会把古老历史当新消息灌回去）；source=startup 的全新 claude →
  新影子会话。一个影子会话 ≈ 一段连续对话史，与 claude 自身的 resume 语义对齐。
  持久化索引在续接时**更新**到新 claudeSessionId（resume 换 id，键会漂移）。
- daemon 为每个活跃镜像 host 一条 ApiSessionClient（**新形态，无先例**，注意 outbox
  纯内存——丢队列由 M1 的重放幂等兜底）。

### 消息幂等（M1）

- mirror 路径的 envelope localId = **`mirror:<行key>:<envelope序号>`**。行 key：
  user/assistant/system 行用 uuid（v4，跨文件全局唯一且 **resume 重写 sessionId
  时保留 uuid**——所以公式里**不得**掺入 claudeSessionId，否则 resume 前后同一行
  算出不同 localId、server 幂等失效）；summary 行用 `summary-<leafUuid>`。
  **实施修正（v3→实现）**：原公式 `mirror:<uuid>` 无序号——但 mapper 一行 JSONL
  会产出 0..N 条 envelope（`sessionProtocolMapper.ts`
  `mapClaudeLogMessageToSessionEnvelopes` 返回 envelopes 数组：turn-start、
  分块 text/tool-call 等），单一 localId 会让同行第二条起全部被
  `@@unique([sessionId,localId])` 当重放吞掉。加序号后仍确定性：重放同一行时
  重复序号照旧去重，重放因 mapper 状态差异少产出的 envelope 只是少发（无害）。
  server `@@unique([sessionId,localId])` 天然去重 → daemon 崩溃/重启后重放零副作用。
- 补齐水位用 `GET /v3` after_seq 分页（不用 v1 的 150 条 cap 接口）。

### 性能（M2，一期必做不推二期）

- scanner 用于 mirror 时改 **append-only offset tail**（transcript 不原地重写；
  resume/fork 是新文件，老文件只增不改；新文件的历史前缀由 `treatExistingAsProcessed`
  整体跳过——见复用规则，**不靠 uuid 去重兜**）。
- 首次绑定 backfill **截断**：只回灌最后 N 行（默认 500，可配）——44MB/万行会话
  全量回灌（≈220 个批量 POST）不做；截断点插一条系统提示「更早内容看终端」。
- claude 退出（SessionEnd hook 或 classifyPane 变化）/终端关闭 → 撤 watcher
  （M4③；535 个历史文件说明幽灵 watcher 是真实风险，deadSessions 先例保留）。

### web 侧只读与全面过滤（B1）

- **predicate 拓宽**：`isAssistantSession` 所在文件按预留形状拓宽出
  `isHiddenSession`（assistant ∪ terminal-mirror），8 个 call site 换用 +
  两条无过滤 lane（`useAllSessions`、feed 通知 `sync.ts:2765`）补过滤 +
  cli `assistantTools.sessions_list` 对 mirror 过滤（不让语音助手当任务报）。
- **镜像专用渲染 gating**（按 flavor==='terminal-mirror'）：藏 AgentInput 整行
  （不是禁用——canSend 不看 presence，留着必出事）、藏 permission UI、
  禁模型/权限/effort 菜单、board 全排除（不进「等我看」——presence 判定对
  镜像无意义）、通知生成器排除。
- 入口：终端页 header toggle（xterm ↔ 结构化），移动端 header 级一眼可达；
  终端列表 push 加 `mirrorSessionId` 字段让 web 知道可切。镜像视图顶部横幅注明
  「只读镜像 · 比终端慢半拍 · 交互请回终端」。
- **needs_input 可见性（M-3①，v1 必做）**：permission 对话框是 TUI 层的、不进
  transcript——手机常驻结构化的用户会看到会话「卡住」而不知道 claude 在等审批。
  结构化视图顶部消费终端 push 里现成的 AgentState（classifyPane 的
  needs_input/working/idle）：needs_input 时显著横幅「claude 正在终端里等待输入 →
  点击切回」。
- **切换态两级偏好（M-3③）**：设备级默认 `terminalViewDefault: 'xterm'|'structured'`
  + per-terminal 覆盖（z.record，`acknowledgedCliVersions` 先例），都在 localSettings
  ——否则「手机常驻结构化」达不成（每个新终端都得手动切一次）。per-terminal
  record 随 closedTerminals 清理防无限累积。
- **终端死后历史可达（M-4）**：closedTerminals 记录（B-084）带上 `mirrorSessionId`，
  归档视图给「查看结构化历史」链接——否则 mirror 被 isHiddenSession 全面隐藏后，
  终端一关历史就无入口（而「长输出回看」正是本功能动机之一）。
- 直达 URL `/session/<mirrorId>` 允许打开（同 assistant 会话先例），渲染同样 gating。
- summary 行**不屏蔽**（别照抄 local launcher）：mapper 免费把 transcript summary
  写进 metadata.summary → 移动端 header 有标题（N-3）。

### 实施裁剪与定稿修正（实现批回流，2026-08-15）

- **cwd 推断降级在 v1 实际不可达，明确裁剪为 v2**：定稿 forwarder 规则是
  「`VH_TERMINAL_ID` 未设即静默退出」，所以存量终端（无 env 标记）的 hook 根本
  到不了 daemon——「cwd 推断（降级）」与 forwarder 规则自相矛盾。v1 取 forwarder
  规则为准（确定性优先，避免风险 3 的同目录歧义面）；存量终端在 daemon 升级后
  新建的终端自然获得 env 标记。「推断绑定」UI 标注随 cwd 推断一并推 v2。
- **SessionStart source='clear' → 新影子会话**（spec 原文只列了
  startup/resume/compact/fork）：/clear 在 claude 语义上是全新对话（新 id、
  历史清空），与「一个影子会话 ≈ 一段连续对话史」对齐，归 startup 类。
  resume/compact 及未知 source：同 terminal 已有镜像则续用，没有则新建。
- **backfill 截断提示的载体**＝`sendSessionEvent({type:'message', ...})`
  （现成 agent event 渲染管线），不发明新 envelope 类型。
- **daemon 重启恢复的判活门**：只恢复 metadata.lifecycleState==='running' 且
  对应 tmux 会话（`vh-<terminalId>`）仍存活的镜像；恢复动作维持 MF-1 原拍板
  ——重放尾部 N 行 + localId 幂等去重（正是为了覆盖 daemon 停机窗口内 claude
  写入的行，不改为「从 EOF 续」）。

### 交互边界与二期通路（M-3②）

「要交互=回 xterm」在手机上正是体验最差的路径，与「手机常驻结构化」存在张力。
v1 接受此边界（镜像严格只读），但架构**不得堵死**二期通路：结构化视图底部未来可嵌
`terminalInputBarMode` 的行输入条（`localSettings.ts:60-65` 现成机制，整行组稿→
送 pty→回车）——输入走 **pty 通道**而非会话消息（镜像会话保持只读，敲的字经
transcript 自然回流镜像），与本方案零冲突。v1 实现不做，但组件留槽位。

### 生命周期（M4①③）

- claude 退出：SessionEnd hook（主）/ classifyPane 不再 claude（辅）→ 停 scanner、
  影子会话 `deactivateSession`（api.ts:459 先例）+ metadata lifecycleState 标记。
- 终端关闭（tick-diff 消失点 `webTerminal.ts:1116-1124`）→ 同上 + 归档。
- daemon 重启：从 PersistedSession 恢复活跃镜像绑定；**文件位置不持久化 seq**
  （seq 是 server 消息序号，不是字节 offset——MF-1）：重启时直接 tail 尾部 N 行，
  重复消息靠 localId 幂等兜（选定此路，免维护 per-file offset 持久化）。

## 兼容矩阵与发布顺序

- server **零改动**。web 不认识 `terminal-mirror` flavor 的旧版本：会话会**泄漏**进
  侧栏（老 web 无 isHiddenSession）——接受（旧端忽略新字段原则的代价面），
  发布顺序 web 先于 CLI 即可避免用户可见期。顺序：**web → CLI(tag) → vh-update**。
- 老 CLI + 新 web：无镜像功能，零影响。
- 回滚：CLI 回滚即停产新镜像；已有镜像会话是普通归档会话，无害。

## 风险

1. daemon host ApiSessionClient 无先例（进程内多 session socket + 内存 outbox）——
   M1 幂等兜底 + 实现时单独压测多镜像并发。
2. transcript 格式无契约——宽松 zod+passthrough 惯例，未知类型静默跳过。
3. cwd 降级路径同目录多 claude 歧义——「推断绑定」标注 + 绑错可手动解绑（v2 再议）。
4. 全局 hook 写用户 settings——显式命令+幂等+可卸载；chezmoi 用户手动入源。
5. offset tail 对文件截断/替换的极端场景（手动删 transcript）——offset > size 时
   重置为 0 并靠 localId 幂等防重复。
6. 双份上传防护依赖 daemon 对 tracked sessions 的实时性——竞态窗口内可能建出
   空镜像，超时无消息自动归档兜底。
7. （实现注意）Owner 机器 dev+stable 双 daemon 并行时（`run.ts:49` hostSuffix
   先例），forwarder 按 HAPPY_HOME_DIR 对应的 `daemon.state.json` 读端口，
   避免跨变体孤儿绑定。
8. （实现注意）offset-tail 模式下 `treatExistingAsProcessed` 可直接实现为
   「起始 offset=当前 EOF」——O(1) 免读全文件，比预标 uuid 集更贴新机制。

## 验收标准

- [ ] vh 终端手敲 claude → 侧栏不出现新普通会话；终端页出现「结构化」toggle
- [ ] 切换后对话以聊天视图渲染（工具特化/复制/thinking 全可用），输入框不存在
- [ ] TUI 里 /compact、Esc-fork、退出后 `claude --resume` → 镜像连续不断裂不重复
- [ ] daemon 重启 → 同一影子会话续传（不新建、不解密失配、不重复消息）
- [ ] 44MB 级长会话绑定 → backfill 只回灌尾部 N 行、打字延迟无可感退化
- [ ] 在 vh 终端里跑 `happy` → 不产生双份上传（HAPPY_MANAGED 主防线生效）
- [ ] 看板/通知/语音助手 sessions_list/⌘K/机器页全都看不到 mirror 会话
- [ ] claude 卡在权限请求时，结构化视图有 needs_input 横幅且点击可切回 xterm
- [ ] 设备级 terminalViewDefault=structured 后，新终端在该设备默认进结构化视图
- [ ] 终端关闭后，归档视图的已结束终端记录可跳转其结构化历史
- [ ] resume 前后 daemon 重启重放 → 无重复消息（localId=mirror:<uuid> 幂等）
- [ ] 老 web（无 isHiddenSession）下的泄漏面已知且发布顺序规避
- [ ] 门禁：三包各自全绿 + CLI 运行冒烟（铁律 2）

## 留真机验证项

- 结构化视图与 TUI 的滞后体感（流式 turn 中切换）
- 多终端并发镜像时的终端打字延迟
- iPad/手机上 toggle 的触达与观感
