# 语音助手第二形态（Voice Assistant / 调度中心）

> 状态：Draft
> 日期：2026-08-13 ｜ 关联 backlog：B-051 ｜ 出处：Owner draft 设想（/goal 2026-08-13）

## 背景

very-happy 现在只有一种形态：「穿在浏览器里的终端」——会话列表 + 聊天/终端
详情。Owner 设想第二形态：类 Siri 的语音助手界面（logo + 动效），通过语音
（按住说话）或文字与一个 **meta-agent** 对话。这个 meta-agent 的本质是调度
中心：经内置 very-happy MCP 操作现有 session（读终端、发消息、管生命周期）、
派发任务（新建 session）；有长上下文与 compact 能力；有记忆系统（个人记忆
对应 Owner agent-system 的 context 体系，grep 检索即可）；可读取 Claude
skills 直接操作（但 prompt 里明确不推荐——它的工作模式是起 session 完成任务，
自己只做调度）。

两形态可一键切换；移动端体验优先；设置里可选音色；第一期只做按住说话；
**现有形态功能零回归**。

## 目标

1. web-v2 新增 `/assistant` 全屏形态：logo 动效（idle/听/想/说四态）、
   按住说话、文字输入兜底、助手回复自动 TTS 播报；与现有形态一键互切。
2. meta-agent 作为**机器侧 Claude Code session**（assistant session）常驻，
   经扩展的 Happy MCP 获得会话管理工具面（list/read/send/spawn/kill、读终端）。
3. 记忆系统：assistant 专属工作目录（CLAUDE.md 角色定义 + memory/ 文件 +
   grep 检索），个人记忆文件路径可配置（Owner 侧符号链接到 agent-system）。
4. 音色设置（synced setting）+ server 端 TTS 流式代理 + 音色列表代理。
5. 三包全部门禁绿；现有聊天/终端/看板/设置全部零回归。

## 非目标（Phase 1 明确不做）

- 不做实时对话（ElevenLabs ConvAI/WebRTC/realtime）——按住说话的
  半双工管线延迟可接受、成本低一个数量级、且不引入新前端重依赖。
- 不做 wake word、不做 barge-in 打断（半双工天然回避）、不做免提连续对话。
- 不做 server 端 LLM loop（零先例 + 零新依赖约束 + 凭据在机器侧）。
- 不动 `docs/plans/` 里上游遗留的 voice 方案；不复活 happy-app。
- 不做多 assistant / 多机器编排（Phase 1 绑定单台在线机器）。
- 不删上游遗留的 voice 死字段/死表（`VoiceConversation`、paywall 计数器等），
  只新增，避免扩大爆炸半径。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| STT 代理已存在：`POST /v1/voice/transcribe` `{audioBase64,mimeType?,languageCode?}` → ElevenLabs `scribe_v1` → `{text}`，authed、**无付费闸门**，复用 `ELEVENLABS_API_KEY`（key 只在 server） | `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`（注册于 `api.ts:111`） |
