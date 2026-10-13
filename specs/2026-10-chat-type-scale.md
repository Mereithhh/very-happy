# 对话字号比例化 + 对话字号设置

> 状态：Final（实现随本分支提交）
> 日期：2026-10-13 ｜ 关联 backlog：B-582 ｜ 出处：Orca `docs/STYLEGUIDE.md`「Chat type scale」（MIT，只借鉴做法）

## 背景

对话区字号此前直接写 `--fs-10…14` 或裸 px，全部是绝对值：想让对话整体变大/变小，只能逐个改，且字号、间距、图标、行高会各自漂移。Orca 的做法是对话区只用几档字号，每档都是「文字大小」设置的比例，间距单位也跟随字号缩放。本次把同样的结构搬到 very-happy，并加一个设备级「对话字号」设置。

## 目标

1. 对话区只用 6 个字号 token（5 个不同默认值），全部 `calc(默认px × --chat-scale)`；对话间距单位 `--chat-space`（默认 4px）同样乘比例。
2. 默认档（`--chat-scale: 1`）与改动前**逐元素像素一致**（几何、字号、行高 diff = 0，取证见下）。
3. 「外观 → 对话字号」：小 / 默认 / 大 / 特大（0.9 / 1 / 1.125 / 1.25），本设备保存，接入设置搜索。
4. 设计 lint 把「对话区字号只用档位」从「不写 px」升级为「只用 `--chat-fs-*`」，CONVERSATION_CSS 补上 `askStepper`、`chatReadingAids`。

## 非目标

- 终端 pane（铁律 9：字体尺寸/行高固定，`terminal.css`、xterm 主题一律不动）、营销页、侧栏/顶栏/弹窗/菜单。
- 输入框工具栏控件（＋、权限、模型、发送按钮）与排队 dock 的按钮尺寸：只缩放输入正文，控件几何保持 B-435/B-513 已验收的尺寸。
- 对话列宽 820px、`--chat-content-inset`（B-455 与输入框共用的左右内边距）不随字号变化。
- `diff.css` / `turnDiff.css`：DiffView 同时服务文件面板改动视图，不属于对话专属，保持原样。
- mermaid 主题里的 `fontSize: '13px'`（SVG 内部渲染，随 viewBox 缩放），不迁移。
- **双指捏合调字号不做**，理由见「设计 §4」。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 字号阶梯 `--fs-10…40` 为绝对 px；`--conversation-size` = 14，触屏/≤860px = 15；`--conversation-icon-size` = 18px | `packages/happy-web-v2/src/styles/tokens.css`（改前 L197–209、L267–269） |
| 对话区 css 集合（lint 的 CONVERSATION_CSS），只拦新增行写死 `font-size: <n>px` | `scripts/dev/check-design-lint.mjs` |
| 对话区存量：`var(--fs-12)` 40、`--fs-11` 38、`--fs-13` 28、`--fs-14` 6、`--fs-10` 2、`--fs-16` 1、裸 px 字号 10、`--workspace-primary-size` 1；`var(--sp-*)` 间距约 210 处 | 本次 `grep` 盘点（下表） |
| 手机所有可编辑控件被全局规则钉在 16px（`:is(#root, body) :where(input, textarea…)`，含 ≤860px 细指针） | `src/styles/base.css` L124–140 |
| 主题偏好走独立 localStorage 键、启动时直接读，不经 LocalSettings | `src/ui/themePreference.ts`、`src/ui/theme.tsx` |
| LocalSettings 是整块 `safeParse`，未知 enum 值会重置整块（所以新增 enum 只能追加） | `src/sync/localSettings.ts` 头注与 `boardLayout` 注释 |
| 设置搜索索引为声明式表，`settingsIndex.test.tsx` 渲染各节断言锚点存在 | `src/screens/settings/settingsIndex.ts` |
| 对话列表容器 `.cl-scroll` 为 `touch-action: pan-y`，页面 viewport 允许缩放 | `screens/session/chatlist.css` L31、`index.html` L5 |

### 盘点与映射表

字号（对话区 27 个 css 文件，迁移后全文件零 `--fs-*`/裸 px，由 `chatTypeScale.test.ts` 整文件校验）：

