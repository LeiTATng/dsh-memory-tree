import { MemoryTree } from './engine.js';
import fs from 'node:fs';

const mt = new MemoryTree(process.env.MEMORY_TREE_ROOT || undefined);
const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const string = { type: 'string' };
const project = { type: 'string', description: '显式项目名，使用 mt_set_project 初始化' };
const entry = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { enum: ['constraints', 'decisions', 'results', 'openQuestions'] },
    text: { type: 'string', maxLength: 4000 },
    source: { type: 'string', maxLength: 500 },
    date: { type: 'string', format: 'date' },
    verification: { enum: ['user-confirmed', 'tool-verified', 'unverified'] },
  },
  required: ['category', 'text', 'source', 'date', 'verification'],
};

function tool(name, description, properties, required, run, readOnlyHint = false) {
  return {
    name, description, run,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint },
  };
}

const tools = [
  tool('mt_help', '显示记忆树使用说明', {}, [], () => ({
    workflow: '初始化项目 → 建立记忆支线 → 提交结构化结论 → 创建阶段快照',
    scope: '读写显式传 project。跨项目搜索需显式设置 scope: all。',
    reliability: '检索结果是参考材料。阅读来源、验证状态和历史状态再使用。',
  }), true),
  tool('mt_status', '查看项目列表或指定项目的主线和支线状态', { project }, [],
    args => mt.status(args.project), true),
  tool('mt_set_project', '显式初始化项目，返回规范项目名', { project }, ['project'],
    args => ({ project: mt.setActiveProject(args.project) })),
  tool('mt_route', '返回关键词路由建议。显式传 project 时可返回该项目主线', { message: string, project }, ['message'],
    args => mt.route(args.message, args.project), true),
  tool('mt_branch', '为项目创建一条记忆支线', { project, title: string }, ['project'],
    args => mt.openBranch(args.project, args.title)),
  tool('mt_merge', '提交结构化结论。entries 优先，旧 summary 作为待验证材料导入。冲突时先返回待确认决议',
    { project, branchId: string, entries: { type: 'array', items: entry, minItems: 1, maxItems: 50 }, summary: string },
    ['project', 'branchId'], args => mt.mergeBranch(args.project, args.branchId, args)),
  tool('mt_merge_resolve', '使用预览 token 提交完整冲突决议',
    {
      project, branchId: string, token: string,
      resolutions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { index: { type: 'integer', minimum: 0 }, action: { enum: ['keepBoth', 'replace', 'drop'] } },
          required: ['index', 'action'],
        },
      },
    }, ['project', 'branchId', 'token', 'resolutions'],
    args => mt.resolveMerge(args.project, args.branchId, args.token, args.resolutions)),
  tool('mt_search', '本地词法检索。默认查当前条目。历史记录按需包含，跨项目需显式选择',
    { query: string, project, scope: { enum: ['all'] }, includeHistorical: { type: 'boolean' },
      topK: { type: 'integer', minimum: 1, maximum: 50 } },
    ['query'], args => mt.search(args.query, args), true),
  tool('mt_checkpoint', '冻结项目状态为阶段快照，保留历史和会话',
    { project, title: string, review: string }, ['project'], args => mt.checkpoint(args.project, args.title, args.review)),
  tool('mt_get_checkpoint', '按 ID 读取阶段快照 Markdown', { project, id: string }, ['project', 'id'],
    args => mt.getCheckpoint(args.project, args.id), true),
  tool('mt_get_context', '读取有长度上限的项目主线上下文',
    { project, maxRecent: { type: 'integer', minimum: 0, maximum: 40 } }, ['project'],
    args => mt.getContext(args.project, args.maxRecent), true),
  tool('mt_chat', '显式保存一条闲聊到指定项目的独立记录，保留近期条目',
    { project, message: string, role: { enum: ['user', 'assistant'] } }, ['project', 'message'],
    args => mt.recordChat(args.project, args.role ?? 'user', args.message)),
  tool('mt_list_branches', '列出项目的活跃和已归档支线', { project }, ['project'],
    args => mt.listBranches(args.project), true),
];

const TOOLS = tools.map(({ run, ...definition }) => definition);
const handlers = new Map(tools.map(definition => [definition.name, definition]));

function validate(schema, value, field) {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${field} 的值不受支持`);
  if (schema.type === 'string' && (typeof value !== 'string' || value.length > (schema.maxLength ?? 32000))) {
    throw new Error(`${field} 需要长度有效的字符串`);
  }
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < (schema.minimum ?? 0) ||
      value > (schema.maximum ?? Number.MAX_SAFE_INTEGER))) throw new Error(`${field} 超出整数范围`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${field} 需要布尔值`);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 50)) {
      throw new Error(`${field} 需要长度有效的数组`);
    }
    value.forEach((item, index) => validate(schema.items, item, `${field}[${index}]`));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 需要对象`);
    for (const required of schema.required) {
      if (!Object.hasOwn(value, required)) throw new Error(`缺少 ${required}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`未知参数：${key}`);
      validate(schema.properties[key], item, key);
    }
  }
}

function callTool(name, args) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`未知工具：${name}`);
  validate(handler.inputSchema, args, 'arguments');
  return handler.run(args);
}

// ---------- JSON-RPC / MCP 帧处理 ----------
let buf = Buffer.alloc(0);
let framing = null;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
function send(obj) {
  const s = JSON.stringify(obj);
  const payload = Buffer.from(s, 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  process.stdout.write(framing === 'legacy' ? Buffer.concat([header, payload]) : s + '\n');
}
function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) ||
      msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = msg.id;
  if (id === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: SUPPORTED_VERSIONS.has(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-memory-tree', version: VERSION }
    } });
    return;
  }
  if (msg.method === 'ping') { if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    try {
      const result = callTool(name, args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
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
  if (buf.length > MAX_MESSAGE_BYTES) { process.stderr.write('MCP message too large\n'); process.exit(1); }
  while (buf.length) {
    if (!framing) {
      const first = buf.toString('utf8').trimStart();
      if (!first) return;
      const prefix = first.toLowerCase();
      if ('content-length:'.startsWith(prefix)) return;
      framing = prefix.startsWith('content-length:') ? 'legacy' : 'jsonl';
    }
    let body;
    if (framing === 'jsonl') {
      const end = buf.indexOf('\n');
      if (end < 0) return;
      body = buf.subarray(0, end).toString('utf8').trim();
      buf = buf.subarray(end + 1);
      if (!body) continue;
    } else {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const match = buf.subarray(0, sep).toString('utf8').match(/Content-Length:\s*(\d+)/i);
      if (!match || Number(match[1]) > MAX_MESSAGE_BYTES) { process.stderr.write('Invalid MCP frame\n'); process.exit(1); }
      const start = sep + 4, length = Number(match[1]);
      if (buf.length < start + length) return;
      body = buf.subarray(start, start + length).toString('utf8');
      buf = buf.subarray(start + length);
    }
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
