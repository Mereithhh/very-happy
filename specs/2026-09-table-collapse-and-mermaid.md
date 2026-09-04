# 长表格折叠 / 表头吸顶 与 mermaid 懒加载渲染

> 状态：Draft
> 日期：2026-09-04 ｜ 关联 backlog：B-356（表格）、B-357（mermaid）
> 前身：`specs/2026-09-markdown-engine-and-attachments.md`（B-354/B-355，已 Shipped `e38b8602`）
> 触发：Owner「markdown 渲染还有啥可以优化」→ 用本机语料定优先级后确认「支持上」，并追加 mermaid（懒加载，以体验为准）

## 背景

B-354 换掉手写渲染器之后，剩下的缺口用**本机真实语料**量过一遍（2,547 份 Claude
transcript / 20,984 条 assistant 文本块 / **1,723 张真表格**），结论是「明显该补」的功能
里大部分不该补，真正的缺口只有一个：**表格没有任何长度上限**。

| 事实 | 数值 |
|---|---|
| 出现表格的回答 | 5.8% |
| 表格行数 | p50 **5** / p90 **17** / p99 **56** / **max 238** |
| 超过 25 行的表 | **75 张** |
| 表格列数 | p50 3 / p90 5 / max 10；**>6 列只有 19 张（1.6%）** |
| `$…$` 数学 | 20 个命中样本**全是假阳性**（`$PODS`、`${tool}`、`$29,612`、`$/月`） |
| mermaid / GitHub alerts | **各 0 次** |

⇒ 表格的痛点是**竖着太长**，不是横着太宽。代码块 420px 就折叠，表格一路铺到底：
238 行 ≈ 10 屏，一条回答就能把 transcript 冲掉。

mermaid 在本机语料里是 0 次，但 Owner 明确要求支持；因此**唯一的硬要求是它不能进主包**
——一个从不出现的功能不该让每个用户多下几百 KB。

## 目标

