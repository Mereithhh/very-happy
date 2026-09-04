# 长表格折叠 / 表头吸顶 与 mermaid 懒加载渲染

> 状态：Shipped（commit `8f2e59da`，2026-09-04；三轮对抗式 review，语料统计已纠错，CSS 与状态机均经真实浏览器实证）
> 日期：2026-09-04 ｜ 关联 backlog：B-357（表格）、B-358（mermaid）
> 前身：`specs/2026-09-markdown-engine-and-attachments.md`（B-354/B-355，已 Shipped `e38b8602`）
> 触发：Owner「markdown 渲染还有啥可以优化」→ 用本机语料定优先级后确认「支持上」，并追加 mermaid（懒加载，以体验为准）

## 背景

B-354 换掉手写渲染器之后，剩下的缺口用**本机真实语料**量过一遍（2,547 份 Claude
transcript / 20,984 条 assistant 文本块 / **1,723 张真表格**），结论是「明显该补」的功能
里大部分不该补，真正的缺口只有一个：**表格没有任何长度上限**。

> ⚠️ **v1 的行数分位数是错的，已纠正。** 第一版统计把「一条消息里所有 pipe 行」当成一张表，
> 于是含多张表的消息被合并计数，得出 p90=17 / max=238。改成**按分隔行逐表锚定**后
> （review 独立复现同一结果）：

| 事实 | 数值（按表锚定，2,547 份 transcript / 20,984 条 assistant 文本块 / **1,726 张表**） |
|---|---|
| 出现表格的回答 | 5.8% |
| 表格**数据行数** | p50 **4** / p75 6 / p90 **9** / p95 11 / p99 **18** / **max 67** |
| 行数 >10 / >16 / >20 | 111（6.4%）/ **22（1.3%）** / 8（0.5%） |
| 表格列数 | p50 3 / p90 5 / max 11；**>4 列 246 张（14.3%）**，>6 列 40 张（2.3%） |
| `$…$` 数学 | **2,079 处命中，抽样全是假阳性**（`$0.2/$`、`$976,815（环比…）；$`、`${tool}`、`$PODS`） |
| mermaid / GitHub alerts | **各 0 次** |

⇒ 结论要跟着数据改：**表格的长度问题只在尾部**（>16 行的 22 张，1.3%），最长 67 行 ≈ 3 屏——
不是「一条回答冲掉整个 transcript」。折叠因此是**给尾部买的保险**，不是普遍收益；
阈值必须保守到不打扰 p90（9 行）那一批。
**顺带一个更大的靶子**：14.3% 的表有 >4 列，在手机上真正难受的是**横向**——这条留作
follow-up（「手机全屏看表」），本批不做，理由见「非目标」。

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
- **不做「手机全屏看表」**：它服务的人群（>4 列，14.3%）比吸顶（1.3%）大一个数量级，
  但它是一个新的 overlay + 手势 + 文案面，与本批的 CSS 改动无关，独立成批更安全。已记 backlog。
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

### A. 长表格折叠（B-357）

复用代码块那一套，**不引入嵌套竖向滚动**（铁律：wheel 必须冒泡到 transcript）：

- 门：`TABLE_VISIBLE_ROWS = 12` + slack 4（同一个 `shouldCollapse`）⇒ **实际折叠起点是 17 行**。
  依据：p90=9、p95=11——17 行让 98.7% 的表完全不受影响，只收 22 张尾部表。
  （`shouldCollapse(n, 12, 4)` 的语义是 `n > 16`，spec v1 只写「阈值 12」会让人以为 13 行就折。）
- 高度由 CSS 定、行数只做门：折叠盒 `max-height: min(60vh, 480px)`，手机与桌面各自合适。
  这和代码块「420px cap + 23 行门」是同一套两段式（行数不依赖字体/缩放，像素才决定观感）。
- 折叠盒是**外层新元素** `.md-tbl--collapsed`，不是 `.md-table-wrap`（见下）。

### B. 表头吸顶（B-357）

**三条实测事实，缺一条方案就不成立**（真实 Chromium + 仓库真 CSS，2026-09-04）：

