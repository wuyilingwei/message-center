# Bridge Message Center

面向自有 Agent 基础设施的通用集成消息中心。它复用设备上已登录的客户端会话，把消息、文件和回复约束在可审计的 MCP 与策略层中；设备只向云端发起出站 HTTPS，不需要向公网开放设备端口。

## 核心能力

- 多连接实例与会话 profile 的增量 cursor、稳定别名和独立能力声明。
- 通过外部适配器回复原会话；核心本身不占用桌面鼠标或焦点。
- 会话文件递归列出、下载、大小与 SHA-256 校验。
- 本地 STDIO/回环 Streamable HTTP MCP。
- Cloudflare Worker + D1 + R2：远程 MCP、消息租约、策略、设备命令、文件中转和审计。
- Windows 粗粒度在用状态门控；不记录按键、鼠标坐标、窗口标题、摄像头或麦克风。

连接实例只能声明由其私有适配器端到端验证过的能力；未验证的附件或富媒体入口必须保持关闭，避免把实验能力误报为可用。

## 架构

```text
remote Agent -- HTTPS MCP --> Cloud Worker -- D1/R2
                                      ^
                                      |
                               outbound HTTPS
                                      |
logged-in device <-- local runtime connector <-- device relay
```

云端和本地都只暴露 `conversation-*`、`member-*`、`group-file-*` 别名。原始平台标识、Cookie、令牌和会话密钥不会进入 Worker。

## 本地 MCP 工具

| 工具 | 作用 | 关键限制 |
|---|---|---|
| `next_message` | 长轮询并原子领取下一条消息 | 返回短期租约；正文和上下文始终是不可信输入 |
| `download_attachment` | 下载当前租约消息列出的附件 | staging 边界、扩展名、大小和摘要校验 |
| `list_conversation_files` | 递归列出受策略允许的会话文件 | 需要 `files_read` |
| `download_conversation_file` | 下载指定文件别名 | 需要 `files_download`，不接受原始文件 ID |
| `reply_message` | 回复领取消息的原会话 | 幂等键、策略和 presence 门控 |
| `complete_message` | 完成、重试或 dead-letter | 必须持有有效租约 |
| `presence_status` | 返回粗粒度在用状态 | 不采集输入内容 |

资源 `bridge://queue/status` 只提供待处理数量，不暴露消息正文。MCP 本身不会执行项目命令；Agent 编排器必须在独立工作区和低权限账户中执行项目操作。

## 本地启动

要求 Node.js 24+ 和 pnpm。

```powershell
Copy-Item .\config.example.json .\config.json
pnpm install
pnpm build
$env:BRIDGE_MCP_CONFIG = (Resolve-Path .\config.json)
pnpm start
```

默认配置使用 `spool` 和 `dry_run`。真实客户端连接使用 `adapter: "device"`，私有适配器及其配置应放在被忽略的 `local-adapters/` 目录；不要把目标标识或任何凭据提交到配置文件。

通用核心通过配置中的 `device.pythonPath` 与 `device.cliPath` 调用外部适配器；进程边界见 [连接器契约](./docs/device-adapter-contract.md)。适配器实现不在公开仓库中。

HTTP 模式仅允许回环绑定：

```json
{
  "transport": "http",
  "http": {
    "host": "127.0.0.1",
    "port": 7319,
    "tokenEnv": "BRIDGE_MCP_BEARER_TOKEN"
  }
}
```

```powershell
$env:BRIDGE_MCP_BEARER_TOKEN = "replace-with-a-long-random-secret"
pnpm start
```

跨机器访问应使用 Cloud Worker、现有 VPN 或零信任网关，不要直接转发本地 MCP 端口。

## 设备 relay

设备 relay 轮询本地已登录会话，把新消息写入耐久 pending spool，成功上传后才移动到 sent spool；网络中断不会丢弃事件。它领取的命令只有：

- `send_text`
- `list_files`
- `download_file`

启动时设置：

```powershell
$env:BRIDGE_MCP_CONFIG = (Resolve-Path .\config.json)
$env:BRIDGE_CLOUD_URL = "https://your-worker.example"
$env:BRIDGE_CLOUD_DEVICE_ID = "device-main"
$env:BRIDGE_CLOUD_DEVICE_NAME = "dedicated-device"
$env:BRIDGE_CLOUD_DEVICE_TOKEN = "replace-with-a-different-long-random-secret"
pnpm relay
```

## Cloudflare 部署

