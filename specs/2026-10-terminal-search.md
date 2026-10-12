# Web 终端内搜索（find in scrollback）

> 状态：Draft（实现 agent 起草，待主 agent 定稿）
> 日期：2026-10-12 ｜ 关联 backlog：B-557 ｜ 参考：Orca `docs/site/content/docs/terminal.mdx` §Search（只读）｜ 相关：B-550 `2026-10-terminal-scrollback-persistence.md`

## 背景

web 终端有 5000 行 scrollback（B-550 之后还包含「上次会话」回放），但没有任何查找手段：
浏览器 ⌘F 只搜 DOM 渲染出来的可见行，xterm 的 DOM renderer 只渲染视口，scrollback 里的内容搜不到。
手机上更没有入口。Orca 的终端有 `Cmd-F` find-in-scrollback（高亮、大小写、匹配导航）。

## 目标

1. 终端聚焦时 ⌘F（macOS）打开搜索条；焦点不在终端时不拦截，浏览器原生 ⌘F 照常。
2. 搜索覆盖整个 xterm buffer（scrollback + 屏幕），自然包含 B-550 回放的「上次会话」历史。
3. 上一个 / 下一个、大小写开关、匹配计数（`3/17`）、全部匹配高亮 + 当前匹配强调、跳转时把匹配滚进视口。
4. Esc 关闭、清掉高亮、焦点还给终端（桌面）；手机关闭后不自动弹软键盘。
5. 手机：终端底部按键栏给一个搜索入口按钮。
6. 输出持续写入时结果自动刷新，当前匹配尽量保持在同一行。

## 非目标

- 不支持正则、整词匹配（Orca 有 regex；首版不做，纯函数留了扩展位）。
- 不搜 daemon 侧比 xterm 5000 行更早的历史（web 拿不到的字节搜不到）。
- 不改 package.json / lockfile：仓库没有锁 `@xterm/addon-search`，用 xterm 公开 buffer API 自实现。
- 不改渲染器、字体、lineHeight、列数（铁律 9）；不引入 canvas/WebGL。
- 不进 header 动作（`termHeaderLayout.ts` 的优先级策略不动）；桌面靠快捷键，手机靠按键栏。

## 现状事实（代码已确认，基线 origin/main `ba901bc44`）

| 事实 | 位置 |
|---|---|
| web 依赖只有 addon-clipboard/fit/unicode11/web-links，lockfile 无 `@xterm/addon-search` | `packages/happy-web-v2/package.json:28-32`、`pnpm-lock.yaml` |
| xterm 5.5.0，DOM renderer，`allowProposedApi: true`（decoration / marker 可用） | `renderer/xtermRenderer.ts` `new Terminal({...})` |
| xterm 5.5 DOM renderer 的行工厂会读 `forEachDecorationAtCell` 应用 decoration 的 `backgroundColor/foregroundColor` | `node_modules/@xterm/xterm/lib/xterm.js`（DomRendererRowFactory） |
| `translateToString(false)`：宽字符的第二格（width 0）不产出字符，空格子产出空格；`getCell(x).getChars()/getWidth()` 可逐格映射 | `@xterm/headless@5.5.0` 实测（`中文ab😀x` → 长度 9 / 10 列） |
| `.term-host` 上挂了 capture 阶段的 paste、touch、mousedown、contextmenu、drop 监听；粘贴会被送进 pty | `WebTerminalScreen.tsx` `host.addEventListener('paste', onPaste, true)` 等 |
| 应用级快捷键都在 window capture 阶段注册（先于 xterm textarea） | `app/presetsShortcut.ts`、`app/viewShortcuts.ts` |
| 焦点看门狗只在焦点「无主」（body/null）时归还终端，输入框持有焦点不会被抢 | `termFocusOwnership.ts` 头注释纪律 2 |
| B-550 回放只是写进 xterm 的快照字节（`full` 前缀），不是独立 UI | `specs/2026-10-terminal-scrollback-persistence.md` D4 |
| 终端 pane 两主题都深色，只用 `--term-*` token | `docs/design-language.md` 头注、`styles/tokens.css` terminal 段 |

## 设计

### D1 纯函数 `screens/terminal/termSearch.ts`

- `findTermMatches(buffer, query, { caseSensitive, limit })`：按 `isWrapped` 把软折行拼成逻辑行，逐逻辑行做子串查找，
  命中再映射回 `(row, col)` 段（跨折行的命中拆成多段，每段 `{ row, col, width }`，宽字符按 2 格计）。
  - 快速路径：行文本长度 = 列数且不含代理对 → 字符下标即列号；否则逐格 `getCell` 建下标→列映射。
  - 大小写不敏感用 `toLowerCase()`（只对长度不变的行做，长度会变的字符走逐字符比较以免映射错位）。
  - 上限 `TERM_SEARCH_MATCH_LIMIT = 2000`，超出返回 `truncated: true`，计数显示 `2000+`。
- `pickInitialIndex(matches, anchorRow)`：取「起始行 ≤ 视口底行」的最后一个匹配（离当前视野最近、最新的在下方），没有则 0。
- `stepIndex(i, n, dir)` 环绕；`scrollTargetFor(row, viewportY, rows)` 已在视口内返回 null，否则让匹配落在视口约 1/3 处。
- `matchTermSearchChord(e, isMac)`：mac = 仅 ⌘ + `KeyF`；非 mac = Ctrl+Shift+`KeyF`（**偏离派工的 Ctrl+F**：
  Ctrl+F 在终端里是 readline forward-char、vim/less 翻页，拦截会吞掉用户真实按键；VS Code/Windows Terminal 同样用 Ctrl+Shift+F）。
  用 `e.code` 不用 `e.key`（CJK 布局）。