| 试的东西 | 结果 |
|---|---|
| `.md-table-wrap` 保持 `overflow-x: auto`（现状） | sticky **失效**：`th.top = -349` vs scrollport 0。`overflow-x:auto` 让 `overflow-y` 计算值也变 `auto`，包裹器成了 Y 滚动容器，sticky 贴到它自己顶边而它从不竖滚 |
| 改 `overflow-x: clip; overflow-y: visible` | computed 停在 `["clip","visible"]`（**不像 `hidden` 那样把另一轴强制成 auto**），sticky **生效**：`th.top = 0`，stuck ✓ |
| clip 下还能不能测出横向溢出 | **能**：`scrollWidth 627 / clientWidth 388`（390px 视口）。`is-scrollable` 照常翻 ✓ |
| 把 `max-height` 直接挂在 `.md-table-wrap` 上（v1 的写法） | **折不动**：wrap 302px 而表格仍 1548px，`clipped: false`。`overflow:visible/clip` 的盒子不裁 Y |
| 外层 `.md-tbl--collapsed{max-height;overflow:hidden}` | 折叠成功（300px vs 1548px）；**展开态不加这个类**时 sticky 仍 stuck ✓ |

于是定死：

```
.md-table-wrap                 overflow-x: clip; overflow-y: visible   ← 默认（97.7%）
.md-table-wrap.is-scrollable   overflow-x: auto                        ← 真的横向溢出时（2.3%）
.md-tbl--collapsed             max-height: min(60vh,480px); overflow: hidden   ← 只在折叠态
.md-tbl--collapsed th          position: static                        ← 折叠态不吸顶（没有竖滚，没意义）
```

**为什么是 `clip` 而不是 review 验证的 `visible`**：两者的 sticky 与测量行为实测**完全一致**，
但失败模式差很多——`visible` 下，在 ResizeObserver 把 `is-scrollable` 翻上去之前，宽表会
**越过滚动容器 455px**（390px 视口实测）并被 `.cl-scroll{overflow-x:hidden}` 裁掉，用户看到
「半张表凭空消失」；`clip` 下最坏只是「表格右缘被切一帧」。`clip` 还顺手让
`border-radius` 正确裁角（`visible` 会让表格四角戳出圆角边框）。

`clip` 之后**不再需要 `useLayoutEffect`**：首帧实测 `escapes_scroller_by = -31`、页面横向溢出 0
——表格被包裹器自己裁住，根本不会逃出滚动容器。`useOverflowX` 保持 `useEffect`，但把
`measure()` 提到了 ResizeObserver 的 guard **之前**（否则没有 RO 的环境下类永远翻不上去，
`clip` 会把宽表静默裁掉且无横滚）。

**吸顶的边框**：`border-collapse: collapse` 下边框归表格不归单元格，sticky 的 `th` 一脱离原位
就把 `border-bottom` 丢在原处——像素实测：吸顶后表头正下方直接是正文底色，没有任何 `--line`。
改用 `box-shadow: inset 0 -1px 0 var(--line)`（跟着单元格走），实测吸顶时该行像素为 `223`
（= `--line` 222）✓。**这条必须用像素验收，computed style 看不出来。**

### C. `scope="col"`（B-357）

一个 rehype pass：给 `thead` 里的 `th` 加 `scope="col"`。`mdast-util-to-hast` 不加。

### D. mermaid 懒加载（B-358）

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

- **API 顺序：先 `parse` 再 `render`**（实测 mermaid 11.17.2）：`parse` **不需要 DOM**、
  `{ suppressErrors: true }` 时坏语法返回 `false` 而不抛；`render` 需要 `document`。
  加 `initialize({ suppressErrorRendering: true })` 双保险，否则 `render` 失败会把 mermaid
  自己的红色错误图插进 DOM。
- **id 必须 sanitize**：React 19 的 `useId()` 形如 `«r1»`，mermaid 会拿它去 `querySelector` 而抛。
  用 `useId().replace(/[^a-zA-Z0-9_-]/g, '')`。