| 改前 | 改后 token | 默认值 | 用途 |
|---|---|---|---|
| `var(--conversation-size)`、`--fs-14`、`14px` | `--chat-fs-body`（= `--conversation-size`） | 14 / 触屏 15 | 消息正文、工具/子代理行、卡片正文、输入正文 |
| `--fs-13`、`13px` | `--chat-fs-control` | 13 | 卡片标题、权限说明、按钮文字、`.cmd`/`.perm-tool` 命令头 |
| `--fs-12`、`12px`（非代码） | `--chat-fs-secondary` | 12 | 标签、时间、计数、行下第二行、思考头 |
| `--fs-12`、`12px`（代码/输出） | `--chat-fs-code` | 12 | `.cv-pre`、shiki、`.tv-query`、`.tv-results`、team/tool-history 源码 |
| `--fs-11`、`11px` | `--chat-fs-caption` | 11 | 度量、注脚、mono 小标题 |
| `--fs-10` | `--chat-fs-badge` | 10 | 附件文件名、徽章 |
| `--fs-16`、`16px`（触屏输入） | `max(16px, var(--chat-fs-body))` | 16 | 输入框、排队编辑、侧问、原位编辑 |
| `var(--workspace-primary-size)`（`.ci-textarea`） | `calc(var(--workspace-primary-size) * var(--chat-scale))` | 14 | 桌面输入正文（保持与侧栏主标签同基准） |
| `1.5em` 等 em | 不变 | — | Markdown 标题、行内代码随父级自动缩放 |

间距与几何：

| 改前 | 改后 | 文件 |
|---|---|---|
| `var(--sp-N)`（gap/padding/margin） | `calc(var(--chat-space) * N)` | message、toolgroup、toolview、statusbar、subagent（不含面板头与 dock 的 lane 内边距）、turnactivity、livestream、markdown、code、command、builtinTool、permission、compaction、meta、messageActions、attachments、askStepper、mermaid |
| `.cl-inner` gap 12 / padding 16·24 | `--chat-space` × 3 / × 4·6 | chatlist |
| 工具组头 32、工具行头 30、预览行 32、思考头 30、展开按钮 30、工具区标题 30、子代理入口 36、实时状态 32 | `--chat-space` × 8 / 7.5 / 8 / 7.5 / 7.5 / 7.5 / 9 / 8 | toolgroup、message、toolview、subagent、statusbar |
| 触屏命中区 44 | `max(44px, calc(var(--chat-space) * k))` | 同上（只可变大，不可变小） |
| 用户气泡 padding 12·18（窄屏 10·14） | `--chat-space` × 3·4.5（2.5·3.5） | message |
| 子代理摘要缩进 40、入口箭头列 14、状态槽高 16、耗时 gap 4 | `--chat-space` × 10 / 3.5 / 4 / 1 | toolgroup、subagent |
| 首图标槽 18px | `--conversation-icon-size: calc(18px * --chat-scale)` | tokens |
| 对话内 lucide 图标（TSX `size={n}`） | `.cl-inner svg.lucide, .sap-body svg.lucide { zoom: var(--chat-scale) }`；直接给 svg 设槽宽的 3 条规则改为 `calc(--conversation-icon-size / --chat-scale)` 抵消 zoom | chatlist、toolgroup、message |

## 设计

### 1. Token（tokens.css）

```css
--chat-scale: 1;
--chat-fs-body: calc(var(--fs-14) * var(--chat-scale));   /* 触屏/≤860px: fs-15 × scale */
--chat-fs-control / secondary / caption / badge / code      /* 13 / 12 / 11 / 10 / 12 × scale */
--chat-space: calc(var(--sp-1) * var(--chat-scale));
--conversation-size: var(--chat-fs-body);
--conversation-icon-size: calc(18px * var(--chat-scale));
:root[data-chat-size='sm'|'lg'|'xl'] { --chat-scale: 0.9 | 1.125 | 1.25; }
```