| `POST /v1/voice/conversations`（ConvAI realtime token）依赖 `REVENUECAT_API_KEY`，缺失直接 500——自托管从未工作过；本设计**不使用**该端点 | `voiceRoutes.ts` |
| web-v2 realtime 是主动砍掉的 shim（14 行，恒 null）；`apiVoice.ts` 的 `transcribeAudio()` 可用但**零消费者**；无 MediaRecorder 代码 | `src/realtime/RealtimeSession.ts`、`src/sync/apiVoice.ts` |
| synced settings 已留 voice 字段（`voiceAssistantLanguage`/`voiceCustomAgentId`/`voiceBypassToken`），均无 UI；**铁律：synced 字段禁 zod `.default()`**，默认值只进 `settingsDefaults` | `src/sync/settings.ts:36-38,44-53` |
| storage 已有 realtime 状态槽（`realtimeStatus`、`realtimeMode:'idle'\|'agent-speaking'\|'user-speaking'`、debounce setter + hooks）可直接复用 | `src/sync/storage.ts:189-192,218-221,1691-1701` |
| 路由是 `react-router-dom@7` `createBrowserRouter`，重屏幕全 `lazy()`；全局单例（CommandPalette/ClipboardHistoryPanel）挂在 `AppLayout` | `src/app/AppRoot.tsx:78`、`src/screens/AppLayout.tsx` |
| iOS 键盘 overlay 的 viewport pin hook 已有，语音界面文字输入必须复用 | `src/app/useKeyboardViewportPin.ts` |
| 麦克风权限探测已有 | `src/utils/microphonePermissions.ts` |
| per-session HTTP MCP（Happy MCP）自动注入给每个 SDK session：`127.0.0.1:0` stateless StreamableHTTP，现有工具 `change_title`/`copy_to_clipboard`；每请求新建 McpServer | `packages/happy-cli/src/claude/utils/startHappyServer.ts`（`runClaude.ts:18` 拉起） |
| stdio MCP `very-happy mcp` 只有 `copy_to_clipboard`；CLI 已有 `@modelcontextprotocol/sdk@1.29`、`@anthropic-ai/claude-agent-sdk` | `packages/happy-cli/src/commands/mcp.ts` |
| spawn 三入口同落 daemon：web `machineSpawnNewSession`→machine RPC `spawn-happy-session`；CLI→daemon 本地控制口 `POST /spawn-session`（`{directory,sessionId?,agent?,environmentVariables?}`） | `src/sync/ops.ts`、`happy-cli/src/daemon/controlServer.ts:129` |
| 发消息到 session：`POST /v3/sessions/:id/messages`（localId 幂等，session key 加密信封）；CLI 侧完整实现 `sendUserMessage()`，session key 来自 `~/.happy/sessions.json`（**只有本机 daemon spawn 过的会话有 key**） | `happy-cli/src/commands/sessionMessage.ts`、`server/v3SessionRoutes.ts:123` |
| 读消息：`GET /v3/sessions/:id/messages?after_seq\|before_seq&limit`；session key 解密 | `v3SessionRoutes.ts:65` |
| 读终端画面：machine RPC `open-terminal` `attachOnly:true` 返回 tmux 权威 snapshot；终端本体是 daemon 机器上的 tmux 会话（**daemon 可本地 `tmux capture-pane` 零 RPC 读**） | `src/sync/ops.ts:machineOpenTerminal`、`happy-cli/src/terminal/webTerminal.ts` |
| 终端 agent 状态推送已有：`TerminalAgentState='working'\|'needs_input'\|'idle'\|'shell'` 经 daemonState 广播——meta-agent 判断「谁在等我」的现成信号 | `src/sync/terminalSync.ts` |
| server↔web 的 RPC 硬超时 30s——所有管理工具必须「下发即返回」 | `server/sources/app/socket/rpcHandler.ts` |
| server「零新 npm 依赖」硬约束（bind-mount 部署）；voiceRoutes 全用裸 fetch 是现成范式 | `CLAUDE.md` 门禁、`voiceRoutes.ts` |
| 「LLM bypass」先例：daemon 侧 `spawn claude -p --model haiku` 一次性调用（titleGenerator/boardAnalyzer），凭据即本机 claude 登录态 | `happy-cli/src/claude/utils/titleGenerator.ts`、`boardAnalyzer.ts` |
| KV store 是 server-trusted 明文 base64，CLI 可读（`vh.board-tasks.v1` 先例）——web↔daemon 共享配置的唯一现成通道；synced settings 是客户端加密 CLI 读不到 | `src/sync/apiKv.ts`、`server/kvRoutes.ts` |
| localSettings 枚举只增不删（整块 safeParse，删值=该设备全部本地设置重置） | `src/sync/localSettings.ts:11` |
| PWA：vite-plugin-pwa generateSW + `push-sw.js` importScripts；SW 缓存混版是已知验收坑 | `vite.config.ts` |
| 会话生命周期收尾：`sessionKill()`（RPC）/`POST /v1/sessions/:id/archive`/`DELETE`（tombstone 防复活） | `src/sync/ops.ts`、`sessionRoutes.ts` |
| daemon spawn handler 解构取参（`params: any` 逐字段解构）——**未知字段天然忽略**，旧 daemon 遇 `variant` 不炸 | `happy-cli/src/api/apiMachine.ts:229` |
| daemon→被 spawn CLI 进程有现成 env 透传管道（`extraEnv`，`HAPPY_FORKED_FROM_SESSION_ID` 先例）——variant 内部用 `HAPPY_SESSION_VARIANT` 传递 | `happy-cli/src/daemon/run.ts:330-348` |
| machine metadata 已带 `happyCliVersion`（zod schema），web 可做版本门控 | `web-v2/src/sync/storageTypes.ts:180` |
| Session 有 `tag` + `@@unique([accountId, tag])` server 端去重创建——assistant 单例免费实现（固定 tag `vh-assistant-<machineId>`） | `server/prisma/schema.prisma`、`sessionRoutes.ts:219` |

