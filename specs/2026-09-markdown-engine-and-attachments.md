# Markdown 引擎替换（GFM 表格）与用户附件呈现

> 状态：Final（v5，四轮对抗式 review 后定稿；实现与实证数据已回填）
> 日期：2026-09-04 ｜ 关联 backlog：B-354（markdown 引擎/表格）、B-355（附件呈现与重复气泡）
> 触发：Owner 截图报「UI 对话模式（claude sdk、pi）markdown 没办法很好地渲染 table，
> 并且输入文件的渲染效果也不好」

## 背景

两件事在同一条渲染链路上，一起改：

1. **表格**：`screens/session/Markdown.tsx` 是手写逐行渲染器。它**有** table 分支，
   所以「完全不支持」是错的诊断；真实故障是**分块规则**——段落收集循环的 break 条件里
   没有 table，于是「结论如下：」后紧跟表格（LLM 最常见写法，中间不空行）时整张表被吞进
   `<p>`。此外还有一串 GFM 缺口（见下表）。
2. **附件**：截图里那条带 `<attached_files>` 的气泡**不是「渲染难看」，是一条本不该存在的
   重复消息**，根因已定位到 CLI（见「现状事实 §2」）。

## 目标

- 会话里（Claude SDK / pi / codex / gemini 共用 `<Markdown>`）正确渲染 GFM：表格
  （对齐、转义竖线、列数补齐）、嵌套列表、任务列表、删除线、自动链接、引用式链接、脚注。
- 表格在窄屏与宽表下都可用：单元格换行优先、真放不下才横滚、滚动有可见提示、可键盘滚动。
- 附件带附件时不再出现重复气泡，不再泄漏 `<attached_files>`；附件呈现为「用户这一轮输入
  的一部分」而不是工具调用；图片出缩略图。
- 不引入 `dangerouslySetInnerHTML`，不放宽 XSS 面；不引入新的性能回归（有可证伪阈值）。

## 非目标

- 不做数学公式（KaTeX）、Mermaid、markdown 编辑器。
- 不做表格排序/筛选/导出。
- 不改 `appendStagedAttachmentsToPrompt` 拼进 prompt 的**文本形状**（那是模型输入）。
- 不动终端（xterm）渲染。

## 现状事实（代码已确认）

### §1 markdown 渲染

| 事实 | 位置 |
|---|---|
| 手写渲染器；段落收集的 break 列表里没有 table（本次故障点） | `packages/happy-web-v2/src/screens/session/Markdown.tsx:140-158` |
| 手写渲染器**有** table 分支，但只在块首行才进入 | 同上 `:87-104` |
| `<Markdown>` 的全部 7 个消费方 | `MessageView.tsx:159,178`、`LiveStreamView.tsx:62,72`、`SubagentDetail.tsx:109`、`ToolView.tsx:267`、`PermissionCard.tsx:113`、`BtwPanel.tsx:50`、`FsFileViewer.tsx:208` |
| **7 个消费方的信任模型不同**：6 个渲染 agent 输出（不可信），`FsFileViewer` 渲染**用户自己的 .md 文件** | `FsFileViewer.tsx:8,208` |
| `onOption` 只有 1 个调用方传；不传时 option 渲染成不可点的 `.md-option` | `MessageView.tsx:178`；`Markdown.tsx:342-346` |
| CopyButton 复制的是 markdown **源码**，不是渲染结果（换引擎不影响） | `MessageView.tsx:180` |
| 路径链接（B-145）挂在叶子 `TextLeaf`；parse 由 `useMemo([text])` 保住，白名单变化只重跑叶子扫描 | `Markdown.tsx:238-300, 288` |
| 会话级白名单 provider，value identity 按路径集合签名缓存（B-311） | `Markdown.tsx:402-410` |
| 白名单随 agent 每次 Write/Edit 增长 → 长会话里最频繁的 context 变更 | `toolFilePath.ts:56-66` |
| `<options>` 由系统提示词要求 agent 输出；提示词明写「Do not wrap it into a codeblock」（说明模型会） | `sync/prompt/systemPrompt.ts:6-16` |
| `Markdown.tsx` 的 options 解析是**逐行、允许不闭合**；`assistantView.ts` 的是**全局正则、要求闭合、不认围栏** | `Markdown.tsx:73-85`；`assistant/assistantView.ts:74` |
| 表格 CSS 现为 `white-space: nowrap`（长单元格永不换行，必横滚） | `screens/session/markdown.css:100-122` |
| `.md-quote` 有 `white-space: pre-wrap`，而 `white-space` 是继承属性 | `markdown.css:40` |
| 真正的行构造器是 `chatTurns.buildChatRows(messages, sessionLive)`；`screens/session/chatRows.ts` 是**死代码**（仅被 `ChatList.test.ts:3` 引用） | `ChatList.tsx:22`、`chatTurns.ts:132` |
| 基线包体：`AppRoot` 2,194.68 kB / gzip 646.49 kB | `vite build`（2026-09-04 实测） |

### §2 附件重复气泡的根因（本次新查明，有 transcript 实证）

