// dsh-memory-tree — MCP server (stdio, LSP 帧格式, 纯 Node 标准库零依赖)
// 让 DSH（经 mcp-manager）获得：隔离路由 / 记忆树 / Merge / Checkpoint / 三套压缩策略
import { MemoryTree } from './engine.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.MEMORY_TREE_ROOT || path.join(os.homedir(), '.dsh', 'memory-tree');
const LOG = path.join(ROOT, 'mcp-server.log');
fs.mkdirSync(ROOT, { recursive: true });
function log(...a) { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {} }

const mt = new MemoryTree(ROOT);

const TOOLS = [
  {
    name: 'mt_help', description: '显示记忆树插件的所有命令与用法（中文）', inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mt_status', description: '查看当前项目、主线状态、活跃支线、路由词配置', inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mt_set_project', description: '设置当前激活项目（记忆树根节点）。后续路由/主线操作默认作用于它',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: '项目名，如 my-app' } }, required: ['project'] }
  },
  {
    name: 'mt_route', description: '对用户消息做意图分类与隔离路由：命中闲聊→闲聊分区；命中项目关键词→绑定项目根节点并返回主线上下文。每次用户发言应先调用它',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: '用户消息原文' }, project: { type: 'string', description: '可选，强制绑定到某项目' } }, required: ['message'] }
  },
  {
    name: 'mt_branch', description: '为一次临时追问/试错新开一条支线（独立上下文，不污染主线）。返回 branchId',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: '支线标题，如 名词调研' }, project: { type: 'string' } } }
  },
  {
    name: 'mt_merge', description: '把支线合并入主线：提炼结构化结论追加到主线 state（只存结论，不复制原始聊天），并归档该支线。若支线结论与主线同类别已有项语义高度相似（疑似冲突），会返回 needsConfirmation 而不改动主线，需用户确认后用 mt_merge_resolve 提交决议。summary 可省略',
    inputSchema: { type: 'object', properties: { branchId: { type: 'string' }, project: { type: 'string' }, summary: { type: 'string', description: '可选：由 LLM 预提炼的结构化结论 markdown' }, force: { type: 'boolean', description: '可选：true 跳过冲突确认直接合并（不安全，仅非交互场景用）' } }, required: ['branchId'] }
  },
  {
    name: 'mt_merge_resolve', description: '在 mt_merge 返回 needsConfirmation 后，提交用户对冲突项的决议。resolutions 为数组，每项 { index, action: keepBoth|replace|drop, customText? }，index 对应 mt_merge 返回的 conflicts[].index。summary 若曾在 mt_merge 传入，此处需传相同值以保证冲突索引一致',
    inputSchema: { type: 'object', properties: { branchId: { type: 'string' }, project: { type: 'string' }, resolutions: { type: 'array', description: '[{index,action,customText?}]' }, summary: { type: 'string' } }, required: ['branchId', 'resolutions'] }
  },
  {
    name: 'mt_search', description: '语义检索记忆：在主线结构化条目、各支线结论、各 Checkpoint 复盘中做轻量本地向量检索（中文 bi-gram + 英文词 token + 余弦），返回最相关片段及出处与相似度。当不确定记忆落在哪棵子树、或想跨项目找相关内容时使用。project 可省略（搜全部项目）',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '检索语句，如 鉴权方案' }, topK: { type: 'number', description: '返回条数，默认 5' }, project: { type: 'string', description: '可选，限定项目' } }, required: ['query'] }
  },
  {
    name: 'mt_checkpoint', description: '里程碑复盘：冻结当前主线 state 导出复盘文档，设为新基线，清空本阶段支线引用与最近对话日志',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: '如 阶段1复盘' }, review: { type: 'string', description: '可选复盘正文' }, project: { type: 'string' } } }
  },
  {
    name: 'mt_get_context', description: '获取主线上下文（结构化 state + 最近少量主线对话），用于注入对话。支线原始日志默认不注入',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, maxRecent: { type: 'number', description: '最近主线对话条数，默认 6' } } }
  },
  {
    name: 'mt_chat', description: '记录一条闲聊消息到闲聊分区（激进压缩，细节可丢，不写入项目主线）',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, role: { type: 'string', description: 'user|assistant', default: 'user' }, project: { type: 'string' } }, required: ['message'] }
  },
  {
    name: 'mt_list_branches', description: '列出当前项目的支线（含活跃/已归档）',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } }
  }
];