- **懒加载**：`await import('mermaid')` 只在第一次遇到 mermaid 块时执行（先例 `highlighter.ts`）。
  **「AppRoot gzip 增量 < 5 kB」是同义反复，不能当验收**——动态 import 必然不进 AppRoot
  （实测 696.25→696.39 kB）。真正要钉的是**运行时代价**，实测（临时接一次 `import('mermaid')` 后
  `vite build`）：JS chunk **48 → 108**，`dist/assets` **7.1M → 11M**，全部 JS gzip 合计
  **1551.5 → 2500.6 kB**；首张 flowchart 需要 `mermaid.core` **171.36 kB gzip** 加图类型分包
  （cytoscape 141.78 / katex 77.25 / sequenceDiagram 31.04 …）。PWA precache 保持 7 entries /
  16.80 KiB **不变**（若哪天 `globPatterns` 放宽，这 60 个 chunk 会被塞进 service worker，
  所以这一条也要钉住）。
- **弱网降级**：`navigator.connection.saveData` 或 `effectiveType` 为 2g/3g 时不自动下载，
  显示代码块 + 「渲染图表」按钮，把 171 kB 的决定权交给用户。
- **流式**：`plainCode` 为真时**一律不渲染图**——半截图形必然解析失败，而草稿每秒重渲多次，
  会变成一串失败重试。草稿显示代码块，1.5 秒后落地的持久消息再出图。
- **主题**：`theme: 'base'` + 从 tokens 读取的 `themeVariables`；主题切换要重渲（订阅现有主题源）。
- **安全**：`securityLevel: 'strict'`（禁 click 处理器与原始 HTML 标签）；mermaid 内部用 dompurify。
  渲染产物是 SVG 字符串，只能经 `dangerouslySetInnerHTML` 注入——**这是本仓第二处**
  （第一处是 shiki，`CodeView.tsx:73-76`，理由是 shiki 自己转义内容）。必须在 spec 与代码注释里
  写清为什么可以接受：`securityLevel: 'strict'` + dompurify 已在 mermaid 内部消毒。
  **注入测试**：`mermaid.render` 在 node 下抛 `document is not defined`，而本包 vitest 跑
  node 环境。因此该测试文件加 `// @vitest-environment happy-dom`（vitest 支持按文件切环境），
  并把 `happy-dom` 加进 devDependencies；`parse` 那一半仍可在 node 跑。
- **体验细节**：图宽超过内容列时按比例缩小到 100%（不横滚）；点击图打开全屏查看（复用已有的
  overlay 手法）；`prefers-reduced-motion` 下禁用 mermaid 动画。

## 兼容矩阵与发布顺序

- **纯 web 改动**，不动 wire / CLI / server。server/web 同镜像发布即可。
- 新增依赖 `mermaid`：只进 `happy-web-v2`，通过动态 import 分包。
- 回滚：本 PR squash 后回滚单位是整个特性（与 B-354 同，见那份 spec 的「回滚粒度」）。

## 风险

1. ~~`overflow: visible` 让宽表首帧外溢~~ → 改用 `overflow-x: clip`，最坏只是右缘被切一帧（见 §B）。
   RO 回调在 paint 之后是规范行为，零帧做不到，验收按「挂载首帧 + resize 一帧内恢复」写。
2. ~~`scrollWidth` 在非滚动容器上的行为~~ → **已实测成立**（clip 下 627/388）。
3. **折叠阈值选错**。缓解：实际起点 17 行，实测只覆盖 1.3%（22 张），p90=9 完全不受影响；
   补测试钉住「p50/p90 尺寸的表不折叠、17 行折叠」。
4. **吸顶的收益很小**（1.3%）而代价是改掉 97.7% 表格的 overflow 默认。缓解：`clip` 让失败模式
   从「半张表消失」降到「切一帧」；且不振荡（实测 12 次测量只翻 1 次，因为水平滚动条吃的是
   `clientHeight` 不是 `clientWidth`，不构成宽度反馈环）。**如果 Owner 觉得不值，删掉 §B 即可，
   §A/§C/§D 不依赖它。**
