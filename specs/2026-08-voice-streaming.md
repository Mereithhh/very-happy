# 语音助手双向流式管线 + 主动汇报（Phase 2）

> 状态：Final
> 日期：2026-08-14 ｜ 关联 backlog：B-069 ｜ 前身：specs/2026-08-voice-assistant.md（Shipped）

## 背景

Phase 1 是半双工整段管线：松手→整段转写、整段回复→整段合成→播。两个体感短板：
说话时没有实时字幕；长回复出声慢（秒级）。Owner 拍板：双向流式 TTS + 双向流式
ASR + 主动汇报 + PC 文字记录常驻栏；earcon/PWA shortcut/转写可编辑搁置。

## 目标

1. TTS：回复文字边生成边合成边播，首响 <1s；播报中字幕逐句推进。
2. ASR：按住说话期间实时字幕，松手 commit 定稿即发。
3. 两条 WS 均浏览器直连 ElevenLabs（single-use token），**HTTP 旧链路完整保留
   为兜底**——token 铸造失败 / WS 建立失败 / 中途断流，当轮自动回落，永不坏。
4. 主动汇报：assistant 派发的 session 完成时，assistant 主动开口汇报。
5. PC（≥1100px）文字记录改右侧常驻栏，浮层仅存于窄屏。

## 非目标

- 不做全双工/barge-in 语音打断（PTT 按下停播已有）；不做 wake word。
- 不改 Phase 1 的 HTTP 端点行为（兜底依赖它们）。
- 主动汇报不新增 server 端点、不动 webhook 出站契约。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| single-use token 官方端点 `POST /v1/single-use-token/{token_type}`，类型 `tts_websocket` / `realtime_scribe` / `batch_scribe`，15 分钟一次性（业界调研已核） | ElevenLabs docs（调研报告§3） |
| TTS stream-input WS：`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`，逐 chunk SendText、`flush:true` 句级切、回 mp3 chunk + alignment | 同上 |
| realtime STT WS：`wss://api.elevenlabs.io/v1/speech-to-text/realtime`，**只收裸 PCM16/ulaw**（不吃 webm）→ 需 AudioWorklet 抽 PCM；`commit_strategy: manual` | 同上 |
| server voice 路由风格：裸 fetch + zod + authenticate + 无 key 501（mint token 端点照此） | `happy-server/sources/app/api/routes/voiceRoutes.ts` |
| web 语音管线现状：`useHoldToTalk`（MediaRecorder 整段）、`ttsPlayer`（整段 mp3 → AudioContext 队列，onUtteranceChange 字幕）、`apiVoice`（transcribe/tts/voices） | `web-v2/src/assistant/` |
| daemon 已有 agentState 跳变监测（B-012：working→idle 2-tick debounce→webhook notify）——主动汇报复用该状态机 | `happy-cli` daemon（webhook 通知链路） |
| assistant 会话可从 daemon 侧发消息：`sendUserMessage`（session key 在 sessions.json） | `happy-cli/src/commands/sessionMessage.ts` |
| daemon 追踪 assistant：TrackedSession.variant（spawn 时打标） | `happy-cli/src/daemon/run.ts`、`assistantSpawn.ts` |
| 文字记录浮层 `.as-transcript`（absolute 盖 `.as-col`） | `web-v2/.../assistant.css` |

## 设计

### A. server：铸 token 端点（零新依赖）

`POST /v1/voice/token` body `{type: 'tts'|'stt'}`（authenticate）→ 裸 fetch
ElevenLabs `POST /v1/single-use-token/{tts_websocket|realtime_scribe}` → 回
`{token}`。无 key 501；每账号 30/min 限流（同款 limiter）。**token 即授权**，
浏览器拿它直连 WS，API key 永不下发。

### B. web：流式 TTS（`ttsPlayer` 增流式路径）

- 新模块 `ttsStream.ts`：句子切分器（按标点/长度攒句，纯函数）+ stream-input
  WS 客户端。回复文本仍按消息到达（非 token 流——happy 消息本身是整条到的，
  **句级流水线作用于「多条消息陆续到达」与「单条长文本分句」两层**）。
- 播放侧复用现有 AudioContext 队列：WS 回的 mp3 chunk 按句聚合 decode 后入队
  （沿用 stop/dispose/字幕语义，`onUtteranceChange` 改按句推进）。
