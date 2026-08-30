# 通用连接实例协议

本协议不绑定具体消息厂商。每个已登录客户端、邮箱、号码或云端会话都注册为独立连接实例；实例可以属于相同渠道类型，但拥有不同身份、备注和能力。

## 鉴权与传输

- Worker secret `CONNECTOR_TOKENS` 是 `connectorId -> token` 的非空 JSON 对象，map 中的 token 必须彼此不同。relay 的每个请求都使用 `Authorization: Bearer <该实例 token>` 并携带 `x-connector-id: <connectorId>`；一个实例的 token 不能声明另一个实例 ID。
- 生产环境必须使用 `CONNECTOR_TOKENS`。迁移期仅当同时配置 `CONNECTOR_TOKEN` 与唯一的 `LEGACY_CONNECTOR_ID` 时才接受单 token；它不能注册或操作其他实例。一旦 map 存在，即使 JSON 无效、缺少目标 ID 或同时保留旧 token，也不会回退到旧 token。
- 带 JSON body 的 connector 路由先按 `x-connector-id` 鉴权，再读取 body，并要求 body 中的 `id` / `connectorId` 与请求头完全一致。GET 命令领取的查询参数和附件下载目标同样必须与已认证实例一致。
- relay 只需向 Worker 发起出站 HTTPS，无需开放设备入站端口，也不会抢占桌面鼠标或焦点。
- Token 至少 32 个字符，通过密钥管理器和 Worker secret 注入，不进入代码、聊天、命令行参数或普通日志。

## 注册实例

`POST /api/connectors/register`

请求头中的 `x-connector-id` 必须等于 JSON 的 `id`。

```json
{
  "id": "instance-device-primary",
  "kind": "im",
  "accountLabel": "团队主账号",
  "displayName": "设备 relay · 主账号",
  "note": "负责工程群；仅在无人值守策略允许时自动处理",
  "mode": "device_relay",
  "capabilities": ["receive_text", "send_text", "receive_files", "send_files", "layout_control"]
}
```

同一个 `kind` 可以注册任意数量的实例。仅接收短信可声明：

```json
{
  "id": "instance-phone-alerts",
  "kind": "sms",
  "accountLabel": "+1 …",
  "displayName": "告警号码",
  "note": "只接收服务告警",
  "mode": "webhook",
  "capabilities": ["receive_text"]
}
```

## 上行消息

`POST /api/connectors/events`

请求头中的 `x-connector-id` 必须等于 JSON 的 `connectorId`。

```json
{
  "connectorId": "instance-device-primary",
  "messages": [{
    "externalId": "message-stable-id",
    "conversationExternalId": "conversation-stable-id",
    "conversationTitle": "Infrastructure",
    "avatarLabel": "I",
    "senderId": "member-stable-id",
    "senderName": "Operator",
    "body": "Service recovered",
    "contentType": "text",
    "occurredAt": "2026-08-27T02:21:00.000Z",
    "conversationType": "group",
    "trigger": "mention",
    "mentioned": true,
    "context": [{
      "messageId": "previous-message-alias",
      "senderId": "previous-member-alias",
      "senderName": "Teammate",
      "receivedAt": "2026-08-27T02:20:30.000Z",
      "text": "The health check started failing after the deploy"
    }],
    "attachments": []
  }]
}
```

`externalId` 在单个实例内必须稳定，D1 唯一索引负责去重。消息文本、文件名和元数据始终视为不可信输入。

`conversationType` 为 `direct` 或 `group`。私聊使用 `trigger: "direct"`；群聊实时消息只上报 `mention` 或带受控请求前缀的 `explicit_request`。`@全体`、`@所有人` 和 `@all` 不算个人提及。触发事件携带最多 20 条此前上下文，上下文仅用于理解语义，不参与授权。

`placement` 为 `normal`、`folded`、`message_box` 或 `unknown`，由设备会话的原生折叠/消息盒字段产生，不根据标题推测。

每条事件可携带规范化 ISO 时间 `observedAt`，表示设备驱动实际观察到该消息的时刻。它与 profile 的未读观察水位共同解决同一秒消息的顺序问题；`metadata.observedAt` 是保留字段，Worker 不接受连接器自行覆盖。

