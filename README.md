# dsh-memory-tree

> DSH（DeepSeek Harness）记忆树插件 —— 让 agent 拥有「主线记忆永不丢、支线过程可清理、闲聊完全隔离」的长期记忆。

DSH 原生是线性聊天上下文。本插件在 DSH 之上实现一套**记忆树**架构，把对话沉淀为可版本化、可清理、可隔离的结构化记忆。以**零依赖 MCP server** 形式运行（用 DSH 已有的、验证可用的 MCP 客户端加载），无需任何第三方 SDK 或联网安装。

---

## 为什么需要它

- **线性上下文会丢约束**：长会话里早期定下的硬性约束/决策，会被滚动摘要慢慢"吃掉"。
- **试错污染主线**：探索性追问、踩坑过程混进主线，让每次推理都背着噪声。
- **闲聊挤占 token**：无关闲聊和项目记忆混在一起。

本插件用三件套解决：**隔离路由 + 记忆树（Root/Branch）+ Checkpoint**。

---

## 核心架构

```
用户消息
   │
   ▼
[隔离路由] ── 命中闲聊 ──▶ 闲聊分区（激进压缩，细节可丢，不写主线）
   │
   └── 命中项目关键词 ──▶ 绑定到 项目 Root 节点
                              │
                ┌─────────────┴─────────────┐
           主线 (Root Node)              支线 (Branch Node)
   结构化 state（约束/决策/成果/待解）   每次临时追问/试错自动新开
   持久化到资料库，不滚动摘要           独立上下文，用完归档隔离
                │                              │
                │         mt_merge             │
                └──── 提炼结构化结论 ◀──────────┘
                          （原始聊天不进 token）
                │
         mt_checkpoint（里程碑）
                │
          冻结为复盘文档 → 新基线
```

### 1. 隔离路由（简单规则）
对用户消息做意图分类：
- 命中闲聊词（你好/谢谢/天气…）→ 路由到**闲聊分区**，不写入项目主线；
- 命中项目关键词（代码/bug/调研/架构/部署…）→ 绑定到对应**项目根节点**。

闲聊分区使用**激进压缩策略**（阈值很低、频繁摘要、细节可丢）；项目主线不走这条路径。

### 2. 记忆树（替代默认单一线性上下文）
- **Root Node（主线）**：结构化 state（JSON / 结构化 md），含核心约束、关键决策、成果、待解问题，持久化到资料库。**不使用滚动摘要**——靠结构化 state + 最近少量主线对话，避免摘要漂移吃掉硬性约束。
- **Branch Node（支线）**：每次临时追问、试错自动新开分支，有自己独立上下文。**分支原始日志默认不注入主线的上下文窗口**。
- 分支可 attach 到主线，但原始日志不进 token。

### 3. Merge（手动触发，合并入主线、清理支线）
指令：`mt_merge(branchId, summary)`。插件自动：
- 读取支线全部对话，提炼**结构化结论**（由 LLM 预提炼 `summary`，或插件启发式抽取）；
- 追加到主线 state（只存结论，不复制原始聊天）；
- 标记该支线为**归档**，不再参与后续上下文注入；原始事件日志保留备查，但不再进 token。

### 4. Checkpoint（里程碑复盘）
指令：`mt_checkpoint(title, review)`。插件：
- 冻结当前主线 state，导出一份复盘文档存入项目资料库；
- 主线把这份复盘文档作为**新基线**，清空本阶段所有支线引用与最近对话日志。

### 5. 上下文策略差异（关键）

| 分区 | 压缩策略 | 说明 |
|---|---|---|
| 闲聊 | 激进压缩 | 阈值低、频繁摘要、细节可丢 |
| 支线 | 普通压缩 | 用完归档隔离 |
| 主线 | **不滚动摘要** | 结构化 state + 最近少量主线对话；靠 checkpoint 快照做版本管理 |

---

## 安装到 DSH