function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'mt_help': return HELP_TEXT();
    case 'mt_status': return JSON.stringify(mt.status(), null, 2);
    case 'mt_set_project': { const p = mt.setActiveProject(args.project); return `已激活项目：${p}`; }
    case 'mt_route': { const r = mt.route(args.message, args.project); return JSON.stringify(r, null, 2); }
    case 'mt_branch': { const b = mt.openBranch(args.project || mt.config.activeProject || mt.config.defaultProject, args.title); return `已开新支线：\n${JSON.stringify(b, null, 2)}`; }
    case 'mt_merge': { const p = args.project || mt.config.activeProject || mt.config.defaultProject; const r = mt.mergeBranch(p, args.branchId, args.summary, !!args.force); return JSON.stringify(r, null, 2); }
    case 'mt_merge_resolve': { const p = args.project || mt.config.activeProject || mt.config.defaultProject; const r = mt.resolveMerge(p, args.branchId, args.resolutions, args.summary || null); return JSON.stringify(r, null, 2); }
    case 'mt_search': { const r = mt.semanticSearch(args.query, args.topK || 5, args.project); return JSON.stringify(r, null, 2); }
    case 'mt_checkpoint': { const p = args.project || mt.config.activeProject || mt.config.defaultProject; const r = mt.checkpoint(p, args.title, args.review); return JSON.stringify(r, null, 2); }
    case 'mt_get_context': { const p = args.project || mt.config.activeProject || mt.config.defaultProject; return mt.getContext(p, args.maxRecent || 6); }
    case 'mt_chat': { const p = args.project || mt.config.activeProject || mt.config.defaultProject; mt.recordChat(p, args.role || 'user', args.message); return '已记入闲聊分区（激进压缩）'; }
    case 'mt_list_branches': { const p = args.project || mt.config.activeProject || mt.config.defaultProject; return JSON.stringify(mt.listBranches(p), null, 2); }
    default: return `未知工具：${name}`;
  }
}

function HELP_TEXT() {
  return [
    '# DSH 记忆树插件 命令手册',
    '',
    '## 记忆模型',
    '- Root Node（项目主线）：结构化 state（约束/决策/成果/待解），持久化到 ~/.dsh/memory-tree/<项目>/',
    '- Branch Node（支线）：每次临时追问/试错自动新开，独立上下文；原始日志默认不注入主线',
    '- Checkpoint（里程碑）：冻结主线为复盘文档，作为新基线',
    '',
    '## 工具',
    '- mt_route(message) → 意图分类 + 隔离路由 + 返回主线上下文（每次用户发言先调用）',
    '- mt_set_project(name) → 切换激活项目',
    '- mt_branch(title) → 新开支线，返回 branchId',
    '- mt_merge(branchId, [summary], [force]) → 支线合并入主线并归档（冲突需确认：返回 needsConfirmation 后用 mt_merge_resolve 提交）',
    '- mt_merge_resolve(branchId, resolutions, [summary]) → 提交用户对合并冲突的决议',
    '- mt_search(query, [topK], [project]) → 语义检索全部记忆（找"忘了在哪棵子树"的内容）',
    '- mt_checkpoint(title, [review]) → 里程碑复盘，冻结为新基线',
    '- mt_get_context([maxRecent]) → 取主线上下文注入对话',
    '- mt_chat(message) → 闲聊写入隔离分区（激进压缩）',
    '- mt_list_branches() / mt_status() / mt_help()',
    '',
    '## 典型工作流',
    '1) 用户发言 → mt_route → 拿到主线上下文作为系统背景',
    '2) 深入某话题 → mt_branch("名词调研") → 在支线里折腾',
    '3) 得出结论 → mt_merge(branchId, "结构化结论...")',
    '   - 若返回 needsConfirmation：逐条展示 conflicts 给用户，征询 keepBoth/replace/drop，再 mt_merge_resolve(branchId, resolutions)',
    '4) 阶段结束 → mt_checkpoint("阶段1复盘")',
    '5) 想找历史记忆但忘了落在哪 → mt_search("关键词")',
  ].join('\n');
}

// ---------- JSON-RPC / MCP 帧处理 ----------
let buf = Buffer.alloc(0);
function send(obj) {
  const s = JSON.stringify(obj);
  const payload = Buffer.from(s, 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, payload]));
}
function handle(msg) {
  const id = msg.id;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-memory-tree', version: '1.1.0' }
    } });
    return;
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'ping') return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    try {
      const text = callTool(name, args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误：${e.message}` }], isError: true } });
    }
    return;
  }
  // 未知方法
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const headerStr = buf.slice(0, sep).toString('utf8');
    const m = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = sep + 4;
    if (buf.length < start + len) break; // 帧不完整
    const body = buf.slice(start, start + len).toString('utf8');
    buf = buf.slice(start + len);
    try { const msg = JSON.parse(body); log('recv', msg.method || (msg.id ? 'resp' : '?')); handle(msg); }
    catch (e) { log('parse err', e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));
log('dsh-memory-tree MCP server started, root=', ROOT);
