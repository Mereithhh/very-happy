# Prompt 笔记（Notes）——等 AI 干活时写下一步 prompt

> 状态：Shipped（commit `e89f3e23`）
> 日期：2026-08-14 ｜ 关联 backlog：B-094 ｜ 出处：Owner 实报（等待 AI 出结果的空档想写备选 prompt，没地方放）

## 背景

高频场景：给 claude 派了活，等结果的几分钟里已经想好了下一步 prompt，
现在只能开外部笔记软件或堆在输入框里（输入框会被草稿同步、且发送即清空）。
需要一个贴着工作流的草稿位：随手写、跨设备同步、一键插回输入框。

## 目标

- 右侧笔记面板：全路由可用（聊天/终端/看板），挤压主内容而非悬浮，可拖宽、可全屏。
- 顶部多 tab（打开的笔记），等宽 textarea 编辑，自动保存。
- 笔记可选绑定 session/终端（创建时自动绑当前），归档/关闭不影响笔记；全局 `/notes` 视图看全部。
- 一键「插入到输入框」：聊天插消息框（不发送）、终端 bracketed paste（不回车）。
- 存储走账号 KV，跨端同步 + 实时推送。

## 非目标

- 不用 Monaco / CodeMirror（Owner 提议 Monaco，已反驳采纳：2-3MB chunk、移动端差，
  prompt 是纯文本；真需要高亮再评估 CodeMirror 6）。
