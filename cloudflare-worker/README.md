# Message Center

`message.example.com` 是一个完全运行在 Cloudflare Worker 上的统一消息中心。一个 Worker 同时提供前端、HTTP 接入协议与远程 MCP；D1 保存规范化消息、策略、队列和审计记录，R2 保存私有附件。

## 运行架构

- `worker/index.js`：唯一生产运行时入口；不依赖 Pages、Sites、服务器或入站设备端口。
- `ui/`：Vue 3 + Vite 前端。Worker 在认证后通过静态资产绑定返回带哈希的构建产物；页面与 API 均显式禁用缓存。收件箱在页面可见时每 5 秒拉取一次，重新聚焦、从浏览器历史恢复或重新联网时会立即刷新。
- `worker/schema.sql`：D1 schema。`connector_instances` 是连接实例表，不对渠道类型设置唯一约束。
- `connector_layout_control` 只服务于显式声明 `layout_control` 的单一设备 owner；云端使用 revision 做 CAS，设备本地动作另用持久化 generation 与 action ID 排序、去重。
- `wrangler.jsonc`：本地开发与 Wrangler 生产部署配置。
- 客户端登录态和供应商凭据只保留在设备 relay 或对应云 relay 中。
- relay 只向 `message.example.com` 发起出站 HTTPS。

## 多账号与能力声明

每个接入实例包含独立的 `id`、`kind`、`accountLabel`、`displayName`、`note`、`mode` 与能力列表。例如同一渠道可以同时注册个人账号和团队账号；一个短信号码可以只声明 `receive_text`，而另一个实例可以声明收发及附件能力。

当前标准能力：

- `receive_text` / `send_text`
- `receive_files` / `send_files`
- `receive_images` / `send_images`
- `receive_video` / `send_video`
- `threads` / `reactions`
- `layout_control`（仅 `device_relay`；每台物理设备只允许一个 owner）

发送 API、网页输入框和 MCP 回复都会检查目标实例的实际能力。
原生表情目前只能作为文本占位摘要入库，未实现独立媒体对象的收发，因此不声明表情收发能力。

## 鉴权

- 网页与人工 API：标准密码登录页；密码使用 `ADMIN_TOKEN`，成功后签发 12 小时 HMAC 会话 Cookie。Cloudflare Access 可放在 Worker 前方作为额外网络边界，但当前 Static Assets 架构仍要求应用内密码会话，不能以 `ctx.access` 代替登录。
- 设备/云 relay：生产环境使用 `CONNECTOR_TOKENS` JSON secret（`connectorId -> token`）。每个请求必须同时携带 `x-connector-id` 和该实例的 bearer，实例之间不能互相冒充。迁移期若确实只接一个实例，可同时设置 `CONNECTOR_TOKEN` 与 `LEGACY_CONNECTOR_ID`；未绑定实例的旧 token 不会被接受。
- MCP agent：`AGENT_TOKEN` bearer。
- 所有 token 至少 32 字符，只作为 Worker secret 注入；`CONNECTOR_TOKENS` 也必须作为 secret 而非普通变量部署，源码和日志中不保存。
- 会话默认不可信，只有显式策略才能赋予 agent 项目、动作和回复范围。

## Agent 消息触发

- 私聊默认进入 Agent 队列。
- 群聊只有个人原生提及、配置的提及词或显式请求前缀才进入队列；全体提及不触发。
- 提及与显式请求附带最多 20 条此前消息上下文。上下文与正文同样是不可信输入，不会扩大项目和动作授权。
- 普通群聊只提取纯文本，每 5 分钟批量写入统一消息流，并标记 `queue_class=background`；不包含文件、图片、视频、语音或表情包，默认保留 30 天。后台消息和即时消息在收件箱中等价展示，但后台消息不能进入 Agent 即时队列。
- 原生折叠与消息盒字段规范化为 `normal`、`folded`、`message_box` 或 `unknown`；原生置顶独立规范化为 `is_pinned`。网页按置顶优先排序并显示状态，但不会把接入实例名称重复写入会话行或消息详情。
- 远程 MCP 使用 `listen_messages` 非破坏性查看即时候选、`claim_message` 原子领取、`consume_message` 完成或释放租约，并通过 `reply_message` 形成双向回复；旧工具名保留为兼容别名。

详细协议见 [CONNECTOR_PROTOCOL.md](./CONNECTOR_PROTOCOL.md)。

## 发送与文件生命周期

- 浏览器先把附件写入私有 R2 staging，再用稳定的 `clientRequestId` 原子排队；同一请求的并发重试只会生成一条消息和一条命令。
- staging 文件最长保留 24 小时；成功排队后转为命令附件，取消或过期文件由 Worker 定时清理。
- 排队操作保证幂等。设备 relay 在本地持久化执行账本；只有明确未调用客户端时才自动重试。客户端调用结果不确定时转入人工检查，避免一次物理发送被重复执行。

## 构建与部署

公开的 `wrangler.jsonc` 只包含示例域名和零值 D1 ID。生产部署前将其复制为被 Git 忽略的 `wrangler.local.jsonc`，填写自己的 Worker、路由、D1 与 R2 资源，并在 Wrangler 命令中使用 `--config wrangler.local.jsonc`；不要把部署标识或 secret 提交到仓库。

```powershell
Set-Location .\ui
npm ci
npm run check
npm run build

Set-Location ..
node --check worker/index.js
node worker/schema-test.mjs
node worker/smoke-test.mjs
npx wrangler deploy --dry-run
```

生产部署必须严格按“远程备份并核对 pending migration → 远程应用 `migrations/` → `wrangler deploy`”执行。Worker 会直接查询最新 schema，禁止在对应 D1 migration 生效前先部署新 Worker，否则收件箱和布局 API 会因缺表失败。前端主题层与 IRIS 一致，来自 WinUIonWeb；固定来源、GPL-3.0 许可证与归属说明位于 `ui/src/vendor/winui/`，部署副本位于 `/vendor/winui/`。
