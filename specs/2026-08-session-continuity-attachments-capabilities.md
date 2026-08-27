# 会话连续性、附件与 Claude 能力呈现

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-236、B-237、B-238、B-239

## 背景

App 从后台或其他 session 返回时，会先用不含瞬时活动状态的 HTTP session 快照覆盖本地
`thinking`，直到下一次 daemon keepalive 才恢复，造成明显闪断。普通对话的附件入口又把
所有非图片文件静默丢弃，PDF 即使上传成功也会在 Claude adapter 被跳过。与此同时，Claude
SDK 的 plan mode 已完整接通，sub-agent 可以执行，但生命周期和部分 task 进度没有产品化
呈现。最后，一批等待 RPC/API 的按钮只做了禁用，没有一致的忙碌反馈。

## 目标

- 非权威 HTTP session 快照不得清除已知的瞬时 `thinking` 状态；session 切换和 Web resume
  期间主要消息区持续显示运行态。
- 普通 Claude 对话支持图片与 PDF 的选择、粘贴/拖放、预览、上传和 SDK document block；
  不支持的文件必须明确提示，不能触发浏览器默认导航。
- 保持 plan mode 现有完整链路，并让 sub-agent 的开始、结束和嵌套工具在 App 内可感知；
  不伪造 SDK 没有提供的状态。
- 所有本批触及、且确实等待异步接口的 App 操作具有局部 loading、重复提交保护和错误收口。

## 非目标

- 不把任意 Office/压缩包转换为 Claude 文档；本批仅支持 Claude SDK 原生接受的 PDF 和图片。
- 不允许 App 动态定义新的 Claude agent；项目/用户 settings 中已有 agents 继续由 SDK 发现。
- 不把同步快照永久改成 `thinking` 权威来源，也不以乐观值冒充 daemon 真实运行状态。
- 不给复制、展开、切换纯本地 UI 等瞬时操作添加假 loading。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| `/v1/sessions` 不返回 thinking，但 Web 解密快照时硬写 `thinking:false` | `packages/happy-web-v2/src/sync/sync.ts:987` |
| 通用 `applySessions` 按入参清空/重建 thinking 计时 | `packages/happy-web-v2/src/sync/storage.ts:474` |
| picker、paste、drop 和 preview 均限制为 image | `packages/happy-web-v2/src/screens/session/AgentInput.tsx:386`、`useAttachments.ts:12` |
| attachment server 只存加密 blob；canonical file event 已有 optional mimeType | `packages/happy-server/sources/app/api/routes/attachmentRoutes.ts:186`、`packages/happy-wire/src/sessionProtocol.ts:42` |
| Claude adapter 只识别四类图片，SDK 类型已包含 PDF document block | `packages/happy-cli/src/claude/claudeRemoteLauncher.ts:363` |
| mapper 已发 subagent start/stop，但 Web normalize 无条件丢弃 | `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts:341`、`packages/happy-web-v2/src/sync/typesRaw.ts:590` |
| ExitPlanMode 的 SDK mode 更新、审批和 Web Markdown 卡片已有覆盖 | `packages/happy-cli/src/claude/permissionHandler.ts:118`、`packages/happy-web-v2/src/screens/session/PermissionCard.tsx:49` |
| 通用 Button 已提供 loading、禁用和 aria-busy 语义 | `packages/happy-web-v2/src/components/ui/Button.tsx:1` |

## 设计

### 1. 瞬时状态的权威边界

新增纯函数只在 `fetchSessions()` 的 HTTP 快照适配层，把当前 store 中同 session 的
`thinking/thinkingAt` 合并进快照。WebSocket activity、turn lifecycle 等权威事件仍原样进入
`applySessions`，因此真实的 `false` 仍能终止运行态。ChatList 的初次消息加载态也必须保留
`SessionLiveStatusBar`，避免状态存在但被 loading 分支遮住。

### 2. 通用附件模型

`AttachmentPreview`/`UploadedAttachment` 保留 `mimeType`；图片才生成尺寸和 thumbhash，PDF
使用文件 chip。选择、粘贴和拖放共用同一个支持类型判定。只要 drag payload 含 Files，drop
就先阻止默认行为，再分别加入支持项并提示拒绝项。object URL 在失败、删除、清空和卸载时
回收。

Web 继续使用既有 opaque attachment endpoint。file event 写入 optional `mimeType`，新 CLI
仍以解密后 magic bytes 为准：图片转 image block，`%PDF-` 转 base64 document block；有附件
但文本为空时不追加空 text block。

### 3. Claude 能力呈现

Plan mode 不重写。sub-agent 沿用现有 cuid2 映射和 `start/stop` envelope，Web 将 lifecycle
normalize 成轻量 agent event，并在父 Agent/Task 卡片与消息流显示运行/完成状态。SDK
`task_*`/`tool_progress` 后续只有在能稳定关联现有 subagent/tool id 时才映射；本批不把
不可关联的 advisory frame 伪造成聊天内容。metadata 增强不阻塞 sub-agent 的实际执行。

### 4. 异步交互反馈

复用 `Button loading` 和现有 Spinner。发送、停止、queue 立即插入、设置保存/删除、机器操作
等等待接口的 action 采用局部 busy key；pending 期间禁用重复触发并设置 `aria-busy`。失败后
恢复可操作状态并走既有 toast/modal。只等待本地渲染的按钮不加 spinner。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 旧 CLI + 新 Web | 图片照常；Web 不向能力未知的旧 daemon 承诺 PDF 成功，发送失败有提示；新的 optional lifecycle/mime 字段缺省降级 |
| 新 CLI + 旧 Web | optional `mimeType` 被忽略；图片照常；PDF 可到达 CLI，旧 Web 仅以普通 file 事件展示 |
| 新 CLI + 新 Web | PDF document block、文件 chip、持续 thinking 与 sub-agent lifecycle 完整生效 |

发布顺序：CLI → `vh-update` 重启 daemon → Web。回滚 Web 不影响 CLI 图片路径；回滚 CLI 后
Web 应拒绝/提示 PDF，而不是静默发送。server 无协议变更，无需发布。

## 风险

1. 错误保留 thinking 会造成永远运行：仅在 HTTP 快照入口保留，权威 activity/turn-end 测试
   必须证明可清零。
2. 浏览器 MIME 可伪造：CLI 只信 magic bytes；不匹配即跳过并向消息发送结果报告失败。
3. 加密后 10MB 上限略小于原文件 10MB：Web 采用保守原文件上限并在选择阶段提示。
4. 生命周期事件跨版本：所有新增字段 optional，未知事件不得破坏主聊天解析。

## 验收标准

- [ ] A thinking 时切 B 再回 A、窗口 blur/focus、socket reconnect 都不闪断；真实 turn-end 会结束。
- [ ] picker 与拖放均可加入 PDF；不支持文件有提示且页面不导航。
- [ ] 图片/PDF 混合发送保持顺序，PDF 进入 Claude document block，attachment-only 不含空 text。
- [ ] Plan mode 回归测试继续通过；sub-agent 开始/结束和嵌套工具有可读状态。
- [ ] 本批所有等待接口的按钮显示局部 loading、阻止重复提交，错误后恢复。
- [ ] Web vitest/build/tsc 与 CLI test/runtime smoke 全绿。

## 留真机验证项

- 手机 Safari/Chrome 拖放支持范围、PDF chip 密度与浅色/深色观感。
- 长时间 sub-agent 的 lifecycle 动画与真实 Claude plan mode 审批体验。
