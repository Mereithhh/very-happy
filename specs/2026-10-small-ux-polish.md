# 小体验四件：看板换列动画、会话预览、功能提示、通知引导卡避让

> 状态：Final
> 日期：2026-10-13 ｜ 关联 backlog：B-588 ｜ 出处：Orca 对照第三轮（`components/dashboard-popout/agent-board-transitions.css`、`sidebar/worktree-card-details-hover-state.ts`、`feature-tips/`、`contextual-tours/`，MIT，只借做法）

## 背景

Orca 对照第三轮列出的三件小体验，加上 B-570 上线后发现的遮挡问题：

1. 看板卡片在列之间跳变（运行中 → 等你处理），眼睛跟不上「哪张卡走了」。
2. 侧栏会话行只有标题和一行副标题，想知道「这个会话在哪台机器、什么模型、上一轮说了什么」必须点进去。
3. 新功能（审阅全部改动、设置项搜索、会话预览）上线后没人知道入口。
4. 通知开通引导卡（B-570）`position: fixed; bottom/right`，手机上盖住输入框、发送按钮，以及之后会放在输入区附近的「上一条/下一条提问」按钮；桌面会话页也会压住输入框右侧的发送按钮。

## 目标

1. 看板卡片换列时有约 180ms 的位移过渡；列内重排、流式更新不触发；减少动态效果时关闭。
2. 侧栏会话行可打开只读「预览」Popover：桌面 `(hover: hover) and (pointer: fine)` 悬停 600ms 打开、离开即关；任意设备可从行菜单「预览」或聚焦行按 Alt+Enter 打开。
3. 轻量功能提示：新功能入口旁一次性小提示（文案 + 「知道了」+ 关闭），本地记忆，全局最多 1 个，首次加载 3 秒内不弹，不遮挡输入区；设置里可「重置功能提示」。
4. 通知引导卡与 PWA 安装卡在会话页/终端页统一移到顶部（顶栏下方、安全区内），不再盖住输入区；打字时延后出现。

## 非目标

- 不做 Orca 式多步 contextual tour、带演示动画的大弹窗、遥测。
- 预览卡不放任何操作按钮（「主要操作」仍在行本身和菜单），不做终端行预览。
- 不引入新依赖、不加 View Transitions API 路径（FLIP 足够，且不受浏览器支持差异影响）。
- ⌘P 打开文件（B-576）与提问导航轨（B-579）在本基线不存在，本轮不为它们接提示；它们合入后各自追加一条 tip 定义即可。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 看板 lifecycle 两列 + done 记录列、tasks 模式按 lane 分组；卡片 `key=item.key`，换列 = 在另一列表重新挂载 | `packages/happy-web-v2/src/screens/board/TaskBoardScreen.tsx` `Column` / `TaskLane` |
| 列表各自 `overflow-y: auto`（桌面），卡片在列间位移会被列裁剪 | `screens/board/board.css` `.bd-col-list`、`.bd-lane-cards` |
| 「最近一轮」只读本 tab 已加载的消息、不发请求，按 messages 数组缓存 | `screens/board/useBoardItems.ts` `useSessionPreview` |
| 侧栏行菜单是 `MenuItemDef[]`，同时喂省略号下拉和右键菜单 | `screens/sessions/Sidebar.tsx` `rowMenuItems` / `SidebarRow` |
| 行状态文案（运行中/等你处理/未读/离线/无更新）在 `SidebarRow` 内已算好 | `Sidebar.tsx` `statusLabel` |
| 运行中模型：`metadata.currentModelCode`，退而 `latestUsage.model`；显示用 `compactResolvedModelCode` | `sync/storageTypes.ts`、`components/modelModeOptions` |
| 会话元数据没有 git 分支；分支只能经 `bash` session RPC 取（Files 面板同法） | `sync/gitStatusFiles.ts`、`sync/ops.ts` `sessionBash` |
| design-language §6 规定「悬停显示富内容：目前没有，触屏点击 Popover」 | `docs/design-language.md` §6 组件选择 |
| 通知引导卡固定右下，窄屏左右撑满，仍在底部 | `screens/notifications/notificationOptInCard.css` |
| PWA 安装卡同样固定底部；输入框聚焦时延后出现（`shouldDeferPwaInstall`）；通知卡让位于它 | `app/pwaInstallPrompt.css`、`app/pwaInstallPolicy.ts`、`app/pwaInstallVisibility.ts` |
| CLI 更新横幅固定顶部，窄屏在 PWA 卡出现时隐藏 | `app/cliUpdateBanner.css` |
| 会话页输入区容器 `.sd-foot`，终端页根 `.term-screen`，会话顶栏 44px | `screens/session/SessionDetailScreen.tsx`、`screens/terminal/WebTerminalScreen.tsx`、`screens/session/header.css` |
| 「审阅全部」入口：每轮改动汇总行的 `.tdr-review` 按钮 | `screens/session/TurnDiffRollup.tsx` |
| 设置项级搜索已上线，设置入口为侧栏底部 `.sb-footer-btn` | `screens/settings/settingsIndex.ts`、`Sidebar.tsx` |

