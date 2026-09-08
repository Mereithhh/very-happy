# 内置 Todo 与可选外部来源

状态：Final · B-394 · 2026-09-09 · 已实现并验证，待合并发布

## 目标与范围
登录后直接记录任务，无需在线机器或 provider。账号内多设备共享；内置列表与外部来源并存。第一批提供新增、标题/备注编辑、完成/恢复、删除和上移/下移排序。外部 provider 保留 list/create/complete 契约和机器归属；不搬运或复制外部任务，不把 agent 的执行步骤自动当作用户 Todo。官方 OAuth 连接器与自动派发后续独立设计，本批不显示不可用连接按钮。

## 现状事实（代码已确认）
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
- 此批为Web变更，无新CLI版本或DB migration。旧Web继续使用同一外部provider。公开与私人变更分别提交；合并后再更新Shipped状态，未发布前不得宣称内置Todo已上线。
