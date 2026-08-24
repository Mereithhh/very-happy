# End-to-end encryption for Very Happy Cloud

> 状态：Final design（实现与独立安全 review 进行中；仍未允许对外声称或启用 E2EE）
> 日期：2026-08-25 ｜ 关联 backlog：B-176 ｜ 出处：Owner E2EE 专项

## 背景

Very Happy 已经在客户端以 per-session / per-machine data key 加密多数会话、RPC、附件和
terminal payload，但 Cloud 仍保存可由 `HANDY_MASTER_SECRET` 解开的账号根 secret，密码和
Google 登录还会把 raw secret 返回浏览器；Task Board、Notes 和部分通知/集成数据也仍是明文。
因此当前产品是 server-trusted encrypted relay，不是端到端加密。

本设计把“账号身份认证”和“内容密钥解锁”拆开。Cloud 可以验证用户名密码或 Google identity、
签发 bearer token、做容量/滥用控制和转发数据，但新 E2EE 账号的 root secret 只在已解锁客户端
出现。旧账号保持兼容，只有用户保存恢复密钥并显式迁移后才删除服务端 escrow；绝不自动迁移或
假装历史内容获得追溯保密。

## 安全目标与诚实口径

### 保护目标

- Relay 数据库、备份、日志和正常转发路径不能解密 session/chat、terminal 字节、RPC 参数与结果、
  文件/附件内容、Task Board、Notes 和账号级通知正文。
- Password/Google 仅解锁账号身份和 bearer session，不能恢复内容 root secret。
- 新 E2EE 账号的 plaintext/raw root secret 永不进入 server 请求、数据库或日志。
- E2EE 账号对 terminal、clipboard、file-preview 和新内容写入 fail closed；旧客户端不能静默降级。
- 新设备通过高熵 Recovery Root Key 解开 recovery capsule，或由已解锁 control device批准获得当前
  epoch root。
  第一阶段以 recovery capsule 为必备、可独立验证的恢复路径；设备批准沿用现有 ephemeral X25519
  pairing 并在 v2 补签名、用途和 epoch。Recovery Root Key 与 current epoch root 是两个独立随机值。

### 不隐藏、需披露的 metadata

Relay 仍会看到账号/OAuth identity、IP/client 信息、伪随机 account/session/machine id、ciphertext
长度/数量/时间、presence/activity、RPC method/scope/target、terminal控制帧的时间/大小、push endpoint，
以及用户显式启用的 provider/webhook 数据。Cloud 自身只能可信计量 ciphertext bytes、objects、storage、
connections、frames和 rate；详细 model/token/cost 处于密文内。若 provider execution/billing必须看到
token/cost，该 provider integration 明确离开 E2EE boundary。

### Web 客户端限制

Very Happy Cloud 同时分发 Web JavaScript。E2EE 能保护静态存储、备份和正常 relay 转发，但一个
已主动恶意或被入侵的 Web origin 可以发布窃取密钥的 bundle。除非未来提供独立签名且可验证的
客户端，文案不得声称 Cloud operator 在任何情况下都“不可能”访问内容，也不得使用 blanket
“zero knowledge”。允许的口径是：

> 内容密钥只在已解锁的客户端上；Relay 转发并存储密文。路由和使用 metadata 仍对 Relay 可见，
> Web 客户端的代码交付仍信任当前 origin。

## 非目标

- 不在本批引入自研密码学 primitive、Signal Double Ratchet 或 MLS；Very Happy 的主要数据是
  单账号多设备同步和远程控制，不伪装成匿名即时通信。
- 不用普通登录密码直接包装 root secret。因为 server 会接收该密码，这不构成 server-blind E2EE；
  若未来要求“同一密码在新设备自动解锁”，必须采用经审计的 OPAQUE/PAKE 协议。
- 不自动删除生产 `AccountSecret`、不自动旋转 Owner 数据、不破坏旧 daemon/session/token。
- 不声称隐藏 routing/usage metadata，不声称第三方 provider、voice vendor 或 webhook 收到的数据
  仍处于 Very Happy E2EE 边界内。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Server 可用部署 master secret 恢复 `AccountSecret.secretEnc` | `packages/happy-server/sources/app/auth/accountSecrets.ts`、`sources/modules/encrypt.ts` |