### D2 组件 `screens/terminal/TermSearchBar.tsx` + hook

- `useTermSearchHotkey({ enabled, isTermFocused, onOpen })`：window capture keydown；仅当 `isTermFocused()`（焦点在
  `.term-host` 内或在搜索输入框里）且 chord 命中时 `preventDefault + stopPropagation`，否则不碰事件（浏览器 ⌘F 正常）。粗指针设备不注册。
- `TermSearchBar`：输入框、`Aa` 大小写开关（`aria-pressed`）、计数（`aria-live=polite`）、↑ ↓、关闭。
  Enter = 上一个（向更早/上方，终端里新内容在底部，与 VS Code 终端一致），Shift+Enter = 下一个，Esc = 关闭。
  输入防抖 120ms 后搜索；打开时若有终端选区且为单行，用它预填。
- 高亮：xterm `registerMarker` + `registerDecoration`。全部匹配一层（最多 1000 个，超出时取离当前匹配最近的 1000 个），
  当前匹配单独一个 `layer: 'top'` decoration（后注册者颜色胜出）。颜色取 token
  `--term-search-match-bg` / `--term-search-active-bg` / `--term-search-active-fg`（xterm 只接受 `#RRGGBB`，运行时读 computed style）。
  不用 `term.select()` 表示当前匹配：选区是移动端长按复制与选择模式的状态，搜索不应改写它。
- 刷新：搜索条打开时订阅 `term.onWriteParsed`，节流 400ms 重搜；当前匹配用一个 marker 跟踪（scrollback 裁剪时 marker 随行移动），
  重搜后按 marker 行 + 列找回同一个匹配，找不到（`reset()` 后 marker 失效）再按视口取最近。
- 关闭：dispose 所有 decoration/marker、退订、焦点交回（桌面 `focusInput()`；手机不 focus，避免顶起软键盘）。

### D3 挂钩（WebTerminalScreen.tsx，热区最小改动）

- 一个 `searchOpen` state；`useTermSearchHotkey` 一行；`<TermSearchBar>` 渲染在 **`.term-header` 内**（`position: absolute; top: 100%`，
  视觉上浮在终端右上角），**不放进 `.term-host`**——后者的 capture paste/touch/mousedown 监听会把输入框的粘贴送进 pty、劫持触摸。
- 按键栏加一个搜索按钮（`onMouseDown preventDefault`，与其他键一致）。
- 渲染器通过已有的 `termRef.current?.raw` 拿到 xterm 实例；不改 `TerminalRenderer` 接口（ghostty 迁移时与其他 raw 用法一起处理）。

## 兼容矩阵与发布顺序

纯 Web 改动，无协议 / wire / server / CLI 变更，不依赖 session capabilities。

| CLI(daemon+wrapper) | server | web | 行为 |
|---|---|---|---|
| 旧 | 旧 | 新 | 搜索可用，搜当前 xterm buffer；旧 daemon 无 B-550 回放则只是没有「上次会话」那段可搜 |
| 新 | 新 | 新 | 同上，含 B-550 回放历史 |
| 任意 | 任意 | 旧 | 无搜索，与现状一致 |

发布：随任意一次 server/Web 镜像发布即可，无顺序要求；回滚 = 回滚 Web。

## 风险

1. **5000 行 × 宽终端的扫描耗时**：逐格映射只在含宽字符/代理对的行触发；持续输出时节流 400ms。接受，实测记录在验收里。
2. **decoration 在 DOM renderer 下的颜色覆盖**：依赖 xterm 5.5 内部行工厂行为；升级 xterm 时需回归（验收截图取像素）。
3. **非 mac 快捷键偏离派工（Ctrl+Shift+F）**：理由见 D1；如 Owner 坚持 Ctrl+F，只改 `matchTermSearchChord` 一处。
4. **rebuild（`term.reset()`）期间打开搜索**：marker 被清，节流重搜后回到视口最近匹配；接受。
5. **alt screen（vim/less/tmux copy-mode）**：搜的是 `buffer.active`，即当前可见的 alt 屏，没有 scrollback；接受。

## 验收标准

- [x] `termSearch.test.ts`：折行拼接、跨行命中拆段、宽字符列映射、大小写、上限截断、初始索引、环绕、chord 匹配（mac/非 mac、Shift/Alt 排除）。
- [x] 桌面 1280：终端聚焦 ⌘F 打开；焦点在页面别处 ⌘F 不拦截（`defaultPrevented=false`）；计数、↑↓、Aa、Esc 关闭并焦点回终端；匹配像素高亮。
- [x] B-550 回放区（「以下为上次会话的输出」分隔之后的历史）可被搜到并滚到。
- [x] 390 coarse：按键栏搜索按钮可打开，搜索条不横向溢出，输入框 16px；亮/暗两主题下终端 chrome 一致。
- [x] `tsc --noEmit`、相关 vitest、`vite build` 全绿。

## 留真机验证项

- iOS Safari 软键盘弹出时搜索条位置与键盘「前往」键 = 上一个。