- **固定比例岛**（review 修订）：浮在对话上的 chrome（选中引用 `.cl-selquote`、提问导航轨预览 `.cl-rail`、悬浮时间 `.msg-hover-time`）、弹窗与预览（`.runtime-controls`、`.image-preview`、`.skill-preview`）、终端页的工具历史 `.term-screen > .tool-history`（铁律 9：终端几何固定）一律不随档位变化。tokens.css 在 `:root` 和这些选择器上声明同一组档位，并在岛上设 `--chat-scale: 1`，岛内的档位 token 就按默认值计算，组件 css 不用另写一套字号。弹窗另外显式改用不乘比例的 `--conversation-size-base`（14 / 触屏 15）。
- 非对话区对 `--conversation-size` 的引用清单：`claudeRuntimeDialog.css`（L1/4/10）、`components/imagePreview.css`（L5/14）、`ui/skillDocumentPreview.css`（L2/6）已改为 `--conversation-size-base`；`screens/notes/notes.css` L156–157（笔记正文，B-451 规定与对话同字号，属于阅读面）保留缩放。
- 输入框上方的 dock（`.perm-dock`、`.sa-dock`、`.ci`）水平内边距固定为 `--sp-4`（触屏 `--sp-3`，与 `.ci` 一致），只有纵向用 `--chat-space`，保证 B-455 左边界不随档位漂移。`.sa-dock` 触屏仍是 16px，这是改动前就有的差异，本次不改。
- 全部定义在 `:root`、比例也放在 `<html>` 上：未注册的自定义属性在声明处做 var 替换后继承，若把比例放到对话子树上，`:root` 已算好的档位不会重算。代价是设置作用于所有复用这些 token 的阅读面：对话、侧问、子代理面板、笔记正文、文件/skill 预览与团队详情里的 Markdown/代码块。它们本来就共用对话字号，统一跟随是预期行为。
- 档位数量：任务建议 4–5 档；本仓 §3 已有「次级控件 13px」，代码块存量是 12px，为了默认档零像素差，保留 6 个语义 token（5 个不同默认值）。`code` 与 `secondary` 同为 12，但语义分开，后续可以单独调整代码字号。
- 比例只到 0.9：0.9 × 10px 徽标 = 9px 仍可读；更小的档位会让徽标低于可读下限。
- 图标用 CSS `zoom` 而非逐个改 TSX `size`：默认档 `zoom: 1` 不改变布局（像素 diff 证实）。`zoom` 会连带放大 svg 自身的 CSS 宽度，所以直接给 svg 设槽宽的规则要除回去。只作用于 `.cl-inner` 与 `.sap-body` 内的 `svg.lucide`，不碰输入框工具栏。
- B-455 左边界：首图标槽 18·s、槽后间距 2 × chat-space = 8·s，首文字始终位于 26·s（实测 26 → 32.5 @1.25，各行一致）。

### 2. 迁移规则

对话区 css 的字号只用上表 token；关键间距与行高度用 `--chat-space` 倍数；触屏命中区一律 `max(44px, …)`。手机可编辑控件保持 `max(16px, var(--chat-fs-body))`，并在 input.css 用 `:is(#root, body)` 同级特异性越过 base.css 的全局 16px，让大/特大档的输入正文也能放大，同时不低于 16px。

### 3. 设置：本地设备级

- 存 `localStorage['vh-chat-text-size']`（`sm|lg|xl`，默认档删除该键），`src/ui/chatTextSize.ts`：`normalizeChatTextSize`（未知值归默认）、`applyChatTextSize`（默认档移除 `data-chat-size`）、`useChatTextSize`（`useSyncExternalStore` + 跨标签 `storage` 事件）。`main.tsx` 在首个 render 前 `installChatTextSize()`，不闪字号。
- **为何不走 synced settings**：字号属于屏幕与视力，手机和桌面通常要不同档；同步会让一台设备的改动覆盖另一台。也就不存在铁律 1 的 `.default()` 风险。
- **为何不进 LocalSettings 整块**：需要在 React 和 storage 初始化之前读取（同主题偏好）；独立键加上读时归一化，旧 web 读到未来的新档位只会回落默认，不会让整块 `safeParse` 失败、重置其他本地设置。
- 设置页：「外观」主题之后新增「对话字号」组（4 个单选行 + 百分比 + 说明），`settingId="appearance.chatTextSize"`；搜索别名：字号 / 字体大小 / 文字大小 / 对话字号 / 字大小 / 放大 / 缩小 / font size / text size / chat font / zoom / scale / larger text / smaller text。

### 4. 双指捏合：不做