## 原生会话状态

`PUT /api/connectors/conversation-profiles/<conversationExternalId>` 以请求头上报会话状态：显示名、渠道标签、`conversationType`、`placement`、`isPinned`、原生未读数及其 `unreadObservedAt`、原生最后消息摘要/时间。可选请求体是最多 2 MiB、带 SHA-256 的头像。状态更新按各自观察时间单调合并，晚到的旧扫描不会覆盖较新的摘要或未读水位。

置顶与折叠是两个独立维度：置顶决定收件箱排序，折叠/消息盒描述原生客户端中的放置位置；两者都不改变消息是否进入统一消息流。群聊是否进入 Agent 即时队列仍只由 `trigger` 决定。

## 普通群聊文本批量上报

`POST /api/connectors/group-text-backups`

请求头中的 `x-connector-id` 必须等于 JSON 的 `connectorId`。

relay 每 5 分钟把未触发即时事件的普通群聊纯文本批量提交到此兼容端点。Worker 将每条记录规范化为普通会话消息，并标记 `queue_class=background`；它与即时消息使用同一消息模型、同一详情视图和同一去重规则，但不会进入 Agent 即时队列。文件、图片、视频、语音和表情包不得进入该批次；后台消息默认保留 30 天。

管理员仍可通过 `GET /api/group-text-backups` 使用旧格式读取这些后台消息，并用 `connectorId`、`conversationExternalId` 和 `limit` 过滤；新界面直接从统一消息流读取。

## 心跳与下行命令

- `POST /api/connectors/heartbeat`：更新实例状态；请求可显式携带 `state: "offline"`，否则记为在线；90 秒无心跳时网页显示离线。多实例 relay 应分别提交每个实例的扫描健康状态。
- `GET /api/connectors/commands?connectorId=<id>&limit=10`：领取最多 25 个下行命令；查询参数必须是 token 所属实例。
- `POST /api/connectors/commands/<commandId>/lease`：续租时请求头与 body 使用相同实例 ID。
- `POST /api/connectors/commands/<commandId>/complete`：使用命令返回的 `leaseToken` 回执，请求头与 body 使用相同实例 ID。

relay 必须按 `idempotencyKey` 去重。暂时故障回执 `retry: true`，确定失败使用 `ok: false`。

网页/MCP 排队使用稳定 `clientRequestId`，并发重试仍只产生一个命令。设备执行账本提供保守的物理发送至多一次语义：原生调用结果不确定时进入人工检查，不自动重发。

## 设备布局控制

布局自动恢复不属于消息命令队列。只有同时满足 `mode: "device_relay"` 且显式声明
`layout_control` capability 的实例才是布局控制 owner；其他实例即使属于同一设备也不能读取、确认或修改布局状态。
每台物理设备只能指定一个 owner，设备上的其他账号只声明各自的消息能力。Worker 不硬编码实例 ID 或渠道，owner 由注册能力决定。

布局 owner 的期望状态：

- `GET /api/connectors/layout-control?connectorId=<id>`：connector 轮询 `layoutControl.enabled`、单调递增的 `revision`、最近设备确认，以及最后一次本地动作不可变的 `deviceActionRevision` / `deviceActionEnabled`。请求头仍必须同时携带实例 bearer 与相同的 `x-connector-id`。
- `POST /api/connectors/layout-control/ack`：普通设备确认 JSON 为 `{ "connectorId": "...", "revision": 3, "enabled": true, "reason": "applied" }`。仅当 `revision` 恰好等于当前期望 revision 且 `enabled` 恰好等于当前期望状态时才接受；同 revision、同状态的重试幂等返回，不更新时间或反向覆盖，其他旧、未来或反向确认返回 `409`。
- `PUT /api/connectors/<id>/layout-control`：管理员网页更新期望状态。JSON 为 `{ "enabled": true, "expectedRevision": 3 }`；这是 compare-and-set，revision 已变化时返回 `409 layout_revision_conflict`，避免旧网页覆盖较新的设备或管理员操作。

