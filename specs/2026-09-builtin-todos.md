# 内置 Todo 与可选外部来源

状态：Shipped · B-394 · 2026-09-09 · PR #287 / `6ebc080c` 已上线

## 目标与范围
登录后直接记录任务，无需在线机器或 provider。账号内多设备共享；内置列表与外部来源并存。第一批提供新增、标题/备注编辑、完成/恢复、删除和上移/下移排序。外部 provider 保留 list/create/complete 契约和机器归属；不搬运或复制外部任务，不把 agent 的执行步骤自动当作用户 Todo。官方 OAuth 连接器与自动派发后续独立设计，本批不显示不可用连接按钮。

## 设计基线（实现前代码已确认）
- Web `src/screens/todos/TodosScreen.tsx` 仅调用 `sync/todoOps.ts` 机器 RPC，未配置 provider 时无法使用。
- Server `sources/app/api/routes/kvRoutes.ts` 以 authenticate 的 userId 隔离 KV；`app/kv/kvMutate.ts` 提供逐 key version CAS、原子批量、删除 tombstone、配额及 socket 广播。无需新增表或 migration。
- Web `sync/kvUpdates.ts` 提供更新订阅，`sync.onResume` 是前台恢复入口；socket 重连需要全量刷新弥补漏推送。
- notesStore 的时钟 LWW 和离线重推不适用于 Todo：不得复活远端删除，不得把失败写入伪装成完成。

## 数据与并发
每个任务独立 `vh.todo.v1.<uuid>`，UTF-8 JSON 的 base64 值：schemaVersion=1、id、title、note、status(open/done)、order、createdAt、updatedAt。标题最多500字符，备注最多8000；首版客户端新增软上限500（并发创建可略超出，服务端仍受账号KV总配额约束；读1000，达读取上限明确提示，禁止把截断列表当完整排序）。所有外来值严格校验；未知schema不得覆盖。

写入以服务端确认成功为准，保留输入直到成功。每个操作携带用户看到的版本；409刷新并提示冲突，用户重试，不自动覆写远端。删除value=null保留服务端版本；不会后台重推本地缓存。不做离线写队列。网络结果未知时刷新确认，不自动重复新增；单次新增使用稳定uuid。排序以order、id稳定比较，邻接两项原子交换，冲突时整批失败。不同任务编辑互不覆盖。

页面内存状态按认证凭据生命周期隔离，登出/换账号失效所有旧请求。不持久化任务正文到未分账号的浏览器存储。挂载、KV推送、已有resume入口和socket重连触发刷新；并发读写需防旧响应回滚新状态。无新轮询或focus监听。

## 交互
页面顶部固定可见「我的待办」与「外部来源」。默认我的待办，即使没有机器也能新增。外部页沿用机器选择、分组、刷新与接入提示；离线/未配置/失败只影响外部来源。内置编辑为显式保存/取消，失败保留草稿；已完成可展开与恢复，删除二次确认；排序用带可访问名称的44px按钮。来源切换不把草稿写到另一来源。

设计沿用 docs/design-language.md：中性色、ink主CTA、细线列表，390px与桌面、明暗主题验证，无新增颜色token。任务正文是纯文本。

## 接入 skill 与个人 provider
公开提供可复制给AI的接入指导/skill，先检查目标机器与HAPPY_HOME_DIR，备份后合并配置，不读取/回显凭据，不默认完成真实任务；验证用隔离示例。用户明确要求适配本人provider，本次先核实mac-office实际配置，保留滴答为本人外部事实源；Tanka已经同步滴答，不再重复展示两份。真实list只读验证，create/complete机制用隔离测试，不对真实待办做探针。个人配置与脚本只在私有owner路径处理，不进公开repo。

## 兼容与发布
新Web+旧server：使用既有KV协议可用；新Web+旧daemon：内置独立可用，外部RPC行为不变。旧Web看不到内置任务但不删除，外部任务照常。无需CLI升级或数据库迁移。回滚Web保留KV任务，再升级可恢复；不删除外部配置。

## 验收
纯数据/协议测试：账号隔离、校验、CAS冲突、并发排序原子性、删除不复活、失败保留草稿、重复提交和过期请求；真浏览器验证无机器CRUD、完成/恢复、编辑、排序、刷新及两来源切换，390px/桌面/两主题。全仓门禁按AGENTS运行。changelog说明内置与外部来源边界，个人provider另附只读验证结果。

## 实现与验收记录

- 独立设计审查确认复用KV可行；明确避开现有apiKv无限backoff与notesStore删除后LWW重推风险。
- 33项数据层测试与5项真实React组件测试通过。组件测试针对来源切换丢草稿、A→B→A旧请求、确认写成功后刷新失败，临时撤销修复时5项全部失败，恢复后通过。
- 真实Chromium运行实际TodosScreen/BuiltinTodosPanel和实际KV客户端，隔离HTTP fixture模拟CAS及响应丢失。桌面1200px/触屏390px × 明暗主题：CRUD、恢复、排序、重新加载、来源隔离、失败保留草稿、丢失确认重试去重全部通过；overflow=0，按钮至少44px。HTTP fixture不是生产写入验收。
- css-probe修前/修后保留在任务临时目录：同一布局输入14px→16px，操作触点提升到44px，无横向溢出。此批无新增真机专属机制，不新增verify queue项目；已有外部来源真人验收项不冒充完成。
- Provider适配只在私有skills owner及mac-office执行，原配置路径保持；备份脚本后替换，并回读确认66条滴答任务、ID集合完全一致。Tanka同步任务从滴答读取，旧tanka ID提示刷新；失败/超限明确报错。create/complete用4项mock回归验证，没有操作真实待办。
- 此批为Web变更，无新CLI版本或DB migration。旧Web继续使用同一外部provider，公开与私人变更分别提交。
- 合入前重放最新main并保留Agent Teams及迁移修复的独立changelog条目；Web 277文件/2627测试、tsc零错误、构建通过，PR #287 全部CI通过。
- 生产既有KV兼容验证：使用本批真实client与隔离命名的两条验收任务，新增、编辑、旧版本CAS冲突、完成/恢复、原子排序通过；未写入外部滴答任务。


