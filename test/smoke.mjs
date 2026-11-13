// 冒烟测试：把 MCP server 当子进程拉起，走一遍记忆树全流程
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(tmpdir(), 'mt-test-'));
const srv = spawn('node', [path.resolve('src/server.js')], { env: { ...process.env, MEMORY_TREE_ROOT: ROOT } });

let buf = Buffer.alloc(0);
const pending = [];
srv.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n'); if (sep === -1) break;
    const m = buf.slice(0, sep).toString().match(/Content-Length:\s*(\d+)/i); if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = +m[1]; const start = sep + 4; if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString()); buf = buf.slice(start + len);
    if (msg.id !== undefined && !msg.method) { const p = pending.shift(); p && p(msg); }
  }
});
const send = (obj) => new Promise((res) => { pending.push(res); const s = JSON.stringify(obj); srv.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); });
const call = (name, args) => send({ jsonrpc: '2.0', id: Math.random(), method: 'tools/call', params: { name, arguments: args } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const out = [];
await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
await sleep(100);
const tl = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
out.push('TOOLS: ' + tl.result.tools.map(t => t.name).join(', '));

await call('mt_set_project', { project: 'demo' });
const r1 = await call('mt_route', { message: '帮我分析一下这个项目的鉴权架构，怎么实现更合理？' });
out.push('ROUTE(project): ' + r1.result.content[0].text.split('\n')[0]);

await call('mt_branch', { title: '鉴权方案调研' });
const bl = await call('mt_list_branches', {});
const branchId = JSON.parse(bl.result.content[0].text)[0].id;
out.push('BRANCH opened: ' + branchId);

const mg = await call('mt_merge', { branchId, summary: '## 决策\n- 采用 OAuth2 + PKCE 前端鉴权\n## 约束\n- 禁止在客户端存长期 token\n## 结果\n- 草拟了 middleware 骨架' });
out.push('MERGE: ' + mg.result.content[0].text.split('\n').slice(0, 4).join(' | '));

const cp = await call('mt_checkpoint', { title: '阶段1复盘', review: '完成鉴权架构选型，主线已固化决策。' });
out.push('CHECKPOINT: ' + cp.result.content[0].text.split('\n')[0]);

const ctx = await call('mt_get_context', {});
out.push('CONTEXT contains 决策? ' + /决策|OAuth2/.test(ctx.result.content[0].text));
const st = await call('mt_status', {});
out.push('STATUS: ' + st.result.content[0].text.replace(/\n/g, ' ').slice(0, 200));

console.log(out.join('\n'));
srv.kill();
process.exit(0);