## 设计

### 0. 总架构：meta-agent = 机器侧 Claude Code session

三个候选位置里选**机器侧**：

| 候选 | 判定 |
|---|---|
| server 端 LLM loop | ❌ 零先例、零 LLM 依赖、零凭据；「零新 npm 依赖」下手写 agent loop + compact + 工具执行是重造 Claude Code |
| 浏览器端 LLM loop | ❌ 凭据下发到浏览器、页面关闭即死、无文件系统（记忆/skills 都在机器上） |
| **机器侧 Claude Code session** | ✅ compact（自动压缩）免费、skills 发现免费、文件记忆免费、凭据已有（本机 claude 登录态）、消息中继/加密/UI 全部复用——assistant 的完整对话在经典形态里就能审计 |

assistant session 就是一个普通 happy session（`agent: claude`），特殊之处只有三点：

1. **专属工作目录** `~/.happy/assistant/`（daemon 首次启用时创建）：
   - `CLAUDE.md`——角色定义（调度中心人设、工具使用纪律、「优先派 session
     而不是自己动手」「读 skills 允许但不推荐」、回复简短口语化适合 TTS）；
   - `memory/personal.md`——个人记忆（Owner 可换成指向 agent-system context
     的 symlink；CLAUDE.md 指导 assistant 何时读写它）；
   - `memory/journal/`——工作日志（assistant 自己按日期追加，grep 检索）。
2. **spawn 参数 `variant: 'assistant'`**（新字段，旧 daemon 解构忽略→当普通
   session，见兼容矩阵）：daemon 据此把 cwd 定到 assistant home、经
   `HAPPY_SESSION_VARIANT=assistant` env（复用 extraEnv 透传管道）通知被
   spawn 的 CLI 进程——runClaude 据此让 Happy MCP 注册管理工具面、给 session
   metadata 打 `variant:'assistant'` 标记（web 用它找到 assistant session）。
3. **单例语义**：session 创建带固定 tag `vh-assistant-<machineId>`，吃 server
   `@@unique([accountId, tag])` 去重——重复 spawn 幂等返回同一 session；web 侧
   「新对话」= archive 旧的 + spawn 新的（新 tag 带时间戳），记忆在文件里不丢。

**上下文 compact**：直接吃 Claude Code 自带 auto-compact；「新对话」按钮
提供手动清零。CLAUDE.md 指导 assistant 在压缩前把要紧事写进 journal。

### 1. MCP 管理工具面（Happy MCP 扩展，CLI 包内）