| password/Google login 返回 raw `{token, secret}` | `packages/happy-server/sources/app/api/routes/accountAuthRoutes.ts` |
| Web 把 token 与 raw secret 存在同一 credentials record | `packages/happy-web-v2/src/auth/tokenStorage.ts` |
| account secret 派生 signing/content box key，可解开 session/machine DEK | `packages/happy-web-v2/src/sync/encryption/encryption.ts` |
| session/machine metadata、messages、RPC 和 attachments 已有客户端加密 seam | `packages/happy-web-v2/src/sync/{sync,apiSocket}.ts`、`packages/happy-cli/src/api/{api,encryption}.ts` |
| terminal 可协商 `encStream`，旧路径仍能明文 fallback | `packages/happy-web-v2/src/sync/ops.ts`、`packages/happy-cli/src/api/apiMachine.ts`、server `terminalHandler.ts` |
| Task Board 与 Notes 只是 base64 JSON | `packages/happy-web-v2/src/sync/{boardTasks,notesStore}.ts` |
| generic KV 不自动加密 | `packages/happy-web-v2/src/sync/apiKv.ts` |
| 现有 account pairing 已有 ephemeral box key + claim secret + 显式浏览器批准 | Web `authQRStart.ts`/`authAccountApprove.ts`，server `authRoutes.ts` |
| CLI dataKey credential 只需 account content public key + local machine key | `packages/happy-cli/src/persistence.ts`、`src/ui/auth.ts` |

## 数据模型

### Key hierarchy 与 `vh-e2ee-1` suite

- `RRK`：随机 32 bytes Recovery Root Key，只以用户恢复码存在；正常 control device 完成恢复/注册后
  不持久保存 RRK。
- `I`：独立随机 32 bytes recovery-authority Ed25519 seed（不是从 RRK 派生），放在 RRK 加密的
  recovery capsule 内；普通
  device/runner不持有 `I`。数据库只存 `I.publicKey`。
- `E_n`：每个 epoch 独立随机 32 bytes secret，不从 `I`、RRK或前一 epoch派生。它派生该 epoch的
  X25519 content keypair与 settings/KV/notes/tasks domain keys。
- control device 有独立 X25519 encryption key 与 Ed25519 signing key，只收到获准的历史
  `{epoch,E_n}` keyring envelope；runner/daemon永远不收 `E_n` 或历史 keyring，只收 current
  content public key、自己的 machine key与有限证书。

冻结 suite：HKDF-SHA-256（salt=`SHA-256("very-happy/vh-e2ee-1")`，info 使用下述 ASCII domain label）
做域分离；payload 使用 AES-256-GCM、96-bit CSPRNG nonce、128-bit tag；recovery payload 使用
XSalsa20-Poly1305 secretbox（24-byte nonce）；device envelope 使用 explicit ephemeral X25519
`crypto_box_easy`（ephemeral public key 32 + random nonce 24 + ciphertext/tag），不是 sealed-box wire；
签名使用 Ed25519。所有 bytes用 unpadded base64url。签名/AAD输入
不是任意 JSON，而是 UTF-8 `JCS(RFC 8785 object)`；每个 transcript首字段固定
`domain:"very-happy/vh-e2ee-1/<purpose>"`，并绑定 `origin`、`accountId`、`suite`和 `epoch`。decoder对
未知字段、错误长度、重复 key、non-canonical encoding、oversize envelope全部 fail closed。

### Account crypto mode

```ts
type AccountCryptoMode = 'trusted-v1' | 'e2ee-migrating' | 'e2ee-v1';
```