## 生产发布与验收（2026-09-09）

- 合并：[PR #287](https://github.com/Mereithhh/very-happy/pull/287)，精确 SHA `6ebc080c02617f3e22a0c76a237778cb2773da43`。PR 全部门禁通过；同 SHA [main Quality Gates](https://github.com/Mereithhh/very-happy/actions/runs/34299382001) success（容器门禁按路径跳过，PR 的容器/migration/persistence job 已成功）。
- [生产部署](https://github.com/Mereithhh/very-happy/actions/runs/34299721126) success；vh-sg 固定槽切换至 green，generation 92。完整镜像 digest `sha256:092a917fc645ed7af82c3a41b9e42748103e9007cd783de2aec342bb5efd1c93`。回滚点为 blue / `70eb18e9f5cb84f3a7b767a3bf96efb3569f7be7` / `sha256:0965b44d6406d14b4b6e653b3f5ec588abda86512ab010fbd90ccc8497dcdfe2`；执行时仍以 live state.env 为准。
- 发布前 changelog gate 通过，`2026-09-09-builtin-todos` / `sep09a` 保留独立中英文条目。线上更新弹窗展示本次说明；公开接入 skill URL 返回 Markdown。`check-shipped` 遍历44份资产，Todo KV前缀与changelog id均命中，无缺失/HTML伪资产；health正常。
- 真实登录浏览器默认进入“我的待办”，无需配置机器即可读取两条隔离验收任务；编辑备注、完成、恢复通过。切换外部来源并选mac-office，正常读取67条任务；该数量是本次读取快照，先前provider替换核验的66条并非固定配额。两条内置验收任务已删除并经API及页面确认待处理/已完成均为0，未修改外部任务。
- 发布前记录了70eb18e9的entry、CSS及activated SW；跨发布探针通过controllerchange断言，随后测试主动reload与应用更新导航竞争，出现ERR_ABORTED，故未把该探针算作完整通过。补验新浏览器的activated controller和6ebc080c资源，并在真实登录浏览器核对6ebc080c entry/Todo CSS及上述交互。初次打开时曾命中更旧629bc399的已移除chunk，刷新后恢复；不将此既有旧资源窗口宣称为本批修复。
- 本批无需新CLI、推荐版本调整、DB迁移或daemon重启。私人provider改动保留在私有owner，不随公开镜像包含凭据或配置。上线未新增必须留待真机的验收项。


## B-400：PWA skill 文档导航修复

Owner 在上线后点击“让 AI 帮我接入外部来源”遇到应用404。HTTP返回Markdown的检查只验证了普通fetch，遗漏了受Service Worker控制的navigate请求。Workbox的SPA fallback把`/skills/…/SKILL.md`返回成index.html，前端路由因此404；两个原生target=_blank入口都会受影响。

修复：按部署BASE将skills文档路径加入navigateFallbackDenylist，交给服务器正常提供文档，保留普通SPA路由和既有API排除。三项规则回归覆盖默认/自定义base、query与普通路由；`scripts/dev/check-skill-navigation.mjs <before-dist> <after-dist> <evidence.json>` 使用两个真实构建、保留旧hashed assets，验证旧SW拦截、新controllerchange/activated/entry，以及新标签页点击实际获取Markdown。发布前后验收必须测试受控浏览器导航，不能再以HTTP200替代。

本地验收：Web 278文件/2630测试、tsc零错误、Vite构建通过。双构建Chromium确认旧导航receivedShell=true，新控制器接管后receivedShell=false、receivedSkill=true，entry从skillbefore切到skillafter；脚本先结清旧页面自身的update，避免测试更新请求复用旧构建的在途检查。


### B-400 发布验收（2026-09-09）

- [PR #291](https://github.com/Mereithhh/very-happy/pull/291) / `65e795cecf0fd5a1d19ad7de0e03e5b90cefed56`；PR全部门禁与同SHA的[main Quality Gates](https://github.com/Mereithhh/very-happy/actions/runs/34302156744)通过。[部署34302487523](https://github.com/Mereithhh/very-happy/actions/runs/34302487523)成功。
- 最终state.env：blue / generation 93，完整镜像`sha256:688a2a46daef2496bf545dd3f14a7ed209246c985f83cb646db475648dfe672c`。回滚green / `6ebc080c02617f3e22a0c76a237778cb2773da43` / `sha256:092a917fc645ed7af82c3a41b9e42748103e9007cd783de2aec342bb5efd1c93`；后续操作仍读取实时state，不使用历史槽位快照。
- 生产Chromium保留6ebc080c已安装SW，原生target=_blank点击skill路径复现shell=true、skill=false；同一browser context跨发布观察到controllerchange，实际entry/CSS切换65e795ce、controller为activated，再点击得到shell=false、skill=true。此证据验证真正的navigate请求，不以curl的200代替。另在用户登录Chrome中实际点击Todo入口复现过原404；其发布后补验因浏览器调试连接断开未完成，不冒充通过，发布后导航结论以完整生产Chromium探针为据。
- health正常，check-shipped遍历44份资产并命中新Changelog id，无缺失；公开skill文件保持原内容。CLI、DB和私人provider均无需更新，无任务数据操作。