扩展 `startHappyServer.ts`：当 session 以 `variant:'assistant'` 启动时，
除 `change_title`/`copy_to_clipboard` 外注册管理工具（全部本地执行，
不走 30s RPC；实现复用 controlClient / sessionMessage / tmux）：

| 工具 | 行为 | 返回 |
|---|---|---|
| `sessions_list` | daemon `/list` + `~/.happy/sessions.json` 汇总（id/title/状态/cwd/agentState） | 即刻 |
| `session_read(sessionId, limit=20)` | REST 拉最近消息 + 本地 session key 解密，输出角色化转写 | 即刻 |
| `session_send(sessionId, text)` | 复用 `sendUserMessage()`（入 outbox 即返回） | 即刻 |
| `session_spawn(directory, prompt?, title?)` | daemon `/spawn-session`，返回 sessionId/url，不等任务完成 | 即刻 |
| `session_kill(sessionId)` / `session_archive(sessionId)` | 控制口 stop / REST archive | 即刻 |
| `terminals_list` | daemonState.webTerminals（id/title/cwd/agentState） | 即刻 |
| `terminal_read(terminalId, lines=80)` | 本地 `tmux capture-pane -p`（含 scrollback 尾部） | 即刻 |
| `terminal_send(terminalId, text, submit=false)` | tmux bracketed paste 写入 PTY（`submit` 才回车——沿用 B-013 不自动回车纪律） | 即刻 |
| `memory_update(section, content)` | 追加/替换 `memory/personal.md` 对应段（个人记忆显式写入口） | 即刻 |

检索纪律：记忆检索不做向量库——assistant 用自带 Grep/Read 工具查
`memory/` 与 skills，简单粗暴（Owner 明确要求）。

安全边界：管理工具只在 assistant variant 注册，普通 session 拿不到；
本 fork 服务端可信 + 单人部署，session key 本就都在本机 `sessions.json`，
不新增信任面。

### 2. 语音管线（Phase 1：按住说话，半双工）

```
按住 ──► MediaRecorder 录音 ──► 松手 ──► POST /v1/voice/transcribe（已有）
                                              │ {text}
      转写文本先上屏（可编辑纠错？Phase1 直发）│
                                              ▼
                    sync.sendMessage(assistantSessionId, text)（已有链路）
                                              ▼
                 assistant session（Claude Code，机器侧）跑工具/调度
                                              ▼
            socket update 增量消息（已有）──► 提取本轮最终 assistant 文本
                                              ▼
                POST /v1/voice/tts（新）──► ElevenLabs TTS 流式 ──► <audio> 播放
```

- **录音**：`MediaRecorder`，`audio/webm;codecs=opus` 优先、iOS Safari 回退
  `audio/mp4`（`isTypeSupported` 探测）；按住说话用 Pointer Events
  （`pointerdown/up/cancel` + `setPointerCapture`），压住 `contextmenu` 与
  长按选择（`touch-action:none`、`user-select:none`）；<500ms 松手判误触丢弃。
- **TTS（新 server 端点，零新依赖，voiceRoutes 范式）**：
  - `POST /v1/voice/tts` `{text, voiceId?, modelId?}` → 裸 fetch ElevenLabs
    `/v1/text-to-speech/{voiceId}/stream`（`eleven_turbo_v2_5`/multilingual，
    调研定）→ 以 `audio/mpeg` 流式透传（Fastify `reply.send(stream)`）。
    文本上限 ~2k chars（超长截断到句边界 + 前端提示）。
  - `GET /v1/voice/tts/voices` → 代理 ElevenLabs voices 列表（name/preview），
    给设置页音色选择用。
- **播放与自动播放限制**：每轮 TTS 播放都发生在「按住说话」这个用户手势
  之后的同一交互链上；首次进入 assistant 形态时用一次点击手势解锁
  AudioContext/audio 元素（静音 play() 预热），iOS Safari 稳妥。