| 事实 | 位置 / 证据 |
|---|---|
| CLI 把附件清单+一句英文说明拼进 prompt 交给 SDK | `packages/happy-cli/src/claude/utils/attachmentContent.ts:85-97` |
| SDK 把**增广后的**文本写进 Claude Code 的 JSONL | 实测 `~/.claude/projects/-Users-jojo-code-github-skills/61ac241e-….jsonl`：user 消息正文 = 原文 + `<attached_files>{…}</attached_files>` + 那句英文 |
| remote-mode 的 JSONL scanner 会把 JSONL 里的 user prompt 转发成 user 消息，靠**按内容比对**去重 app 发来的那条 | `claude/runClaude.ts:483-504`（`consumeAppPrompt`） |
| 而登记进去的是**未增广的原文** | `runClaude.ts:679-685` `recordAppPrompt(message.content.text)` |
| ⇒ **只要带附件，去重必然落空**，web 上就多一条带机器 XML 的重复 user 气泡 | 与 Owner 截图逐字吻合；不带附件时去重生效，所以此前无人报重复 |
| 多出来的 user 消息还会被当成**新的 turn 边界** | `chatTurns.buildChatRows:132-145` 按 `user-text` 切轮次 |
| reducer 只按 localId 去重，没有内容级去重 | `sync/reducer/reducer.ts:863-870` |
| web 侧只剥 4 种 harness 块，不剥 `<attached_files>` | `screens/session/harness.ts:16-21` |
| `harness.ts:64` 的 `isUserSlashCommandEcho` 在 web-v2 里导出但零调用（web 从未处理过回显） | `harness.ts:64` |
| `file` 事件被归一化成 `name:'file'` 的 tool-call + 配对 tool-result | `sync/typesRaw.ts:866-899` |
| 于是走 ToolView 的工具卡（纯文字行，不显示图片） | `ToolView.tsx:155-173, 404` |
| `file` 事件有**三种**落点：toolgroup 首段 / toolgroup 尾段 / **activity 折叠抽屉内**（上一轮没有 final agent text 时） | `chatTurns.ts:157,178,190` 实测探针 S1–S4 |
| 附件下载/解密函数存在但全仓无人调用（图片从未显示过） | `sync/apiAttachments.ts:183-220` |
| blob key 按 session 派生（legacy 会话回落 master key） | `sync/encryption.ts:95-99,127`；`encryption/blob.ts:41` |
| objectURL 所有权的现成先例 | `useAttachments.ts:191-203`（`ownedUrlsRef`） |
| 排队取消依赖的不变量在 `queuedMessages`/`cancelQueued`，**不经过 `buildChatRows`** | `ChatList.tsx:64-69,104-108`（`chronological` 只收 `inputState === undefined`） |

### §3 手写渲染器的实测缺陷（15 例探针）

| 输入 | 现在 | 应该 |
|---|---|---|
| `结论如下：\n\|a\|b\|\n\|---\|---\|…` | 整块变一个 `<p>` | 表格 |
| `\|x \\\| y\|` | 转义竖线被当分隔符，切 3 列 | 2 列 |
| 表头 3 列 + 数据行 2 格 | 只出 2 个 `<td>`（列错位） | 补齐 |
| `- a\n  - b\n- c` | 三个同级 `<li>` | 嵌套 |
| `foo_bar_baz` | `foo<em>bar</em>baz` | 原样 |
| task list / `~~x~~` / 裸 URL / `[a][1]` / 脚注 | 全不支持 | GFM |

## 设计

### A. 引擎：react-markdown@10.1.0 + remark-gfm@4.0.1 + remark-breaks@4.0.0

替换整套手写管线；`Markdown.tsx` 保留同名导出与现有 props，新增两个可选 prop（见 C/F）。

**候选对比（全部实测，2026-09-04）**

| 候选 | 表格 | 原始 HTML 默认行为 | 定制能力 | 判定 |
|---|---|---|---|---|
| 继续打补丁 | 要自己补 6 类缺口 | 现状（React 转义） | — | 见「最小修」讨论 |
| **react-markdown + remark-gfm** | ✅ 含对齐/转义/补列 | **转义成可见文本**（`<script>`→`&lt;script&gt;`，实测） | remark/rehype 插件 + components | **选它** |
| `markdown-to-jsx` (~6 kB gzip) | ✅ | ❌ **默认把原始 HTML 渲染成真 DOM**：实测 `x <img src="https://evil/p.png"> y` → 真 `<img>` **并注入 `<link rel=preload>`**；`<div>hello</div>` → 真 `<div>` | 只有 `overrides`，无 remark 生态 | 否决，理由是**失败模式不对称**：忘了传它的 `disableParsingRawHTML` = agent 输出的 HTML 直接进 DOM（fail-open）；react-markdown 忘了传 `components.img` 最多多一个远程图片请求、忘了 `urlTransform` 什么也不会发生（fail-closed）。本次正好新增 `trustContent` prop、有 7 个调用方，「某个新调用方忘了传」是可预期事件。次要理由：没有 remark 生态 ⇒ 脚注、自动链接、`remark-breaks` 的软换行都做不了，而它们在目标里。代价是明码标价的 ~6 kB vs 实测 47 kB gzip |
| `streamdown` | ✅ | — | 绑 Tailwind + shadcn CSS 变量（`--background`/`--muted`/`--radius`） | 否决：与 `tokens.css` 的 bg 台阶纪律正面冲突，等于在 UI 里开第二套 token 体系 |
| `marked`/`markdown-it` + sanitizer | ✅ | 需 `dangerouslySetInnerHTML` | 高 | 否决：把「渲染成真 DOM 节点，标记无法注入」的**结构性**保证换成依赖 sanitizer 配置正确性的保证 |

