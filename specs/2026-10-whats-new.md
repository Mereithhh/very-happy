# 更新通知改版：亮点 + 截图（What's new）

> 状态：Final ｜ 日期：2026-10-21 ｜ 关联 backlog：B-677、B-715
> 出处：Owner 10-21「更新文档写的可读性不够好，也没有一个截图啥的，用户看了就忽略了，其实我们最近做的都是很大的更新。」

## 背景

应用内更新通知（`ChangelogNotice`）和 `/changelog` 页每个版本只有「标题 + 一段摘要 + 一串勾选句子」。10-21 的 Web 版本（`oct21`）有 9 条、每条 40–80 词，CLI 0.2.179（`oct21a`）有 5 条；改版前截图见 PR。项目、可编辑草稿、会话搜索这种大功能和「键盘修复」排在同一个列表里、同样的字号，用户扫一眼看不出哪件事值得试，于是直接点「知道了」。

## 目标

1. 定一个所有版本通用的格式：少量亮点（每个有截图、一句话收益、可直达入口）+ 折叠的「其他改进」。
2. 条目数据支持亮点配图；旧条目（纯文字）原样显示，不迁移。
3. 弹窗和 `/changelog` 页按新格式渲染，桌面 / 手机、亮 / 暗都好看，遵守 `docs/design-language.md`。
4. 截图不拖慢首屏、不进 Service Worker 预缓存。
5. 用新格式重写 `oct21` / `oct21a`（中英），GitHub Release v0.2.179 同步。

## 非目标

- 不做视频 / GIF（见「竞品对照」第 6 条，后续需要时再加 `mp4` 字段）。
- 不做轮播 / 分页：亮点藏在「下一页」后面，大部分用户不会点。
- 不改已读回执（`vh.changelog.seen`）和「多版本堆叠」逻辑（B-315 / B-320 的语义保持）。
- 不给旧版本补截图。

## 竞品对照

2026-10-21 调研。「核验」= 读过页面 / HTML；「未核验」= 二手或记忆。