数据库把 legacy `Account.publicKey` 改为 nullable，并为 `Account` 增加
`cryptoMode String @default("trusted-v1")`、`cryptoEpoch Int @default(0)`、
`cryptoWriteState String @default("active")`、
`recoveryAuthorityPublicKey String? @unique`、`e2eeContentPublicKey String?`、`e2eeContentKeySignature String?`
与 `recoveryCiphertext String?`；`AccountCredential.secretEnc` 改为 nullable（读取事实源统一到
`AccountSecret`）。迁移只加默认值和 nullable，不删除任何现有 secret。现有 `Account.publicKey` 仅是
trusted-v1 legacy anchor。E2EE 的稳定 trust anchor 是 RRK capsule内独立随机 `I` 的 Ed25519 public
key；它独立于 rotating epoch root，不能复用 server 已知 secret 派生的 legacy key。

E2EE device authorization 使用独立持久化模型：

```ts
type CryptoDevice = {
  id: string; accountId: string; type: 'web' | 'daemon' | 'cli';
  encryptionPublicKey: string; signingPublicKey: string;
  status: 'pending' | 'active' | 'revoked'; keyEpoch: number;
};
type ControlDeviceRootEnvelope = {
  accountId: string; deviceId: string; keyEpoch: number; suite: 'vh-e2ee-1';
  ciphertext: string; // authorized historical {epoch,E_n} keyring
  authorizer: { kind: 'recovery' } | { kind: 'device'; deviceId: string };
  signature: string;
};
```

签名 transcript绑定 `authorizer.kind`；device分支用复合 FK 保证 recipient/authorizer 与 `accountId`
同属一个账号，recovery分支以 `I.publicKey` 验证且没有伪造 device id。`AccountLoginSession`
增加 nullable `deviceId/capabilities/e2eeProtocol` 复合约束。DB CHECK保证 mode/epoch/key字段一致，并用
trigger拒绝给 `e2ee-v1` 插入或更新 `AccountSecret`，让遗漏的旧 route也不能重建 escrow。

E2EE bearer/login session 必须绑定 `deviceId` 与 capability（control device、daemon、read-only 等），
socket handshake 必须携带匹配的 `deviceId`/`e2eeProtocol`。`ControlDeviceRootEnvelope` 只允许目标类型
为 Web/control device，绝不能把 epoch root 发给 daemon/CLI runner。runner registration是另一种证书：
只含 current content public key、runner本地产生的 machine key和有限 capability，延续现有 dataKey原则。
`cryptoWriteState` 撤销状态机为 `active → rekey-required → active`：第一事务 revoke device sessions、主动断开 sockets、
把账号置为 `rekey-required` 并拒绝旧 epoch所有新写；用户用 RRK解出 `I`，生成随机 `E_(n+1)`、更新
Recovery Keyring Capsule和其余 control-device envelopes，以 `I` 签名 epoch commit；server在一个事务
校验 commit与 deadline 内在线 active runner的 future-write cutover ack、原子切 current epoch并恢复写入。
离线/超时 runner在同一 account commit中标为 `runnerWriteState=rekey-required` 并从可路由集合移除；
之后只有验证 I-signed epoch commit、完成本地 rekey并补 ack后才能恢复。每个参与的活跃
session/machine必须产生 epoch-scoped新 DEK；runner验证 `I.publicKey` 对 epoch commit的签名后，本地
生成 `machineKey_(n+1)`/活跃 session DEK，包装给新的 content public key并擦除旧 current-write key。
新 messages/attachments/RPC/terminal只准使用新 epoch DEK；历史 ciphertext可保留旧 DEK。离线 runner
在完成 rekey前保持 locked，不能写入或接受控制。没有 recovery authority时账号保持只读/锁定，绝不
静默继续旧 epoch。被撤销设备仍可读它曾拿到的历史内容，撤销不提供追溯抹除。
legacy account token只允许 trusted-v1。

- `trusted-v1`：现有行为，旧 Web/CLI/server 完全兼容；文案显示“Server-managed key”。
- `e2ee-v1`：`AccountSecret` 必须不存在，login response 不得含 secret，server 对内容数据面强制
  encrypted/versioned payload，且禁止回到 trusted-v1。

### Auth response v2