云端组件位于 `cloud/`。部署前必须先选择账户，再创建 D1 数据库和私有 R2 bucket，写入实际 D1 ID，并分别设置 `AGENT_TOKEN` 与 `DEVICE_TOKEN`。默认数据库没有任何可信会话策略。

```powershell
wrangler d1 migrations apply bridge-message-center --remote --config cloud/wrangler.jsonc
wrangler secret put AGENT_TOKEN --config cloud/wrangler.jsonc
wrangler secret put DEVICE_TOKEN --config cloud/wrangler.jsonc
pnpm cloud:deploy
```

远程 MCP 地址为 `https://<worker>/mcp`，使用 Agent 专用 bearer token。详细步骤见 [cloud/README.md](./cloud/README.md)。

## 统一 Worker relay

`unified-relay` 连接 `message.example.com` 的多实例协议。每个本地 profile 映射到一个独立实例，并声明账号标签、备注和实际能力；同一渠道可以注册多个实例，能力不会互相继承。

```powershell
$env:BRIDGE_MCP_CONFIG = (Resolve-Path .\config.json)
$env:BRIDGE_MESSAGE_URL = "https://message.example.com"
# 从密钥管理器注入 JSON：connectorId -> 专属 token
$env:BRIDGE_MESSAGE_CONNECTOR_TOKENS = $connectorTokensJson
$env:BRIDGE_MESSAGE_CONNECTORS = @'
{
  "primary": {
    "id": "instance-device-primary",
    "kind": "im",
    "accountLabel": "团队主账号",
    "displayName": "设备 relay · 主账号",
    "note": "工程协作会话",
    "mode": "device_relay",
    "capabilities": ["receive_text", "send_text"]
  }
}
'@
npm run unified-relay
```

启动时 relay 会幂等注册所有实例，随后发送心跳、上传消息和入站附件、领取下行命令。每个请求都同时携带实例 ID 与该实例在 `BRIDGE_MESSAGE_CONNECTOR_TOKENS` 中的专属 bearer；一个实例的 token 不能声明或操作另一个实例。迁移期单 token 模式还要求 Worker 显式设置与之绑定的 `LEGACY_CONNECTOR_ID`，不能用于多实例。附件下载同样携带实例 ID，Worker 会阻止实例读取不属于自己的下行附件。旧 `BRIDGE_MESSAGE_CONNECTOR_MAP` 字符串映射仍兼容，但为避免宣称未经验证的附件路径，其能力只按收发文字注册；新部署应使用带元数据的 `BRIDGE_MESSAGE_CONNECTORS`，并仅声明已验证贯通的能力。

布局控制是独立且 fail-closed 的可选适配器能力：每台物理设备只允许一个 `device_relay` 实例声明 `layout_control`，其本地状态损坏或版本不兼容只会停用布局同步，不会终止消息 relay。公开核心仅定义带 revision、稳定 action ID 和幂等确认的协调协议；本地实现不在仓库中。

每个设备会话还可声明 `conversationType`、`groupDelivery`、`mentionTerms`、`contextBefore` 和可选的 `placementOverride`。私聊默认上报；群聊实时流只上报个人原生提及、匹配的提及词或受控请求前缀，并为触发事件附带最多 20 条此前上下文。全体提及不会触发个人事件。

支持批量枚举最近活跃的私聊和群聊：分别启用 `discoverDirectConversations`、`discoverGroupConversations`，并用 `discoveryConversationLimit`、`discoveryMessageLimit`、`discoveryCatchupSeconds` 和 `discoveryActiveWindowSeconds` 限制枚举、读取与首次补录范围。活跃窗口与 `historyWindowSeconds` 默认均为 7 天。不同设备 profile 可分别使用原生消息游标或原生本地消息游标逐页向旧消息读取，不把 20/100 条页面大小误当作完整历史；单次保护上限为 100 页或 2000 条，达到上限会明确标记 `truncated` 而非宣称完整。递增 `historyRevision`（兼容别名 `backfillRevision`）会把普通、非折叠群聊的 7 天纯文本历史仅重放一次到 background 通路，私聊、折叠会话、附件和旧提及不会进入即时队列。驱动可枚举全部会话目录，但只读取活跃窗口内或时间未知的会话；任何新消息都会重新激活对应会话。动态发现的会话默认没有项目或动作权限，只有显式加入服务端策略后才获得受控能力。设备 profile 的扫描结果会独立上报 `online / offline`，单个可用实例不再掩盖其他实例的读取失败。