- 兜底：token 400/501/WS error → 当轮回落 `synthesizeSpeech`（现 HTTP 整段），
  并在会话期内记忆「WS 不可用」少打无谓请求（重进屏重试）。

### C. web：流式 ASR（`useHoldToTalk` 增流式路径）

- 按下：mint token → 开 WS →（并行）AudioWorklet 抽 PCM16@16kHz 上行；
  partial 转写事件 → 实时字幕（新 store 槽 `liveTranscript`，PTT 期间显示在
  user 行位置）。
- 松手：发 commit → 收 final → 走既有 sendText。滑出取消=关 WS 丢弃。
- 兜底：token/WS/Worklet 任一失败 → 当轮回落 MediaRecorder 整段 batch（现链路）。
  注意 iOS Safari AudioWorklet 可用性探测（不支持=直接 batch）。
- MediaRecorder 与 Worklet 不并行跑（同一 stream 二选一，按可用性决定）。

### D. CLI：主动汇报（daemon → assistant session）

- daemon 已有的 agentState 跳变状态机上加一个 sink：当 **非 assistant** 的
  tracked session 发生 working→idle/needs_input 稳定跳变，且本机存在**存活的
  assistant session**，且该 session 是 **assistant 派发的**（spawn 来源标记：
  `session_spawn` MCP 工具 spawn 时在 controlServer 请求带 `spawnedBy:
  'assistant'`，daemon 记进 TrackedSession）→ 用 `sendUserMessage` 给 assistant
  发一条角色化通报：`[系统通报] 会话「<title>」已完成/等待输入（<sessionId>）。
  请用 session_read 核实结果并向用户口头汇报一句结论。`
- 节流：per-session 5min 冷却 + assistant 不存活时静默跳过；不进 server、
  不新协议字段（daemon 本地闭环）。
- web 端零改动：通报触发 assistant 回复 → 现有消息流 → TTS 自动开口。
- CLAUDE.md 模板补一段「收到 [系统通报] 的处理方式：核实→一句话汇报，
  不要复读通报原文」。

### E. web：PC 文字记录右侧常驻栏

≥1100px 且开启时：`.as-root` 变两栏 grid（语音台 minmax(480px,1fr) + 记录栏
380px，`--line` 分隔，`--bg-1` 底），浮层样式仅 <1100px 生效。开关状态存
localSettings（`assistantTranscriptPinned`，枚举只增）。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 server | `/v1/voice/token` 404 → 全部回落 HTTP 链路（Phase 1 行为） |
| 旧 web + 新 server | token 端点无人调用，无影响 |
| 新 CLI + 旧 web | 主动汇报照发（daemon 本地闭环），web 只是多显示一轮对话 |
| 旧 CLI + 新 web | 无 spawnedBy 标记→无通报；语音流式与 CLI 无关，正常 |

发布顺序 server → web → CLI（默认序）；各自独立回滚安全（全部有兜底路径）。

## 风险

1. ElevenLabs WS 协议字段与调研有出入 → 实现 agent 以官方 docs 实测为准，
   发现出入回改本 spec（先例：B-051 固定 tag 两轮修订）。
2. AudioWorklet + iOS：可用性探测 + batch 兜底覆盖；真机项进 verify-queue。
3. 主动汇报风暴（多任务同时完成）→ per-session 冷却 + assistant 端 prompt
   要求聚合汇报。
4. token 端点被滥用 → authenticate + 30/min 限流；token 本身 15min 一次性。

## 验收标准

- [ ] 长回复首响 <1s（本地实测）；播报字幕逐句推进
- [ ] 按住说话时实时字幕出现；松手定稿即发；滑出取消不发
- [ ] 拔网线/挡 token 端点 → 当轮自动回落整段模式，无报错风暴
- [ ] assistant 派发的 session 完成 → assistant 主动口头汇报（≤1min）
- [ ] 非 assistant 派发的会话完成 → 不通报
- [ ] PC ≥1100px 文字记录为右侧常驻栏，窄屏仍浮层
- [ ] 三包门禁全绿；新纯函数（句子切分/PCM 帧打包/通报节流判定）有单测

## 留真机验证项

iOS Safari 流式 ASR（Worklet 可用性/字幕跟手感）、双向 WS 在弱网下的回落体验。