- 不做富文本/markdown 渲染（textarea 纯文本；预览需求出现再说）。
- 不做笔记分享/导出、不做版本历史。
- 不动 server / CLI（KV 通道现成，web 单包）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 账号 KV 全套现成：GET/:key、prefix list（limit≤1000）、bulk、原子 mutate（per-key 版本 CAS，409 带 winner value+version）；删除=tombstone（value:null，version+1，get 视为不存在） | `happy-server/sources/app/api/routes/kvRoutes.ts`、web `src/sync/apiKv.ts` |
| KV mutation 向账号全 socket 广播 `kv-batch-update`，web 端 `onKvChanges` 订阅（自写也回显→订阅须幂等；断连丢推送→需自有 refetch） | `src/sync/kvUpdates.ts`、`sync.ts:2788` |
| CAS push 最完备模板 = notificationSeenStore（MMKV 镜像+账号指纹防串号、500ms debounce、4 次 CAS 重试、credentials 注入走 context 防 getCurrentAuth 时序坑） | `src/sync/notificationSeenStore.ts`、`app/useSeenTracker.ts:68` |
| mmkv-web 底层是 localStorage（~5MB quota），clipboard 历史因此 cap 50 条×32KB | `src/sync/clipboardHistory.ts` 注释 |
| 可拖宽面板成熟模式：右锚定纯函数 + hook（window listeners、`vh-col-resizing` body class、parentElement.right 抓边） | `src/screens/files/filesPanelWidth.ts`、`useFilesPanelWidth.ts` |
| 挤压布局先例：flex row + `flex:none` aside + `.app-resize-handle`；≤860px 转 fixed 全屏 overlay + scrim | `screens/session/SessionDetailScreen.tsx:20-101`、`session.css:1-46` |
| 聊天插入不发送：`AgentInput.insertPreset(text)`（空则整段、非空则换行拼接+refocus），无全局通道，props 回调 | `screens/session/AgentInput.tsx:126-129` |
| 终端插入不回车：`term.paste()`（bracketed paste）+ **必须先 `presetPasteText()` 归一化**（尾换行在裸 shell=自动回车） | `screens/terminal/WebTerminalScreen.tsx:1199-1230`、`termPresetPaste.ts` |
| 全局单例开关 = window event 模式（palette `vh:command-palette-open`、剪贴板 `vh:clipboard-history-open`），单例挂 AppLayout shell 之后 | `CommandPalette.tsx:33-42`、`AppLayout.tsx:129-136` |
| ⌘J / ⌘E / ⌘B / ⌘; 未占用（⌘. = presets，⌘K = palette，⌘N/W/[/1-9/R 已用） | 快捷键盘点（探索报告 §4） |
| localSettings 加字段=同文件 2 处（schema + defaults），整块 safeParse→enum 只增不删；笔记内容**不进 synced settings**（字段级 LWW 会整数组互覆——notificationSeen 拒用同因） | `src/sync/localSettings.ts`、`settings.ts:56-70` |
| 路由表 createBrowserRouter，AppLayout children 加 `notes`（懒加载 `Lazy` 包装）；`closeViewTarget`/`targetKeyOfPath` 只认 session/terminal，新路由零副作用 | `app/AppRoot.tsx:81-125` |
| i18n：加 key 只改 `_default.ts` + `zh-Hans.ts`，其余语言 fallback | `src/text/README.md` |

## 设计

### 数据模型与存储

每条笔记一个 KV key：`vh.note.v1.<id>`（id=random UUID 去横线截 12），value=base64(JSON)：

```ts
interface NoteRecord {
  id: string;
  content: string;              // 纯文本，≤32768 chars（clipboard 同 cap 先例）
  boundTo?: { kind: 'session' | 'terminal'; id: string; machineId?: string; title: string } | null;
  createdAt: number;
  updatedAt: number;            // LWW 依据
}
```

- **per-note key 而非单 blob**：两设备编辑不同笔记零冲突；同一笔记冲突时 CAS 409
  带回 winner → `updatedAt` 大者胜（tie 取 remote），absorb 后按需重推。
- 拉全量 = `kvGetByPrefix('vh.note.v1.', 500)`；上限 200 条（超出创建时拒绝+提示）。
- 实时 = `onKvChanges` 按前缀过滤，version ≤ 已知则跳过（幂等）；`visibilitychange`
  + initialize 时 refresh 兜底。
- MMKV 本地镜像（`notes-cache`，带账号指纹）即时渲染/离线可读。
- 标题不单独存：取 content 首个非空行（去 `#`/`-` 前缀，cap 32 chars），空则「未命名」。
- 删除 = kvMutate value:null（tombstone）。笔记是草稿，真删除不违背 archive-only
  纪律（那是对 claude 会话可恢复性的约束）。
- 自动保存：本地 store 即时，KV push 按笔记 600ms debounce；blur/pagehide flush。

### 面板与布局

- `NotesDock` 挂 **AppLayout** 第三格内：grid 保持 `${width}px 6px 1fr` 不动，
  第三格换成 `.app-main-row`（flex row）包住 `<main>` + `{open && <handle/><aside/>}`
  ——一处挂载全路由生效，AppLayout 改动最小。
- 桌面（≥861px & pointer:fine）：挤压 + 拖宽（右锚定，MIN 300 / DEFAULT 380 / ≤50vw，
  宽度存 localSettings `notesPanelWidth`）；窄屏/触屏：fixed 全屏 overlay + scrim。
- 终端被挤压时走既有 RO→scheduleFit 链路（B-088 已实战）；侧栏拖宽本就无抑制，同标准。
- `/notes` 路由（AppLayout 内，保侧栏）= 全局视图 + 全屏编辑：左列全部笔记
  （updatedAt desc + 过滤框 + 绑定 chip 可跳转），右侧大编辑器。面板的全屏按钮跳这里。
- 在 `/notes` 上自动隐藏 dock（冗余）。

### tab 与 localSettings（设备本地）

`notesPanelOpen: boolean`、`notesPanelWidth: number|null`、
`notesOpenTabs: string[]`、`notesActiveTab: string|null`。
tab 关闭≠删笔记；被远端删除的笔记自动从 tabs 剔除。

### 插入到输入框

window event `vh:insert-to-input`，`detail: { text, handled: false }`；
监听方（当前路由的 AgentInput / WebTerminalScreen）同步置 `handled=true`：
- AgentInput：`insertPreset(text)`（既有函数）。
- WebTerminalScreen：`insertPreset(text)`（既有，内部 presetPasteText+paste，不回车）。
  **热区文件，只加一个 useEffect 订阅，≤10 行。**
- 派发后 `handled` 仍 false → toast「当前页面没有输入框」。

### 入口

- ⌘J / Ctrl+J：面板 toggle（NotesPanel 自注册，capture + isImeGuardedEvent，同 palette）。
- 命令面板 action「笔记」（hint ⌘J）+「所有笔记」（→ /notes）。
- 侧栏 footer 铃铛旁 StickyNote 图标。
- 新建笔记时若在 session/terminal 路由 → 自动绑定（含 title 快照，目标消失仍可显示）。

## 兼容矩阵与发布顺序

- 纯 web 单包；KV server 通道既有，旧 server 不存在（本 server 早已含 kvRoutes）。
- 新 KV 前缀 `vh.note.v1.` 对旧 web 端不可见（无人读该前缀）——双向兼容天然成立。
- 发布 = 仅 web deploy；回滚 = 回滚 web，KV 数据留存无害。

## 风险

1. **KV 无 per-value 大小限制、mmkv-web 5MB quota** → 双 cap（32K chars/条 + 200 条）
   在客户端强制（textarea maxLength + 创建守卫）；镜像只存已通过 cap 的数据。
2. **CAS 首次冲突 version 谎报**（tombstone 后 get 返回 null 但真实 version>0）→
   照 seen store 先例：409 时吸收真实 version 重试。
3. **两设备同时编辑同一笔记** → LWW 按 updatedAt，慢端丢字。接受：单人多端，
   同时编辑同一条是罕见姿势；per-note key 已把冲突面缩到最小。
4. **终端挤压 reflow** → 与侧栏拖宽同标准（RO→rAF fit），不额外做抑制；真机验。
5. **Sidebar.tsx / WebTerminalScreen.tsx 是热区** → 各只加 ≤10 行（footer 图标 / 订阅）。

## 验收标准

- [ ] 纯函数模块（notes 数据/merge/标题/宽度 clamp）带 vitest 用例
- [ ] 聊天页写笔记→另一浏览器 profile 秒级可见（kv-batch-update）
- [ ] 同一笔记双端改，后写者胜、无 throw 死循环
- [ ] 聊天插入不发送、终端插入不回车（含多行/尾换行）
- [ ] /notes 全屏视图：列表+过滤+绑定跳转
- [ ] tab 开/关/切换持久化；远端删除自动剔 tab
- [ ] ⌘J、⌘K 入口、侧栏 footer 入口
- [ ] 移动端 overlay 形态；桌面拖宽刷新后记住
- [ ] 门禁：vitest / vite build / tsc 零新增

## 留真机验证项

- 移动端全屏 overlay 观感 + 软键盘弹起编辑体验（IME）
- 终端页拖宽笔记面板时终端 reflow 是否可接受（对照 V-039 标准）
