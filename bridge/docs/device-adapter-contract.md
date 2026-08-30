# Current-session device adapter contract

设备会话接入必须实现 `BridgeAdapter`，并与 MCP、策略和 Agent 执行器保持进程边界。

## 入站要求

适配器向核心提交规范化 `IncomingBridgeMessage`：

- 全局唯一且可去重的消息 ID。
- conversation/sender 的稳定 ID、显示名和身份可信度。
- UTC 时间、纯文本内容、附件元数据和不透明 reply handle。
- 附件先复制到 staging 根目录，计算大小和 SHA-256；不得把远程 URL直接交给 MCP。

如果只能取得群名、昵称或 OCR 文本，`assurance` 必须是 `display_only`。核心会阻止此类事件获得项目访问权。

## 出站要求

`sendReply(message, text, idempotencyKey)`：

- 只能使用消息已有的 reply handle 回复原会话。
- 必须使用幂等键避免重试导致重复发信。
- 不得提供按原始平台标识任意发送的旁路接口。
- 若实现需要激活窗口，`canSendWhileLocked` 必须是 `false`，且只能在核心返回 `away_unlocked` 时运行；检测到用户重新输入应中止并恢复原窗口/草稿。

## 可接受的接入优先级

1. 厂商公开或明确授权的本地扩展/辅助接口。
2. 用户授权、版本固定且不导出认证材料的设备运行时连接器。
3. 可访问性接口、通知接口或经过版本固定的 RPA；无法证明身份时必须降级为 `display_only`。
4. 用户离席时的受控前台自动化，带立即中止和状态恢复。

会话密钥提取、聊天数据库解密和协议中间人不属于本适配器契约。运行时连接器不得扩大到这些能力。
