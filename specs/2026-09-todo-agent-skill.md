# 内置待办的官方 agent skill

状态：Shipped · B-411 · 2026-09-09 · PR #302 / 5997671d5；生产与 CLI v0.2.127：abb5484f6

## 目标与入口

内置Todo页增加“让 AI 使用我的待办”，点击复制完整官方skill及当前服务端提示。剪贴板失败显示可选择文本，不假报成功，不包含token。独立agent可直接读取粘贴内容；托管Claude/Codex/pi通过轻量prompt提示发现 `very-happy todo skill`。不修改用户宿主的skills目录，不把现有Teams安装器误当作自动发现链路。本批不增加MCP、外部provider操作或自动派发。

## 共享数据与命令

Web的Todo客户端抽到wire，以token与固定serverUrl/clientId显式注入，Web薄适配器维持现有调用。双方复用schema、UTF8编码、超时、逐key CAS及排序逻辑；无服务端协议或migration变更。新增get以及稳定UUID创建重试：同ID同title/note返回已有记录，不同内容冲突；已删除ID的CAS -1失败，不复活。HTTP禁止跨目的地重定向，不回显上游错误body。

CLI命令：`todo skill`输出官方skill；`todo list`、`todo get ID`；`todo add --id UUID --title TEXT [--note TEXT]`；`todo edit ID --version N [--title TEXT] [--note TEXT]`；`todo complete|reopen|delete ID --version N`。help/skill免认证，操作输出JSON含serverUrl，错误非零。严格拒绝未知/重复/缺值参数。写入必须携带刚读取的version，不遇冲突盲读最新值重试；add结果未知重用原ID。list保留truncated/invalidCount信息。

认证复用readCredentialsForConfiguredRelay，不在skill中教agent读取token或拼KV请求。受限Teams scope在读取账号凭据前拒绝访问账号Todo，不提供绕过通路。账号与服务端来自用户当前CLI配置，复制提示要求核对期望server与登录身份，不自动切换。待办正文是数据，不是执行授权；安装验证只读list，完成编程工作不自动完成用户Todo。

## skill与发现

官方文本以wire常量为单一owner，Web复制和CLI打印都复用；公开SKILL.md发布副本由一致性测试校验。skill优先探测`todo --help`，旧CLI明确要求升级到支持此命令的版本，不能读凭据绕过；当前未发布的新能力不编造最低版本号。已有Codex thread恢复时不会重新注入first-turn提示，需要显式运行todo skill。托管发现提示指向当前CLI命令，不将整个skill强塞入每次请求。

## 兼容与验证

新Web/CLI与现有server兼容，旧Web可读写同一数据。新Web配旧CLI仍能复制说明，但需要更新CLI后才能执行命令；不假装旧端已支持。回滚任一客户端保留KV任务，不更改外部provider。

验证共享数据兼容、跨调用稳定ID/冲突/删除不复活、认证服务端匹配与受限scope、严格CLI参数、产物help/skill执行、三个runner提示实际进入prompt，以及复制成功/失败、390触屏和明暗主题。公开skill沿用已修复的PWA文档导航；不会仅用HTTP200代替复制交互验收。

## 验收记录

- wire 80测试；Web全量2625测试、build、tsc通过；CLI全量2028测试、tsc/pkgroll通过，review后的参数修复39测试通过；server 632测试通过（原有1跳过）、tsc通过。
- 生成CLI在独立HAPPY_HOME_DIR与本地HTTP fixture验证跨进程重试去重、丢失ACK、旧version拒绝、增改完成恢复删除及墓碑防复活；未访问真实账号任务。
- 真实Chromium验证1200/390（pointer coarse）×明暗主题，实际剪贴板成功及拒绝回退、外部来源不显示按钮；均无横向溢出，按钮44px，文本16px。CSS probe保存修改前后结果。
- 官方skill通过格式校验与公开文档同源测试；独立review发现前导双连字符正文无法传入，已增加等号参数语法及回归。
- 本批无新真机专属待验项。

## 发布验收

- Server/Web：`abb5484f61cd029b9f6c7db2729922a4bef0374e`，部署 run `34319208007` 成功；health正常，check-shipped在真实资源中找到Todo入口与skill命令。
- CLI：不可变tag `v0.2.127` 指向同一SHA，publish `34319673066` 成功；tag push smoke `34319673194` 的Linux/macOS/Windows × Node20/24六项全部success，npm latest/next均为0.2.127。
- 真实登录Chrome普通刷新后entry/CSS由dab8ea0e迁移到abb5484f，点击复制显示成功；完整只读预览4021字符含正确server和全部命令。CUA虚拟剪贴板无法读取页面原生剪贴板，因此线上记录成功状态与预览，实际剪贴板内容以本批本地Chromium端到端测试为证。
- 公开`/skills/very-happy-todos/SKILL.md`通过curl返回与源码逐字一致的Markdown（SHA256 `79c794d06ee9d3a01af1d4450bad5d70057571db2dc37a649d759453d784dd93`），不是SPA页面。浏览器扩展拦截下载导航不作为源站404证据。
- 共享发布浏览器探针确认controllerchange、新controller与新entry；本次生产Todo验收只读，不创建测试任务。
- 双Mac均用实际安装的0.2.127执行`todo list`与`todo skill`：目标veryhappy.dev，当前账号0条记录、无truncated/invalid，输出skill与公开文档一致（忽略console.log额外尾换行）；没有真实待办写入。
- 发布时npm latest/next均为0.2.127；推荐端点source=registry仍有1小时缓存，现场recommended0.2.126，不通过临时pin绕过；独立autoUpdateVersion保持0.2.122。
- 回滚：server/Web回到`dab8ea0e5`的完整镜像（`sha256:10f961a5fe1e28305950a3b4692aa08c657003e4bec601b2e75358e6ecd6a784`）；CLI回0.2.126。无Todo数据迁移。