5. **mermaid 的运行时体积**（首图 171 kB gzip + 图类型分包）。缓解：懒加载 + 弱网降级 +
   验收回填实测 chunk 清单。
6. **mermaid 的 SVG 注入**。缓解：`securityLevel: 'strict'` + `suppressErrorRendering` +
   happy-dom 下的注入测试。
7. **多张长表同时吸顶**：实测 6 个滚动位 `bothStuck` 恒 false，交接干净，不成立。
   但 sticky 会紧贴 scrollport 顶边（`.cl-scroll` 无上 padding），需要一点偏移或分隔。

## 验收标准

- [ ] 4 行（p50）与 9 行（p90）的表**不折叠**；17 行折叠并显示「展开（N 行）」
- [ ] 折叠态**确实裁剪**了内容（盒高 < 表高），且**没有**嵌套竖向滚动（wheel 冒泡到 transcript）
- [ ] 展开态不设 max-height/overflow；滚动时表头吸在 transcript 顶部（真实浏览器，深浅主题各一张图）
- [ ] **吸顶时表头下边框仍可见**（像素采样对照，computed style 看不出来）
- [ ] 宽表：**挂载首帧不外溢**（clip），`is-scrollable` 翻上后可横滚且有滚动阴影；resize 后一帧内恢复
- [ ] `thead th` 带 `scope="col"`
- [ ] mermaid：正确的图出图；**坏语法无声回落代码块**（不出现 mermaid 自己的错误图）；
      流式期间只显示代码块；弱网（`saveData`）时不自动下载
- [ ] mermaid 注入测试（happy-dom 环境）：`<script>` / `onclick` 不出现在产物里
- [ ] `vite build` 回填实测：AppRoot gzip 增量、**chunk 数**、`dist/assets` 总体积、
      **全部 JS gzip 合计**、首张 flowchart 的下载 chunk 清单；**PWA precache 条目数不变**
- [ ] 深浅主题下 mermaid 配色坐在 token 台阶上
- [ ] 门禁全绿：web vitest / build / tsc 零错误

## 实测结果（回填）

| 项 | 数值 |
|---|---|
| 包体 | `AppRoot` gzip **696.26 → 698.15 kB（+1.89）**——这是折叠/mermaid **组件**的代价，mermaid 本体不在里面 |
| mermaid 分包 | `mermaid.core` **171.36 kB gzip** 独立 chunk；JS chunk **48 → 108**；`dist/assets` **7.1M → 11M**；全部 JS gzip 合计 **1551.5 → 2512.5 kB** |
| PWA precache | **7 entries / 16.80 KiB，不变** ✓ |
| 折叠（真实浏览器 + StrictMode） | 4/9/16 行不折叠；30 行折叠：盒高 **480px** vs 表高 **1109px**，`clipped: true`，`overflow-y: hidden`（无嵌套滚动），按钮「展开全部（30 行）」 |
| 吸顶 | 展开后滚动：`th.top = 0 == scrollport.top`，**stuck** ✓（900/390px、深浅主题各验） |
| 吸顶边框 | `box-shadow: inset 0 -1px 0` 实测生效（深 `rgb(48,50,45)`；浅 `rgb(222,223,217)`） |
| 宽表 | 900px：`overflow: clip`、不滚（放得下）；390px：`is-scrollable` 翻上、`overflow: auto`、**页面横向溢出 0**、越界 -16px（无外溢） |
| a11y | `th[scope="col"]` ✓ |
| mermaid | flowchart 与 sequence 各出一张 SVG；**坏语法回落代码块 + 一行说明**，未出现 mermaid 自己的错误图；控制台零错误 |
| 弱网降级 | 伪造 `saveData:true / effectiveType:'2g'`：首屏 0 张图 + 「渲染图表」按钮；**点击后 1 张图 + 「源码」切换**（第一版这里是死胡同：点了按钮既不出图、按钮也消失，`renderCalls` 恒 0） |
| 折叠盒可滚性 | `overflow: clip` 下 `scrollTop = 500` 之后仍是 **0**（`hidden` 时会被滚走，而表格里有可聚焦的链接/路径按钮） |
| 注入 | 5 种恶意形态注入 detached DOM 后：live `<script>` 0、`<img>` 0、`<iframe>` 0、`on*` 属性 0、`javascript:` href 0 |
| 慢网中间态 | 点击后按钮**留在原地并 disabled**、文案变「正在加载图表…」，不再是「点一下按钮就消失、然后十几秒什么都没有」 |
| 折叠 fade | `overflow: clip` 下 fade 仍是 absolute、与盒底齐平；像素上字形亮度沿 fade 由 255→35（深）/ 0→215（浅），渐变真的在起作用 |