```ts
type AccountAuthV2 = {
  token: string;
  expiresAt?: string;
  accountId: string;
  deviceId?: string;
  capabilities: string[];
  cryptoMode: 'trusted-v1' | 'e2ee-migrating' | 'e2ee-v1';
  cryptoEpoch: number;
  recoveryAuthorityPublicKey?: string; // stable Ed25519 trust anchor from capsule I
  contentPublicKey?: string;         // epoch-scoped X25519 content recipient
  contentKeySignature?: string;      // recovery-authority signature over account/epoch/content key
  recoveryCiphertext?: string;       // RRK-wrapped {I, historical epoch keyring}
  legacySecret?: string;  // ONLY trusted-v1 compatibility/migration
};
```

Routes：

- `POST /v2/account/signup/challenge`：创建短 TTL `E2eeSignupReservation`，返回预留的 `accountId` 与
  一次性 nonce；password 与 Google 路径共用。signup proof 必须绑定
  `{accountId, nonce, provider, normalizedUsernameOrGoogleSubject, suite, epoch, recoveryCiphertextHash,
  recoveryAuthorityPublicKey, contentPublicKey, deviceEncryptionPublicKey, deviceSigningPublicKey}`，防止
  public keys、recovery capsule 或 provider identity 被替换/跨账号重放。reservation consume 原子且一次性。
- `POST /v2/account/signup/password`：client 生成全新的 epoch-1 root、独立 Recovery Root Key 与首个
  control-device keypair。使用 RRK capsule内独立随机 `I` 的 Ed25519 recovery authority，从 epoch root派生 epoch-1
  X25519 content key；只提交两把 public key、recovery authority 对
  canonical `{origin, accountId, signupNonce, provider, normalized identity, suite, epoch,
  recoveryAuthorityPublicKey, contentPublicKey, devicePublicKeys, capability, recoveryCiphertextHash}` 的 proof 与
  `recoveryCiphertext`，以及 recovery authority签名的首设备证书与 root-envelope hash。server consume nonce 后创建
  `e2ee-v1`, epoch 1 与 active首设备，不创建
  `AccountSecret`。
- `POST /v2/account/login`：验证身份后为提交的 device public keys 创建 `pending` device 和只允许读取
  recovery capsule/完成 unlock 的短 TTL token；E2EE 账号绝不返回 secret或直接给 control capability。
- `POST /v2/account/device/activate`：新设备不能用“知道 epoch root”自证。它必须提交以下之一：
  (a) RRK解出的随机 authority seed `I` 对 device challenge/certificate 的签名；或 (b) 已 active control
  device 对新 device certificate 与 `ControlDeviceRootEnvelope` 的签名。server验证签名链后才激活
  device并签发 device-bound control token；失败/过期即删除 pending device/session。
  主动批准必须用 QR/deep-link自带的 target public keys 与 claim secret构造 transcript，不能信任 relay
  查询出的 pending key；否则 active relay可替换 recipient骗取 keyring。
- `POST /v2/account/login/google`：新 signup 必须带 client-generated recovery authority/content/device
  public keys；已有 E2EE 账号只返回
  pending device/unlock session，语义与 password 相同。
- 首版不提供 `/v2/account/e2ee/activate`。旧账号 migration 是独立后续 spec；在全量 rotation、可恢复
  manifest 和所有 daemon epoch升级完成前，server根本不暴露删除 escrow 的 route，避免半实现被误用。

旧 `/v1` routes 继续服务 trusted-v1；遇到 `e2ee-v1` 必须返回稳定 `426 e2ee_client_required`，不能
返回空 secret 或创建新的 escrow。

### 客户端 credentials 与 unlock

Web credentials 改为版本化 union：

```ts
type PersistedAuthSession =
  | { version?: 1; token: string; legacySecret: string; cryptoMode?: 'trusted-v1' }
  | { version: 2; token: string; cryptoMode: 'e2ee-v1'; deviceId: string;
      accountId: string; cryptoEpoch: number; recoveryAuthorityPublicKey: string;
      contentPublicKey: string; contentKeySignature: string };
type RuntimeKeyVault = { deviceId: string; currentEpoch: number; keyringHandle: CryptoKey };
```

