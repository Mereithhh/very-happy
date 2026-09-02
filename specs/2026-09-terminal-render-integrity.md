# 终端渲染完整性：首帧字体宽度 + 恢复 SGR 泄漏（B-288 / B-289）

状态：方案待对抗 review。分支 `feat/terminal-geometry-arbiter`（接 B-287）。
两个独立根因,都属「快照/首帧重建时把错误的 cell 状态冻进历史,刷新无效」。

## 现象与根因

### B-289 首帧按错误宽度渲染 → 历史里冻住窄表格

**现象**:首次打开会话,claude 欢迎横幅/表格按偏窄的宽度打印;字体加载完后
后续输出恢复正宽,早期窄内容永久留在 scrollback(刷新/新输出都清不掉——终端
表格每行是硬行,历史落定后 xterm 不 reflow)。

**根因(已核验)**:终端等宽字体 `IBM Plex Mono` 是异步 web 字体
(`@fontsource/ibm-plex-mono/400`,`main.tsx:7`)。首次 open 时
`machineOpenTerminal({cols: term.cols})` 的 `term.cols` 来自一次 `safeFit()`,
**没有等字体**(`WebTerminalScreen.tsx:1476`)。字体没就绪时 xterm 用回退字体
(SF Mono/系统 mono)量 cell 宽,advance width 不同 → 列数偏窄 → daemon 按此建
tmux 会话、claude 按窄宽打印;`document.fonts.ready` 的重排在**之后**才发生
(`:980`),已冻的窄内容回不来。这是「首帧半 logo」的同源,B-287 只修了冷恢复
尺寸与多设备,没修这条单设备首开路径。

### B-288 恢复快照不重置 SGR → 绿色块(以及新输出被染色)

**现象**:B-273「接入已有 tmux 会话」的终端里经常出现整片绿色矩形,盖住若干行、
一直铺到窗口右缘;点击/滚动都不消(不是选区,选区是 teal)。

**根因(已核验 + 本机 tmux 3.7b 实证)**:
- 捕获用 `capture-pane -e`(`captureAssembly.ts:132-150`),忠实复现内层 tmux 的
  绿色 copy-mode 选区 / 默认绿色状态栏为绿底 SGR;`-N/-J` 保留行尾空格,使绿底
  一直到右缘。
- `assembleRestore` 拼接 history + screen + **零长 EMPTY 填充行** + tail + cursor,
  **任何接缝都不插 `\x1b[0m`**(全文只注入过 `?1049h`/`[H`/CUP/CRLF)。tmux 每行
  会在行首重声明 SGR(本机实证:每行以 `^[[42m` 开头),但**行尾可能不带 reset**
  (实证最后一行 `^[[42mbash-3.2$` 绿底未闭合);于是一个未闭合的绿底会顺着
  很happy **自己合成的空白填充行**和各段接缝一路蔓延,直到下一个显式 SGR。
- 更糟:payload 以 CUP 结尾、**末尾无 reset**,恢复后终端「当前属性」仍是绿底,
  **应用接下来的实时输出也会被染绿**(green 也会出现在新内容上)。
- 冻结原因:绿底被烤进 snapshot 字节与 daemon headless grid(`restoreHeadless`),
  是历史内容而非 live 选区图层,故刷新无效、颜色是绿(非 teal)。

## 设计

### D1 首帧等字体再定尺寸(B-289,web)

新增可复用的渲染器 seam,把「量尺寸」永远建立在真实终端字体上:

- `TerminalRenderer` 加 `remeasureFont(): void`;xterm 实现内部封装私有
  `_core._charSizeService.measure()`(现在散在 screen 里直接 poke 私有 API,收敛到
  renderer)。
- 新增纯工具 `awaitTerminalFont(weight400 面, timeoutMs)`:
  `Promise.race([document.fonts.load("<size>px 'IBM Plex Mono'"), 超时])`,吞掉异常/
  不支持;字体已缓存时近 0ms。查询用 weight 400(xterm 的 cell advance 只由常规面
  决定,`main.tsx` 的 400/500 里 400 才是量度依据);size 对「加载哪个面」无关紧要,
  但传实际 `FONT_SIZE` 无害。
- **超时按 open 类型分档(review F5:损伤是永久的,且只发生在 fresh create)**:
  - fresh create(daemon 据此建会话、claude 首帧按此宽打印,错了永久冻进 scrollback):
    等**较久**(默认 3000ms,或 `document.fonts.ready` 取先到者),这个延迟一辈子付一次;
  - resub/attachOnly(几何由响应 `paneCols` 权威 adopt,B-287 已自愈):短档(300ms)
    或直接跳过等待——错宽会被 adopt 纠正,代价小。
- **ref 读取放在 await 之前(review F6)**:`const isFresh = freshRef.current; const
  attach = …;` 先同步读,再 `await awaitTerminalFont(...); renderer.remeasureFont();
  renderer.fit();` 然后 `machineOpenTerminal({cols: term.cols})`。既有 rAF/60ms
  safeFit 兜底保留;`document.fonts.ready` 分支改用 `renderer.remeasureFont()`。