Orca 的捏合是 React Native 原生手势。Web 上要接管两指手势，就得在对话列表 `preventDefault` 掉 `touchmove`/`gesture*`：这会关掉页面缩放这个无障碍兜底；iOS Safari 的 `gesturechange` 与 `touch-action` 支持也不一致；长按选择、B-577 选中引用都在同一区域。桌面 Chromium 的触屏模拟验证不了真机多指行为。按任务要求（必须不干扰页面缩放与长按选择，否则不做），本次不实现，档位只在设置里切换。

## 兼容矩阵与发布顺序

纯 Web 改动，无 wire/协议/存储语义变化，无 Prisma migration，不涉及 CLI 与 server。

| 组合 | 行为 |
|---|---|
| 新 web × 旧/新 server × 旧/新 CLI | 正常；设置只在浏览器本地，不上送 |
| 旧 web（回滚）× 任意 | 忽略 `vh-chat-text-size` 键与 `data-chat-size`，按原绝对字号显示；无报错 |
| 新 web 读到未知档位值（未来版本写入） | `normalizeChatTextSize` 归默认 |

发布：随常规 server/Web 镜像发布，无顺序要求；回滚点为上一个 Web 镜像。

## 风险

1. **作用面比「对话」略宽**（笔记、文件/skill 预览、团队详情中的 Markdown/代码也跟随）：属于有意统一，已写入设置说明与 design-language。
2. **5 个元素在触屏/≤860px 宽度下 +1px**：`.ci-queue-text`、`.peer-message-who`、`.peer-message-body`、`.team-message-summary`、`.team-message-work > strong` 原写 `--fs-14`（不随触屏变 15），归入正文档后与正文一致（14→15）。桌面不变；harness 未覆盖这几个元素，未做像素比对。接受，理由：它们都是消息内容，原先不跟正文触屏档是遗漏。
3. **CSS `zoom` 兼容**：Chrome/Safari 长期支持，Firefox ≥126。Firefox <126 不支持 zoom：默认档不受影响；非默认档下，直接给 svg 设槽宽的规则（`calc(--conversation-icon-size / --chat-scale)`）没有 zoom 抵消，图标列与其他行相差约 4.5px（18 × 1.25 − 18）。接受：Firefox ESR 128 已支持 zoom。
5. **已知限制：跨标签切换档位**时，另一个标签页在 `storage` 事件里立即换档，正在上翻阅读的位置会随内容高度变化而跳动。接受：换档是低频操作，贴底跟随不受影响。
4. **小档位徽标 9px**：只在用户主动选择「小」时出现。

## 验收标准

- [x] 默认档前后逐元素对比（`/dev/mobile-chat`、`/dev/subagent/x` × 1280/390-coarse × 亮/暗，共 8 组、约 2,700 个元素）：rect / font-size / line-height 最大差 0.00；截图像素仅 `HH:mm` 时间戳行不同（两次截图跨了一分钟）。
- [x] 四档 × 两视口 × 两主题：无横向溢出（`scrollWidth - clientWidth = 0`）；代码块在块内横向滚动（`overflow-x: auto`，sw > cw）；实时状态单行（高度 = 8·chat-space，触屏 ≥44）；输入框底部工具栏按钮垂直中心一致；工具组/子代理/实时状态/预览首文字 26·s 对齐；触屏最小命中区 44。
- [x] 触屏输入在大/特大档放大（16.875 / 18.75px），默认/小档保持 16px。
- [x] 设置页（1280 / 390-coarse）切换写入 localStorage、刷新保留、回默认移除属性与键；设置搜索 字号/字体大小/对话字号/font size/text size 首条命中。
- [x] `check-design-lint` 规则②升级（含 `font:` 简写），整文件契约测试 `chatTypeScale.test.ts`。
- [x] 固定比例岛在特大档仍为默认值（实测：终端工具历史 13/11、选中引用与导航轨 12、悬浮时间 11、运行控制弹窗 14/触屏 15）；`.perm-dock` 水平 16 / 触屏 12 不变，纵向 8 → 10。

## 留真机验证项

- iOS Safari：大/特大档输入框聚焦不触发页面缩放（≥16px，理论上安全），以及 `zoom` 下图标清晰度。
- 真机上四档的长时间阅读观感（行长、代码块密度）。