E2EE persisted auth绝无 raw root/epoch secret。运行时通过 `RuntimeKeyVault` 句柄访问 keyring；注册时
以独立 32-byte Recovery Root Key 使用 authenticated secretbox 包装
`{origin,accountId,suite,currentEpoch,I,epochs:[{epoch,E_n}]}`，把
recovery capsule交给 server，
只把 Recovery Root Key 格式化后展示给用户。首账号生成后必须先展示并确认已保存恢复码，再进入 app。
新设备 login 后进入本地 unlock step：取回 capsule、输入 Recovery Root Key、本地解密 `I` 与 keyring，
再派生 recovery authority/content public keys、验证 content-key signature并 constant-time 比对 server keys；不匹配
则不保存 credentials、不启动 sync。刷新恢复使用本地 credentials，不重新向 server取 secret。

PWA/browser 存储可能被系统回收，因此 recovery key 不是可跳过的“高级选项”。E2EE 发布门要求 token
与 keyring分存：bearer 保持 session storage contract；keyring用浏览器本地产生的 non-extractable
WebCrypto device key 包装后存 IndexedDB，不能再把 raw key与 token放同一个 localStorage JSON。
它不能防同-origin XSS/恶意 bundle，但能避免普通 localStorage dump 一次拿走长期 root。恢复码采用
带版本和 checksum 的无歧义编码；解析器禁止 0/O、1/I、9/G 等静默纠错。

## 内容数据面

### Account KV

从 current epoch root 用带上下文的 KDF 分别派生 settings/KV/notes/tasks domain key，不复用 legacy master
key。每个 envelope 使用 canonical UTF-8 JSON header 作为 AES-256-GCM AAD：

```ts
type AccountEnvelopeV1 = {
  suite: 'vh-e2ee-1'; epoch: number; domain: 'settings' | 'kv' | 'notes' | 'tasks';
  objectId: string; nonce: string; ciphertext: string;
};
```

通用 stored envelope wire：

```ts
type StoredE2eeEnvelopeV1 = {
  v: 1; suite: 'vh-e2ee-1'; epoch: number;
  domain: 'session'|'machine'|'message'|'settings'|'kv'|'notes'|'tasks'|'artifact'|'attachment';
  objectId: string; field: string; nonce: string; ciphertext: string;
};
```

`nonce` 解码必须 12 bytes；ciphertext至少含16-byte tag；JCS header（除 ciphertext）作为 AAD。每条
record自身携带 epoch，同一 session可读历史不同 epoch；server只解析严格 envelope header做 mode/size/
epoch上限验证，绝不解密 body。

Task Board 与 Notes：trusted-v1 保持 legacy read；E2EE 账号只写/读 envelope。客户端在内存中 merge，
server 只做 CAS。daemon board analyzer 不再依赖 server plaintext：由 Web 通过 encrypted machine RPC
发送所需 task snapshot，或给 daemon 独立可撤销 task-domain key；未实现前 E2EE 账号禁用 analyzer，
而不是回退明文。

### Terminal / RPC / files

E2EE account socket 加入 `requiresE2ee`，以下条件 server fail closed：

- terminal input/output/snapshot/replay 必须 `enc:true`；拒绝 missing/false。
- clipboard/file-preview payload 必须 `enc:true`。
- session/machine RPC params/result 必须是 encrypted envelope。
- message/session/machine writes 必须满足现有 encrypted schema 并携带 crypto version/epoch。
- usage 的详细 model/token/cost 进入客户端加密 envelope；server配额只使用可信的 ciphertext
  bytes/events/storage/objects/connections/rate，并在 decode/store 前执行 envelope 与尺寸上限。
- attachment reservation 的 filename/MIME/path 进入 session envelope；relay 只收大小和不透明 object ref。

E2EE v1 本身（不能延后）把 clear routing header
`{accountId, scope, objectId, method, direction, requestId, terminalId, seq, keyEpoch}` 作为 AES-GCM AAD，
daemon/Web 分别维护 connection-scoped strict counter。terminal resize/close/exit/activity 也必须在认证 envelope
内；outer routing字段只用于投递，接收端必须与解密后的字段逐项比对。否则恶意 relay 可重放命令或
伪造控制帧，这属于远程执行边界 P0，而不是可以靠文案缩小的后续 integrity 改进。