## 设计

### 1. 看板换列 FLIP（`screens/board/boardFlip.ts` + `useBoardFlip`）

- 屏幕组件把每张卡所在列算成 `Record<key, column>`（lifecycle：`running`/`waiting`；tasks：lane id / `ungrouped`）。
- **只在列映射变化时**工作：render 阶段比较新旧映射（纯函数 `columnChanges`），有变化时趁 DOM 仍是旧状态量出换列卡片的旧矩形（First）；`useLayoutEffect` 里量新矩形（Last），用一个 `position: fixed` 的克隆卡（ghost）从旧位置 `transform` 过渡到新位置（Invert/Play，180ms，`cubic-bezier(.2,0,0,1)`），期间真卡 `visibility: hidden`，结束后移除。
- 用克隆而不是直接位移真卡：列表是独立滚动容器，真卡位移会被裁剪。克隆是覆盖层，不参与布局。
- 旧/新位置不在各自列的可见区内（滚出视野、移动端折叠列）就跳过；`prefers-reduced-motion: reduce` 跳过；同 key 新动画开始前先结束上一个。
- 没有颜色变化，不用 accent；流式更新只改卡片内容，不改列映射，不触发。

### 2. 会话预览（`screens/sessions/SessionPeek.tsx`）

- Radix Popover，Anchor 为整行，`side=right`（coarse 时 `bottom`），不抢焦点（`onOpenAutoFocus` prevent），Esc/外点关闭。
- 打开方式：
  - 桌面 `(hover: hover) and (pointer: fine)`：`pointerenter` 600ms 后打开，`pointerleave`/按下/滚动即关；拖拽、菜单打开时不打开。
  - 行菜单「预览」（所有设备；触屏唯一入口）。
  - 行按钮聚焦时 Alt+Enter（Windows 资源管理器「属性」同键）。
- 内容（只读，无按钮）：标题；机器 · 目录 · 分支；agent · 模型；状态（复用行的 `statusLabel`）；最近一轮（复用 `useSessionPreview`，未加载过消息就省略）；未读 / 待处理 N（`agentState.requests` 数）。
- 分支：打开时若会话 active，经现有 `bash` RPC 跑 `git rev-parse --abbrev-ref HEAD`（3s 超时），按会话缓存 60s；失败/离线/非 git 目录不显示该段，不报错。
- 显示规则写回 design-language §6：只在 pointer: fine 悬停、600ms 延迟、离开即关、不含主要操作、触屏走菜单点击。

### 3. 功能提示（`components/featureTips/`）

- `featureTipsModel.ts`（纯）：tip 定义（id、文案、版本）、已看集合读写（`FEATURE_TIPS_SEEN_STORAGE = 'vh.featureTips.seen.v1'`，try/catch，存 `id@version`）、`pickTip`（按定义顺序挑第一个「未看 + 有可见锚点」的）、`placeTip`（锚点下方/上方，夹在视口内，与避让矩形相交就换边，两边都撞就不显示）、启动门槛 `performance.now() >= 3000`。
- `useFeatureTipAnchor(id, ref, enabled)`：入口组件登记锚点；`FeatureTipHost`（AppLayout 挂一次）选出唯一 tip，fixed 定位渲染：文案 + 「知道了」+ 关闭（44px 触屏命中），`role="dialog"` 非模态、不抢焦点；滚动/尺寸变化重新定位。避让矩形：`.sd-foot`（输入区、发送按钮、其上的固定区）。有 Radix 对话框/菜单打开时不显示。
- 本轮 3 条：审阅全部改动（`.tdr-review`，B-572）、设置项搜索与 ⌘K 设置直达（侧栏设置按钮，B-575/B-580）、会话预览（侧栏第一条会话行，B-588；桌面说悬停、触屏说菜单）。
- 设置 › 外观新增「重置功能提示」行（`settingId=appearance.featureTips`，入 `SETTINGS_INDEX`），点击清空记忆并 toast。