- 超长表格默认折叠（fade + 展开按钮），与代码块同一套观感与阈值语义。
- 展开后滚动浏览长表时，**表头吸在 transcript 顶部**，随时知道每列是什么。
- `<th scope="col">`：屏幕阅读器能读出列头归属。
- ```` ```mermaid ```` 渲染成真图；**mermaid 及其依赖只在页面上真的出现 mermaid 时才下载**。
- 图渲染失败（LLM 写错语法是常态）时**无声降级回代码块**，不得把错误糊在正文里。

## 非目标

- 不做 KaTeX（数据见上：真数学≈0，装了反而会把 `$29,612`、`${tool}` 吃成公式，净负面）。
- 不做 GitHub alerts（`> [!NOTE]`，语料 0 次）。
- 不做表格排序/筛选/导出 CSV。
- 不动 B-354 定下的引擎、插件与安全策略。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 代码块折叠：420px cap + fade + 「展开 N 行」按钮，阈值 23 行 + 5 行 slack | `CodeView.tsx:62-99`、`codeCollapse.ts:40-45`、`code.css:113-119` |
| **折叠区绝不能变成嵌套竖向滚动区**（wheel 必须冒泡到 transcript，事故 `fb44581f`） | `CodeView.tsx:6-9` 头注释 |
| `shouldCollapse(lineCount, threshold, slack)` 是共享纯函数 | `codeCollapse.ts:35-37` |
| 表格包裹器已有 `overflow-x: auto` 与 `is-scrollable`（ResizeObserver 测 `scrollWidth-clientWidth`） | `Markdown.tsx` 的 `useOverflowX` / `MarkdownTable`；`markdown.css` 的 `.md-table-wrap` |
| 表格**没有任何 max-height**，也没有折叠 | `markdown.css` `.md-table-wrap` |
| 代码块走 `components.pre`，`plainCode`（流式草稿）时跳过 shiki | `Markdown.tsx` 的 `buildComponents`；`CodeView.tsx:47-58` |
| shiki 是懒加载分包的先例（`shiki/core` + 按语言/主题动态 import） | `highlighter.ts:1-14` |
| 主题 token 与深浅两套值 | `styles/tokens.css` |
| transcript 的滚动容器 | `chatlist.css` 的 `.cl-scroll`；内容列 `max-width: 820px` |
| mermaid 最新版 11.17.2，依赖 d3 / cytoscape / katex / roughjs / dompurify 等 22 个包 | npm registry（2026-09-04 查） |

## 设计

### A. 长表格折叠（B-356）

复用代码块那一套，**不引入嵌套竖向滚动**：

- 阈值：`TABLE_VISIBLE_ROWS = 12`，slack 4（走同一个 `shouldCollapse`）。
  取 12 的依据：p50=5、p90=17——12 行让一半以上的表完全不受影响，又能把 p90 那批收进折叠。
- 折叠态给 `.md-table-wrap` 加 `max-height`（约 12 行 + 表头）+ 底部 fade + 「展开（N 行）」按钮，
  与 `.cv--collapsed` / `.cv-fade` / `.cv-expand` 同形同文案键。
- **展开态不设 max-height、不设 overflow-y**——保持「一条 transcript 一个滚动容器」。

### B. 表头吸顶（B-356）

`th { position: sticky; top: 0 }` 要能贴在 **transcript 视口**上，前提是 `.md-table-wrap`
**不是 Y 方向的滚动容器**。而 `overflow-x: auto` 会让 `overflow-y` 计算值也变成 `auto`
（CSS overflow 规范：一轴非 visible 时另一轴的 `visible` 计算为 `auto`），于是 sticky 会
贴到包裹器自己的顶边、而包裹器没有竖向滚动 ⇒ 完全失效。

**做法**：把 `overflow-x: auto` 从**默认**改成**只在真的横向溢出时才加**——`is-scrollable`
这个信号已经有了。于是：

| 表格形态 | 占比 | 包裹器 | 表头吸顶 |
|---|---|---|---|
| 不需要横滚 | **98.4%** | `overflow: visible` | ✅ 贴 `.cl-scroll` 视口 |
| 需要横滚 | 1.6% | `overflow-x: auto`（+ 滚动阴影） | 退化成无效（贴包裹器顶边），可接受 |

**风险与缓解**：`overflow: visible` 时若表格真的过宽，会在 ResizeObserver 把类翻上去之前
**溢出一帧**。测量改到 `useLayoutEffect`（paint 之前）即可消除；实现时必须在真实浏览器里
确认「宽表首帧不外溢」。另外要确认 `overflow: visible` 下 `scrollWidth` 仍能报告内容宽度
（否则 `is-scrollable` 永远不会翻）——**这一条实现前先写探针实测，不能靠推断**。

### C. `scope="col"`（B-356）

一个 rehype pass：给 `thead` 里的 `th` 加 `scope="col"`。`mdast-util-to-hast` 不加。

### D. mermaid 懒加载（B-357）

```
components.pre
  ├─ lang === 'mermaid' 且 !plainCode  → <MermaidView code>
  └─ 其他                              → <CodeView>（现状）