每次 Web↔daemon 连接先完成 authenticated handshake：双方各生成 32-byte fresh nonce；daemon同时提供
每进程随机 `bootId`。双方用 machine key 对完整 JCS handshake transcript做 HMAC-SHA-256并互验。
密钥材料严格使用
`HKDF-SHA256(ikm=machineKey, salt=SHA-256("very-happy/vh-e2ee-1"),
info=JCS({domain:"very-happy/vh-e2ee-1/connection",accountId,machineId,deviceId,clientNonce,daemonNonce,bootId}),
L=104)`，按顺序切出 c2r AES key 32、r2c AES key 32、c2r noncePrefix 4、r2c noncePrefix 4、
connectionId 32。每方向 counter从 0 单调递增，96-bit GCM nonce由该方向4-byte noncePrefix + uint64 counter
唯一构造；AAD绑定 connectionId/direction/method/object/requestId/counter/epoch。receiver为当前
connection维护严格 `expectedNext`；任何 gap、duplicate或 out-of-order frame立即 fail并关闭连接，
绝不重排 terminal/control 字节。断线即丢连接 key；daemon restart更换 bootId；旧
connectionId永不重新接受。所有 RPC和 terminal input/resize/close/output/exit/activity都走该 authenticated
channel；不存在跨 restart 的“重置 counter 继续用同 key”。初始 handshake response绑定发起方 nonce，
relay重放旧 response会验证失败。

```ts
type ControlFrameV1 = {
  v: 1; suite: 'vh-e2ee-1'; connectionId: string; epoch: number;
  direction: 'control-to-runner'|'runner-to-control'; counter: string; // uint64 decimal
  method: string; objectId: string; requestId: string;
  nonce: string; ciphertext: string;
};
```

`method/objectId/requestId` outer值逐字进入 JCS AAD，plaintext内重复同一 header并在 decrypt后 exact
compare；RPC response复用 requestId并把 method固定为 `<request-method>:response`。counter达到 uint64 max
立即关闭并重新 handshake，不允许 wrap。

每个 control device有独立 connection context；daemon按 recipient分别加密同一 PTY output，frame只发到
server从 device-bound auth建立的 opaque `connectionId/deviceId` room，不能把一个 recipient ciphertext
broadcast给整个 user room。每 daemon默认最多64个 control connections，disconnect/timeout立即清 context；
fan-out按 plaintext bytes计一次、ciphertext按 recipient计配额。

接收顺序是安全不变量：先完成 AEAD auth → 比对 outer/inner header → 检查 expectedNext但不提交 →
成功后原子提交 counter/seq → 最后才更新 gap tracker、terminal sync状态或 UI。尤其
`WebTerminalScreen` 不能像现状一样在异步 decrypt/auth 前先调用 `sync.liveChunk(seq)`；未经认证的高
seq不得污染窗口或造成持久 DoS。

HTTP/WS downgrade 表必须覆盖 messages、session/machine metadata/state、account settings、KV、
artifacts、attachments、terminal、RPC、clipboard/file-preview 和 push routes。握手缺少支持的
`e2eeProtocol` 或 active device-bound token 时直接拒绝连接；不是只在 `/v1` login 返回 426。
Server auth middleware产出权威 `{cryptoMode,cryptoEpoch,deviceId,capabilities,e2eeProtocol}` context；writer
在持久化事务/Account row lock内再次验证。对 E2EE 账号，无 DB-backed loginSessionId 的 legacy bearer、
`/v1/account/credentials` escrow回写和 legacy pairing token全部拒绝。

### Notifications、providers 与 webhooks

- E2EE 默认只发送 generic push（“Very Happy has an update”）；正文在客户端解密。
- 需要 server/vendor 明文的 voice HTTP fallback、provider credential vault、rich webhook 均在 UI
  明确标记“Leaves the E2EE boundary”，默认关闭且用户逐项 opt in。