### 方式 A：直接加载（已在本机验证）
1. 把本插件目录放到任意位置（如 `~/.dsh/memory-tree-plugin`）。
2. 在你的 `cordis.patch.yml`（profile 层）的 `mcp-manager.config.servers` 下加：
   ```yaml
   - id: mcp-manager
     config:
       servers:
         memory-tree:
           transport: stdio
           command: '<你的 node.exe 绝对路径>'
           args:
             - '<插件目录>/src/server.js'
           enabled: true
   ```
   > 提示：DSH GUI 启动进程不继承 shell PATH，请务必用**绝对路径**指向 node 与 server.js。
3. 把 `system-instruction.md` 的内容粘贴进 DSH 的「人设 / 自定义指令」。
4. **重启 DSH**。对话工具列表应出现 `mcp__memory-tree__*`（或 `mt_*`）。

### 方式 B：作为 DSH 插件包
本仓库 `package.json` 已带 `dsh` 元数据块（含 `bundle.patch` 与兼容 `0.2.2-rc.2` 的版本闸门），可被 DSH 插件市场/CLI 识别为可分发包。具体加载方式取决于你使用的 DSH 插件分发渠道。

---

## 使用（在 DSH 对话里）

装好并重启后，agent 会自动：
1. 你每次发言 → `mt_route` 做分类与隔离路由，把主线上下文作为背景；
2. 深入某话题 → `mt_branch("名词调研")` 开支线折腾；
3. 得出结论 → `mt_merge(branchId, "结构化结论…")` 并入主线；
4. 阶段收尾 → `mt_checkpoint("阶段1复盘")` 冻结为新基线。

你也可以手动调用任意 `mt_*` 工具。完整命令见 `system-instruction.md` 或调用 `mt_help`。

---

## 数据存储

```
~/.dsh/memory-tree/
  _config.json              # 活跃项目、路由词配置
  <项目>/
    mainline.state.json     # 结构化 state（约束/决策/成果/待解）
    mainline.md             # 人类可读主线状态
    mainline.events.jsonl   # 最近少量主线对话（仅注入用，定期裁剪）
    branches/<id>/
      meta.json             # 支线元信息（status: active|archived）
      events.jsonl          # 支线原始事件日志（保留备查，不进 token）
      conclusion.md         # 合并时提炼的结构化结论
    checkpoints/<id>.md     # 冻结的复盘文档（新基线）
    chat/chat.events.jsonl  # 闲聊分区（激进压缩）
```
可用 `MEMORY_TREE_ROOT` 环境变量改根目录。

---

## 工具清单

| 工具 | 作用 |
|---|---|
| `mt_help` | 命令手册 |
| `mt_status` | 当前项目/主线状态/活跃支线/路由词 |
| `mt_set_project(name)` | 切换激活项目（记忆树根节点） |
| `mt_route(message)` | 意图分类 + 隔离路由 + 返回主线上下文 |
| `mt_branch(title)` | 新开支线，返回 branchId |
| `mt_merge(branchId,[summary],[force])` | 支线合并入主线并归档（疑似冲突时返回 needsConfirmation，需 mt_merge_resolve 确认） |
| `mt_merge_resolve(branchId,resolutions,[summary])` | 提交用户对合并冲突的决议（keepBoth/replace/drop） |
| `mt_search(query,[topK],[project])` | 语义检索全部记忆（轻量本地向量，零依赖） |
| `mt_checkpoint(title,[review])` | 里程碑复盘，冻结为新基线 |
| `mt_get_context([maxRecent])` | 取主线上下文注入对话 |
| `mt_chat(message)` | 闲聊写入隔离分区（激进压缩） |
| `mt_list_branches()` | 列出支线 |

---

## 开发 / 测试

```bash
# 冒烟测试（自动拉起 server 走完整流程）
node test/smoke.mjs

# 手动以 MCP 客户端连接（stdio）
MEMORY_TREE_ROOT=/tmp/mt node src/server.js
```

纯 Node 标准库、零运行时依赖，Node ≥ 18 即可。

---

## License

MIT © dsh-memory-tree contributors