## 已知并接受的残余

1. **Safari 15 及更早**不认 `overflow-x: clip`，会丢弃这条声明退回 `visible`——也就是本 spec
   想避开的「宽表在 RO 翻类之前越过滚动容器被裁掉半张」。`.md-table-wrap` **没有**可用的
   fallback（写 `hidden` 会把另一轴强制成 `auto`、杀掉吸顶），所以这是有意接受的降级。
   **但折叠盒有**：它本来就两轴都要裁，所以写成 `overflow: hidden; overflow: clip;` 两行并列
   ——老引擎拿到 `hidden`（能裁，只是会被焦点/⌘F 滚走），现代引擎取 `clip`。没有这行兜底的话，
   Safari 15 上折叠会**完全不生效**（30 行表全量铺开，中间浮一条 fade），比不做还差。
2. **StrictMode 下同一张图会并发渲染两次**（dev only）。已用「每次 effect 递增的 id 后缀」
   把互相抢临时节点的问题关掉；生产不双调用。
3. **happy-dom 只覆盖到 flowchart**：sequenceDiagram 在测试环境会抛
   `svg element not in render tree`（缺 SVG 排版引擎）。其它图类型只有浏览器验收一处证据，
   CI 挡不住它坏掉——测试文件里已写明。
4. **mermaid 加载失败只试一次**（`loadFailed`），与附件缩略图的「重试一次」一致；离线时
   5 张图不会变成 5 次失败请求。它是**模块级**的，比附件那边的组件级更严——所以补了一个
   `online` 监听把标志（连同那个已经 resolve 成 null 的 promise）清掉：这是个常开几小时的
   PWA，「进一次电梯断网」不该让剩下一整个 session 都没有图。
5. **手机上的横向问题这批没解决**：>4 列的表占 14.3%，在 390px 下只能横滚。真正的解是
   「全屏看表」，已记 backlog（B-359），它服务的人群比吸顶（1.3%）大一个数量级。
6. 另外 6 个 `<Markdown>` 调用方（`BtwPanel` / `ToolView` plan / `PermissionCard` /
   `SubagentDetail` / `FsFileViewer`）里，表头会吸在**那个面板自己的滚动视口**上——是想要的
   行为，但只在 transcript 里做过观感确认。

## 上线实证（2026-09-04）

- PR #258 squash 合入 `main@8f2e59da`；deploy run 33841788473（`target=all`、`rollout=switch`）
  `conclusion=success`；无 migration 变更。
- `check-shipped` 从**线上 entry 读到的 release SHA = 8f2e59da**，needle
  `md-tbl-expand` / `md-tbl-body--collapsed` / `mmd-svg` / `saveData` / `slow-2g` /
  `mermaidLoading` / `suppressErrorRendering` 全部命中；`/health` ok。
  （注意：`shouldDeferMermaid` 这种**函数名**在生产构建里会被压缩掉，不能当 needle——
  能钉住的是 CSS 类名与字符串字面量。）
- CLI `v0.2.119` 同批发布（带的是 B-355 的根因修复），`latest` 已由 promote job 提上去，
  平台包 `very-happy-tools-arm64-darwin@0.2.119` 在位；relay 的 `recommendedVersion`
  跟着 registry 走、1h 缓存，会自己跟上。

## 留真机验证项

- 手机上长表格折叠/展开的手感，与展开后吸顶表头在触屏滚动下的表现。
- mermaid 大图在手机上的可读性（缩放后是否还看得清）。