- **boot 预热(review F8,一行 belt)**:`main.tsx` 在 `@fontsource` import 后
  `document.fonts?.load("13px 'IBM Plex Mono'")`,让绝大多数会话打开时字体已就绪、
  `awaitTerminalFont` 近 0ms。不替代 D1(第一次冷启仍可能 race),只缩小窗口。

### D2 恢复时只在「very-happy 自己制造的段接缝」重置 SGR(B-288,daemon 纯函数)

⚠️ **对抗 review 推翻了初版**:本机 tmux 3.7b 实证——`capture-pane -e` 只在属性
**变化处**发 SGR,一段跨多行的背景色**靠 pen 连续性跨行延续**,第 2 行起**行首没有
SGR**(`row1=^[[42mAAA` / `row2=BBB`(无声明,续绿)/ `row3=…^[[49m`)。所以「每行
行尾插 reset」会把第 2 行起的颜色**抹成默认**——彩色 TUI 面板、vim/htop 配色、跨行
copy-mode 选区全中招,是比现状更糟的普遍回归。**必须只在 very-happy 自己拼接的段
边界 reset,绝不动 capture 内部的行间**(每次 `capture-pane` 都从默认 pen 起,故段
边界 reset 无损:下一段第一格若非默认会自带声明)。

`captureAssembly.ts` 改动(纯函数):`SGR_RESET = \x1b[0m`
1. **history↔screen 接缝**插 reset(现为裸 CRLF):history 未闭合的绿不再漏进 screen
   第 0 行(该行若默认则无 SGR,会继承)。
2. **填充块之前**插一次 reset(不是每行):合成的零长 EMPTY 行恒为默认——「绿矩形铺到
   底部空行」的主因。
3. **payload 结尾**(CUP 之后)追加 reset:恢复后应用的实时输出从默认 pen 起(修「新
   输出被染绿」)。review F3:此为唯一真实语义变化——若某 app 打了带色 prompt 并留色
   期待本地回显继承,恢复帧的 pen 变默认;本架构里按键走 send-keys、回显作为 %output
   自带 SGR,风险低,且与「原生重新 attach 后应用自绘」一致。
4. **body↔tail 接缝**插 reset:real 内容未闭合的绿不染 tail/cursor 区。
5. alt 路径:history/saved 接缝、scrollback↔`ALT_ENTER` 接缝各插 reset(pen 跨 1049h
   缓冲切换仍延续)。
6. **payload 开头**补 reset:daemon headless `restoreHeadless` 不像 web 先 `term.reset()`,
   要自带干净起点(web 侧多一个 reset 无害)。
7. `joinCrlf` / `normalizeCaptureLines` 的**行间保持裸 CRLF**(保 wrap 连续性)。

不动 `capture-pane` flag(`-e/-N/-J` 必需)。真实整行绿(状态栏)仍绿到右缘(忠实),
只是不再泄漏进下方空行、段接缝与新输出。

### D3 不做/边界

- 不去解析内层 tmux copy-mode 状态、不改 attach 语义:绿底是被捕获的真实 cell,
  忠实复现没错,错的是 very-happy 的泄漏放大。
- 已经冻在**用户历史**里的旧窄表格/旧绿块无法回溯清理(终端固有);两个修复只保证
  此后新产生的恢复/首帧是干净的。用户主动拖窗口改宽度导致的旧宽度留痕是终端固有,非 bug。
- 不动 live 流(应用自己不 reset 的染色,原生终端同样表现,非本仓库能修)。

## 兼容 / 发布

- D1 纯 web;D2 纯 daemon 纯函数,无协议字段,新旧端无关(铁律 4)。
- 发布:web 镜像带 D1,CLI 带 D2(daemon handover,铁律 5/7);D2 对存量会话下次
  open/catch-up 即生效(每次恢复都走 assembleRestore)。

## 验收

- 单测 `captureAssembly.test.ts`:构造「跨 2 行未闭合绿底 + 后随填充行 + history↔screen
  接缝」输入,**把组装结果渲染进 `@xterm/headless` 并断言 cell 属性**(不是文本):
  (a) 绿行仍绿、**(b) 跨行绿块下面那一真实行仍绿(F1 回归专项)**、(c) 合成填充行为
  默认、(d) history 末尾绿不漏进 screen 第 0 行、(e) payload 末尾 pen 为默认。既有
  `.toBe(...)` 字节断言按新段接缝字节更新。
- 单测/源断言(web):`termChannelV2.test.ts` 断言首次 open 前 await 字体 + remeasure;
  `remeasureFont` seam 存在。新增 `awaitTerminalFont` 纯工具单测(超时/无 API 兜底)。
- 集成(真 tmux):在 vh 会话里 `printf '\033[42m…'` 造未闭合绿底再 open,断言恢复
  payload 末尾 reset、下方无绿。
- 真机(verify-queue):① 首开 claude 横幅/表格即正宽、不再先窄后宽;② B-273 接入
  tmux + copy-mode 选区后回看,绿不再糊成整块、新输出不被染绿。
