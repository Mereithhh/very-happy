# 终端输入路径所有权改造（Input Ownership）

> 状态：**Shipped（Step 0-3，2026-08-14）** ｜ Step 4（删旧路径）刻意押后
> 日期：2026-08-14 ｜ 关联 backlog：B-093 ｜ 前身：无（前两轮是补丁：`imeStuckGuard.ts` 自愈 + `utils/ime.ts` 守卫）

## 背景

中文输入法在 web 终端失效已复发**三次**。机制已确诊并可 CDP 复现：xterm 5.5 的
`CompositionHelper` 用一个**持久标志** `_isComposing` 当闸门，而这个标志的关闭
完全依赖浏览器成对发出 `compositionend`。切输入法 / 焦点变化 / 系统级中止会让
`compositionend` 不发 → `_isComposing` 永久 true → 之后所有经 IME 的键（keyCode
229）被 `keydown()` 静默吞掉（英文正常，中文全哑），且下一个非 229 键会触发
`_finalizeComposition(false)` 把中止的 preedit 当正文提交（"删不掉的字母"）。

两轮外部补丁（round 1 自愈 + round 2 加固：矛盾持续 ≥2 keydown 才出手、heal 永不
写 textarea、残字清理移到 blur 边界）都只是在**别人的状态机外面**做纠错，仍然复发。
Owner 明确表态接受架构上的大改造。

结论方向（主 agent 给定）：**输入状态机的所有权必须在我们手里**——由我们自己的
受控输入元素接管全部键盘与 composition 事件，只把已提交文本写进 PTY，xterm 退化
为纯渲染器（+ 按键编码器，见 §设计 D）。

**主 agent 独立复核（2026-08-14，本仓 shipped 的 `node_modules/@xterm/xterm/lib/xterm.js`）**：
`_isComposing=!0` 在整个构建里**只出现一次**，位于 `compositionstart(){...}` 内；
composition 三个监听器全部绑在 `this.textarea` 上；`_keyUp` 内确实调用 `this.focus()`。
⇒ 本 spec 的两条承重论证（卡死态不可达、绝不补发 keyup）经实证成立。

### ⚠️ 第三次复发的真实病因（2026-08-14 CDP 实证，**推翻了上面那段"背景"对本次的归因**）

上面描述的 `_isComposing` 卡死是 round 1/2 的机制，**不是 2026-08-14 这次的病因**。实测结论：

1. **持续性失效 = 键盘焦点丢到 `<body>`（中英文全哑）**。`⌘K` 命令面板 → Esc、`⌘R`
   重命名弹窗 → Esc 之后 `document.activeElement === BODY`，composition 事件 0 个、
   进 PTY 0 字节。视觉上几乎看不出（xterm 光标只是实心变空心），所以用户以为焦点还在
   终端。根因：焦点归还是三处各写一遍的**偶然行为**（`viewShortcuts.restoreFocusAfterCancel`、
   Radix 的 `onCloseAutoFocus`），而 `CommandPalette` / `RenameModal` / `NewSessionModal` /
   非 ⌘W 路径的 `ModalProvider` 弹窗**都没写**。
2. **「中文哑英文正常」的唯一路径 = 我们自己的 `refocus()` 吞掉在途合成文本**。
   `refocus()`（`window 'focus'` + `visibilitychange` 触发）做 `ta.blur(); term.focus()`；
   若此时正在合成，`compositionend` 到了但 xterm **一个 `onData` 都不发**，已敲的拼音被
   静默丢弃。触发面：alt-tab 回来、切标签页回来、**点 macOS 菜单栏的输入法菜单**（会
   blur/refocus 窗口）——正好对上 Owner 说的「切输入法就打不了中文」。
   ⇒ **round 1/2 加的"治疗手段"本身变成了病因**（与 round 2 "heal 写 textarea 反而制造
   卡死" 是同一类错误的第二次发生）。
3. **`imeStuckGuard` 的 229 sustained-contradiction 分支是死代码**：第 1 键矛盾后紧随的
   `compositionstart` 把 streak 清零，第 2~4 键 `isComposing:true` 无矛盾 ⇒ streak 永远
   到不了 2。round-2 的加固把自己锁死了。**非 229 分支实测有效**（卡死态按普通键时 heal
   被调用且成功阻止了游离字母提交），保留。
