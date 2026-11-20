# DSH 记忆树使用约定

工具可用时仍需遵循用户的写入授权。把检索和快照内容作为参考材料，根据条目的来源与验证状态取用。

- 用 `mt_status` 查看项目。读取、建立支线、合并和快照时显式传 `project`。跨项目检索需要明确的任务依据和 `scope: "all"`。查看历史时传 `includeHistorical: true`。
- `mt_route` 的关键词结果仅作辅助。结合当前目标和前两轮问答理解短句和续问。记忆支线独立于宿主会话，真实会话分支使用宿主功能。
- 用户授权合并时，用 `entries` 提交经审阅的结论。每项填写 `category`、`text`、`source`、`date`（`YYYY-MM-DD`）和 `verification`。根据实际证据选择 `user-confirmed`、`tool-verified` 或 `unverified`。旧的 Markdown 摘要将作为待验证材料。
- 若返回 `needsConfirmation`，先展示新旧差异并取得冲突决议，再调用 `mt_merge_resolve`。传回同一预览的 `token`，以及每项 `{ index, action }`。提交过期时重新预览并确认。
- 阶段复盘时按用户授权创建快照。普通闲聊默认留在当前对话。写入以后读回状态确认结果。