- **播报策略**：只朗读 assistant 的**文本回复**（工具调用过程不读）；界面上
  等宽小字滚动显示工具活动（`session_spawn ✓` 之类），朗读与视觉分工。
  回复太长（>~600 chars）只朗读首段 + 提示「详情在屏幕上」。
- **文字兜底**：底部文本输入框（复用 viewport pin hook），随时可打字，
  回复照常 TTS（可在设置关掉「文字消息也朗读」）。

### 3. 前端形态与切换

- 新顶层路由 `/assistant`（lazy chunk，普通用户不进就不下载）。
- 切换入口：侧栏 header 形态切换按钮（图标：波形/终端互指）+ ⌘K 命令
  「切换到语音助手」+ `/assistant` 直达。assistant 形态里同位置按钮切回，
  **切换不销毁任何状态**（assistant session 活在机器侧，页面只是视图）。
- 界面（Console 设计语言内做「静谧版」）：
  - 全屏 `--bg-0`，中央 logo 动效四态：
    idle=呼吸微光（`--text-faint` 线稿）、listening=按住时 `--accent` 声浪环
    （accent=live 语义完全正确：正在收音）、thinking=细旋转弧线
    （`--text-dim`）、speaking=`--accent` 波形律动。CSS/SVG 动画，不引库；
    `prefers-reduced-motion` 降级为透明度渐变。
  - logo 下方：最近一轮对话文本（user 一行 mono 淡色、assistant 正文）+
    工具活动 ticker（mono、`--text-faint`）。完整历史看经典形态的 session 页。
  - 底部：大按住说话键（拇指热区，≥64px）+ 文本输入 + 「新对话」。
  - 移动端即默认设计对象；桌面同一布局居中限宽。
- 状态机复用 storage 现成槽位：`realtimeMode` 驱动动效四态；assistant
  session 的 agentState（working→thinking）与 TTS 播放态（speaking）合成。

### 4. 记忆系统

| 层 | 载体 | 读写方 |
|---|---|---|
| 工作记忆 | assistant session 上下文本身（+auto-compact） | Claude Code |
| 个人记忆 | `~/.happy/assistant/memory/personal.md`（Owner symlink 到 agent-system context 即完成对应） | assistant 经 `memory_update` 或直接 Edit；随时更新 |
| 工作日志 | `~/.happy/assistant/memory/journal/YYYY-MM-DD.md` | assistant 追加；compact 前固化要点 |
| 领域知识 | `~/code/github/skills`（已在机器上） | assistant 只读，grep 检索；CLAUDE.md 声明「可用但不推荐直接操作，优先派 session」 |

### 5. 设置

- 设置新页 Settings → Voice（`SettingsRoutes.tsx` 是冲突热区，派工时声明）：
  音色下拉（voices 代理 + 预览播放）、语言、「文字消息也朗读」开关、
  assistant 绑定机器选择（Phase 1 默认唯一在线机器）。
- synced settings 新增（**无 `.default()`**，默认值进 `settingsDefaults`）：
  `voiceTtsVoiceId?`、`voiceTtsModelId?`、`voiceReadTextReplies?`、
  `assistantMachineId?`。沿用「旧端忽略未知字段」的 schema v2 合并语义。

### 6. Phase 划分与后续可做（供 Owner 挑选）

- **Phase 1（本 spec 交付）**：上述全部。
- Phase 2 候选：转写先上屏可编辑再发；TTS 句级流水线（边生成边播，降延迟）；
  barge-in（按下即停播）；快捷唤起（PWA shortcut / 长按 app 图标直达
  `/assistant`）；「读给我听」按钮进经典形态消息气泡；每日站会播报
  （assistant 主动汇总各 session 状态）；Web Push「任务完成」点开直接语音追问。
- Phase 3 候选：ConvAI/realtime 全双工、wake word、多机器编排。

## 兼容矩阵与发布顺序