**为什么不止步于「最小修」**（reviewer 提议只补 `parseBlocks` 的 table 判据）：那确实能修掉被报的
那一条，但 §3 剩下 5 类缺口每一条都要新写正则，而正则之间互相干扰（转义竖线要在切分前、
行内代码要在强调前、嵌套列表要引入缩进栈）——等于自己重写 CommonMark，且没有 spec 测试
套件兜底。**取舍**：接受 reviewer 的风险论点，本 PR 拆成两个 commit（① 附件 B-355；② 引擎 B-354，
表格 CSS 在这一边）。**但它们能否分别 revert 取决于落地方式——见下面「回滚粒度」一节，
结论是不能，本批已明确接受「回滚单位 = 整个特性」。**

**`remark-breaks`**：现状 `.md-p { white-space: pre-wrap }` 让段落内单换行可见，CommonMark 会
折成空格，不加就是可见排版回归。加了之后 **`.md-p` 和 `.md-quote` 都要去掉 `pre-wrap`**
（`white-space` 会继承；实测同段文字 `normal` 45px vs 继承 `pre-wrap` 67px）。

**包体**：实测 esbuild（react 外置）四包 152 kB min / **47.0 kB gzip**，对 646.49 kB 基线是
**+7%**。低于本 spec 设定的 +60 kB 阈值，接受，不做懒加载（markdown 在会话首屏）。

### B. 性能（上线前置条件）

实测（`renderToStaticMarkup`，同 harness，本机 node）：

| 文本 | 旧手写 | react-markdown+gfm+breaks |
|---|---|---|
| 1.1 KB | 2.98 ms | 2.55 ms |
| 4.2 KB | 4.65 ms | **8.51 ms** |
| 16.5 KB | 7.63 ms | **38.32 ms**（超线性） |

`LiveStreamView` 每秒重渲 ~12 次，手机再乘 3–5。两条措施：

1. **白名单不得进入 parse 依赖**。rehype 插件 `rehypeTextLeaves()` 与白名单**无关**：
   它只把每个非空白 `text` 节点（`<a>`/`<pre>` 子树除外）包成自定义元素 `vh-text`；
   `components['vh-text']` 渲染 `<TextLeaf>`，由**它**读 context 做 `findPathHits`。
   `Markdown` 把 `<ReactMarkdown>` 元素本身 `useMemo` 在 `[segments, components, onOption]` 上，
   并且**自己不读 path context**。
   实证（真实 Chromium + React 19 `createRoot`，插桩计数）：
   ```
   mount                                   parse=2 leaf=10
   白名单变化（新 context value）            parse=2 leaf=20   → parse +0
   父组件强制重渲染（text 不变）              parse=2 leaf=20   → parse +0 / leaf +0
   ```
   （spec v1 把这条说反了，此处更正：若把白名单塞进插件参数，agent 每 Write 一次文件
   就会让整条 transcript 全量重 parse，而白名单正是长会话里最频繁变化的东西。）
   `vh-text` 这层包裹本身的开销实测 **+10%**（4.1 KB 8.31→9.17 ms；16.4 KB 32.57→35.94 ms），接受。

2. **流式草稿按时间节流**（`streamThrottle.ts`，`Markdown` 的 `streaming` prop）：
   <2 KB 不节流、<8 KB 120 ms、<20 KB 250 ms、更大 400 ms。

   **v2 的「按块 memo」方案已被实测否决**：按空行切块在最该管用的两种形状上收益恰好为零，
   因为**表格和列表内部没有空行**——
   | 16 KB 流式文本 | 切出块数 | 整篇 reparse | 只 reparse 最后一块 |
   |---|---|---|---|
   | 空行分段散文 | 258 | 14.07 ms | 0.10 ms |
   | 300 项 bullet list | **1** | 18.98 ms | **19.66 ms** |
   | 260 行表格 | **1** | 25.57 ms | **25.71 ms** |

   而「agent 正在流式吐一张大表」正是本次要修的场景（65 行 8.16 ms/帧 → 260 行 24.14 ms/帧）。
   按块切分还会引入可见抖动（松散列表被切成多个 `<ol>`/`<ul>`、脚注与引用式链接跨块失效）。
   节流与文本形状无关，且草稿是 disposable 的（1.5 秒后被完整解析的持久化消息替换）。

### C. 三处自有行为怎么保住（+ 一处信任模型差异）

