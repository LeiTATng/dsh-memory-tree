import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryTree } from '../src/engine.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mt-regression-'));
const entry = (value, verification = 'tool-verified') => ({
  category: 'decisions', text: value, verification, date: '2026-11-20', source: 'isolated fixture',
});
const proposal = (...entries) => ({ entries });

try {
  const mt = new MemoryTree(root);
  assert.deepEqual(mt.status(), { activeProject: null, projects: [] });
  assert.throws(() => mt.getContext('missing'), /尚未初始化/);
  assert.throws(() => mt.search('test'), /指定 project/);
  assert.equal(mt.route('继续').route, 'undetermined');
  assert.deepEqual(fs.readdirSync(root), []);

  for (const unsafe of ['../other', 'C:\\temp', 'CON', 'LPT¹', '__proto__', '.hidden']) {
    assert.throws(() => mt.setActiveProject(unsafe), /无效项目名称/);
  }
  assert.equal(mt.setActiveProject('Demo'), 'demo');
  assert.equal(mt.setActiveProject('DEMO'), 'demo');
  const second = new MemoryTree(root);
  second.setActiveProject('other');
  assert.deepEqual(mt.status().projects.sort(), ['demo', 'other']);
  const other = second.openBranch('other', '独立项目');
  second.mergeBranch('other', other.id, proposal(entry('Project-specific sentinel')));
  assert.deepEqual(mt.search('sentinel', { project: 'demo' }), []);
  assert.equal(mt.search('sentinel', { scope: 'all' })[0].project, 'other');
  assert.throws(() => mt.search('sentinel', { scope: 'all', project: 'demo' }), /指定 project/);

  const main = mt.openBranch('demo', 'initial decision');
  assert.throws(() => mt.mergeBranch('demo', main.id, { summary: '## 未知分类\n- 需要确认' }), /无法识别/);
  mt.mergeBranch('demo', main.id, proposal(entry('Alpha OAuth2 PKCE enabled')));
  assert.equal(mt.mergeBranch('demo', main.id, {}).alreadyMerged, true);

  const provisional = mt.openBranch('demo', 'unverified legacy input');
  mt.mergeBranch('demo', provisional.id, { summary: '## 未验证结果\n- cache rumor' });
  assert.deepEqual(mt.getMainline('demo').results, []);
  assert.deepEqual(mt.getMainline('demo').openQuestions, ['cache rumor']);

  const conflict = mt.openBranch('demo', 'conflict');
  const pending = mt.mergeBranch('demo', conflict.id, proposal(entry('Alpha OAuth2 PKCE disabled')));
  assert.equal(pending.needsConfirmation, true);
  assert.throws(() => mt.resolveMerge('demo', conflict.id, pending.token, []), /不完整/);
  assert.throws(() => mt.resolveMerge('demo', conflict.id, pending.token, [{ index: 0, action: 'force' }]), /无效/);
  mt.resolveMerge('demo', conflict.id, pending.token, [{ index: 0, action: 'drop' }]);
  assert.deepEqual(mt.search('disabled', { project: 'demo' }), []);
  assert.equal(mt.search('disabled', { project: 'demo', includeHistorical: true })[0].status, 'rejected');

  const stale = mt.openBranch('demo', 'stale preview');
  const stalePreview = mt.mergeBranch('demo', stale.id, proposal(entry('Alpha OAuth2 PKCE updated')));
  const add = second.openBranch('demo', 'concurrent change');
  second.mergeBranch('demo', add.id, proposal(entry('Unrelated settings')));
  assert.throws(() => mt.resolveMerge('demo', stale.id, stalePreview.token, [{ index: 0, action: 'replace' }]), /失效/);
  const fresh = mt.mergeBranch('demo', stale.id, proposal(entry('Alpha OAuth2 PKCE updated')));
  mt.resolveMerge('demo', stale.id, fresh.token, [{ index: 0, action: 'replace' }]);
  assert.equal(mt.search('enabled', { project: 'demo', includeHistorical: true })[0].status, 'superseded');

  const branch = mt.openBranch('demo', 'commit failure');
  const before = mt.loadProject('demo');
  const next = path.join(before.revisionDir, String(before.revision + 1).padStart(12, '0') + '.json');
  fs.mkdirSync(next);
  try {
    assert.throws(() => mt.mergeBranch('demo', branch.id, proposal(entry('Recovery sentinel'))));
    assert.equal(mt.branch(mt.loadProject('demo'), branch.id).status, 'active');
    assert.ok(!mt.getMainline('demo').decisions.includes('Recovery sentinel'));
  } finally {
    fs.rmdirSync(next);
  }
  mt.mergeBranch('demo', branch.id, proposal(entry('Recovery sentinel')));
  assert.throws(() => second.save(before, {}), /状态已变化/);
  assert.equal(second.branch(second.loadProject('demo'), branch.id).status, 'archived');

  const legacy = path.join(root, 'Legacy');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'mainline.state.json'), JSON.stringify({
    constraints: [], decisions: ['旧主线'], results: [], openQuestions: [], baselineCheckpoint: null,
  }));
  fs.writeFileSync(path.join(legacy, 'mainline.events.jsonl'), JSON.stringify({ role: 'user', text: '原始事件' }) + '\n');
  const cp = second.checkpoint('legacy', '阶段复盘', '复盘正文');
  assert.match(second.getCheckpoint('LEGACY', cp.id).markdown, /旧主线/);
  assert.deepEqual(second.search('复盘正文', { project: 'legacy' }), []);
  assert.equal(second.search('复盘正文', { project: 'legacy', includeHistorical: true })[0].status, 'checkpoint');
  assert.match(second.getContext('legacy').context, /原始事件/);
  assert.doesNotMatch(second.getContext('legacy', 0).context, /原始事件/);
  assert.equal(second.getMainline('legacy').baselineCheckpoint, cp.id);
  assert.equal(second.search('旧主线', { project: 'legacy' })[0].verification, 'legacy');

  fs.writeFileSync(path.join(root, '_config.json'), 'broken');
  assert.throws(() => new MemoryTree(root), /无法读取记忆文件/);
  console.log('PASS engine: read-only tools, scope, migration, conflict review, stale writes, failed commit, checkpoint');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