### 4. 引导卡位置统一（`app/floatingCards.css`）

- 规则：**有输入区的页面（`body:has(.sd-foot, .term-screen)`）上，PWA 安装卡与通知引导卡移到顶部**：`top: calc(max(safe-area-top, 0px) + 52px)`（让开 44px 顶栏），`bottom: auto`；其他页面保持原位置。两张卡共用这一份规则。
- 顶部已有 CLI 更新横幅（可能是 required 级别），不能让它让位；改为**通知卡在 `.cli-update` 存在时隐藏**（它本来就是可稍后的邀请）。PWA 卡与 CLI 横幅的既有让位规则不变。
- 通知卡出现时机对齐 PWA 卡：到点时若焦点在输入控件（`shouldDeferPwaInstall`），每秒重查，直到不在打字。

## 兼容矩阵与发布顺序

纯 Web 改动，无 wire / server / CLI 字段。

| 组合 | 行为 |
|---|---|
| 新 web + 旧 server | 无新接口，正常 |
| 新 web + 旧 CLI（daemon/wrapper） | 预览的分支经已有 `bash` RPC；旧 wrapper 支持；离线/不支持/超时只是不显示分支 |
| 新 web + 新 CLI | 同上 |
| 旧 web + 任意 | 无变化 |
| localStorage 不可用（隐私模式） | 提示每次加载可能再出现一次（知道了后本页内不再出现），不报错 |

发布：随 server/Web 镜像发布即可，无顺序要求；回滚即回滚 Web。

## 风险

1. render 阶段读 DOM 量旧矩形不纯：只在列映射变化时读、只读矩形，StrictMode 双调用结果一致；接受。
2. ghost 克隆与真卡视觉不一致（克隆不含后续流式内容）：只持续 180ms；接受。
3. 悬停预览误触：600ms 延迟 + 离开即关 + 不抢焦点；拖拽/菜单期间不开。
4. 分支 RPC 打到离线 wrapper：仅在 `session.active` 时发，结果缓存 60s，避免悬停扫一遍侧栏时打爆 RPC（一次悬停最多 1 次）。
5. `:has()` 旧浏览器不支持：卡片退回原底部位置，与改前一致。
6. 提示遮挡：显式避让 `.sd-foot`，撞上就不显示；全局最多 1 个。

## 验收标准

- [ ] 看板 running→waiting 换列时卡片位移约 180ms；列内重排、流式文本更新不动；`prefers-reduced-motion` 无动画。
- [ ] 桌面悬停会话行 600ms 出预览，离开即关；Alt+Enter 与菜单「预览」可开；触屏无悬停、菜单「预览」可开。
- [ ] 预览含标题、机器/目录/分支（可得时）、agent/模型、状态、最近一轮（已加载时）、未读/待处理。
- [ ] design-language §6「悬停显示富内容」一行更新。
- [ ] 功能提示：3s 内不出；全局 1 个；知道了/关闭后不再出；设置「重置功能提示」后可再出；不压 `.sd-foot`。
- [ ] 390 coarse 会话页：通知引导卡与 PWA 卡在顶部，不覆盖输入框/发送按钮；1280 会话页同样不压发送按钮。
- [ ] 1280 / 390(coarse) × 亮/暗 css-probe 取证；tsc、vitest、vite build、design lint、gitleaks 全过。

## 留真机验证项

- iOS Safari 安全区下引导卡顶部位置与刘海/灵动岛（模拟器验不了真实 inset）。
- 真触屏长按菜单打开「预览」的手感。