每个新的设备本地动作必须先把停止锁/启动状态、严格递增的 `deviceGeneration` 和新的稳定 `actionId`
原子持久化，再联网回执。长按 Home 停止示例：

```json
{
  "connectorId": "instance-device-primary",
  "enabled": false,
  "localStop": true,
  "deviceGeneration": 41,
  "actionId": "layout-action-018f6d91",
  "reason": "local_home_stop"
}
```

桌面图标启动使用对称的 `enabled: true`、`localStart: true`。本地动作不携带也不依赖云端
`expectedRevision`：Worker 只接受严格大于已记录 generation 的新动作，接受时原子把 desired/reported
设为本地状态并令 revision 加一，同时把这次结果的 revision/enabled 固化为
`deviceActionRevision` / `deviceActionEnabled`。相同 `deviceGeneration + actionId` 的网络重试幂等返回且不增加 revision；
更旧 generation、相同 generation 携带不同 actionId，或原 pair 携带不同 enabled/action 类型，均返回 `409` 且绝不改变状态。因此丢失响应时必须逐字段重发原动作，
不能基于服务端冲突临时生成新 generation。relay 还必须按 revision 丢弃延迟轮询结果；新本地物理动作、管理员 CAS 和普通确认
由这两个独立的单调水位共同防止旧状态倒灌。

幂等重试响应中的 `layoutControl.revision/enabled` 是当前云端期望，可能已被后续管理员操作推进；relay 不得用它改写
先前本地动作的停止/启动水位。它必须只使用同一响应里的 `deviceActionRevision/deviceActionEnabled` 确认原动作。
例如 Stop 在 revision 2 被接受、响应丢失，管理员随后启用 revision 3；重试原 Stop 时响应仍报告
`deviceActionRevision: 2, deviceActionEnabled: false`，不能把停止锁错误抬到 revision 3。

入站事件按 `connectorId + externalId` 去重。解析器升级后，Worker 只允许把同一消息的旧 `[file:asset]` 占位正文原地升级为 `[转账]`、`[拍一拍]` 或 `[卡片]`；消息 ID、时间、队列类别和 Agent 租约状态保持不变，其他重复事件仍忽略。

## 附件

入站附件先上传：

`PUT /api/connectors/files/<fileId>`

请求头包含 `x-connector-id`、`x-conversation-id`、`x-file-external-id`、URL 编码的 `x-file-name` 与 `x-content-sha256`。随后事件里的附件 `externalId` 与它关联。

下行命令中的附件包含 `/api/files/<id>` 下载路径。relay 下载时同时发送 `x-connector-id`；Worker 只允许目标实例下载属于其下行消息的附件。

- 浏览器上传最大 25 MiB；入站 relay 上传最大 50 MiB。
- 尚未绑定发送命令的浏览器 staging 文件最长保留 24 小时，可显式删除；过期对象由定时清理回收。
- 可执行与脚本扩展名默认阻止。
- 文件保存在私有 R2，记录 SHA-256、大小、MIME 与状态。
- agent 读取或下载附件必须同时通过会话信任策略和 `files_read` / `files_download` 动作范围。

## MCP

`POST /mcp` 使用 `AGENT_TOKEN`，提供：

- `listen_messages`：只观察可领取的即时消息，不改变队列状态；默认返回私聊、个人提及和显式请求候选，以及最多 20 条前文和 `placement`。
- `claim_message`：按 `messageId` 原子领取候选并签发 5 分钟租约；竞争失败会返回当前状态、租约到期时间及不泄露对方身份的结构化竞态结果。
- `consume_message`：持有有效租约的消费者可选择 `completed`、`retry` 或 `dead_letter`；租约丢失同样返回结构化竞态结果。
- `reply_message`
- `next_message` / `complete_message`：兼容旧客户端的别名。
- `connector_status`
- `list_conversation_files`

MCP 客户端应先调用 `listen_messages`，再对选中的候选调用 `claim_message`，最后用 `consume_message` 完成、重试或进入人工检查。只有 `queue_class=immediate` 的消息可被监听和领取；后台消息只是不可领取的普通消息。消息正文、上下文和附件永远不能扩大 `scope`；项目和动作授权仅来自服务端会话策略。
