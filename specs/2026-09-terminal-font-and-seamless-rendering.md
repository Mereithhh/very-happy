# 终端字体与「严丝合缝」渲染：定律、选型与被否决的方案

状态：已实现并上线（2026-09-03）。本文是终端**字形渲染**的机制事实源；
几何/宽度回收见 `2026-09-terminal-multi-device-width-reclaim.md`，
捕获/SGR 完整性见 `2026-09-terminal-render-integrity.md`。

写它的原因：2026-09-02/03 一连 6 个 PR 都在打同一片地，期间**三次**差点走错路
（换字体修 logo、上 WebGL、指望历史重排）。下面每条都是实测结论，不是推断。

## L1 「严丝合缝」是 (字体) × (lineHeight) 的**联合**属性

DOM 渲染器**用字体的字形**画 block(U+2580–259F)/box(U+2500–257F)。所以要无缝拼接，
**两个条件都得满足**：

1. **字体的方块字形必须填满整格**。IBM Plex Mono **有**这些字形却**填不满 cell**
   ——实测在 lineHeight 1.0 下堆叠方块**行间仍有横缝**。「字体有这个码位」≠「能无缝拼接」。
2. **lineHeight 必须 = 1.0**。任何 >1 的行高都在行与行之间插入 leading，
   方块必然裂开（xterm.js #2572）。**这条与字体无关**，换任何字体都救不了。

实测结论（同一 block 图案、lineHeight 1.0、并排渲染截图对比）：
- ✅ 无缝：**Sarasa/Iosevka 系**、**Maple Mono CN**（当前用的）
- ❌ 有缝：**IBM Plex Mono**（cell-short）、**Cascadia Next SC**（方块与框线都露缝，
  尽管它官方宣称为无缝 ANSI art 对齐过网格——**别只信 release note，要实测**）

推论：**「行距太紧」与「logo 严丝合缝」是直接冲突的**，lineHeight 1.0 是后者的硬前提。
想两者兼得只有 customGlyphs（见 L2），而那条被否了。

## L2 WebGL/Canvas 渲染器：**已评估并否决**，别再提（除非先解决移动端复制）

xterm 的 `customGlyphs`（自绘 block/box，像素级完美、**任何 lineHeight 都无缝**）
**只在 canvas/webgl 渲染器生效，DOM 渲染器不支持**。它确实是 L1 的「终极解」——但对
本产品是**净负**：

- canvas/webgl **把文字画进 `<canvas>`，DOM 里没有文字节点**。而 very-happy 的
  **移动端复制正是靠原生长按选中 DOM 文字**（`terminal.css` 专门把 `.xterm-rows`
  的 `user-select` 强制成 `text`）→ **换后端 = 手机复制必死**。
- 桌面复制走 `term.getSelection()`（渲染器无关）能活；**只有移动端**要整套重写
  （合成手势驱动 xterm 选区 + 复制工具条），且相对 iOS 原生长按是**降级**
  （无放大镜、无查询/翻译/分享）。
- iOS Safari 后台切走会**丢 WebGL 上下文且常不触发 restored** → 需要 DOM 兜底常驻，
  收益在它本要服务的移动端基本蒸发。

**结论：用每会话高频的移动端复制，换一次性启动 logo 的装饰缝，不划算。**
维持 DOM 渲染器 + 选一款自身能无缝拼接的字体（L1）就够。

## L3 CJK 叠字有**两个独立层**，只修一层不算修好

1. **宽度计数层**（daemon/tmux）：tmux 的 wcwidth 依赖 locale。非 UTF-8 locale 下中文按
   宽度 1 算 → 自我覆盖。注意 **POSIX 优先级：非 UTF-8 的 `LC_ALL` 会盖过
   `LANG`/`LC_CTYPE`**，只设后两者无效；且 `en_US.UTF-8` 在精简 Linux 上可能**未生成**
   （用 `C.UTF-8`；macOS 无 C.UTF-8，用 `en_US.UTF-8`）。见 `utf8LocaleEnv`。
2. **字形贴合层**（web/字体）：字体必须是**双宽 2:1**（CJK advance 恰好 = 2× ASCII）。
   **拉丁专用字体（IBM Plex Mono 无任何 CJK）+ OS 回退**是最典型的失配来源。

两层都对，中文才落在网格上。改一层前先确认另一层。

## L4 终端历史**不可重排**——别再尝试，也别向用户承诺

Claude Code 用的 Ink 在折行处**写入字面量 `\n`**（ink#883 点名 Claude Code）。终端收到的是
硬换行，**与真正的段落换行再也无法区分**（软/硬信息在写入那刻销毁）。因此：

- tmux 的 `-J` **只能接回 tmux 自己的软折行**，接不了 app 的 `\n`；
- iTerm2/kitty/WezTerm/xterm.js 的 scrollback 重排**同样只作用于自己软折的行**；
- 换 emulator、丢 tmux、ANSI 反解析**全部无效**；一个 pty 只有一个 winsize/COLUMNS，
  多路复用器**都不提供「每设备各自重排」**。

**唯一能跨设备完美重排的架构是不传终端网格、传结构化内容**（SDK 原生会话）。
终端这条路**只能预防**（别用错宽度写进历史），**已冻的历史永久不可回溯**。

## L5 输入框换行不丝滑 = **网络延迟**，不是渲染问题

终端**没有本地回显**（`sendInput` 只发字节、不写 xterm），每次按键与 ink 的整块重绘都要走
web↔daemon 一整个 RTT 才显示。**换渲染后端/字体都修不了**。真解是降延迟
（relay 就近 B-192）或预测式本地回显（mosh 式，在全屏 TUI 下有误判风险的 R&D）。
误当渲染问题会白做一个大工程。

## 落地事实（当前实现）

- 字体 **Maple Mono CN**（OFL，2:1 双宽，方块/框线填满格），`TERM_FONT` 放第一。
  选它是因为同时满足：无缝(L1) + 双宽(L3) + **可自托管的 OFL 源(Regular+Bold+全字集)**。
  > 选型陷阱：ZeoSeven 上好看的「JetBrains Maple Mono」**没有可自托管的源、且只有
  > Regular 无 Bold**——观感再合适也不能用。**先确认「能不能自托管 + 有没有 Bold」再看观感。**
- **自托管在 Cloudflare Pages**（`veryhappy-fonts.pages.dev`）：`cn-font-split` 按
  unicode-range 切片，浏览器只下用到的片；woff2 带 `ACAO: *` + immutable。
  **very-happy 没有任何 CSP**（server/index.html/Caddy 都没设）→ 换 CDN 不需要放行配置。
  字体**不进仓库**，只在终端路由懒加载。
- **`document.fonts.ready` 抓不到动态注入的 CDN 字体**：它在 CDN 的 css 还没取回来时就
  resolve 了。必须**显式 `document.fonts.load(family, 拉丁样本)` 再 `remeasureFont()`+refit**，
  否则字体换入后 xterm 仍用回退字体的 advance，**网格会变松**。
- 首开有「字体加载中」提示（`fonts.check` 命中缓存则不显示）；`font-display: swap`
  保证终端全程可用。

## 工具坑

- **`cn-font-split` 写完输出后不退出**（挂住、0% CPU）。**别用 `&&` 串联**，否则永远等不到
  下一步；改成轮询 `result.css` + 分片数稳定后再 kill。
