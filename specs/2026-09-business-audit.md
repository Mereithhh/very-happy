# 业务审计 V1

状态：Final。关联：B-409。

## 已核实现状

`api/sessionMessageStore.ts` 是 HTTP/Socket.IO 消息持久化共同入口，保存加密载荷；`state/accountStateStore.ts` 创建会话，`session/sessionDelete.ts` 删除会话及消息。`accountAuthRoutes.ts` 负责密码、邮件、Google 登录；登录凭证表不是完整访问历史，也没有登录 IP。`terminalHandler.ts` 的终端输入仅转发，因此现有消息不能证明用户每条终端命令都有记录。

## 数据流与失败语义

控制端在业务事务提交后，将登录成功/失败、会话创建/删除、新增消息放入有界内存队列。不得在事务重试体里外发；消息重放不重复采集。单 worker 异步批量投递，超时和有限重试后累计缺口；审计不可用、队列满或载荷超限均不阻塞业务。进程退出可能丢失内存队列，V1 不承诺无损或防篡改。

独立 collector 使用 SQLite WAL、FULL 同步，事务落盘后 ACK；按事件 ID 和 sourceId/seq 幂等。独立只读数据库身份仅取账户密钥，单连接、短超时。消息事件携带已提交的加密正文及包装数据密钥、会话元数据快照，避免会话随后删除导致无法解析。原始事件与摘要保存在独立卷，业务删除不级联。默认 30 天、10 万行、256 MiB 数据库上限；达到容量时显式报告失败与投递缺口，不挤占业务 DB。管理员查询有独立凭据并记录访问。

事件协议：`{v:1,id,sourceId,seq,at,kind,accountId?,sessionId?,messageId?,messageSeq?,ip?,ipSource?,userAgent?,method?,route?,payload?}`；时间为 ISO UTC。消息 payload 为 `{content,dataEncryptionKey,metadata}`，密钥包装为 base64 或 null。POST /ingest 使用独立 bearer，body `{sourceId,status,events}`；GET /events 使用只读 bearer。保留默认可读用户指令、工具调用和有界结果摘要；常见凭据脱敏，截断有标记。普通 assistant/thinking 不进入可读审计。结果缺失不得推断成功，未知协议显式显示覆盖缺口。

IP 仅根据经过核验的反向代理链恢复；不信任任意客户端传入的 CF-Connecting-IP。Cloudflare Access 身份验证与业务登录事件分开，Access 本身不会自动填充业务 DB。首次部署之后才开始采集，不将当前数据伪装成完整历史，也不采集终端逐键输入。

## 兼容、发布和恢复

不改变客户端 wire 协议，不修改业务数据库结构。旧 CLI/Web 无需升级。先发布 collector/admin，再通过完整不可变 Server/Web 镜像启用 producer。环境变量缺失则默认关闭。回滚控制端镜像或关闭配置后正常业务继续；审计卷保留，admin/collector 可单独回滚。

## 验收

测试事务回滚/重试、消息重放、collector 故障/慢响应/满队列、可信代理与伪造 IP、幂等、磁盘满、会话删除后独立记录、四类消息协议、未知结果与脱敏。全仓门禁及 admin 测试/build/typecheck；真实浏览器验证筛选、翻页、状态和窄屏。上线核对精确 SHA、健康、实际事件进入与来源，不以健康接口代替业务验证。