```

`MermaidView` 的状态机（**每一步都保证屏幕上有内容**）：

| 状态 | 显示 |
|---|---|
| 初始 / 加载 mermaid 中 | **代码块**（`CodeView`，plain）——不是 spinner，不是空白 |
| 渲染成功 | SVG + 右上角「源码 / 图」切换 |
| 语法错误或渲染抛错 | 回落代码块，附一行 `--text-dim` 的说明；**不显示 mermaid 自己的错误图** |

- **懒加载**：`await import('mermaid')` 只在第一次遇到 mermaid 块时执行，落到独立 async chunk
  （先例 `highlighter.ts`）。验收硬指标：`vite build` 后 mermaid 不得出现在 `AppRoot` chunk 里，
  且 `AppRoot` 的 gzip 增量 < 5 kB。
- **流式**：`plainCode` 为真时**一律不渲染图**——半截图形必然解析失败，而草稿每秒重渲多次，
  会变成一串失败重试。草稿显示代码块，1.5 秒后落地的持久消息再出图。
- **主题**：`theme: 'base'` + 从 tokens 读取的 `themeVariables`；主题切换要重渲（订阅现有主题源）。
- **安全**：`securityLevel: 'strict'`（禁 click 处理器与原始 HTML 标签）；mermaid 内部用 dompurify。
  渲染产物是 SVG 字符串，只能经 `dangerouslySetInnerHTML` 注入——**这是本仓第二处**
  （第一处是 shiki，`CodeView.tsx:73-76`，理由是 shiki 自己转义内容）。必须在 spec 与代码注释里
  写清为什么可以接受：`securityLevel: 'strict'` + dompurify 已在 mermaid 内部消毒。
  **实现时要写一条测试**：喂一段带 `<script>`/`onclick` 的 mermaid，断言产物里没有它们。
- **id 唯一性**：`mermaid.render(id, code)` 的 id 必须每次唯一，否则同页多图互相踩（用 `useId`）。
- **体验细节**：图宽超过内容列时按比例缩小到 100%（不横滚）；点击图打开全屏查看（复用已有的
  overlay 手法）；`prefers-reduced-motion` 下禁用 mermaid 动画。

## 兼容矩阵与发布顺序

- **纯 web 改动**，不动 wire / CLI / server。server/web 同镜像发布即可。
- 新增依赖 `mermaid`：只进 `happy-web-v2`，通过动态 import 分包。
- 回滚：本 PR squash 后回滚单位是整个特性（与 B-354 同，见那份 spec 的「回滚粒度」）。

## 风险

1. **`overflow: visible` 让宽表首帧外溢**（见 B）。缓解：`useLayoutEffect` 测量 + 真实浏览器验。
2. **`scrollWidth` 在非滚动容器上的行为**是整个 B 方案的前提。缓解：实现前探针实测，不成立就退回
   「永远 `overflow-x: auto` + 放弃吸顶」，并在 spec 里记下为什么。
3. **折叠阈值选错**会让常见的 5 行表也被折叠（比不折叠更烦）。缓解：阈值取自实测分位数，
   并补一条测试钉住「p50 尺寸的表不折叠」。
4. **mermaid 进主包**。缓解：验收硬指标（AppRoot gzip 增量 < 5 kB）+ 构建产物断言。
5. **mermaid 的 SVG 注入**。缓解：`securityLevel: 'strict'` + 注入测试。
6. **mermaid 渲染在长会话里的成本**：每张图一次 `render()`。缓解：`plainCode` 不渲染；
   同一份源码在 `MessageView` memo 下只渲染一次。

## 验收标准

- [ ] 5 行表（p50）不折叠；30 行表折叠并显示「展开（30 行）」；展开后无 max-height
- [ ] 折叠区**没有**嵌套竖向滚动（wheel 冒泡到 transcript）
- [ ] 展开长表滚动时表头吸在 transcript 顶部（真实浏览器实测，深浅两个主题各一张图）
- [ ] 宽表（>6 列）首帧**不外溢**，仍有横滚与滚动阴影
- [ ] `thead th` 带 `scope="col"`
- [ ] mermaid：正确的图出图；**错误的图无声回落代码块**；流式期间只显示代码块
- [ ] mermaid 的 `<script>` / `onclick` 注入测试通过
- [ ] `vite build`：mermaid 不在 `AppRoot` chunk；`AppRoot` gzip 增量 < 5 kB（实测值回填）
- [ ] 深浅主题下 mermaid 配色坐在 token 台阶上，不是 mermaid 默认色
- [ ] 门禁全绿：web vitest / build / tsc 零错误

## 留真机验证项

- 手机上长表格折叠/展开的手感，与展开后吸顶表头在触屏滚动下的表现。
- mermaid 大图在手机上的可读性（缩放后是否还看得清）。
