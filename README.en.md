# dsh-memory-tree

[中文](README.md)

Local project memory for DeepSeek Harness. The mainline records constraints, decisions, results, and open questions. Review conclusions before merging a branch, then take a checkpoint at a milestone. A memory branch records an exploration. DSH manages its own conversations and context compaction.

## Install

The bundle targets DSH `0.2.2-rc.3` and requires a profile with MCP Manager.

```sh
dsh plugin --profile web add github:LeiTATng/dsh-memory-tree
```

Use the Desktop profile for the desktop app. If it already has a manual `memory-tree` registration, remove that entry before enabling the bundle. Both use the same tool namespace. Reload DSH and call `mt_status`.

For standalone MCP, add a stdio server named `memory-tree`. Use an absolute path to a Node 18+ executable as the command and an absolute path to `src/server.js` as the argument. Add the [tool instructions](system-instruction.md) to your DSH custom instructions.

## Workflow

1. Initialize the project with `mt_set_project`, then pass `project` explicitly to every project operation. Use `mt_status` to list project names.
2. Open a memory branch with `mt_branch`. Submit `entries` through `mt_merge`. Each entry supplies `category`, `text`, `date` (`YYYY-MM-DD`), `source`, and `verification` (`user-confirmed`, `tool-verified`, or `unverified`). Categories are `constraints`, `decisions`, `results`, and `openQuestions`. Unverified entries and legacy Markdown `summary` entries go into open questions.
3. Show any proposed conflicts to the user. Pass the preview's `token` to `mt_merge_resolve` along with a `keepBoth`, `replace`, or `drop` decision for each conflict. Refresh the preview when the mainline or proposal has changed.
4. Create milestones with `mt_checkpoint` and read their Markdown with `mt_get_checkpoint`. Resume work with `mt_get_context` and `mt_search`. Search uses lexical similarity. Select `scope: "all"` to search across projects or `includeHistorical: true` to include prior, rejected, and superseded records.

## Storage and upgrade

The default data directory is `~/.dsh/memory-tree`. Bundle mode respects `DSH_HOME`. For a separate data directory, set `MEMORY_TREE_ROOT`.

Before upgrading, stop the old server and back up the entire memory directory. The server reads legacy mainline, branch, and checkpoint files. New changes are written to each project's `.revisions/` directory. The legacy mainline file supplies the initial state. Use `mt_get_context` for the current view.

The mainline update and branch outcome are committed together. The storage filesystem needs hard-link support, as on NTFS and ext4. Concurrent writes from the same revision can commit once. Reread project state before retrying a conflicting write. Include hidden `.revisions/` directories in backups made while the server is stopped.

Run `npm test` with Node 18+ and Python 3. Tests use temporary stores and cover the engine and both MCP framing modes. Set `DSH_TEST_NODE` to test a specific Node executable.