- provider access token 不纳入“content E2EE”声称；server-custodied token 继续以部署 master secret
  加密，并在安全文档中单列。

Attachment upload reservation 只发送 ciphertext size 和不透明 object ref；filename、MIME、dimensions、
thumbhash/path 全部放 encrypted message。terminal file handoff 走带 method/direction/requestId/epoch AAD
且有 replay protection 的 machine RPC，不存在独立明文旁路。

## 现有账号迁移（首版非目标、后续独立 spec 的硬约束）

不提供会让历史数据失去解密来源的 partial/forward migration。现有账号迁移必须先进入
`e2ee-migrating`，以旧 secret 最后一次解密，再生成全新 RRK/recovery authority/epoch/content keys，逐
session/machine/domain 生成新 DEK并重加密 metadata/messages/blobs/KV；所有 record 和 key capsule带
epoch，更新在线 daemon，最后用可恢复 manifest 的计数/hash核对完整性。只有全量 rotation 成功，
才允许 activate 并删除旧 escrow。

迁移必须显式、可中断、可重试。删除 escrow 前要完成 dry-run、恢复密钥确认、在线 daemon兼容检查
和 ciphertext 完整性计数。生产 Owner 账号不自动执行。即使当前存储副本已全部用新 key 重加密，
迁移前 relay 与备份曾拥有旧 key；产品永远不声称旧内容获得追溯保密，只能说明“迁移后的当前副本
与新内容由 E2EE keys 保护”。

Recovery Root Key 稳定跨 account epoch，并作为离线 ultimate authority；正常 control device只持获准
历史 epoch keyring和自己的 device private keys，完成注册/恢复后不持久化 RRK。每次 rotation生成新的
`RecoveryKeyringCapsule{currentEpoch, epochs:[...], ciphertext}` 并签名。capsule plaintext自身绑定
origin/accountId/suite/currentEpoch/keyring。客户端拒绝低于本地已知最高
epoch 的 capsule。全新或清空存储的 recovery client没有外部 freshness anchor，无法区分 relay给出的
旧但签名有效 capsule；v1明确把这列为 availability/consistency限制，不声称 fresh recovery可检测回滚。
未来可把最新 epoch fingerprint写入用户持有的恢复 artifact或透明日志。撤销或遗失设备后的旧 device
envelope不能解开新 epoch；离线设备恢复后必须重新批准。
谁持有 RRK 就拥有恢复权限，这是明确的账号所有权边界；撤销普通 device不承诺撤销一份已泄漏 RRK。

## 兼容矩阵与发布顺序

| Client / account / server | 行为 |
|---|---|
| 旧 Web + trusted-v1 + 新 server | 原路径不变 |
| 新 Web + trusted-v1 + 新 server | v2 login 可拿 `legacySecret`，行为不变并显示迁移状态 |
| 旧 Web/CLI + e2ee-v1 + 新 server | 明确 `426 e2ee_client_required`，不降级、不创建 escrow |
| 新 Web + e2ee-v1 + 旧 server | v2 route 不存在：阻止 signup/迁移，提示 server 升级 |
| 新 Web + 新 e2ee signup + 新 server | client 生成/保存 key，server 仅见 recovery authority/content/device public keys 与 recovery capsule，恢复确认后进入 app |
| dataKey CLI + e2ee-v1 | 正常配对；只得到 account public key + local machine key |
| legacy CLI pairing + e2ee-v1 | server/Web 拒绝，提示升级 CLI |

`E2EE_SIGNUP_ENABLED` 与 `E2EE_SIGNUP_REQUIRED` 是两个独立开关，默认都为 false。前者在完整 wire/
Web/CLI 门禁通过前禁止创建 E2EE 账号；后者只在 E2EE 已开放后禁止新建 trusted-v1，绝不影响现有
trusted-v1 login。