| 产品 | 呈现位置 | 每个版本的结构 | 媒体 | 示例 |
|---|---|---|---|---|
| **Linear**（[changelog](https://linear.app/changelog)） | 独立页，每条有永久链接（核验）；应用内帮助菜单有 What's new 入口（未核验） | 1 个主功能（2–3 段 + 一句「To get started…」上手指引）→ ~4 个 H2 次要功能（1–2 段，部分带 Learn more）→ Fixes / Improvements 列表，行首带模块标签（核验） | PNG 原图约 3600×2100，CDN 按 dpr=2 输出；mp4 带 poster、`preload="metadata"`；页面 16 处 `loading="lazy"`（核验） | **Priority inbox** — "The new Priority tab separates what needs your attention from what can wait…" |
| **Raycast**（[changelog](https://www.raycast.com/changelog)） | 独立页，分平台标签（核验）；v2.0 时在应用内引导（核验）；普通更新后应用内提示（未核验） | 版本 + 日期 + 1–3 句导语 → 0–1 个主功能小节（配图 + Tip）→ 固定三组 ✨ New / 💎 Improvements / 🐞 Fixes，每行「模块: 一句话」（核验） | PNG（核验） | **Send Context to AI** — "Two new commands let you show AI exactly what you're looking at." |
| **Arc**（[release notes](https://resources.arc.net/hc/en-us/articles/20498293324823)） | Help Center 文章累积（核验）；早期用 Easel 做图文发版说明、更新提示不打断工作（第三方） | 早期 FEATURES / IMPROVEMENTS + bullet；现在维护期只剩一段（核验） | — | "This release moves Arc to Chromium 149…" |
| **OpenAI Codex**（[changelog](https://developers.openai.com/codex/changelog)） | 独立页；桌面 App 的 What's new 按钮链过去（核验）；有用户抱怨提示没直链到当前版本（[issue #19948](https://github.com/openai/codex/issues/19948)，核验） | 标题 + 版本 → 一段主功能 → "This launch also includes:" 要点 → New features / Improvements 用 `<details>` 折叠（核验） | **webp、`loading="lazy"`、亮暗两张图**；内嵌 `max-height:400px`，点开 90vh 大图（核验） | **Appshots** — "Press both Command keys to send the frontmost app window to Codex…" |
| **Claude Code / claude.ai**（[changelog](https://code.claude.com/docs/en/changelog)、[release notes](https://support.claude.com/en/articles/12138966-release-notes)） | Claude Code 升级后启动显示 release-notes splash，`/release-notes` 可回看（二手）；claude.ai 帮助中心按月分组（核验） | Claude Code：Added / Changed / Improved，长修复列表折叠成 "Show 8 bug fixes"（核验）；claude.ai：加粗标题 + 一段 + 文档链接（核验） | 无图 | **Interactive apps in Claude for iOS and Android** — "Pull up live charts, sketch diagrams… right in your conversation." |
| Vercel（[changelog](https://vercel.com/changelog)） | 独立页，一个功能一条 | 标题是结果陈述（"X is now generally available"）+ 一句价值（核验） | 详情页才有主图 | **WebSocket support is now generally available** |

### 结论

1. **亮点少而大**：每家都是 1 个主功能 + 0–4 个次要功能，修复类沉到底部的分组列表里。
2. **标题写用户得到什么**（「Priority inbox」「X is now GA」），第一句写能做什么，不写实现。
3. **每个亮点给一个可点的动作**：「To get started…」「Learn more in the docs」。Codex 的 issue 说明：入口必须直达。
4. **长尾默认折叠、摘要里写数量**（Codex `<details>`、Claude Code "Show 8 bug fixes"）。
5. **截图准备亮暗两套**（Codex），webp + lazy，内嵌时限制高度。
6. 这几家都不用 GIF；需要动效时用 mp4 + poster + `preload="metadata"`。本次不做。
7. 已读按版本记，关掉一次不再弹；历史页可随时回看（我们已有 `/changelog` 和 B-315 的显式确认）。

## 格式规则（以后每个版本照此写）

1. **亮点 ≤ 4 个**（`CHANGELOG_MAX_HIGHLIGHTS`，测试强制）。按用户价值挑：新能力 > 明显变快 / 变顺 > 修复。只有修复的版本不写亮点，保持纯列表。
2. **每个亮点 = 标题 + 一句话 + 一张截图 + 可选「去试试」/「看文档」**：
   - 标题 ≤ 8 个汉字 / 6 个英文词左右，写结果（「一次搜遍所有会话」），不写 B-id、不写组件名；
   - 一句话写「你现在能做什么」，≤ 60 个汉字 / 30 个英文词，不堆细节；细节放 docs；
   - 截图：真实实现 + 演示数据（不出现真人姓名、邮箱、内部主机名或内部信息），裁到功能本身，16:10；
   - 「去试试」只放真能直达的入口：应用内路径（`{ kind: 'link', href }`）或无 URL 的动作（目前只有 `sessionSearch`）；「看文档」放公开文档路径。
3. **其余改动进「其他改进」**：`itemKeys` 在有亮点时渲染为折叠的「其他改进（N）」，每条一句话、≤ 2 行。
4. **标题和摘要短**：版本标题列出 2–3 个亮点名；摘要一句话，说清是否需要升级 CLI。
5. **中英都写**：`_default.ts` 与 `zh-Hans.ts` 同时加；alt 文本也要翻译。
6. **CLI 版本单独一条**，亮点只写需要新 CLI 才有的能力；Web 条目提到依赖时写「需要 CLI x.y.z」。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 条目只有 `titleKey` / `summaryKey` / `itemKeys`，没有媒体字段 | `packages/happy-web-v2/src/app/changelogRelease.ts`（`ChangelogRelease`） |
| 弹窗单版本 / 多版本两种渲染，都是勾选列表；只有显式确认才写回执（B-315） | `src/app/ChangelogNotice.tsx` |
| `/changelog` 是公开路由，在 `AppLayout` 外（会话搜索面板挂在 `AppLayout` 里） | `src/app/AppRoot.tsx` 的 `{ path: '/changelog' }`；`src/screens/AppLayout.tsx` 引用 `SessionSearch` |
| SW 只预缓存 `index.html` 和 manifest；运行时只缓存 `/assets/*.{js,css,woff,woff2}` | `packages/happy-web-v2/vite.config.ts` `workbox.globPatterns` / `runtimeCaching` |
| `/assets/*` 由 server 以 immutable 下发，`public/` 文件是 `max-age=0` | `packages/happy-server/sources/app/api/staticCache.ts` |
| 发布门禁用行首 `id:` / `cliVersion:` 正则解析条目 | `scripts/changelog/check-release.mjs` `extractReleases` |
| 主题由 `ThemeProvider` 解析，`useTheme().resolved` 是实际生效的亮 / 暗 | `src/ui/theme.tsx` |

## 设计

### 数据

```ts
interface ChangelogHighlight {
  key: string;                       // 不叫 id：check-release.mjs 用行首 `id:` 识别版本
  titleKey: SimpleTranslationKey;
  bodyKey: SimpleTranslationKey;
  image?: ChangelogImage;            // 规则要求有图；类型上可选，便于纯文字亮点过渡
  action?: { kind: 'link'; href: string } | { kind: 'sessionSearch' };
  docsHref?: string;                 // 公开文档路径，如 /docs/projects
}
interface ChangelogImage {
  width: number; height: number;     // 所有变体同尺寸，用于占位，避免图片到达时跳动
  altKey: SimpleTranslationKey;
  en: { light: string; dark?: string };
  zh?: { light: string; dark?: string };   // 中文界面截图，缺省回落 en
}
ChangelogRelease.highlights?: readonly ChangelogHighlight[];  // 有亮点时 itemKeys = 「其他改进」
```

- 图片放 `src/app/whats-new/<YYYY-MM-DD>/<name>-<en|zh>-<light|dark>.webp`，`changelogShots()` 用 `import.meta.glob(..., { query: '?url', import: 'default', eager: true })` 拿 URL。打进包里的只有 URL 字符串，没有字节。
- 选图是纯函数 `changelogImageSrc(image, lang, theme)`：`zh*` 语言且有 `zh` 时用中文图，暗色且有 `dark` 时用暗色图。

### 渲染

`ChangelogHighlights` 组件同时给弹窗和 `/changelog` 页用：

- 每个亮点一行：容器宽 ≥ 560px（桌面 760px 弹窗、`/changelog` 页）时左文右图（2 : 3），截图实际显示约 400px 宽，接近 480px 原始裁切，界面文字基本 1:1 可读；更窄（手机底部抽屉）时图在上、文在下。用 container query 判断，不看视口。
- 卡片本身不画框（弹窗已是闭合容器，1-Border Rule）。截图和弹窗底色相同，所以外面加一层 `--bg-2` 填充衬底（8px 内边距、`--r-md` 圆角），不用描边；`<img>` 带宽高和 `aspect-ratio`，图片到达前就占好位置。
- 「去试试」用 soft-fill 次级按钮（不用 accent，不和主 CTA「知道了」抢）；「看文档」是安静的下划线链接。触屏命中区 44px。
- 「其他改进（N）」用原生 `<details>`，默认折叠，键盘 / 读屏开箱可用。
- 点「去试试」/「看文档」先写已读回执再关弹窗（等同「知道了」），避免回来又弹一次。
- `/changelog` 页在 `AppLayout` 外，没有会话搜索面板，所以页面上只显示 `link` 类动作（`inApp={false}`）。
- 弹窗有亮点时加宽到 760px（`data-highlights`）；手机仍是底部抽屉。

### 图片体积与加载

- webp，单张 ≤ 150KB（测试强制），2× 像素密度截取，16:10。oct21/oct21a 的 24 张图每张 15–36KB，合计 632KB；弹窗只请求当前语言 + 主题的 6 张，其中折叠线以下的到滚动时才加载。
- `loading="lazy"` + `decoding="async"` + 宽高属性。图片只在弹窗打开或进入 `/changelog` 时才请求，首屏 JS / CSS 不变。
- 走 Vite 资源管线 → `/assets/<name>-<hash>.webp` → server immutable 缓存。**不进 SW 预缓存**（`globPatterns` 不变），SW 的运行时缓存规则只匹配 js/css/字体，图片走浏览器 HTTP 缓存，不占 SW 安装流量。
- 不放 `public/`：那里是 `max-age=0`，每次都要重新验证。

### 被否方案

- **轮播 / 分页**：一张大图更清楚，但第 2–4 个亮点要点「下一页」，多数人不会点；也要额外处理滑动、焦点和读屏。
- **两列网格**：先实现过，弹窗里每张图只有约 340px 宽，480px 的裁切缩到 0.7 倍，界面文字太小（按 760px 弹窗计算）。
- **单列整宽大图**：可读性最好，但 4 个亮点约 2000px 高，弹窗变成长文。左文右图的行布局在两者之间。
- **`<picture>` + `prefers-color-scheme`**：不跟随应用内手动选的主题，改用 `useTheme().resolved`。

## 兼容矩阵与发布顺序

纯 Web，无协议 / 存储变化。旧条目没有 `highlights` 时走原来的勾选列表。回执语义不变。随 server/Web 镜像发布即可，不需要 CLI 发版。

## 风险

1. **截图过期**：界面改了，截图就和实际不一致。缓解：截图只用于新版本条目，历史条目不回头改；截图脚本和演示数据流程写在 PR 里，可复现。
2. **截图里的文字太小**：缓解：只裁 480×300 CSS px 的功能区域，2× 截取（960×600），桌面显示约 400px、手机约 340px。
3. **翻译遗漏**：`zh-Hans` 类型完整性由 tsc 保证；alt 也走翻译 key。

## 验收标准

- [x] 竞品对照 + 格式规则（本文件）。
- [x] `highlights` / `ChangelogImage` 类型、`changelogImageSrc` 纯函数、`ChangelogHighlights` 组件；旧条目渲染不变。
- [x] 测试：亮点 ≤ 4、亮点 key 在本版本内唯一、文本 key 都在本版本的 block 下、每个亮点有图、图片文件存在且 ≤ 150KB、`check-release.mjs` 解析出的版本 id 与 `CHANGELOG_RELEASES` 一致、选图逻辑。
- [x] `oct21`（4 个亮点）/ `oct21a`（2 个亮点）中英重写，配亮暗截图。
- [x] 桌面 + 手机、亮 + 暗真浏览器截图（PR 附图）。
- [x] GitHub Release v0.2.179 正文按新格式更新。

## 增补（2026-10-21 第二版：大版本通知）

出处：Owner 10-21「要有一个比较好的发版通知，能跟大家直观的反映我们更新了什么，让大家意识到这是一个很牛的更新」。当天两次发布合成一个大版本讲（`oct21b` Web + `oct21c` CLI 0.2.180），已发布的 `oct21` / `oct21a` 不改写。

1. **主题组 `topics`（≤ 4，`CHANGELOG_MAX_TOPICS`）**：亮点之外的成组改动（团队、侧栏、手机、登录与稳定性），每组「标题 + 一句话 + 小图」。小图 640×400（320×200 CSS px 裁切 ×2）。弹窗里是左图右文的紧凑行，容器 ≥ 640px 时两列；`itemKeys` 仍是折叠的长尾。
2. **短动图 `motion`**：与静图同名加 `-motion` 后缀的动画 webp（`<name>-<lang>-<theme>-motion.webp`），`changelogShots()` 自动识别。只在 `/whats-new` 页播放（`motion` prop），弹窗仍用静图，首屏和通知不多下载；用 `<picture><source media="(prefers-reduced-motion: no-preference)">` 让「减少动态效果」的人只看到静图，不依赖 JS。体积上限：静图 150KB、动图 600KB（测试强制）。这条覆盖上文「非目标：不做 GIF」——选 webp 动图而不是 mp4，是因为它走现有 `<img>` 管线（懒加载、占位、亮暗/语言选图），不需要播放器控件。
3. **`featured` + `featuredTaglineKey`**：大版本在弹窗顶部显示品牌行，副标题可按版本配置（原来写死 9 月改版那句）；同时显示「打开完整更新页」。
4. **`hero` + `/whats-new` 长页**：公开路由（不需要登录，可直接转发），数据来自 `whatsNewReleases()`——最新的 featured 且有亮点的 Web 条目，加上同一天的 CLI 条目。结构：hero（标题、摘要、打开应用 / 升级 CLI、海浪动图）→ 4 个亮点（编号、左右交替、动图）→ 主题组 → 其余改进（Web / CLI 两列）→ 升级命令（`cliUpdateInstallCommand`，可复制）。官网「最新更新」区块和更新弹窗都链过去。
5. 截图脚本与演示环境：本地 standalone server + 隔离 daemon（`HOME=/home/alex`，主机名 `build-box`），真实 Claude 会话产出对话、团队与离线送达；脚本在 PR 描述里列出。

## 增补（B-715：大更新标识 + 叠加必须看完）

出处：Owner 10-21「我们最近的大更新，你可以明显标识一下，确保大家都能看到，然后我最近可能会发好几个大更新的通知，如果是叠在一起的，你要让用户看完再关，我不想让用户忽略任何有价值的功能。」本节覆盖上文「非目标：不做轮播 / 分页」——那条针对的是单个版本内部的亮点；这里分页的单位是**版本**。

### 数据

- `ChangelogRelease.major?: boolean`：大更新。`oct21`（`2026-10-21-projects-drafts-search`）与 `oct21b`（`2026-10-21-big-update`）标为大更新。
- 大更新必须有 `highlights`：`changelogPager.test.ts` 对 `CHANGELOG_RELEASES` 强制；发布门禁 `scripts/changelog/check-release.mjs` 的 `extractReleases` 解析 `major:` / `highlights:`，`evaluateWebRelease` 对「major 但无亮点」直接 FAIL，并在输出里列出本次新增的大更新（`major:` 行）。

### 醒目标识

- 「大更新」徽标（`MajorBadge`，`.vh-major-badge`）：弹窗 eyebrow、`/changelog` 条目 meta 行、`/whats-new` hero eyebrow。
- 颜色用新 token `--major` / `--major-dim`（紫，亮暗各一套，登记于 design-language §2）：accent 只表 live，warn/danger 是状态色，`--search-hit` 只表搜索命中，所以给它自己的色相。
- 大更新页更强：弹窗标题 24px、有 `hero` 时显示 hero 截图；`/changelog` 条目标题 24px（手机 20px）+ hero。小更新保持原轻量样式。

### 分页规则（`app/changelogPager.ts`，纯函数）

1. 页 = 每个未读大更新一页（**从旧到新**），所有未读小更新合并为最后一页「其他更新」（组内最新在前）；只有一页时就是原来的单版本 / 多版本弹窗。
2. 进度：eyebrow 行右侧「1 / 3」+ 圆点；读屏用 `aria-live=polite` 播报「第 1 条，共 3 条更新」。
3. 没到最后一页：没有 ✕，主按钮是「下一条 →」，Esc / 点遮罩 / 外部交互都 `preventDefault`；第 2 页起有「← 上一条」。底部提示「共 N 条，看完全部后可关闭」。
4. 最后一页：出现 ✕，主按钮「我都看完了」（单页时仍是「知道了」），点了写回执；Esc / 遮罩照 B-315 只关不记（之前页已记，下次只剩这一页）。
5. 亮点的「去试试 / 看文档」：最后一页 = 全部已读；中间页 = 只记当前页已读并关闭，后面的页保持未读（侧栏入口 + 下次正常打开再弹），不算跳过。
6. 「打开完整更新页 / 查看全部更新记录」只在最后一页出现，CLI 升级卡片也在最后一页。

### 已读状态

- 沿用 `vh.changelog.seen`（B-315 回执，含义 = 该版本及更早都已读，水位线），新增 `vh.changelog.read`：水位线之上逐条读过的 id（JSON 数组）。看完一页就把该页的 id 记进去；水位线紧上方连续已读的版本会被吸收，集合随之清空，所以通常为空或只有几个 id。
- 刷新后未读 = 回执 diff（B-320）减去集合 → 从第一条没看过的继续。旧版本客户端只认回执，不受影响。
- 仍是浏览器本地（与改版前一致）；不改账号级同步，所以不涉及 synced settings（关键约束 1）。多标签页通过 `storage` 事件同步。

### 不锁死（保留 B-697）

- 深链加载不自动弹：`app/entryKind.ts` 在 `main.tsx` 里先于 `presenceBoot` 求值，记下首个 URL。带 query（`?task=`、推送点击的 `vh_presence`、`?panel=`、`?new=` 等）或动作路径（`/terminal/connect`、`/machine/connect`）= 深链。这次加载只显示侧栏入口，下次正常打开（无 query 的任意路径，包括 `/session/:id`）再弹。分享链接是公开路由，不挂 `ChangelogNotice`。
- 弹窗本身仍走 `overlayQueue`：用户打开的对话框（如任务详情）优先，笔记让位、不记已读，对话框关了再回来。
- Radix modal 让页面其他部分不可交互、焦点困在弹窗内；浏览器返回和刷新不被拦截（不加 `beforeunload`、不改 history）。

### 侧栏入口（与 B-713 协调）

- `MajorUpdateEntry`：有未读大更新时，在侧栏 `SidebarRateLimit` 之后、footer（设置 · 帮助 · …）正上方显示一行「✨ 大更新　N 条未看」（`--major-dim` 底、`--major` 字，触屏 44px），点击打开分页弹窗；全部大更新读完即消失。B-713 把 footer 拆进 `SidebarTop.tsx`，本入口是独立组件，不改 footer 行本身，两个 PR 在 `Sidebar.tsx` 只有一行 JSX + 一条 import 的交集。
- 手机：根路径的会话列表就是侧栏，入口在列表底部 footer 之上；桌面侧栏折叠时 rail 上有 ✨ 图标 + 未读红点（复用 `--danger` 未读点语义）。

### 验收

- [x] `changelogPager.test.ts`：2 大 2 小 → 大更新从旧到新 + 小更新合并末页；逐条记录与水位线推进；刷新续看；无回执；oct21/oct21b 为大更新且有亮点；深链判定表。
- [x] `ChangelogNotice.test.tsx`（真组件）：3 页翻页顺序与进度、最后一页前 ✕ 不存在、Esc/遮罩关不掉（去掉守卫的变异会让测试失败）；中途刷新续看；最后一页 Esc 只关不记；深链不弹、入口可见可打开；读完大更新入口消失。
- [x] `check-release.test.mjs`：解析 `major` / `highlights`，major 无亮点 FAIL。
- [x] 截图：桌面亮 / 暗、手机 390（第 1 页、最后一页、侧栏入口）。

## 留真机验证项

无。弹窗在 Chromium 桌面 / 移动模拟（`pointer: coarse`）下已验证；iOS Safari 的 `<details>` 和 lazy 图片是标准行为，没有自定义手势。

## 增补（B-842：任何未读更新说明都有可见入口）

Owner 10-28「刷新页面也没有收到通知」。生产形态复现（`e2e/changelog-entry.mjs`，before = 72d23279）：只剩一条**小版本**未读时，

| 进入方式 | 修复前 | 修复后 |
| --- | --- | --- |
| 普通刷新 `/` | 弹窗 | 弹窗（不变） |
| 会话页开着侧栏刷新（`?panel=files/board/notes…`，工作时 `replace` 写进 URL） | 被当成深链：无弹窗、无入口、无任何提示 | 界面状态参数不再算深链：照常自动弹出 |
| 动作链接进入（`?task=`、推送点击 `vh_presence`、`?new=`…） | 无弹窗、无入口 | 不弹窗（B-697 不变）；toast「有 1 条更新说明 · 查看」+ 侧栏低调入口 |
| 刷新后立即按键/点按（B-823 `userHasInteracted`） | 同上，什么都看不到 | 同上 |
| 其他浮层占用（`?task=`、⌘K…） | 打开它们本身就是 query 或按键，落入上两条 | toast 等 `interaction`/`critical` 浮层释放后才出 |
| SW 旧壳 | Chromium 上不成立：`skipWaiting`+`clientsClaim`，F5 先拿旧壳、约 1s 后 `controllerchange` 自动换新 entry；两个 tab 同样 | — |

根因两层：① `entryKind` 把任何 query 都当深链，会话页开着侧栏时 URL 恒带 `?panel=`，Owner 在会话页刷新永远不弹；② 被抑制时设计上靠侧栏入口，但入口只数**未读大更新**（`unreadMajorCount`），小版本被抑制后哪里都没有。

- 侧栏入口改数全部未读：有大更新照旧（`--major-dim` 底「大更新 · N 条未看」，rail `--danger` 点）；只有小版本时是低调行「✨ 更新说明　N 条未看」（无底色、`--text-dim` 字、图标 `--major`，rail 点用 `--major`），触屏仍 44px。全部读完才消失。
- 被抑制（深链或已操作）时，同次访问给一条不挡操作的 toast「有 N 条更新说明 · 查看」（10s，按钮打开分页弹窗），一次访问只出一次，`overlayHeldAbove(notice)` 时等待。选 toast 而不是「空闲 20–30s 后再弹」：分页弹窗是 Radix modal、多页时锁定不可关，在用户读输出的空闲时段突然抢焦点，回来一按键就落进弹窗；toast 不抢焦点、不挡输入，侧栏入口在 toast 消失后继续兜底。
- 深链判定收窄（Lead 10-28）：只有界面状态参数 `panel` / `sub` / `wp`（`sessionPanelState.ts`）不算深链，其他任何参数仍算——宁可少弹。B-697 本意（动作链接不弹）不变。上文「`?panel=` = 深链」一句以此为准。
- 纯函数：`changelogEntry`、`changelogAutoAction`（`changelogPager.ts`）。
