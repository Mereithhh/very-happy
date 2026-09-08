# 消息操作与编辑重跑

状态：Final · 2026-09-09 · B-389

## 目标与边界

消息下方提供稳定的操作行：用户/助手正文复制、引用到输入框，用户消息提供编辑重跑。移动端常显且命中区不小于 44px，键盘焦点可见。沿用 docs/design-language.md 的中性色和字体，操作不覆盖正文。

编辑重跑创建独立会话分支，只保留目标用户消息之前的历史，再发送编辑后的消息；原会话保留且新分支可返回原会话。文件和命令的既成副作用不回滚，提交前明确告知。首条消息使用全新上下文。运行中的源会话先要求用户停止，避免两个分支同时修改工作目录。

## 现状事实（代码已确认）

- `screens/session/MessageView.tsx` 当前只提供 hover copy overlay；用户正文有 attachment manifest。
- `utils/sessionFork.ts` 提供 Claude/Codex 源信息；pi 不能借用遗留 claudeSessionId。
- `sync/ops.ts` 的 forkAndSpawn 可创建带 parentSessionId/forkedFromMessageId 的分支。
- CLI `api/apiMachine.ts` 已有 duplicate RPC，但 Claude cutAfter 与 Codex rollback+inject 都保留旧提问，不满足替换语义。
- `sync/typesMessage.ts` 的 claudeUuid/codexItemId 是可选字段；缺失时不能凭文本猜测回退位置。Web 原消息被 CLI 文本去重丢弃磁盘 echo，SDK 转换器还有合成 UUID，所以现有 ID 必须先在磁盘点位列表验证；无匹配时让用户手选点位。
- `AgentInput.tsx` 本地维护输入文本，修改 storage draft 本身不会同步已挂载输入框；引用需要明确的 session-scoped 事件。

## 协议与流程

新增 machine RPC `claude-rewind-before-message` {directory, claudeSessionId, cutBeforeUuid} 与 `codex-rewind-before-message` {directory, codexThreadId, cutBeforeItemId}。成功返回新底层 id，首条返回 {type:success,startFresh:true}；精确点缺失/不安全截断失败。不修改原 duplicate 协议。

Web 在 RPC resolve 后先检查 error 与 type，再读新 id；失败不 spawn。随后沿用 machineSpawnNewSession 持锁入口与 lineage，按 runner 保留明确权限；Codex read-only/safe-yolo 不经过 Claude 清洗，未知 Codex 模式保守 read-only。刷新 session 后发送编辑文本。提交期间禁止双击/关闭，发送失败保留新分支与编辑文本，重试不得再 fork。请求结果未知不自动重放创建操作。

引用追加当前输入草稿，不发送，不覆盖现有草稿。含附件消息的编辑第一版禁用并说明，避免将附件静默丢失。缺精确底层 id 时列出机器实际点位，用户明确选择后编辑；只按 ID 匹配，不按文本自动映射。若选了另一点位，不写错误的 forkedFromMessageId。镜像与不支持 runner 明确说明限制。正文操作不显示在系统通知上。

## 兼容矩阵与发布顺序

| Web | daemon | 行为 |
|---|---|---|
| 旧 | 新 | 旧功能不变 |
| 新 | 旧 | 新 RPC method not found，提示更新，不退回 cutAfter |
| 新 | 新 | 精确 before 分叉后发送编辑内容 |

可先 server/Web 后 CLI；CLI升级之前编辑入口遇旧 daemon 明确失败，无 server schema 变化。生产发布须另按授权和 release 门禁。

## 验收

精确截断与原数据不变的 CLI 机制回归；Web 覆盖 unsupported/ID缺失/附件/运行中/响应error/首条/发送失败/双击；真实 Chromium 390px粗指针与桌面、明暗主题，验证操作行不盖正文，引用保留草稿、编辑取消不写、分支返回入口。跑全包门禁和 review。

## 本地验证（未发布）

- CLI 211 文件 / 1953 测试通过（包括真实工具解包/PTY装配后重跑），生成产物可执行。
- Web 真实 Chromium 1200px 与 390px coarse × 明暗：引用保留草稿、编辑弹层、失败后关闭重开恢复、单次创建检查通过；手机操作命中区44px，页面无横向溢出。
- draft/store 回归覆盖延迟 session hydration 与 Codex 父只读/全局 yolo 时首条出站仍只读。
- 尚未将新版 CLI 部署到生产；浏览器创建/发送失败验证采用隔离 RPC stub，底层截断通过文件/协议机制测试，不能代替发布后真实 runner 的模型续接验收。
