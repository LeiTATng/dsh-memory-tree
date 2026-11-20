# dsh-memory-tree

[English](README.en.md)

给 DeepSeek Harness 保存本地项目记忆。主线记录约束、决策、成果和待解问题。用户确认后，将支线结论合并进主线，再用 Checkpoint 留下阶段快照。支线是记忆记录，DSH 会话与上下文压缩由宿主管理。

## 安装

### DSH bundle

Bundle 的验证目标为 DSH `0.2.2-rc.3`。在包含 MCP Manager 的 profile 中安装，例如：

```sh
dsh plugin --profile web add github:LeiTATng/dsh-memory-tree
```

桌面端可用 Desktop profile。若已有手工接入的 `memory-tree`，先停用并移除该条注册，再使用 bundle。两种入口共用同一工具命名空间。重载后调用 `mt_status` 检查连接。

### 独立 MCP

通过 DSH 的 MCP 设置添加一个 stdio 服务，名称为 `memory-tree`，命令为 Node 18 或更高版本的可执行文件，参数为仓库中 `src/server.js` 的绝对路径。在 Windows 桌面端也使用 Node 的绝对路径。

将 [system-instruction.md](system-instruction.md) 放入 DSH 自定义指令，供 Agent 按需使用工具。

## 工作流

1. 用 `mt_set_project` 初始化项目。后续项目读取和写入都显式传 `project`。 `mt_status` 可查看项目名。
2. 用 `mt_branch` 开支线。完成试验后，用 `mt_merge` 提交 `entries`。每项提供 `category`、`text`、`date`（`YYYY-MM-DD`）、`source` 和 `verification`（`user-confirmed`、`tool-verified` 或 `unverified`）。类别可用 `constraints`、`decisions`、`results`、`openQuestions`。未验证条目进入待解问题。兼容旧的结构化 Markdown `summary`，其条目以待验证材料导入。
3. 若检测到疑似冲突，向用户展示新旧条目，通过 `mt_merge_resolve` 带回预览的 `token`，逐项提交 `keepBoth`、`replace` 或 `drop`。主线或预览变化后重新确认。相似度用于筛出值得审阅的条目。
4. 用 `mt_checkpoint` 冻结阶段状态，用 `mt_get_checkpoint` 读取快照的 Markdown。日常续接用 `mt_get_context` 或 `mt_search`。检索使用中文字符、二元组与英文词的词频余弦。跨项目搜索需显式传 `scope: "all"`，查看历史需显式传 `includeHistorical: true`。历史结果会标记被驳回、已替换、快照或旧版资料等状态。

## 存储与升级

默认使用 `~/.dsh/memory-tree`。通过 bundle 加载时遵循 DSH 的 `DSH_HOME`，也可用 `MEMORY_TREE_ROOT` 指定独立存储。在需要与其他同类插件并用时设置不同的数据目录。

升级前备份整个记忆目录并停止旧服务。旧主线、支线、闲聊文件及 Markdown 快照仍保留。新版本读取旧主线、支线和快照，新项目更改写入项目的 `.revisions/`。旧主线文件保留为导入基线，当前主线请用 `mt_get_context` 读取。已归档的旧版摘要按历史参考资料检索。

合并的主线变化、冲突决议和归档状态在同一条修订中提交。存储目录需要支持硬链接（例如 NTFS 或 ext4）。两个进程基于同一修订写入时只有一个成功。状态变化时先重读再重试。备份和同步时包含隐藏的 `.revisions/`，请仅在服务停止后复制整个目录。

## 测试

运行 `npm test`，需要 Node 18+ 和 Python 3。测试在临时目录检查项目隔离、只读查询、合并决议、失败重试、并发写入检测、旧数据读取和两种 MCP stdio 帧格式。可用 `DSH_TEST_NODE` 选择不同的 Node 可执行文件。