上下文驱动会把客户端应用卡片规范化为 `card` 元素。当前识别转账、拍一拍和普通应用卡片；转账仅保留可显示的金额、备注和状态，拍一拍只保留显示摘要。交易 ID、内部账号、URL 与原始 XML 不进入消息正文。文件类型卡片目前只生成文件占位摘要，尚未提取原生文件名、字节或可下载对象，不会误报为已入库附件。

设备驱动从原生 `hidden`、`keepHidden`、消息盒和嵌套会话字段判断 `normal / folded / message_box`，并独立读取原生置顶标志；无法判断时为 `unknown`，不按群名猜测。每次 profile 扫描还携带未读数及其设备观察时间，消息事件携带采集观察时间，云端据此处理同一秒内的扫描/事件顺序。普通群聊只抽取文字元素，写入耐久 background spool；relay 启动时立即提交积压，之后每 5 分钟批量提交。云端会把它们规范化为 `queue_class=background` 的普通消息，且不会加入 Agent 即时队列。文件、图片、视频、语音、卡片和表情包不会进入该批次。

下行发送以 `idempotencyKey` 写入本地执行账本。明确发生在原生调用前的暂时故障可重试；一旦原生调用是否成功无法判定，relay 会回报人工检查而不自动重放，从而提供保守的物理发送至多一次语义。

### Windows 本地安全密钥

无法使用外部密码管理器时，可用 `scripts/message-secrets.ps1` 生成并保存 Worker 密钥。脚本先生成向后兼容的 `CONNECTOR_TOKEN`、`AGENT_TOKEN` 与 `ADMIN_TOKEN`，也可为每个实例生成独立 token 并把 `CONNECTOR_TOKENS` JSON 安全上传。所有值都使用 Windows DPAPI `CurrentUser` 加密到 `%LOCALAPPDATA%\MessageCenter\secrets.dpapi.json`，ACL 限制为当前用户与 SYSTEM；明文不会写入仓库、命令行参数或终端输出。

```powershell
# 首次生成本地加密存储，并同步到 Cloudflare Worker Secrets
.\scripts\message-secrets.ps1 -Action Provision

# 为实例生成并上传独立 token map；再次运行会保留现有 token
.\scripts\message-secrets.ps1 -Action ConfigureConnectorTokens `
  -ConnectorTokenIds 'instance-device-primary','instance-device-secondary'

# 仅在明确需要轮换所列实例时使用
.\scripts\message-secrets.ps1 -Action ConfigureConnectorTokens -ForceRotate `
  -ConnectorTokenIds 'instance-device-primary'

# 仅核对名称、长度与不可逆指纹
.\scripts\message-secrets.ps1 -Action Status

# 从现有本地加密存储重新同步 Cloudflare
.\scripts\message-secrets.ps1 -Action SyncCloudflare

# 不打印密钥，验证公网密码会话与 MCP 监听工具
.\scripts\message-secrets.ps1 -Action VerifyOnline

# 把网页登录密码复制到 Windows 剪贴板，不在终端显示明文
.\scripts\message-secrets.ps1 -Action CopyAdminPassword

# 在已设置其余 relay 环境变量后，安全注入 Connector Token 并运行 relay
.\scripts\message-secrets.ps1 -Action RunRelay
```

DPAPI 文件只能由创建它的 Windows 用户解密；重装系统或删除该用户配置前应主动轮换 Worker Secrets。脚本不会静默覆盖现有存储，轮换必须显式传入 `-ForceRotate`。

## 推荐编排流程

1. 对统一 Worker 调用 `listen_messages` 非破坏性观察即时候选，再用 `claim_message` 原子领取并保存 `messageId` 和 `leaseToken`（本地 MCP 仍使用 `next_message`）。
2. 在 LLM 之外强制执行 `scope.projectIds` 与 `scope.allowedActions`。
3. 只有 `scope.trustTier == "trusted"` 时才启动项目工具或下载文件。
4. 不把聊天正文拼接到 Shell；在隔离工作区诊断、测试并生成修复分支。
5. 使用稳定 `clientRequestId` 回复，然后调用 `consume_message`；旧客户端可继续使用 `complete_message`。
6. 临时故障使用 `retry`；需人工检查时使用 `dead_letter`。

## 验证

```powershell
pnpm check
pnpm test
pnpm build
```

安全边界见 [SECURITY.md](./SECURITY.md)，设备适配器要求见 [docs/device-adapter-contract.md](./docs/device-adapter-contract.md)。