| 端组合 | 行为 |
|---|---|
| 新 web + 旧 CLI | spawn 带 `variant:'assistant'`：旧 daemon zod 忽略未知字段→当普通 session 起在默认 cwd、无管理工具。**web 必须先探测**：经 machine metadata 的 CLI 版本（B-040 骨架）判断不支持则引导升级，不盲 spawn |
| 旧 web + 新 CLI | 完全不受影响（新字段/新端点旧 web 不调用） |
| 新 web + 旧 server | `/v1/voice/tts` 404 → 前端降级为纯文字模式（助手可用、不出声）并提示升级 server |
| 旧 server + 新 CLI | MCP 工具全在机器侧本地执行，不依赖新 server 端点，正常 |

发布顺序：**server → web → CLI**（默认序即可：TTS 端点先行无人调用；web
上线后探测 CLI 版本；CLI 最后发，`vh-update` 后全量能力就位）。
回滚点：三包互相独立回滚均安全（web 降级逻辑覆盖 server 回滚；assistant
session 本质是普通 session，CLI 回滚后它退化为普通会话不炸）。

## 风险

1. **iOS Safari 录音格式/权限**——MediaRecorder mp4 回退 + 已有权限探测；
   真机验证项兜底。缓解：转写失败时保留音频重试 + 文字兜底永远可用。
2. **TTS 流式透传在 Fastify 的背压/中断**——用 Node 流直管 + 客户端断开时
   abort 上游 fetch；成本上限靠 2k chars 截断。
3. **assistant 乱操作 session**（读错终端/发错会话）——工具返回里带
  title/cwd 强化确认；`terminal_send` 默认不回车；CLAUDE.md 写明贵操作
  （kill/archive）先口头复述确认。
4. **单例竞态**（两端同时 spawn assistant）——daemon 侧 tag 查重 + 已存在
   即返回现有 sessionId（幂等）。
5. **SettingsRoutes/WebTerminalScreen 冲突热区**——本批派工显式「别碰
   WebTerminalScreen」；SettingsRoutes 只加独立新页，由主 agent 合并。
6. **ELEVENLABS_API_KEY 成本失控**——transcribe 本就无闸门（现状）；TTS 加
   每账号 60 req/min 限流（复用 webhook 限流手法）+ 文本截断。接受：单人部署。
7. **PWA SW 缓存混版**——验收一律硬刷新后判断（流程已有）。

## 验收标准

- [ ] `/assistant` 形态：按住说话→转写→assistant 回复→TTS 播报全链路通
- [ ] 文字输入兜底可用；「新对话」重置后记忆文件仍在
- [ ] assistant 能经 MCP：列会话、读会话、发消息、spawn 派任务、读终端画面
- [ ] `terminal_send` 默认不回车；kill/archive 有确认话术
- [ ] 音色设置生效（换音色下一轮 TTS 即变）；voices 列表可加载可预览
- [ ] 双形态切换按钮双向可达；移动端布局无横向滚动、无键盘遮挡
- [ ] 旧 CLI 场景：web 提示升级而非静默起普通 session
- [ ] 旧 server 场景：语音降级纯文字，不白屏不报错风暴
- [ ] 三包门禁全绿（web vitest/build/tsc0；cli build+unit+HAPPY_HOME_DIR 隔离冒烟；server tsc+vitest 零新依赖）
- [ ] 新逻辑纯函数化并有单测：录音状态机、TTS 队列/截断、assistant 单例判定、MCP 工具参数校验
- [ ] 现有形态回归：聊天/终端/看板/设置全部可用（E2E 冒烟 + 走查）

## 留真机验证项（shipped 后转 verify-queue）

- iOS Safari / Android Chrome 真机：按住说话手感（误触/滑出取消）、
  MediaRecorder 格式、TTS 自动播放、PWA standalone 下麦克风权限
- 真机双主题下 logo 动效观感与耗电（长时间 idle 呼吸动画）
- 车载/蓝牙耳机场景播放路由（记录即可，不阻塞）
