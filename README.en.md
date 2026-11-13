# dsh-memory-tree

> A memory-tree plugin for DSH (DeepSeek Harness) — giving your agent "mainline memory that never loses, branches that can be cleaned up, and chat fully isolated".

DSH is natively a linear chat context. This plugin builds a **memory tree** on top of DSH: contextual memory that is versionable, cleanable, and isolated. It runs as a **zero-dependency MCP server** (loaded through DSH's existing, verified MCP client) — no third-party SDK or network install required.

## Why

- **Linear context drops constraints**: hard constraints/decisions made early get "eaten" by rolling summaries.
- **Trial-and-error pollutes the mainline**: exploratory Q&A and dead-ends mix into the main thread, adding noise to every inference.
- **Chat wastes tokens**: small talk and project memory get tangled.

The fix is three pieces: **isolation routing + memory tree (Root/Branch) + Checkpoint**.

## Architecture

```
user message
   │
   ▼
[isolation router] ── small talk ──▶ chat partition (aggressive compaction, details disposable, not written to mainline)
   │
   └── project keywords ──▶ bind to project Root node
                              │
                ┌─────────────┴─────────────┐
         mainline (Root Node)          branch (Branch Node)
   structured state (constraints/      auto-opened per follow-up/trial
     decisions/results/open)           independent context, archived & isolated
   persisted, NO rolling summary       raw log NOT injected into mainline context
                │                              │
                │         mt_merge             │
                └──── structured conclusion ◀──┘
                       (raw chat never enters tokens)
                │
         mt_checkpoint (milestone)
                │
          freeze → review doc → new baseline
```

### 1. Isolation routing (simple rules)
Intent classification on each user message:
- hits small-talk words (hi / thanks / weather…) → **chat partition**, never written to project mainline;
- hits project keywords (code / bug / research / architecture / deploy…) → bound to the **project root node**.

The chat partition uses an **aggressive compaction** strategy (low threshold, frequent summarization, details disposable); the project mainline does not.

### 2. Memory tree (replaces the default single linear context)
- **Root Node (mainline)**: structured state (JSON / structured md) — core constraints, key decisions, results, open questions — persisted to a store. **No rolling summary** — relies on structured state + recent few mainline turns, avoiding summary drift that eats hard constraints.
- **Branch Node**: auto-opened per follow-up/trial, with its own independent context. **Branch raw logs are NOT injected into the mainline context window by default**.
- Branches can attach to the mainline, but raw logs never enter tokens.

### 3. Merge (manual trigger → into mainline, clean branches)
`mt_merge(branchId, summary)`: reads the whole branch, extracts a **structured conclusion** (LLM pre-extracts `summary`, or the plugin heuristically extracts), appends it to the mainline state (conclusion only, no raw chat copy), marks the branch **archived** (no longer injected), while the raw event log is retained for audit but out of tokens.

### 4. Checkpoint (milestone review)
`mt_checkpoint(title, review)`: freezes the current mainline state, exports a review doc into the project store, sets it as the **new baseline**, and clears this phase's branch references and recent conversation log.

### 5. Context strategy differences (key)

| Partition | Compaction | Note |
|---|---|---|
| Chat | Aggressive | low threshold, frequent summary, details disposable |
| Branch | Normal | archived & isolated after use |
| Mainline | **No rolling summary** | structured state + recent few mainline turns; versioned via checkpoint snapshots |

## Install into DSH

### Option A: direct load (verified on this machine)
1. Place this plugin anywhere (e.g. `~/.dsh/memory-tree-plugin`).
2. In your profile `cordis.patch.yml`, under `mcp-manager.config.servers`, add:
   ```yaml
   - id: mcp-manager
     config:
       servers:
         memory-tree:
           transport: stdio
           command: '<absolute path to your node.exe>'
           args:
             - '<plugin dir>/src/server.js'
           enabled: true
   ```
   > DSH GUI does not inherit shell PATH — use **absolute paths** for node and server.js.
3. Paste `system-instruction.md` into DSH's "Persona / Custom Instructions".
4. **Restart DSH**. Tools `mcp__memory-tree__*` (or `mt_*`) should appear.

### Option B: as a DSH plugin package
This repo's `package.json` carries a `dsh` metadata block (with `bundle.patch` and a compatibility gate including `0.2.2-rc.2`), so DSH plugin marketplaces/CLIs can recognize it as a distributable package.

## Usage (in a DSH chat)
After install + restart, the agent will automatically:
1. each message → `mt_route` classifies & routes, uses mainline context as background;
2. dive into a topic → `mt_branch("topic research")` opens a branch;
3. conclude → `mt_merge(branchId, "structured conclusion…")` merges into mainline;
4. phase wrap → `mt_checkpoint("phase 1 review")` freezes as new baseline.

You can also call any `mt_*` tool manually. Full command list in `system-instruction.md` or via `mt_help`.

## Data layout
```
~/.dsh/memory-tree/
  _config.json
  <project>/
    mainline.state.json      # structured state
    mainline.md
    mainline.events.jsonl    # recent mainline turns (injection only)
    branches/<id>/{meta.json, events.jsonl, conclusion.md}
    checkpoints/<id>.md
    chat/chat.events.jsonl   # chat partition (aggressive compaction)
```
Override root with `MEMORY_TREE_ROOT`.

## Tools
`mt_help` · `mt_status` · `mt_set_project` · `mt_route` · `mt_branch` · `mt_merge` · `mt_checkpoint` · `mt_get_context` · `mt_chat` · `mt_list_branches`

## Dev / test
```bash
node test/smoke.mjs                 # end-to-end over stdio
MEMORY_TREE_ROOT=/tmp/mt node src/server.js   # manual MCP client connect
```
Pure Node stdlib, zero runtime deps, Node ≥ 18.

## License
MIT © dsh-memory-tree contributors