| 行为 | 实现 |
|---|---|
| 路径链接（B-145） | 见 B-1。`<a>` 子树跳过（finding 3：button 不能嵌 a）；行内 `code` 里的 text 照样包（finding 1）。实测：`node.position` 存在、`<a>` 直接子节点就是 text、自定义元素名 `vh-path`/`vh-text` 在 `components` 映射里正常工作 |
| `<options>` 按钮 | 不进 markdown（实测 react-markdown 把它转义成可见文本）。抽共享纯函数 `screens/session/optionsBlock.ts`，语义 = **现在 `Markdown.tsx` 的那套：逐行、跟踪围栏、容忍未闭合**，外加两处修正：同一行多个 `<option>` 全部识别；**闭合标签与开启标签在同一行时只消费本行**（第一版无条件向后找 `</options>`，遇到 `<options><option>A</option></options>` 写在一行就会把该消息后面的**全部正文吞掉**——提示词只是「建议」独立成行，模型写成一行很常见），切成 `[{markdown}|{options}]` 段。`assistantView.ts` **迁到这个实现**（顺手修掉它「同一行两个 option 只认一个」和「围栏内也切」两个 bug），不是反过来把 `Markdown` 迁到全局正则——否则会 ①把 ``` 围栏里的 options 示例切烂（提示词明写模型会这么写），②流式中途的半开 `<options>` 落进引擎被转义，用户看到一坨 `&lt;options&gt;` 抖 1.5 秒（现渲染器此刻已画出按钮） |
| 代码块 → `CodeView`（shiki） | `components.pre`：从 hast `node` 取 `code` 子节点的 `language-*` class 与文本，交 `<CodeView lang plain={plainCode}>`。映射 `pre` 不映射 `code`，避免与行内 code 混淆 |
| **信任模型差异** | 新增 prop `trustContent`（默认 `false`）。`false` 时 `components.img` 渲染成**不发起网络请求**的链接 chip；`FsFileViewer` 传 `true`（用户自己的 .md 文件，README 里的远程图片是正常内容，屏蔽是产品退化）。理由：agent 正文是不可信内容，一个远程图片就是追踪像素 + IP/UA 泄漏；实测 react-markdown 除了 `<img>` 还会额外注入 `<link rel="preload" as="image">` |

### D. 安全与降级（实测取证）

| 输入 | react-markdown@10 实测 | 我们的处理 |
|---|---|---|
| `<script>` / `<div>` / `<Button>` | **转义成可见文本** | 保持默认（正是要的；也与旧渲染器一致） |
| `[x](javascript:…)` / `data:` 图片 | 已经 `href=""` / `src` 被丢弃 | 仍显式收窄到 `http/https/mailto` 白名单——**验收断言必须包含一条现状会放行的 case（如 `tel:`）**，否则这条测试永远绿、钉不住任何东西 |
| `![](https://…)` | 真 `<img>` + `<link rel=preload>` | 见 C 的 `trustContent` |
| 未闭合 ``` / `**` | 分别渲染为代码块 / 纯文本 | 接受（流式友好） |
| `title\n---\nbody` | `<h2>`（setext） | 行为变化，与 GitHub 一致，接受并记录 |
| 表格单元格里 `` `a|b` `` | 仍按 `\|` 切列 | 接受：GFM 规范行为，GitHub 同样 |
| 表格单元格里 `<br>` | **转义成可见文本** | **修**：一个 rehype 处理，只在 `td`/`th` 内把文本里的 `<br>`/`<br/>` 切成 `br` 元素。理由：这是 LLM 在表格里换行的主要写法，GitHub 会渲染；不修的话「GFM 表格正确渲染」这句话在验收时会被这个例子打脸 |

### E. 表格呈现（CSS 数值经真实 Chromium 实测）

```
.md-table-wrap  background: var(--bg-1)   ← 必须有自己的表面：7 个调用方坐在 --bg-0/--bg-1/--bg-2
                                             三个不同台阶上，scroll-shadow 的实色端否则必错色
                overflow-x: auto; tabindex/aria-label 见下
.md-table       width: auto; min-width: 100%      ← 不是 max-content
th, td          white-space: normal; word-break: break-word; max-width: min(32ch, 60vw)
对齐            走 GFM 的 style="text-align:*"（mdast-util-to-hast 自带）
滚动提示        纯 CSS scroll-shadow（background-attachment: local, scroll），实色端用 --bg-1
```

**为什么不是 `width: max-content`**（spec v1 写错，此处更正）：实测 390 px 视口、3 列
（1 短 + 2 段散文）——`max-content` 下表宽 525 px、**横向溢出 161 px**；改 `auto` 后表宽
364 px、**溢出 0**（单元格从 2 行变 3 行，正是我们要的「换行优先」）。500 px 下 107 px vs 0。
`max-content` 制造的恰恰是它要消灭的横滚。反向也验了：6 列短表在 `auto` 下溢出仍是 0，
`min-width: 100%` 已经管住「窄表撑不满」。

a11y：`aria-label` 必填（无名 landmark 是反模式），`tabIndex` **只在真的溢出时**给
（用一个小 hook 测 `scrollWidth > clientWidth`，同一个信号顺便驱动 scroll-shadow 的开关），
否则长 transcript 里十几张表就是十几个 tab stop。

任务列表 / 删除线 / 脚注（含 `sr-only`）需要补样式。

### F. 附件与重复气泡

根因在 CLI（§2），但铁律 14 说在跑的 wrapper 拿不到新 CLI 代码，所以**两侧都修**，
且 web 侧的修法必须对**所有历史与旧版本**成立。

1. **CLI（根因修复）**：**登记「最终交给 SDK 的那个字符串」**，而不是在两侧各做一次逆变换。
   `loop({ onPromptFinalized })` → `claudeRemoteLauncher` 的四个终点（replay parked / 带附件 /
   普通 / steer）各回调一次，`runClaude` 用它替掉 `session.onUserMessage` 里那次登记。
   理由：app 发出的字符串与落进 JSONL 的字符串**至少三处会发散**，manifest 只是其中一处——
   ① `MessageQueue2.collectBatch` 会把同 mode 的多条 `join('\n')` **合批**（实测：排队发 2 条
   就漏去重，与附件无关）；② manifest 增广；③ trailing whitespace 不对称（MCP `sessions_send`、
   webhook、Tanka 桥都不经过 composer 的 `text.trim()`）。登记最终串把 ①②③ 一并解决，
   并且未来任何新的 prompt 增广都自动被覆盖。比对仍统一过 `promptDedupeKey()`
   （= `stripAttachmentManifest(...).trim()`，两侧同一个函数）作为兜底。
   **已知残余**：同一文本在 5 分钟内被发送多次时，去重仍可能错配（老问题，未在本批处理）。
2. **web（对旧 CLI 与历史 transcript 生效）**：
   - `stripHarnessBlocks` 增加剥 `<attached_files>…</attached_files>` 与紧随其后的那句
     固定英文说明；
   - **整条隐藏**这样一条消息，三个条件缺一不可：① 带 manifest（普通的连发两条相同文本
     永远不会被误杀）；② **没有 `meta.sentFrom`**（web/iOS 自己发的那条一定有，`sync.ts` 的
     sendMessage 总会写；scanner 合成的那条没有）；③ 剥掉 manifest 后与它前面最近一条
     **用户自己发的**文本逐字相同。加上 ② 之后，「上一条不带附件的『看这个』+ 下一条带附件的
     『看这个』」这种真实假阳性也被排除。
     **过滤位置必须是 `ChatList` 的 `chronological`**，不能在 `UserText` 里 `return null`：
     `chatTurns.buildChatRows` 按 `kind === 'user-text'` 切轮次、与渲染无关，留在数组里就仍会
     多切一个空轮次、让 `rows.length` 虚增（未读角标多算 1）、挪动 `agentLiveness` 的切点。
     **已知边界**：分页时若「自己那条」还在上一页，找不到前驱 → 回显照常显示（剥掉 XML、
     带附件条），加载更早之后归位。
   - 若带 manifest 但**不**重复（本地/CLI 侧发起、历史会话），则剥掉 manifest 并**用清单里的
     name/mimeType/size 渲染附件条**——剥离不能造成信息净损失。
   - 跨包源码断言测试：web 测试读 `attachmentContent.ts` 源码，断言它 strip 的字面量确实
     存在于 CLI 源码里（手法同 `screens/public/publicContent.test.ts`），CLI 改文案会红。
3. **附件归属到 user 这一轮**：在 **`chatTurns.buildChatRows`** 里（不是死文件 `chatRows.ts`）
   做一次**前置**摘取——把「紧邻下一条 user-text 之前的一串 `name==='file'` tool-call」摘走挂到
   那条 user 行上，**再**进 leaf/activity 三条分支；否则「上一轮没有 final agent text」那种情况
   会把附件留在 activity 折叠抽屉里（实测 S3），用户的附件就此消失。落单的 `file` 事件
   （后面没有 user-text）保留原工具卡兜底。顺手删 `chatRows.ts` 并把 `ChatList.test.ts` 迁到
   `chatTurns`，否则下一个 agent 还会改错文件。
   **明令禁止的捷径**：不许把 `file` 加进 `knownTools` 的 hidden 名单——`ChatList.tsx:73` 的
   `isHiddenToolCall` 会把它从 `chronological` 整个滤掉，连带 `currentTurnMessages`
   （`agentLiveness.ts:62-67`）和队列里的「已排队文件」标签（`ChatList.tsx:389-391`）一起坏。
4. **语音助手**：`assistantView` 读的是 `m.displayText ?? m.text` 原文、**完全绕过
   `stripHarnessBlocks`**，所以 TTS 仍会念出 `<attached_files>` 与那句英文。它现在与
   `<Markdown>` 共用 `optionsBlock`，剥离在 `extractOptions` 之前统一处理。
5. **`UserText` 渲染附件条**：气泡上方右对齐，文件名 + 类型 + 大小，无 chevron、无工具框。
6. **图片出图**：对 `image/*` 走 `downloadEncryptedAttachment` + `decryptBlob`（现存死代码）。
   - blob key 按 session 派生 ⇒ **缓存 key 必须是 `sessionId + ref`**，否则跨会话串号；
   - objectURL 所有权在**缓存**不在组件：LRU（≤30）淘汰时 `revokeObjectURL`，组件卸载时不 revoke
     （先例 `useAttachments.ts:191-203`）；
   - 失败降级成文件行、不弹窗，但**必须 `console.error` 出状态码**（401/网络错误要可观测）；
   - 缩略图上限 240 px，点击开大图。

## 兼容矩阵与发布顺序

- web 改动是自足的：不依赖新 CLI 就能消灭重复气泡与机器 XML（对历史 transcript 也成立）。
- CLI 改动是根因修复，**不阻塞 web 发布**：旧 CLI + 新 web = 重复气泡被隐藏；
  新 CLI + 旧 web = 不再产生重复 envelope。两个方向都安全，无协议字段变更。
- 顺序：server/web 同镜像发布 → 下一次常规 CLI 发版带上 §F-1。不需要临时 `vh-update`。
- 附件链路本身**只在 Claude 会话上存在**（`sync.ts` 的 `supportsAttachments = !flavor || flavor === 'claude'`，
  pi/codex/gemini/openclaw 一律弹窗拒绝）。markdown 渲染则是四种 runner 共用的。

### 回滚粒度（**必须与落地方式一起读**）

> **本批的结论：选 1——回滚单位 = 整个特性。** 理由见下；因此本节后面那三条
> 「让 per-commit revert 成立」的约束**本批不适用**（它们已经执行过了，作为提交卫生保留，
> 但不是回滚保证）。
>
> ⚠️ **`scripts/land-pr.sh` 用的是 `gh pr merge --squash`**（`land-pr.sh:106`，main 的历史逐条单亲）。
> 一旦 squash，下面这四个 commit 在 main 上会变成一个，**「引擎翻车只 revert 引擎」这条恢复
> 路径就不存在了**——回滚单位重新变回「整个特性」。这正是 review 当初提议「拆两批发布」
> 想避免的状态，所以落地前必须在两条里**明确选一条**，不能默认：
>
> 1. **接受**：回滚单位 = 整个特性（引擎出问题连附件修复一起回退）。什么都不用改，
>    但 Owner 要知道自己买的是什么。
> 2. **保住 per-commit revert**：改用 `gh pr merge --rebase` 落地（仍是线性历史）。
>    代价：commit ① 里那个含 NUL 字节的 `attachmentPreview.ts` blob 会永久留在 main 的
>    历史里（`git blame`/`bisect` 到那一段失效），所以要先 `git rebase -i` 把它 amend 掉。
>
> **选 1 的理由**：① per-commit revert 是给引擎那一半买的保险，而那半边的风险已被四轮
> 实测逐条关掉（性能、options 切分、路径链接、表格 CSS、`<br>`、URL 白名单、StrictMode），
> 每条都带回归测试，「只想回退引擎、保住附件修复」这个具体情形概率很低；② 路 2 要在一条
> 已经逐 commit 过门禁的分支上重写历史（amend 掉 NUL blob），5 个 commit 全部换 SHA，
> **刚刚逐 commit 收集的独立门禁证据随之作废**，而铁律 10 记的两次事故都出在「land 前挪
> SHA」；③ 本仓回滚本来就是「回退 commit + 重发整镜像」（铁律 5），回退一个还是两个
> commit 的操作流程完全一样，路 2 省下的实际运维价值比纸面上小。
> Owner 若不同意这个取舍，改走路 2 即可，代价如上。

review 建议拆成两批发布以隔离风险；这里改用**提交粒度**，并接受三条硬约束把它补成等价：

1. **commit ① 不得依赖 commit ② 引入的任何符号**（`trustContent` / `streaming` /
   `splitOptionSegments` / 新 deps）。方向只能是 ② 依赖 ①。新增依赖与 `pnpm-lock.yaml`
   必须落在 ②，否则 revert ② 会留下四个没人 import 的 dep。
2. **每个 commit 各自独立通过完整门禁**（web vitest/build/tsc + CLI test + 运行冒烟），
   不是整个 PR 过一次——否则「可 revert」只是名义上的，revert 后的树没人验过。
3. **①、② 各自带自己的验收证据**（见下面清单里的 [①] / [②] 标记）。

commit 划分：
- **① 附件（B-355）**：CLI 去重根因 + web 剥离/去重/附件条/图片缩略图 + `chatTurns` 摘取
  + 删 `chatRows.ts`。
- **② markdown 引擎（B-354）**：`Markdown.tsx` 重写 + 插件 + `optionsBlock` + `streamThrottle`
  + `markdown.css` + 新依赖。

## 实测结果（回填）

| 项 | 数值 |
|---|---|
| 包体 | `AppRoot` gzip 646.49 kB → **696.25 kB（+49.76 kB / +7.7%）**，低于 +60 kB 阈值 |
| 表格窄屏（headless Chromium，touch context，3 列含两列散文） | 390px：溢出 **335px → 0**（表宽 699→364）；500px：**225 → 0**；768px：0 → 0 |
| 表格窄屏（12 列） | 390px 溢出 379px（**照常横向滚动**，`is-scrollable` + `tabindex=0` + `aria-label` 已实测生效）；768px 溢出 1px |
| `word-break: break-word` 的坑 | 它等价于 `overflow-wrap: anywhere`，让单元格 min-content 塌到**一个字符**（12 列表被压成竖排字母）。改用 `overflow-wrap: break-word` 后恢复正常 |
| 白名单变化的重 parse | `parse +0 / leaf +N`（真实 Chromium 插桩计数） |
| `vh-text` 包裹开销 | +10%（4.1 KB 8.31→9.17 ms，16.4 KB 32.57→35.94 ms） |
| 真实浏览器验收 | 390/900px × 深浅主题，控制台**零错误**；3 张表、2 个路径链接、2 个 option 按钮、2 个 task 勾选框、单元格内 `<br>`、脚注区各 1；`<img>` 0 个、`rel=preload` 0 个（不可信图片被 chip 化）；页面横向溢出 0 |

### 单测抓不到、只有真实浏览器/像素/StrictMode 才能抓到的六个 bug（全部已修）

| # | 症状 | 为什么单测和「类名断言」抓不到 |
|---|---|---|
| 1 | `rehypeTextLeaves` 包裹了**空白文本节点**，hast 把 `<table>/<thead>/<tr>` 之间的换行保留为 text 子节点 → React 每行报一次「whitespace text nodes cannot be a child of `<table>`」 | `renderToStaticMarkup` 不发这个警告 |
| 2 | **滚动阴影从未可见**：四层 `background-image` 画在包裹器的背景层，而 `.md-table { background: var(--bg-1) }` 作为子元素画在它**上面**并完全覆盖内容盒 | 我原来的验收只断言 `is-scrollable` / `tabindex` / `aria-label` **存在**，这三样都真的生效了。必须**采样像素**：修前右内缘是一条平的 `250`，修后 `228→196`（浅）/ `19→12`（深） |
| 3 | `useThrottledText` 在 **StrictMode 下永久冻结**：清理只 `clearTimeout` 没把 `timer.current` 置空，而 StrictMode 的模拟卸载**保留 fiber 上的 ref** → 此后每次 effect 都撞 `if (timer.current) return` | node 环境不跑 effect、不做双调用。实测 dev 下草稿冻在 5000 字符、incoming 已到 8000 |
| 4 | `AgentText` 的 `onOption` 是内联箭头，进了 parse memo 的依赖 → `session.thinking` 每翻一次（每轮两次）**整条 transcript 全量重 parse** | 需要插桩计数真实渲染。实测内联 +1 parse/重渲，`useCallback` +0 |
| 5 | `stripHarnessBlocks` 里剥 `<attached_files>` 会**销毁 agent 正文**（本仓的 agent 天天讨论这个标签，围栏里的示例也被吃） | 我的测试只喂了 user 消息。改成只在 user 路径剥 |
| 6 | `attachmentPreview.ts` 里混进一个**字面 NUL 字节**（`cacheKey` 的模板串），git 把整个文件当二进制 → PR 里没有 diff、`git blame` 失效 | 运行时完全正常，任何测试都不会红 |

另外两个静默错判：`isDuplicateAttachmentEcho` 只在「有清单」那一支折叠 3+ 连续换行，
于是「正文本来就有连续空行 + 带附件」两侧不相等、重复气泡照样出现（改成两侧同一个
`normalizeForCompare`）；`safeUrlTransform` 放行 `//evil.example/x`（无 scheme 走了「相对
URL」分支），与「白名单」的说法不符。

**方法论沉淀（两条，都值得进 `docs/PROCESS.md`）**：
1. 视觉改动的验收断言**不能只断言类名/属性存在**——类存在与效果可见是两回事，第 2 条正是
   这样溜过去的。有渐变/遮挡/层叠的改动要采样像素并留修前修后两份。
2. 源码断言测试有**两类假绿**，`mutation-check` 只抓得到第二类：
   ① 断言的字符串命中了**同一段里解释这条规则的注释**（本次实测踩到：`toContain('timer.current = null')`
   命中了紧邻的注释）→ 断言前先剥注释；② 断言太松，被 mangle 后的标识符满足
   （`toContain('useCallback')` 会被 `useCallbackXX` 满足）或被**同文件另一处**满足
   （`toContain('retried.current')` 被下一行的 `retried.current = true` 满足）→ 断言要带上定界符。

**已知并接受的两个残余（有意识地接受，不是没看见）**：
- **表头行的滚动阴影仍被遮住**：删掉 `.md-table` 的背景之后，`th { background: var(--bg-2) }`
  是同一个遮挡机制往上挪了一层。像素实测：正文行有渐变（浅 `250→191`、深 `23→11`），
  表头那条带是平的。行数少的表看起来像渐变被啃掉一块。彻底修要把渐变搬到画在内容之上的
  sticky 伪元素，收益不抵复杂度。
- **图片预览失败后没有原地重试**：退到文件行之后要换会话或刷新才会再试一次
  （网络抖动那一次已经有重试了，见 `UserAttachments.tsx`）。给文件行加「点我重试」需要
  一条新文案与新的交互面，不值得压在本批。
- **`--bg-1` 面板上的表格没有表面台阶**：`PermissionCard`/`BtwPanel`/`FsFileViewer` 本身就是
  `--bg-1`，包裹器与它同色，只剩 1px `--line` 区分。这是 token 台阶的既有事实，不是本次引入。

## 风险

1. **包体 +48.81 kB gzip（+7.6%）**。接受（阈值 +60 kB）。
2. **排版行为变化**：setext 标题、词内 `_` 不再斜体、软换行改由 `<br>` 承担
   （`.md p` / `.md blockquote` 的 `pre-wrap` 一并去掉，否则同段文字从 45px 涨到 67px）。
   前两条向 GitHub 语义收敛。
3. **流式重解析成本**（超线性，4 KB 已破 8 ms）。缓解见 §B 两条。
4. **B-145 接线回归**。缓解：源码断言测试**升级成真渲染测试**（29 例）。
5. **附件图片引入新网络/内存路径**。缓解：缓存 key = `sessionId + ref`、objectURL 归缓存所有
   （LRU ≤30 时才 revoke，组件卸载不 revoke）、失败静默降级但 `console.error` 保留状态码。
6. **`chatTurns` 是热区**。缓解：摘取是纯函数前置变换（无附件时返回**原数组**，memo identity 不变），
   S1–S4 四种落点各有单测。排队取消不经过 `buildChatRows`（`ChatList.tsx` 的 `queuedMessages` 自己 filter），不受影响。
7. **`optionsBlock` 合并两处实现**改变了语音助手行为：多余空行少了一个（已改测试并注明），
   同一行多个 `<option>` 现在全部识别，围栏内的示例不再被切走。
8. **GFM 的两个已知差异**（不修，与 GitHub 一致）：表格单元格里的 `` `a|b` `` 仍按 `|` 切列；
   `title\n---\nbody` 现在是 setext 标题而不是段落 + 分隔线。

## 验收标准

- [x] [②] 29 例渲染测试（含「段落后紧跟表格」）全绿，取代原来的源码断言测试
- [x] [②] 表格：对齐生效；长单元格换行；宽表才横滚；`<br>` 在单元格里换行
- [x] [②] 表格窄屏：headless Chromium touch context 下量 `scrollWidth - clientWidth`，390/500/768px
      各留修前 + 修后数据（见「实测结果」）
- [x] [②] 任务列表 / 删除线 / 嵌套列表 / 自动链接 / 脚注 有样式，深浅两个主题实测可读
- [x] [②] `.md-table-wrap` 自带 `--bg-1` 表面，scroll-shadow 实色端用同一 token
- [x] [②] `<options>`：可点 / 不传 `onOption` 时不可点 / 围栏内示例不被切 / 未闭合仍出按钮 /
      **同一行闭合时其后正文不丢**
- [x] [②] 代码块仍走 CodeView（实测有 shiki 高亮与复制按钮），流式草稿走 `plain`
- [x] [②] 路径链接：行内代码里的路径命中；链接 label 里不出现；代码块内不扫描
- [x] [②] 白名单变化不触发重 parse（真实 Chromium 插桩：parse +0）
- [x] [②] `trustContent=false` 输出里没有 `<img src=http`、没有 `rel="preload"`；`FsFileViewer` 传 `true`
- [x] [②] URL 白名单断言含一条现状会放行的 scheme（`tel:` / `xmpp:` / `intent:`），可被证伪
- [x] [②] 包体 delta 实测并回填
- [x] [①] 用户气泡不再出现 `<attached_files>` 与那句英文说明；语音助手也不再朗读它
- [x] [①] 带附件时只留一条 user 气泡（回显整条隐藏，判据含 `meta.sentFrom`）
- [x] [①] 附件呈现为 user 轮次的附件条，S1–S4 四种落点各有单测；图片走缩略图路径
- [x] [①] `chatRows.ts` 已删除，`ChatList.test.ts` 迁到 `chatTurns`（`chatListRows.test.ts`）
- [x] [①] 跨包源码断言测试存在，且 `mutation-check` 验过钉得住（1/1 caught）
- [x] [①] CLI：`onPromptFinalized` 接线测试 + `mutation-check`（3/3 caught）
- [x] [②] 滚动阴影**像素级**可见（深浅两个主题各采样一次，修前平坦 / 修后有渐变）
- [x] [②] StrictMode 下流式草稿追到最终长度（真实浏览器，`LEN=9000`）
- [x] [②] `session.thinking` 翻转不触发重 parse（`onOption` 走 `useCallback`，`mutation-check` 4/4）
- [x] [②] 段落节奏一致：实测 `P→P 12px`、`P→UL 12px`、`UL→P 12px`（修前 P→P 是 24px）
- [x] [②] `<br>` 在加粗等嵌套标记内也生效（`<strong>line1<br/>line2</strong>`）
- [x] [②] `//host` 协议相对 URL 被拦
- [x] [①] agent 正文里的 `<attached_files>` **不被销毁**（只在 user 路径剥）
- [x] [①] 回显判重两侧走同一个归一化（正文含 3+ 连续换行时也命中）
- [x] [①] 源码里没有 NUL 字节（`file` 报 UTF-8 text）
- [x] 门禁全绿：wire build+test(31)、web vitest(2325)/build/tsc 零错误、CLI test(1865)+运行冒烟、server tsc

## 留真机验证项

- 触屏上表格横向滚动与页面纵向滚动的手势冲突（桌面浏览器量不出来）。