4. 线上 bundle 实证：`imeStuckGuard` **在**（未被 tree-shake，挂载点也在），今天新加的
   window-capture 监听**全部排除**（裸键 Escape/1/3/./[/w/Enter 在弹窗开关后都原样进 PTY；
   `ModalProvider` 的 window 级 Esc/Enter 确实解绑）。

**这对本 spec 的影响**：架构方向不变（所有权改造仍是根治），但 §风险 R1「焦点归属」从
"风险"升级为**当前正在发生的事故**，且必须在 Step 0/1 之前先以战术修复止血：
① 焦点所有权不变量 + 看门狗（终端页 + 无浮层 + activeElement 是 body ⇒ 归还焦点）；
② `refocus()` 幂等化、**永不 blur 作为治疗手段**、合成期不动焦点；
③ 退掉死的 229 分支；④ 加诊断钩子（第三次复发有一半原因是线上问不到状态：守卫的
counters 关在闭包里）。诊断脚本与原始日志：`skills/tmp/ime-diag/`。

**新增的机制清单（架构改造必须覆盖，来自诊断报告）**：终端屏的键盘焦点必须有**唯一
所有者**；要有不变量+看门狗兜住"谁忘了写归还"；**禁止用 blur 当治疗手段**；在途合成
文本不能靠 xterm 的 `_compositionPosition` 算术 + 0ms 延迟读 textarea；停止把正确性押在
xterm 私有内部（本次 6 个观测点里 4 个是私有 API）；helper textarea 残字无界增长（只有
blur 才清）是"不拥有这个 field"的直接后果；`ModalProvider` 的 Esc/Enter 守卫应 scope 到
弹窗而不是 window（将来有弹窗忘了关，终端的 Esc 就没了，vim/claude TUI 靠它活）。

## 目标

1. **卡死态在构造上不可达**：xterm 的 `CompositionHelper` 永不接收任何 composition
   事件，`_isComposing` 恒为 false。不再需要"检测 + 自愈"这一层。
2. **`composing` 标志永不作为放行/拦截的闸门**。写入 PTY 的字节只由两个来源产生：
   ①输入域文本的单调增量 diff；②显式按键路由表。所以"`compositionend` 丢失"这类
   事件缺失在数学上不可能吞键。
3. 桌面 CJK 输入手感 ≥ 本地终端：候选窗在光标处、拼音就地显示、**静止时屏幕上没有
   第二个输入框**（claude TUI 自带输入框的场景是主场景）。
4. 事件序列 → 应写入 PTY 的字节，是一个**纯函数**，病理序列全部单测覆盖。
5. 新旧路径由一个 `localSettings` 开关并存，可灰度、可**不发版**一键回退。
6. 桌面/移动端共用同一个核心状态机（现有 `mobileInputBridge` v2 是它的雏形）。

## 非目标

- **不动输出侧**：`termWriteHold.ts` / `termStreamSync.ts` / seq 记账 / 加密，一行不改。
- 不做 ghostty/Restty 渲染器迁移（B-005 另议）。
- **不手搓 VT 按键编码表**（Phase 1 复用 xterm 的 `evaluateKeyboardEvent`，见 §设计 D
  与 §风险 R3；纯 TS 编码表列为延后债，只有换渲染器时才必须做）。
- 不动 server / CLI / 协议，无 wire 字段变化。
- 不改移动端 `TermInputBar`（输入行模式）的既有交互，只把它接到新核心上。
- 不改 app 级快捷键的既有语义（⌘W/⌘[/⌥←/⌘. 的 target 豁免规则原样保留）。

## 现状事实（代码已确认）

### xterm 5.5 内部（`node_modules/@xterm/xterm/lib/xterm.js`，即本仓 shipped 的构建）

| 事实 | 位置 / 证据 |
|---|---|
| `_isComposing` **只在** `CompositionHelper.compositionstart()` 置 true；该方法只由 textarea 上的 `compositionstart` 监听器调用 | `compositionstart(){this._isComposing=!0,this._compositionPosition.start=this._textarea.value.length,…}` |
| xterm 在 `this.textarea` 上注册 **10 个**监听器：`blur` `compositionend` `compositionstart` `compositionupdate` `focus` `input` `keydown` `keypress` `keyup` `paste` | `grep -o 'this\.textarea,"[a-z]*"'` 全量枚举 |
| xterm 另在 `this.element` 上注册 `copy` `paste` `contextmenu` `mousedown` `auxclick`；`copy` → `copyHandler(e, selectionService)` 写选区到剪贴板 | `this.element,"copy",(e=>{this.hasSelection()&&copyHandler(e,this._selectionService)})` |
| `_customKeyEventHandler` 是 `_keyDown` 的**第一句**，早于 `_compositionHelper.keydown(e)`；`_keyPress`/`_keyUp` 同样先问它 | `_keyDown(e){…this._customKeyEventHandler&&!1===this._customKeyEventHandler(e))return!1;…!this._compositionHelper.keydown(e)…}` |
| ⇒ `customKeyEventHandler` 只能否决 xterm 的**按键**处理，对 `input`/`composition*`/`paste` 监听器**零影响**；且返回 false **不 preventDefault**（xterm 的 `cancel()` 才做） | 同上 |
| **xterm 没有任何公开开关能禁用 `CompositionHelper`**：它在 open 路径无条件构造，`disableStdin`（只 gate `triggerDataEvent`）与 `screenReaderMode`（只影响 `_inputEvent`）都不碰它 | `disableStdin` 全仓仅 2 处引用；`_inputEvent` 内 `!screenReaderMode` |
| `_syncTextArea()` 把 helper textarea 定位到**光标单元格**（inline `left/top/width/height/lineHeight`，`zIndex:-5`），由 `this.onCursorMove(...)` 驱动，合成中跳过 | `_syncTextArea(){…this.textarea.style.left=a+"px",…}` / `this.register(this.onCursorMove((()=>{…this._syncTextArea()}` |
| `.xterm-helper-textarea` 默认 `opacity:0; left:-9999em` ⇒ **原生 inline preedit 不可见**，这正是 xterm 必须自己画 `.composition-view` 的根因 | `node_modules/@xterm/xterm/css/xterm.css:60-77` |
| `_keyUp` 对非纯修饰键调用 `this.focus()` ⇒ **任何 keyup 到达 xterm 的 textarea 都会把焦点抢回去** | `_keyUp(e){…(isModifier(e)||this.focus(),…)}` |
| `_handleTextAreaFocus` 加 `.focus` class + `_showCursor()` + `sendFocus` 时发 `ESC [I`；`_handleTextAreaBlur` 清 `textarea.value` 并发 `ESC [O`。`CoreBrowserService._isFocused` 也由 textarea 的 focus/blur 驱动，DOM renderer 靠它决定光标是实心块还是 outline | `…classList.add("focus"),this._showCursor(),this._onFocus.fire()` / `_textarea.addEventListener("focus",(()=>this._isFocused=!0))` / row factory 的 `xterm-cursor-outline` 分支 |
| `_inputEvent` 只处理 `inputType==='insertText'` 且 `(!e.composed \|\| !this._keyDownSeen)` | `_inputEvent(e){if(e.data&&"insertText"===e.inputType&&…)}` |
| `term.modes` 是**公开 API**：`applicationCursorKeysMode` / `applicationKeypadMode` / `bracketedPasteMode` / `sendFocusMode` / `mouseTrackingMode` …；`term.textarea` 也是公开 API | `typings/xterm.d.ts:829` `IModes` / `:788` |
| `term.onCursorMove` / `onRender` / `onResize` 公开 | `typings/xterm.d.ts:902/933` |

### 本仓现状

| 事实 | 位置 |
|---|---|
| `sendInput` 是**唯一**写 PTY 出口（xterm onData / 移动桥 / 键盘条 / 预设 / 输入行全经此），内含 `writeHold.noteUserInput()` + `stampLocalActivity` | `web-v2/src/screens/terminal/WebTerminalScreen.tsx:396-418` |
| 移动端 v2 桥已经是"我们拥有输入"的雏形：capture on `term.element`、diff 引擎、**绝不清空 textarea**、拦 keydown 229 与 `input`、接管 compositionend 提交 | `.../mobileInputBridge.ts`（`diffTextValue` 已是纯函数） |
| 输入行模式已上线：普通 `<textarea>` + `useImeGuard`，Enter 送 `text+\r` | `.../TermInputBar.tsx`、`localSettings.terminalInputBarMode` |
| 焦点归属是一个纯状态机（`reduceTermFocus`），动作由屏幕执行 | `.../termFocusPolicy.ts` |
| **helper textarea / `term.focus()` 的耦合点共 8 处**（迁移必须全部改成一个间接层）：`WebTerminalScreen.tsx:248`（focus-terminal）、`:259`（blur-all）、`:494-496`（refocus 的 blur-then-focus 自愈）、`:777`（open 后聚焦）、`:1023`（focus-settled 探针按 class 判定）、`:1212`（runCommand）、`:1331`（预设菜单取消归还焦点）；`ui/Menu.tsx:51-53`（Radix 菜单关闭归还焦点）、`app/viewShortcuts.ts:80`（refocus fallback）、`app/closeGuard.ts:25`（⌥W 的 xterm textarea 豁免） | 同列 |
| app 级快捷键**全部** `window` + capture + `preventDefault()+stopPropagation()`：⌘.（presetsShortcut）、⌘W/⌥W（viewShortcuts）、⌘[/⌥←（appBack）、⌘N/⌥N（newTerminal）、⌘K（CommandPalette）、⌘1-9/⌘R（Sidebar）、Esc/Enter（ModalProvider）、FsBrowser/剪贴板面板/通知铃 | `grep "addEventListener('keydown'.*true"` 全量 13 处 |
| DECSET 过滤已有先例（`registerCsiHandler` + 私有 `_inputHandler` 部分回放） | `.../termMouseModeFilter.ts` |
| 自动标题的 fallback 依赖 xterm 的 `onKey` 累积**可打印**字符 | `WebTerminalScreen.tsx:442-456` |
| 渲染器抽象已存在，私有耦合从 `raw` 逃逸 | `.../renderer/TerminalRenderer.ts` |
| 测试环境是 **node（无 jsdom）**；已有测试对 headless `new Terminal()` 跑真解析器 | `.../termMouseModeFilter.test.ts` 头注 |
| localSettings 模式：zod schema + `localSettingsDefaults`（默认值只写在这里）+ `passthrough().partial()` 整块 safeParse（**枚举值只增不删**，删了会把该设备所有本地设置重置） | `web-v2/src/sync/localSettings.ts:7-151` |
| CDP 复现工具坑（已记账）：`dispatchKeyEvent` 的 down/up keyCode 必须配对；headless 下 `imeSetComposition` 污染键状态；**headful 窗口失焦时 dispatchKeyEvent 被静默丢弃而 composition 事件照常送达**（round 1 假阴性的根源） | `skills/happy/references/very-happy-build-state.md:416` |

## ⚠️ Step 0 实施回流的设计修订（2026-08-14，实现后定稿）

Step 0 实现过程中发现本 spec 的 6 处路由缺陷与 5 个未定义点，**以下修订为准，覆盖下文对应段落**：

**路由表（§C）的 6 处修正**（已在 `termInputRoute.ts` 实现并单测）：
1. **P6 在原表序下是死代码**——P5 的具名集合含 `Enter` 且优先级更高。P6（barMode 的 Enter）
   必须**提到 P5 之前**；并补 barMode + `Shift+Enter` → `text`（对齐 `TermInputBar` 既有的
   "Shift+Enter 换行"语义，原 spec 漏写）。
2. **P7 判据与依据打架**：判据 `key.length===1` 收不住死键（`key==='Dead'` 长度 4），而同行
   依据点名了死键 ⇒ `Dead`/`Unidentified` 纳入 P7。
3. **非 mac 的 Alt 语义缺失**：xterm 在 `(!isMac || macOptionIsMeta) && altKey` 时发 `ESC+char`。
   照原表实现会让 Windows/Linux 的 `M-b`/`M-f` **全哑**（浏览器不把 Alt 组合插进输入域）
   ⇒ 补一条非 mac `Alt+字符` → `vt`。
4. **AltGr 未覆盖**：Windows AltGr 上报为 `ctrlKey && altKey`，照 P5「Ctrl+字母」会被送去 VT，
   欧洲布局打不出 `€` ⇒ ctrl 分支加 `!altKey` 硬条件（与 xterm 编码器同款）。
5. **纯修饰键次序**：修饰键自身的 keydown 带 `ctrlKey:true`，照原表序 ⌃ 单击会先命中 P5
   ⇒ 修饰键判定提到 P5 之前。
6. **Ctrl 组合做成兜底而非白名单**：失效不对称——漏一个键 = R3 的"按了什么都不发"，
   多兜一个 = 编码器决定不发（与 xterm 现路径逐字节一致）。

**模型（§E）的 4 个未定义点定稿**：
- 返回类型加 `clearField: boolean`（清空是**动作**，纯函数只能作为结果返回；清空恒不发字节，
  与 `emit` 是两条互不相干的通道）。
- `blur` **解除** composing（失焦后 IME 不会再给 `compositionend`——这正是"切输入法打不了
  中文"的现场；不解除会让清空能力永久失效 = 又一个持久标志卡死）。
- `clear-request` 在合成期**拒绝**（清空会打断在途 preedit；round 2 的"heal 写 textarea 反而
  制造卡死"就是这个错误的第一次发生）。
- `policy` 的 `clearIdleMs`（仅 clear-on-idle）与 `maxLen`（仅 sticky）在对方模式下无意义，
  不是四种组合都有效。

### ★ 宿主观测时机（原 spec 两处默认了不同答案，此处拍板）

Step 0 暴露的关键问题：**"何时把输入域内容喂给模型"是宿主的选择**，原 spec §可测试性 第一行
的断言隐含"合成期不观测"，而 §B ① 的手感设计隐含"全量观测"——两者不能同时成立。
若合成期全量观测，preedit 拼音会被**回显进 PTY**，与 §B ① 想要的"原生 inline preedit 画在
光标处"**叠字**（PTY 回显的 "ni" 在下、preedit 的 "ni" 在上），提交时还要看到一串退格。

**定稿：宿主在合成期不观测输入域**，具体为四条事件级规则（**全部无持久标志**）：
1. `input` 且 `ev.isComposing === false` ⇒ 观测（emit diff）。
2. `compositionend` ⇒ 观测。
3. `blur` ⇒ 观测（提交在途内容，恰好一次）。
4. ~~**兜底 tick**：距上一次 composition 事件超过 5s 时**无条件观测**——自过期的有界看门狗
   （与 `termFocusOwnership` 的合成布尔同款），保证任何病理路径下文本最多迟到 5s，
   **绝不永久吞字**。~~
   ⚠️ **第 4 条已于 2026-08-14 上线后删除**（实证是一条真泄漏，改由三条真实边界承担
   "绝不永久吞字"）——见文末「上线后实测修正」第 2 条。

为什么这不违反铁律：铁律约束的是**模型**不得用 `composing` 门控 emit；宿主选择观测时机是
另一回事——因为模型对 composition 事件无状态，即使 `compositionend` 永远不来，下一次
非合成 `input` 携带的**完整 diff** 也会一次性补齐（Step 0 对两种接线都写了用例）。

## 设计

### A. 谁接收键盘：选 B（自有 overlay 输入元素）

**A 案 —— 继续用 xterm 的 helper textarea，capture 拦截它的全部事件。** 被否，三条：

1. **是"饿死"不是"消除"**。`CompositionHelper` 仍然活着、仍然绑在同一个 textarea 上。
   要精确拦住 `compositionstart/update/end` + `input` 4 类事件；xterm 6.x 加一个监听器、
   或把某个监听器挪到 `element` 上，这个 bug 就第四次复发。与"构造上不可达"的目标冲突。
2. **无法摆脱 `_handleAnyTextareaChanges` 的定时器窗口**。非合成 keydown 会让 xterm 在
   keydown 时快照 textarea、0ms 后 diff 并自己发送 ⇒ 我们**永远不能**在 keydown 后约
   一帧内改动输入域（清空残字会被 xterm 翻译成一串 `\x7f` 发给 PTY）。round 2 已踩过
   同类"时序禁区"（heal 不能写 textarea），再叠一层就是造同一类雷。
3. **原生 preedit 不可见**（`opacity:0`），要么保留 xterm 的 `.composition-view`（= JS 镜像
   composition 状态，正是要消灭的东西），要么把它 opacity 改成 1 —— 那时它已不再是
   "xterm 的隐藏 textarea"，只是一个被我们接管却仍绑着 10 个 xterm 监听器的元素，纯亏。

**B 案（选定）—— 我们自己的输入元素，xterm 的 textarea 永不获得焦点。**

- 一个 `<textarea class="vh-term-input">`，**挂在 `term.element` 内部**（`.xterm-helpers`
  的兄弟位置，`position:absolute`）。挂在内部是硬要求：xterm 的 `copy`/`paste`/
  `contextmenu` 监听器在 `this.element` 上，只有作为后代，⌘C 复制选区与 host 层的
  文件粘贴 capture 才继续免费生效。
- **卡死态不可达的证明**：`_isComposing` 只在 `compositionstart()` 里置 true，该方法只由
  `this.textarea` 上的监听器调用；textarea 永不聚焦 ⇒ 永不收到 composition 事件 ⇒
  `_isComposing` 恒 false ⇒ `keydown()` 永不吞键、`_finalizeComposition` 永不触发。
  这条性质不依赖我们拦对了几类事件。
- **安全带（一行）**：`term.attachCustomKeyEventHandler(ev => ev.isTrusted === false)`。
  真实按键（`isTrusted:true`）一旦以任何方式到达 xterm，xterm **一律不处理**（包括
  `_keyUp` 里那个会抢焦点的 `this.focus()`）；只有我们补发的合成事件被处理。
  **不要用 `disableStdin`** —— 它 gate `triggerDataEvent`，连 `term.paste()` 一起废掉。
- **光标定位免费**：`_syncTextArea()` 每次 `onCursorMove` 已把 helper textarea 的 inline
  `left/top/width/height/lineHeight` 设到光标单元格；我们订阅公开的 `term.onCursorMove`，
  把 `term.textarea.style` 这 5 个值抄到自己的元素上（外加 §B 的宽度策略）。零私有 API、
  零 typography 数学，移动端键盘态换字号也自动跟随。
- **焦点观感与 DEC 1004 焦点上报**：我们的元素获得/失去焦点时，向 `term.textarea`
  **补发** `new FocusEvent('focus')` / `'blur'`。xterm 的监听器不校验 `isTrusted`，于是
  `.focus` class、`_showCursor()`、`CoreBrowserService._isFocused`（决定实心块 vs outline
  光标）、以及 `sendFocusMode` 下的 `ESC [I` / `ESC [O` 全部按原样工作。
- **`term.focus()` 不再被任何人调用**。renderer 接口新增 `focusInput()/blurInput()/
  isInputFocused()`，上表 8 个耦合点全部改走它；`focus-settled` 探针改为按
  `renderer.isInputFocused()` 判定；`closeGuard.isXtermTextarea` 扩成"终端输入元素"判定。

### B. 合成中的文本怎么显示：选 ①（原生 preedit 就地显示）

**关键约束**：claude code 的 TUI 自己有输入框，这是 Owner 最高频场景；屏幕上出现第二个
输入框会造成"我在哪打字"的困惑。

**① 原生 inline preedit 就地显示在光标处（推荐）**
我们的输入元素 `opacity:1`、字体/字号/行高/前景色对齐终端，`caret-color: transparent`
（xterm 的块光标是唯一光标），`background: transparent`，静止时内容为空 ⇒ **屏幕上完全
看不到它**。合成开始后浏览器把 preedit 原生绘制在元素内（macOS 下带下划线），位置正是
终端光标 ⇒ 拼音长在 claude 输入框里的光标处，候选窗贴在其下方。
- 体验与本地终端（iTerm/Terminal.app）一致；静止零视觉噪音；**无双输入框**。
- 实现代价小。宽度策略 = `min(40ch, 光标到右边缘的距离)`、`white-space: pre`、
  `overflow: hidden`。
- **零 JS 镜像**：preedit 内容与位置都不经我们的代码，`compositionupdate.data` 一次都不读。
- 遗留取舍（需 Owner 真机审美判断）：拼音画在光标处已有字形之上，可能与 claude 输入框
  边框轻微叠字。要不透明背景框就得加一个由 compositionstart/end 驱动的 CSS class ——
  那是**纯装饰性**镜像：即使卡住，后果只是一个空的透明框，**绝不吞键**（配 800ms
  watchdog：非聚焦或输入域为空即摘 class）。镜像从**输入通路**降级到**装饰层**。

**② 我们自己渲染 preedit 覆盖层（否）**
读 `compositionupdate.data` 自绘 = 把 composition 状态镜像原封不动搬回我们家：
`compositionend` 丢失 ⇒ 覆盖层永久残留，只是这次卡的是我们的 state。重演 round 1/2 的
"检测+自愈"路线。唯一可能被迫采用的情形：某平台原生 inline preedit 无法样式化到可读
（真机验证若发现，再降级到 ②，且**只降级显示层，输入通路不变**）。

**③ 显式输入行 / 输入框（否为默认，保留为模式）**
优点：IME/听写/多行粘贴全是原生行为，最稳、零新代码。致命缺点：在 Owner 最高频场景里
恰恰最差（真·双输入框），且 TUI 的逐键交互（y/n、菜单、vim）需要另配桌面版键盘条。
结论：作为**可选模式**保留（桌面复用 `terminalInputBarMode`），不做默认；移动端继续以它
为 opt-in 是合理的（手机没有硬件键盘做逐键交互）。

### C. 非文本键路由：判定优先级表

我们的 keydown handler **必须注册在元素上，严禁再注册 window capture** —— app 级快捷键
全在 window capture 且都 `preventDefault+stopPropagation`，DOM 派发顺序天然保证它们先手。
这是可测试的结构约束（见 §可测试性）。

按序短路，第一条命中即停：

| 优先级 | 判据 | 处置 | 依据 / 备注 |
|---|---|---|---|
| **P0** | `ev.defaultPrevented === true` | 立即 return | app 层 window-capture 已消费（⌘K/⌘./⌘W/⌥W/⌘[/⌥←/⌘N/⌘1-9/⌘R、弹窗 Esc/Enter） |
| **P1** | `ev.isComposing === true` ‖ `ev.keyCode === 229` ‖ `ev.key === 'Process'` | **完全放行**：不 preventDefault、不路由、不记状态 | IME 拥有这一击。**无状态判据**——判据来自事件本身，不来自任何持久标志，这是根治的核心。Android 每键 229 也正好该走输入域路径 |
| **P2** | `ev.metaKey === true` | **一律不进 PTY**。⌘C/⌘V/⌘X/⌘A 不 preventDefault（放行给原生 → xterm element 级 copy / 我们的 paste 处理）；其余 return | xterm 自己也从不把 meta 组合转发给 PTY |
| **P3** | 非 mac 下 `Ctrl+Shift+C` / `Ctrl+Shift+V`；`Shift+Insert` | 剪贴板语义，不进 PTY | Linux 终端惯例 |
| **P4** | `ev.altKey && !ctrlKey && !metaKey` 且 key 为单字符 | **落到 P7**（不 preventDefault，让输入域收 macOS Option 产出的 `∑` 等字符） | `macOptionIsMeta` 保持 false |
| **P5** | 非文本键与控制组合：`Enter` `Tab` `Shift+Tab` `Backspace` `Delete` `Escape` `↑↓←→` `Home` `End` `PageUp` `PageDown` `Insert` `F1`-`F12`、`Ctrl+字母`、`Ctrl+[ ] \ ^ _ Space`、`Ctrl/Shift+方向键` | `preventDefault()` + 交给 VT 编码器 → PTY | `Tab` 必须 preventDefault（否则焦点跑掉、claude 补全没了）。`Ctrl+C` 无论有无选区都送 `\x03` |
| **P6** | 输入行模式下的 `Enter`（无 Shift） | 送整行 `text + \r` | 就地模式下 Enter 落 P5 送 `\r` |
| **P7** | 其余可打印键（`ev.key.length === 1`，无 ctrl/meta） | **不 preventDefault**，交给输入域 → `input` → diff → PTY | 死键（´+e=é）、Option 字符、**不发 composition 事件的输入法**只有输入域是唯一真相 |
| **P8** | 既不产字符也无 VT 语义：`CapsLock` `F13+` 媒体键 纯修饰键 | 忽略 | |

**粘贴 / 复制 / 拖放（独立于按键表）**

| 事件 | 处置 |
|---|---|
| `paste`（含 files） | **不变**：host 既有 capture 监听器先手拦下 → 上传 → `renderer.paste("'路径' ")` |
| `paste`（纯文本） | 在输入元素上 `preventDefault()` + `renderer.paste(text)`。**刻意复用 `term.paste()`**：自带 `prepareTextForTerminal`（`\r\n`/`\n`→`\r`）+ `bracketTextForPaste`（按 `bracketedPasteMode` 决定包裹并剥离载荷里的 `ESC[201~` 防注入）→ `onData` → `sendInput`。多行、bracketed paste、`runCommand`/`insertPreset`/`execPreset`/文件上传**一行不改** |
| `copy`（⌘C / Ctrl+Shift+C） | 免费保留：我们的元素是 `term.element` 后代，`copy` 冒泡到 xterm 的 element 级 `copyHandler`。copy-on-select 与 OSC 52 在输出/选区侧不受影响 |
| `drop`（文件） | 不变（host 的 dragover/drop） |
| `drop`（文本落到输入元素） | `preventDefault()` + 同一 `renderer.paste()` 路径（否则绕过 bracketed paste 包裹） |

### D. VT 编码器：Phase 1 复用 xterm（不手搓表）

`renderer.sendKey(ev)` 加进 `TerminalRenderer`，`xtermRenderer` 实现为向 `term.textarea`
派发**合成 keydown**（复制 `key/code/keyCode/location/修饰键/repeat`）。于是 xterm 的
`_keyDown` 全套编码逻辑照旧：DECCKM、`applicationKeypadMode`、修饰位（`ESC[1;5A` 类）、
F1-F12、`macOptionIsMeta`、`scrollOnUserInput`、`updateCursorStyle` —— 一行不用重写，
结果经 `term.onData` 落到既有 `sendInput`。

三条纪律：
1. **只补发 keydown，绝不补发 keyup**（`_keyUp` 里有 `this.focus()`，会抢走焦点）。
2. 安全带 `attachCustomKeyEventHandler(ev => ev.isTrusted === false)`。
3. 合成 keydown 会 arm `_handleAnyTextareaChanges`：它 diff 的是 **xterm 自己的 textarea**，
   而那个元素永不聚焦、永不被 IME 触碰、value 恒为空 ⇒ 恒定 no-op（需探针背书）。

**为什么不现在做纯 TS 编码表**：正确性面（F 键带修饰、Ctrl+方向、keypad、DECCKM）恰恰
最容易静默回归，而本仓没有 jsdom，**无法在单测里拿 xterm 当 oracle 做差分**。列为延后债，
换非 xterm 渲染器时才必须偿还，届时用按键扫描 golden 做迁移护栏。

### E. 核心状态机（纯函数）

三个新纯模块，零 DOM、零定时器（时间由宿主注入 `tick`）：

1. **`termInputRoute.ts`** — `routeKey(ev, ctx): RouteDecision`
   `ctx = { isMac, barMode, modes }`；`RouteDecision.kind ∈ {app,ime,clipboard,vt,text,ignore,send-line}`
   —— §C 那张表的直译。
2. **`termInputModel.ts`** — `reduce(state, ev): { state, emit }`
   `ev` 判别联合：`field-value` / `composition-start` / `composition-end` / `blur` / `focus` /
   `adopt`（外部改动，不发送）/ `tick` / `clear-request`。内部只有 `shadow`（已镜像到 PTY 的
   内容）、`composing`（**只决定能否清空输入域，绝不决定是否发送**）、`lastCommitAt`。
   diff 引擎 = 现有 `diffTextValue`（逐**码点**计数 `\x7f`、不切代理对）+ `toPtyText`。
3. **字段策略（入参 config，不是新文件）** `{ mode, clearIdleMs, maxLen }`
   - 桌面 `clear-on-idle`：`tick` 上若 `!composing && now-lastCommitAt > 300ms` ⇒ 清空并
     `shadow=''`。可以清是因为桌面硬件键盘不镜像字段内容；要清是因为残字会累积且宽度
     策略会失准；300ms 是给多阶段 IME 留时间的保守值。
   - 移动端 `sticky`：**绝不主动清**（OS 软键盘把该字段当自己的模型，清了退格就哑 ——
     "删不掉的最后一个字母"），只在 `!composing && len>400 && /[\n\s]$/` 的自然边界清。

**铁律（单测直接断言）**：`emit` 只有两个来源 —— ①`field-value` 的单调 diff；②`routeKey`
返回 `vt`/`send-line` 时宿主的显式发送。`composing` 从不出现在"是否发送"的判断里。
⇒ **任何 composition 事件的缺失、重复、乱序，都不可能吞掉或重复发送文本**；最坏情况
只是输入域清空被推迟。

### F. 两端统一还是分叉：统一核心，分叉策略与呈现

| 层 | 桌面 | 移动 | 结论 |
|---|---|---|---|
| `termInputRoute` | 同 | 同 | **统一** |
| `termInputModel` + diff | 同 | 同 | **统一** |
| 字段策略 | `clear-on-idle` | `sticky` | **分叉，但只是一个入参** |
| 呈现 | 就地 overlay | 就地 overlay + 输入行模式 | **分叉，且都已有实现** |
| 键盘/视口/焦点策略 | 既有 `refocus` | 既有 `termFocusPolicy` + `termKbViewport` | 不动 |

分叉两处都有**物理性**依据（移动端观测不到按键，只能以字段为真相；桌面能观测按键，必须
让字段回空），不是历史包袱。**收益**：`mobileInputBridge.ts`（219 行）在 Step 3 后可整体
删除，它的四个 bug 教训由统一核心承接，且不再需要跟 xterm 的定时器抢时序。

## 迁移与回退

开关：`localSettings` 新增 `terminalInputOwnership: z.enum(['xterm','own'])`，默认 `'xterm'`
（Step 3 改 `'own'`）。用 localSettings 而非构建 flag，因为**回退不需要发版**，且 device-local
语义对（输入硬件是设备属性）。枚举值**只增不删**。附加 `?input=own|xterm` URL 参数一次性
覆盖，方便 CDP 在同一构建上跑两条路径做差分。

| Step | 内容 | 独立上线 | 验证 |
|---|---|---|---|
| **0** | 纯函数落地 `termInputRoute.ts`/`termInputModel.ts`（含从 `mobileInputBridge` 抽出的 diff）+ 全量单测。**零接线，行为不变** | ✅ | 单测 + tsc + 现有测试全绿 |
| **1** | 桌面新路径：overlay 元素、renderer 加 `focusInput/blurInput/isInputFocused/sendKey`、8 个耦合点改走间接层、安全带、开关默认 **off**；开关 on 时 `imeStuckGuard` 不安装 | ✅ | Owner 翻开关日用；CDP 按键扫描 + 病理序列 |
| **2** | 移动端接同一路径（同开关）：overlay + `sticky`；`TermInputBar` 行为不变 | ✅ | 真机 iOS/Android（登记 verify-queue） |
| **3** | 默认翻 `'own'`，旧路径保留一版作逃生门 | ✅ | 一整批周期观察；Owner 报问题→翻开关→零发版恢复 |
| **4** | 删除 `imeStuckGuard.ts`(280)+其测试(170)+`imeFix.ts`(39)+`mobileInputBridge.ts`(219)+`refocus()` 的 blur-then-focus 自愈段。开关键保留（标 deprecated，不删枚举值） | ✅ | 全量测试 + tsc + 真机复验 |

**回滚点**：Step 1-3 任一步出问题 → 翻开关回 `'xterm'`（**无需发版**）；新路径代码本身崩溃
→ 回滚 web bundle（`webapp.prev`，PROCESS §4）。**一次性替换输入路径的方案明确排除。**

## 兼容矩阵与发布顺序

- **纯 web 包内改动**：无 wire 字段、无 KV/metadata、无 RPC 变化 ⇒ server/CLI/daemon 零协同，
  只发 web，无发布顺序约束。
- `localSettings` 新键：旧版 web 读到未知键被 `passthrough().partial()` 保留并忽略；新版读到
  旧存储落 defaults ⇒ **双向兼容成立**。
- 多设备：device-local 不同步，一台灰度不影响另一台。

## 可测试性

**纯函数边界**（"事件序列 → 应写入 PTY 的字节"就是 `reduce`）：`routeKey`、`reduce`、
`diffTextValue`/`toPtyText`（已有测试，迁移时保留原用例）。

**病理序列单测**（每条都是一次真实事故的回归锚）：

| 用例 | 序列 | 断言 |
|---|---|---|
| `compositionend` 缺失 | start → `field("ni")` → **无 end** → `field("你")` → `field("你a")` | 依次 emit `"你"` 与 `"a"`；**一字节不吞**；`composing` 仍 true 也不影响 emit |
| 切输入法中止 | start → `field("ni")` → blur → focus → `field("nia")` | emit 总量 == 最终内容；无重复提交 |
| 合成期间失焦 | start → `field("nihao")` → blur（end 可能不来） | 残留内容**恰好提交一次**；迟到的 end 不重复发 |
| 快速连打 | `field` × 20 交错 start/end，含同值重复 | 幂等：emit 拼接 == 最终内容；无双发 |
| Gboard 重组合 | `"hello"` → start → `"hell"` | emit `"\x7f"`（一个码点） |
| 码点/代理对 | `"a"` → `"a😀"` → `"a"` | 插入整个 emoji；删除只发**一个** `\x7f` |
| 换行归一 | `field("ls\n")` | emit `"ls\r"` |
| 清空不发送 | `clear-on-idle` 触发的清空 | emit 空（`adopt` 语义），shadow 归零 |
| 路由 P1 无状态性 | `{isComposing:true,key:'Enter'}` / `keyCode:229` / `key:'Process'` | 全部 `kind:'ime'`, `preventDefault:false` |
| 路由 P0 结构约束 | `{defaultPrevented:true}` | 恒 `kind:'app'`；另加**结构测试**：grep 断言 `termInput*` 不出现 `window.addEventListener('keydown'` |
| 路由 Tab/⌘/⌥ | `Tab`、`Shift+Tab`、`⌘C`、`⌘V`、`⌥w`、`Ctrl+Shift+V` | 逐条钉住 §C 的表 |

**性质测试（1 条，覆盖面最大）**：给定任意"规范 composition 转写"与任意注入的缺失/重复/
乱序 composition 事件，`emit` 拼接恒等于输入域内容序列的单调增量和。—— 通过即等于证明目标 2。

**CDP 回归**（沉淀成 `scripts/probe/term-input-replay.mjs`，非 CI，按批手跑）：
- 场景 A 完整合成；B 合成中途跳过 end；C 合成中 blur；D 快速连打；E 合成中程序化写字段
  （round 2 "亲手制造卡死"的场景，新架构下应无影响）。
- **断言面改造（关键）**：`debugMode` 下挂 `window.__vhTermInput = {routed:[],emitted:[]}`
  （环形缓冲上限 200），脚本直接断言**字节**，不靠截屏。并断言
  `term._core._compositionHelper._isComposing === false` 恒成立。
- **必须遵守的既有 CDP 陷阱**：①down/up `keyCode` 必须配对；②**headful 失焦时
  `dispatchKeyEvent` 被静默丢弃而 composition 照常送达**（round 1 假阴性根源）→ 脚本开头
  `Page.bringToFront` + `Emulation.setFocusEmulationEnabled({enabled:true})`，并先发探针键
  断言 `routed` 有增长；③headless 下 `imeSetComposition` 污染键状态 ⇒ 每场景开新 tab；
  ④不要碰 `clipboard.readText`（弹权限框冻结 renderer），剪贴板断言用 `pbpaste`。
- **按键扫描（golden，Step 1 的护栏）**：同构建同页面，`?input=xterm` 与 `?input=own` 各跑
  约 60 个键/组合（F1-F12、方向键 ×{无,Ctrl,Shift,Alt}、Home/End/PgUp/PgDn/Insert/Del、
  Ctrl+a..z、Ctrl+[ ] \ ^ _ Space、Tab/Shift+Tab、Enter/Esc/Backspace，DECCKM on/off 各一轮），
  比对 `emitted`。**逐字节一致才算通过**。也是未来换纯 TS 编码表的迁移护栏。

## 风险

**R1 —— 焦点归属回归（历史最高频）**：8 个耦合点漏改一个就"打字没反应"；特别是 `_keyUp`
偷焦点、Radix 菜单关闭归还、tab 切走再回。
*检测*：①单测把 `termFocusPolicy` 动作枚举全映射到新目标 + grep 结构测试断言不再出现
`querySelector('.xterm-helper-textarea')`；②CDP：切 tab 走→回→断言 activeElement 是我们的
元素且发键有 emitted 增长；③CDP：右键菜单/预设菜单/确认弹窗各一轮，每轮后直接打字断言；
④断言 `term.textarea === document.activeElement` **恒 false**。

**R2 —— DEC 1004 焦点上报与光标观感**：补发 FocusEvent 若不生效，claude TUI 收不到
`ESC[I`/`ESC[O`（界面变暗/光标不闪/停止刷新），光标退化成空心 outline。
*检测*：CDP `term.write('\x1b[?1004h')` 后聚焦/失焦，断言 emitted 恰好一次 `\x1b[I` 与
一次 `\x1b[O`；`?1004l` 下断言**零**上报；断言 `term.element.classList.contains('focus')`
与 `_coreBrowserService.isFocused`。截图比对光标是实心块。

**R3 —— 非文本键覆盖漏洞（vim/claude TUI 里某键静默失效）**：典型 `Tab` 忘 preventDefault
→ 焦点跑掉；`Ctrl+方向` 落进 P7 → 什么都没发。
*检测*：**按键扫描 golden 差分**（`?input=xterm` vs `?input=own` 逐字节，含 DECCKM 两态）。
**Step 1 未跑通此扫描不得进入 Step 3。**

**R4 —— 双通路 / 双发**：①新旧路径同时安装（两个输入元素→字符双发）；②同一次按键既走
P5 又让输入域收到（漏 preventDefault）。
*检测*：①单测断言 `kind:'vt'` 时 `preventDefault` 必须 true（表驱动全覆盖）；②dev 断言：
一次 keydown 内 emitted 增量 ≤1，越界 `console.error`；③CDP：连打 `abc`、粘贴多行、
IME 打"你好"，断言 emitted 拼接恰好等于期望串；④结构断言 `.vh-term-input` 恰好 1 个。

**R5 —— IME 候选窗位置 / preedit 可读性 / iOS 自动滚动（手感风险，最难自动化）**：
`opacity:1` 元素落在光标处，候选窗可能偏位、拼音可能与 claude 输入框边框叠字；**iOS 会为
露出聚焦元素自动 pan 布局视口** ⇒ 可能与 `termKbViewport` 的 maxHeight 数学互相打架
（V-012 那批踩过的坑区）。
*检测*：①几何断言（可进 CDP）：我们的元素 rect 与 `term.textarea` rect 左上角偏差 ≤1px；
`top` 落在 host 可视框内；软键盘态下断言 `window.scrollY === 0` 且 host `maxHeight` 未被
二次改动；②真机项进 `docs/verify-queue.md`。

**R6 —— 选区 / 复制链路（⌘C、copy-on-select、OSC 52）**：只有当我们的元素是 `term.element`
**后代**时 ⌘C 才继续工作；xterm 的 `user-select:none` 与我们元素的可选性可能互相干扰。
*检测*：①结构断言 `term.element.contains(inputEl)`；②CDP：拖选→`getSelection()` 非空→⌘C→
`pbpaste` 比对（**不用 `clipboard.readText`**）；③断言我们的元素 `user-select:none` +
`pointer-events:none`。

## 验收标准

- [ ] `termInputRoute.ts`/`termInputModel.ts` 为纯模块（无 DOM/无定时器/无 import 副作用），
      §可测试性 表中**每一行**都有对应用例且全绿。
- [ ] 性质测试通过：任意 composition 事件缺失/重复/乱序下，emit 拼接 == 输入域单调增量和。
- [ ] 结构断言：新输入模块**没有** window-capture keydown 监听器；`WebTerminalScreen` 不再
      出现 `querySelector('.xterm-helper-textarea')`；`.vh-term-input` 恰好 1 个；
      `term.element.contains(inputEl)`。
- [ ] 不变式：开关为 `own` 时 `_compositionHelper._isComposing` 恒 false；
      `term.textarea` 永不等于 `document.activeElement`。
- [ ] **按键扫描 golden 差分通过**：约 60 键/组合 × DECCKM 两态，两条路径 emitted 逐字节一致。
- [ ] CDP 五场景全绿，其中 B（end 缺失）与 C（合成期失焦）在**旧路径上必须复现失败**、
      新路径通过——否则说明探针没打到位（round 1 假阴性教训）。
- [ ] DEC 1004：`?1004h` 下聚焦/失焦各一次上报；`?1004l` 下零上报。
- [ ] 粘贴矩阵：单行/多行/bracketed on/off/剪贴板文件/拖放文件/拖放文本/预设 insert/
      预设 run（`\r` 仍在文本之后）—— 与旧路径一致。
- [ ] 门禁（PROCESS §3）：`vitest run` 全绿 + `vite build` 成功 + `tsc --noEmit` 0 错误。
- [ ] 开关来回翻各 3 次不留残留（无双输入元素、无残字、无焦点丢失）。
- [ ] Step 4 后：三个补丁文件已删除，`refocus()` 的 blur-then-focus 自愈段已移除。

## 留真机验证项

（Step 1/2 上线时登记进 `docs/verify-queue.md`）

1. **桌面 macOS 系统拼音 + 搜狗**：拼音是否就地显示、候选窗是否贴光标、**打一半切输入法
   再切回**是否立即恢复（V-001 同场景，新架构下应无从卡死）。
2. **桌面 claude TUI 场景**：拼音与 claude 输入框的视觉关系（是否叠字、是否要背景框）——
   直接决定「合成气泡要不要背景框」这条待拍板项。
3. **桌面 Windows 微软拼音 / macOS 注音 / 日文 IME** 各一轮（多阶段候选、半角/全角切换）。
4. **iOS Safari（含 PWA 独立窗口）**：软键盘弹起后就地模式打中文、退格能删到底
   （"删不掉的最后一个字母"回归锚）、听写、预测文本、键盘收起后布局完整还原。
5. **Android Chrome/Gboard**：滑行输入、退格进已提交词的重组合、Enter 不误发。
6. **iPad + 硬件键盘**（coarse pointer 但有真键盘）：路由表在这台设备上的表现。
7. **vim / less / tmux copy-mode** 逐键交互：方向键、Ctrl+方向、F 键、Shift+Tab。
8. **⌘C 复制选区 + copy-on-select + OSC 52**（tmux yank）三条路径各一次。

## 上线记录（2026-08-14）

| Step | 内容 | 上线构建 | 门禁证据 |
|---|---|---|---|
| 0 | 纯函数 `termInputRoute`/`termInputModel` + 病理序列与性质测试 | （零接线） | 单测 940→1021；**做了变异验证**（故意加 `composing` 闸门 → 11 条红） |
| 1 | 桌面自有 overlay 输入元素 + renderer 间接层 + 开关（默认关） | `202608141113` | 1021→1071；**golden 差分 142/142 逐字节一致**；点击焦点交接 5/5 |
| — | B-095 `isAppChord`（macOS 上 Ctrl+K/J/N/R 归还终端） | `202608141113` 后 | 复跑差分：4 个用例从「两边都空」变成 `\x0b`/`\x0a` 且一致 |
| 2 | 移动端接入同一路径（sticky 策略 + iOS 16px 防自动放大） | `202608141145` | 1071→1104；复跑 golden 142/142 无回归 |
| 3 | **默认值翻成 `own`** | `202608141151` | 全部门禁复跑绿；旧路径留作逃生门 |
| 4 | 删旧路径与三个补丁文件 | **未做（刻意）** | 需真实使用一批之后再清理 |

**关键实证**：两条路径经指纹确认**真的分叉**（`ownInputEls` 0 vs 1、activeElement 分别是
xterm 的 helper textarea 与 `.vh-term-input`），不是「都没收到」的假绿。`tmux` 前后逐行零差异。

**实施中回流的设计修正**见上文「Step 0 实施回流的设计修订」，另有 Step 1/2 的补充发现：
- 耦合点实际是 **11 处**（spec 写 8），漏的那个是 `classifyFocusHolder` 的 class 判定——漏改不会
  立刻打不了字，但诊断快照会把 overlay 报成 `'other'`，而「焦点在谁手里」正是上次事故唯一
  问得出真相的量。
- **`pointer-events:none` 与「点击终端要能聚焦」冲突**：点击仍走 xterm 的 mousedown →
  `term.focus()` → helper textarea 拿到焦点 → 真实按键被安全带全部否决 = **打字全哑**。
  spec 完全没提这条通路。实现用 `focusin` 弹回自愈（**整个改造里唯一靠时序自愈而非构造
  成立的地方**），已由 focus-handoff 探针 5/5 背书。
- 因此验收标准「`term.textarea` 永不等于 `document.activeElement`」**字面上做不到**（click 期间
  有同步的瞬时窗口）；要构造性成立需给 xterm textarea 加 `inert`，那是又一个赌注，未押。
- **拖放文本落到输入元素做不到**（`pointer-events:none` 的元素不能当 drop target）；行为与旧
  路径一致，非回归。
- **barMode 双发风险不成立**：`TermInputBar` 在 `term.element` 之外，两个输入面 DOM 不相交。
  反向才是真风险——barMode 下停用增量观测会让 overlay 变成**静默缓冲区**（打字零回显直到
  回车），正是本 spec 要消灭的吞字形态。
- **iOS 的真雷不是 pan 是自动放大**：Safari 聚焦字号 <16px 的表单控件会放大整页，而
  `onViewport` 第一条守卫是 `scale > 1.001` 直接 return ⇒ **软键盘避让数学整个停摆**
  （键盘盖住终端且不再还原）。移动端终端字号 12px 正好踩线 ⇒ overlay 在粗指针下抬到 16px、
  宽度上限收窄到 24 列、静止透明只在合成期露出。

## 上线后实测修正（2026-08-14，`?input=own` 真机三问题）

Step 3 把默认值翻成 `own` 之后 Owner 真机实报两条病象：「一个绿条跟着光标走」＋「中文输入法
没法用（只进英文）」。默认值当场撤回 `xterm`（576874a9），CDP 取证得到三个独立问题——
**三条都不是"新架构选错了"，而是两个潜伏缺陷被显影 + 一条设计判断做反了**。

### 1. 「绿条跟着光标」= 全局 `:focus-visible` 焦点环被显影（不是新代码画的）

`CSS.getMatchedStylesForNode` 点名：`textarea.vh-term-input` 命中的唯一规则是 `base.css` 的
**元素级** `:focus-visible { outline:none; border-color:accent; box-shadow:0 0 0 3px accent-glow }`，
实测 `boxShadow = rgba(52,226,196,0.16) 0 0 0 3px`。**旧路径同样命中这条规则** —— xterm 的
helper textarea 一直在收同一个 3px 光晕，只是它 8px 宽、`opacity:0`，所以规则是**看不见**，
不是无害。`.vh-term-input` 作者写了 `outline: none`（想到了 outline）却漏了 `box-shadow`
（**规则真正画环用的就是 box-shadow**），于是一个刻意 `opacity:1`、宽 40 列的元素把它显影了。

修法两条（都做）：
- `.vh-term-input` 补 `box-shadow: none`，并加 `.vh-term-input:focus, :focus-visible`
  （0,2,0）一份，使它**即使全局规则再被放宽也免疫**；
- **结构性收窄**全局规则为 `:focus-visible:not(:where(.xterm, .xterm *))` ——
  终端 pane 内不画 app chrome 的焦点环（pane 自己的指示器是那颗 teal 块光标，
  `terminal.css` 原文就写着 "No focus ring either"）。`:where()` 在 `:not()` 里贡献
  **0 特异性**，所以选择器仍是 (0,1,0)：既有组件覆盖的胜负关系一个都不变，这条修改
  **只可能少画，不可能重排层叠**。将来任何"刻意可见的功能性输入元素"挂进 pane 都自动免疫。

### 2. own 路径独有的真泄漏：合成在途停手 >5s 把拉丁 preedit 当正文灌进 PTY

差分实证：停手 4.0s 无泄漏；停手 6.6s 时 `?input=own` 泄漏 `"ni hao"`（随后模型自己发 6 个
`\x7f` 纠正），`?input=xterm` 无此现象——与 `COMPOSITION_STALE_MS = 5000` 一致。机制是
★ 规则 4 的兜底 tick **无条件观测输入域**，而此刻输入域里装的正是拉丁 preedit。触发面比设计时
以为的宽得多：**在候选窗里翻页不产生 `compositionupdate`**，所以"打一半翻候选"就会踩。

**判断复盘（这是设计错，不是实现错）**：那条兜底防的失效模式是"`compositionend` 永不到来
导致永久吞字"，而**那个失效模式只存在于旧架构** —— 旧路径卡的是 xterm 自己的持久标志
`_isComposing`。新架构里合成状态由**浏览器**持有且是准的（IME 中止会发 `compositionend`，
或下一个 `input` 的 `isComposing` 直接是 false）。用"把 preedit 当正文发出去"去防一个
已不存在的问题，在**终端**里方向是反的：那几个字母在 vim normal mode 会被当命令吃掉，
`\x7f` 纠正是不可逆副作用之后的补救，不是预防。

**定稿：删掉第 4 条。** 「绝不永久吞字」改由三个**真实边界**承担，任意一条到达即补齐
（模型是单调 diff，重复到达恒 emit `''`，多兜零成本）：
1. **非合成 `input`** —— IME 中止/切走/继续打字时浏览器给的下一个 `input` 就是
   `isComposing:false`，它携带字段全量；
2. **`compositionend`** —— 正常提交（含 0ms 补跑，Safari/Firefox 晚一拍写字段）；
3. **`blur`** —— 焦点离开（失焦后 IME 不会再给 `compositionend`）。

`ObserveTrigger` 里**删掉 `tick` 这个 kind**（不是"tick 返回 false"）：让"拿时钟问该不该观测"
在类型层面无法表达。阈值本身留下来只做一件事——合成停滞超过它时**记数不动作**：
`isCompositionStale` / `tallyCompositionStale`（纯函数，一个停滞窗口只记一次）→
`__vhTermDiag.guardCounters.compositionStaleSeen`。万一将来真出现"永不结束的合成"，
我们**问得出来**，而不是靠一个会伤字节的兜底去猜（上次事故一半代价就是线上问不到状态）。

### 3. preedit 与终端正文视觉无法区分（「以为 IME 坏了」的直接原因）

新路径的 preedit 用**终端同一个字体 + 同一个前景色**内联画在光标处，看起来和"已经打进终端的
英文"完全一样；旧路径是 xterm `.composition-view` 的 teal 边框气泡，一眼能看出"这是输入法在
合成"。叠上问题 1 的绿框，用户看到的就是「光标处一个绿框、拼音以英文出现在里面」⇒ 判定
"中文输入法不能用" ⇒ 按 Enter（**macOS 简体拼音的 Enter = 提交原始拉丁字母**）⇒ 真的只进英文。
**"打不了中文"不是通路坏了，是观感把用户引到了一个会毁掉输入的操作上。**

修法：`.vh-term-input.is-composing` 从"粗指针专用"改成**两端都用**（`syncPreedit` 去掉粗指针
早退），观感与 `imeFix` 给 xterm 注的气泡**同两个色值**：不透明 `#181f2a` 底 + 1px `#34e2c4`
描边 + 3px 圆角 + `z-index:10`。用 `outline` 而不是 `border`：`border-box` 加上抄来的 inline
宽高下，1px border 会吃掉内容盒把 preedit 削顶；outline 不进布局。静止时依旧完全不可见
（桌面 `clear-on-idle` 把字段收空、粗指针 `opacity:0`）。这个 class **纯装饰**、不 gate 任何
字节，最坏后果是一个空框或 preedit 不显。

### 验证方式（除单测门禁之外）

- **焦点环**：真浏览器（Chrome 151）加载**本次构建产物**，把 `base.css` 里那条规则
  **原地**（同 sheet 同 index）换回老写法做 A/B —— ⚠️ 不能用"在 head 末尾追加老规则"模拟，
  那会让它排在所有组件 CSS 之后凭"同特异性后来者胜"拿到本来没有的话语权（实测把
  `.vh-input` 的 border-color 抢成 accent，是**工具**的假阳性）。结果：Tab 扫描 8 站的真实控件
  （`.vh-input` / `.auth-alt`）**逐属性一致**，光晕仍是 `rgba(52,226,196,0.16) 0 0 0 3px`；
  `.xterm` 内的 `xterm-helper-textarea` 老规则下有光晕、新规则下 `none`（差异恰好落在
  carve-out 上）；`.ci-textarea`（组件自带覆盖）两种写法下都是 `none`（特异性未变）。
- **`.xterm` 里到底有什么可聚焦元素**：xterm 5.5 只给 helper textarea 设 `tabIndex=0`
  （accessibility tree 不可 Tab），本仓在 `term.element` 内只有一处 `appendChild`
  （overlay）。所以 carve-out 影响到的可聚焦元素**穷举就是这两个 textarea**，都不是
  用户会看的控件。
- **气泡**：同一构建下量 computed style —— 桌面静止 `background: rgba(0,0,0,0)` / 无描边；
  桌面合成期 `rgb(24,31,42)` + `solid 1px rgb(52,226,196)` + `radius 3px` + `z-index 10`
  + `box-shadow: none`；粗指针静止 `opacity 0`、合成期 `opacity 1`（`.is-composing` 排在
  `.is-coarse` 之后，同特异性后者胜 —— 这条顺序有结构测试钉住）。
- **留真机验证**：合成气泡宽度沿用 overlay 的 `min(40ch, 到右边缘)`，合成期会是一个
  40 列宽的不透明框（旧路径的 xterm 气泡是贴合内容宽的）。行尾打字无所谓，**行中编辑
  （vim）时它会盖住光标右侧的字**；要不要做"贴合内容宽"等真机看过再定。