发布顺序：schema migration + server（仅增加 v2，现有账号默认 trusted-v1）→ `vh-update` → Web（新 signup
默认 v2，legacy login兼容）→ CLI patch（强制 encrypted stream/拒绝 legacy E2EE 配对）→ 浏览器与
isolated HOME 验收。只有验证 E2EE 新账号后，才允许开启 `E2EE_SIGNUP_REQUIRED`；Owner 账号迁移
另开 migration spec 与维护窗口。
Server image必须包含本 commit重新生成的 Prisma Client；发布时核对 image/source SHA，不能把新 schema/
TS bind-mount 到旧 runtime。

## 风险与缓解

1. **丢 key 永久丢数据**：注册强制 recovery 确认；新设备 unlock 明确说明；后续设备批准和多份
   recovery capsule。Server/operator不能代为恢复。
2. **旧 client 静默降级**：account cryptoMode 是 server-side 单调状态；E2EE handlers fail closed，
   `/v1` 返回 426。
3. **迁移假安全**：只允许 full rotation 后 activate；即使重加密也永不把旧内容写成追溯 E2EE。
4. **active relay 篡改/replay**：AAD/requestId/seq/epoch、签名 key capsule 与 terminal control envelope
   都是 e2ee-v1 发布门，缺一项都不得对外声称 E2EE。
5. **hosted Web supply-chain**：CSP、依赖锁定、secret scan、可复现构建与签名客户端 roadmap；文档
   永久披露 code-delivery trust boundary。
6. **集成功能破口**：默认 generic push；voice/provider/webhook 逐项 opt-in 并标出边界。

## 测试与验收

- [ ] Server route tests 证明新 signup DB 中不存在 `AccountSecret`/credential `secretEnc`，login response
  不含 secret，v1/E2EE downgrade 返回 426，trusted-v1 完全兼容。
- [ ] 固定 crypto vectors 覆盖 Web↔Node RRK解 capsule、I→authority key、epoch root→content key、account KV envelope、session/machine AES wire、
  wrong key/epoch/tamper fail closed。
- [ ] Board/Notes E2EE roundtrip + legacy read/migrate tests；server 存储 fixture不可出现任务/Note 文本。
- [ ] terminal/clipboard/file-preview E2EE account plaintext downgrade regression tests。
- [ ] 每个 HTTP/WS writer 的 downgrade table、stolen bearer 无法构造有效 RPC、cross-method/object swap、
  duplicate/gap/out-of-order request/terminal counter、旧 epoch均 fail closed；recovery capsule rollback
  只要求已有本地 highestEpoch 的客户端检测，fresh recovery限制按上文披露。
- [ ] recovery capsule epoch rollover、lost/revoked device、同一 session 的新旧 record epoch读取、迁移
  中断恢复以及 device session/socket 立即撤销测试。
- [ ] fresh-nonce handshake、directional key/counter唯一性、disconnect/reconnect与 daemon bootId变更、
  旧 connection replay、counter overflow和 strict expectedNext边界测试。
- [ ] revocation cutover覆盖 active/offline runner、session/machine新 DEK、旧 epoch新写拒绝、key擦除；
  per-device terminal fan-out、opaque room routing、connection上限与断线清理测试。
- [ ] 真实浏览器：E2EE password signup → recovery confirm → refresh；logout → login → wrong recovery失败 →
  correct recovery成功；Google 首次/再次登录按同样 unlock 语义。
- [ ] isolated HOME：最新 CLI pairing、daemon start、terminal create/restore，抓取 relay payload确认无内容明文。
- [ ] Web/server/CLI/wire 全门禁、clean checkout build、生产 trusted-v1 smoke 全绿。
- [ ] 独立密码学/relay threat review 与首次用户 recovery UX review 的确认问题全部修复。
- [ ] README/landing/security docs 仅在上述门禁、生产部署和新账号验证后更新；明确 metadata、Web origin
  与第三方集成限制。

## 实现冻结门

本 spec 首版实现范围仅含新 E2EE 账号、客户端 signup/unlock/device、完整内容闭合与 authenticated
control protocol；不含旧账号 activation。任何删除现有 escrow、生产账号迁移或对外 E2EE 宣称仍需
单独满足测试清单，不得因代码“看起来已加密”提前执行。
