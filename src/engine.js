import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { tokenize, tf, cosine, SemanticIndex } from './semantic.js';
import { commit, list, publish, readJson, revisions } from './store.js';

const CATEGORIES = {
  constraints: '约束', decisions: '决策', results: '成果', openQuestions: '待解问题',
};
const KEYS = Object.keys(CATEGORIES);
const DEFAULT_IDLE = ['你好', '您好', 'hi', 'hello', '在吗', '谢谢', '感谢', '哈哈', '好的', '晚安', '天气', '再见'];
const DEFAULT_PROJECT = ['项目', '代码', 'bug', '修复', '实现', '开发', '调研', '分析', '设计', '接口', '部署',
  '测试', '优化', '重构', '需求', '方案', '文档', '报错', '配置', 'git'];
const HEADINGS = new Map([
  ['约束', 'constraints'], ['核心约束', 'constraints'], ['constraints', 'constraints'],
  ['决策', 'decisions'], ['关键决策', 'decisions'], ['decisions', 'decisions'],
  ['结果', 'results'], ['成果', 'results'], ['results', 'results'],
  ['待验证', 'openQuestions'], ['未验证结果', 'openQuestions'], ['待解', 'openQuestions'],
  ['待解问题', 'openQuestions'], ['问题', 'openQuestions'], ['open questions', 'openQuestions'],
]);
const VERIFY = ['user-confirmed', 'tool-verified', 'unverified'];
const MAX_TEXT = 4000;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value, field, limit = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${field} 需要 1–${limit} 个字符`);
  }
  return value.trim();
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function ensureDirectory(dir) {
  const entry = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) throw new Error(`记忆目录类型无效：${path.basename(dir)}`);
}

function markdownLines(markdown) {
  return markdown.split(/\r?\n/).map(line => line.trim().replace(/^[-*]\s+/, ''))
    .filter(line => line && !/^([#>]|-{3,}$)/.test(line));
}

export class MemoryTree {
  constructor(root = path.join(os.homedir(), '.dsh', 'memory-tree')) {
    this.root = path.resolve(root);
    this.config = readJson(path.join(this.root, '_config.json'), {});
    this.activeProject = this.config.activeProject || null;
    this.routing = {
      idleWords: this.config.routing?.idleWords ?? DEFAULT_IDLE,
      projectWords: this.config.routing?.projectWords ?? DEFAULT_PROJECT,
    };
  }

  projectKey(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 100 ||
        name.startsWith('.') || /[\\/:*?"<>|\x00-\x1f]|[.]$/.test(name) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ||
        ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())) {
      throw new Error('无效项目名称');
    }
    return name.normalize('NFC').toLowerCase().normalize('NFC');
  }

  projectPath(name) {
    const key = this.projectKey(name);
    const matches = list(this.root).filter(entry => entry.name.normalize('NFC').toLowerCase().normalize('NFC') === key);
    if (matches.length > 1) throw new Error('检测到名称冲突的旧项目目录，请先核对并迁移');
    if (matches[0] && !matches[0].isDirectory()) throw new Error('项目路径必须是实际目录');
    const project = matches[0]?.name ?? key;
    return { name: project, dir: path.join(this.root, project) };
  }

  loadProject(name, required = true) {
    const project = this.projectPath(name);
    const revisionDir = path.join(project.dir, '.revisions');
    ensureDirectory(revisionDir);
    const legacy = readJson(path.join(project.dir, 'mainline.state.json'), null);
    const branchDir = path.join(project.dir, 'branches');
    ensureDirectory(branchDir);
    const branches = new Map();
    for (const entry of list(branchDir)) {
      if (!entry.isDirectory()) continue;
      const meta = readJson(path.join(branchDir, entry.name, 'meta.json'), null);
      if (meta) branches.set(entry.name, { ...meta, id: entry.name, legacy: true });
    }
    const checkpoints = new Map();
    const entries = new Map((legacy ? KEYS.flatMap(category => legacy[category].map((value, index) => ({
      id: digest([project.name, category, index, value]), category, text: value,
      verification: 'legacy', status: 'current',
    }))) : []).map(entry => [entry.id, entry]));
    let baseline = legacy?.baselineCheckpoint ?? null;
    let updated = legacy?.updated ?? null;
    let revision = 0;
    const archivedEntries = [];
    for (const filename of revisions(revisionDir)) {
      const change = readJson(path.join(revisionDir, filename));
      if (Number(filename.slice(0, -5)) !== ++revision || change?.version !== 1) {
        throw new Error('项目修订记录不连续或版本不受支持');
      }
      for (const id of change.removedIds ?? []) entries.delete(id);
      for (const entry of change.addedEntries ?? []) entries.set(entry.id, entry);
      if (change.archivedEntries) archivedEntries.push(...change.archivedEntries);
      if (change.branch) branches.set(change.branch.id, change.branch);
      if (change.checkpoint) {
        checkpoints.set(change.checkpoint.id, change.checkpoint);
        baseline = change.checkpoint.id;
      }
      updated = change.time;
    }
    const exists = !!(legacy || revision || branches.size);
    if (!exists && required) throw new Error(`项目尚未初始化：${project.name}`);
    return { ...project, exists, revisionDir, revision, entries: [...entries.values()], archivedEntries, branches, checkpoints, baseline, updated };
  }

  save(project, change) {
    return commit(project.revisionDir, project.revision, {
      ...change, version: 1, time: new Date().toISOString(),
    });
  }

  setActiveProject(name) {
    const project = this.loadProject(name, false);
    if (!project.exists) this.save(project, {});
    // Kept as a local preference for status. Calls carrying project data
    // always use an explicit project, even when DSH shares an MCP process.
    this.activeProject = project.name;
    return project.name;
  }

  getMainline(name) {
    const project = this.loadProject(name);
    return {
      ...Object.fromEntries(KEYS.map(key => [key, project.entries.filter(item => item.category === key).map(item => item.text)])),
      updated: project.updated,
      baselineCheckpoint: project.baseline,
    };
  }

  render(project) {
    const sections = KEYS.map(key => {
      const entries = project.entries.filter(entry => entry.category === key);
      if (!entries.length) return `## ${CATEGORIES[key]}\n\n（暂无）`;
      return `## ${CATEGORIES[key]}\n\n` + entries.map(entry => {
        const metadata = [entry.date, entry.source, entry.verification].filter(Boolean).join(' · ');
        return `- ${entry.text} [${entry.id}] (${metadata})`;
      }).join('\n');
    });
    return [`# ${project.name}`, `基线：${project.baseline ?? '无'}`, ...sections].join('\n\n');
  }

  getContext(name, maxRecent = 6) {
    if (!Number.isInteger(maxRecent) || maxRecent < 0 || maxRecent > 40) throw new Error('maxRecent 必须是 0–40 的整数');
    const project = this.loadProject(name);
    const recent = maxRecent ? readText(path.join(project.dir, 'mainline.events.jsonl')).trim().split('\n')
      .filter(Boolean).slice(-maxRecent).map(line => {
        const event = JSON.parse(line);
        return `- [${event.role}] ${event.text.slice(0, 300)}`;
      }).join('\n') : '';
    const content = this.render(project) + (recent ? `\n\n## 最近主线记录\n${recent}` : '');
    return {
      project: project.name, revision: project.revision, truncated: content.length > 12000,
      context: content.slice(0, 12000), trust: 'reference',
    };
  }

  route(message, project) {
    const msg = text(message, 'message', 16000).toLowerCase();
    const score = this.routing.projectWords.filter(word => msg.includes(word.toLowerCase())).length * 2 -
      this.routing.idleWords.filter(word => msg.includes(word.toLowerCase())).length * 2;
    if (project !== undefined) return { route: 'project', score, advisory: true, ...this.getContext(project) };
    return { route: score > 0 ? 'project' : 'undetermined', project: null, score, advisory: true };
  }

  openBranch(name, title = '未命名支线') {
    const project = this.loadProject(name);
    const branch = {
      id: `branch-${randomUUID()}`, project: project.name, title: text(title, 'title', 200),
      created: new Date().toISOString(), status: 'active',
    };
    this.save(project, { branch });
    return branch;
  }

  branch(project, id) {
    const branch = project.branches.get(id);
    if (!branch) throw new Error('支线不存在');
    return branch;
  }

  listBranches(name) {
    return [...this.loadProject(name).branches.values()].map(({ pending, ...branch }) => branch);
  }

  parseSummary(summary) {
    const items = [];
    let category;
    for (const line of text(summary, 'summary', 32000).split(/\r?\n/)) {
      const heading = line.trim().match(/^##\s+(.+)$/);
      if (heading) {
        category = HEADINGS.get(heading[1].trim().toLowerCase());
        if (!category) throw new Error(`无法识别的摘要标题：${heading[1]}`);
      }
      const item = line.trim().match(/^[-*]\s+(.+)$/);
      if (item) {
        if (!category) throw new Error('条目必须放在已知的二级标题下');
        // Legacy Markdown cannot establish who verified a fact. Preserve it
        // with explicit uncertainty; typed entries carry verified provenance.
        items.push({ category, text: item[1], verification: 'unverified' });
      }
    }
    return items;
  }

  proposedEntries(branch, summary, entries) {
    if ((summary === undefined) === (entries === undefined)) throw new Error('请提供 summary 或 entries 中的一项');
    const proposed = summary === undefined ? entries : this.parseSummary(summary);
    if (!Array.isArray(proposed) || !proposed.length || proposed.length > 50) throw new Error('合并需要 1–50 条结构化结论');
    return proposed.map(item => {
      if (!item || !KEYS.includes(item.category) || !VERIFY.includes(item.verification)) throw new Error('结论类别或验证状态无效');
      const date = item.date === undefined && summary !== undefined ? undefined : text(item.date, 'date', 10);
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('date 必须是有效的 YYYY-MM-DD 日期');
      const source = summary !== undefined ? branch.id : text(item.source, 'source', 500);
      return {
        category: item.verification === 'unverified' ? 'openQuestions' : item.category,
        intendedCategory: item.category, text: text(item.text, 'text'),
        verification: item.verification, source, date,
      };
    });
  }

  detectConflicts(current, candidates) {
    const conflicts = [];
    const clean = [];
    for (const entry of candidates) {
      const peers = current.filter(existing => existing.category === entry.category);
      if (peers.some(existing => existing.text === entry.text)) continue;
      const vector = tf(tokenize(entry.text));
      let best;
      for (const existing of peers) {
        const score = cosine(vector, tf(tokenize(existing.text)));
        if (score >= 0.5 && (!best || score > best.score)) best = { existing, score };
      }
      if (best) conflicts.push({ index: conflicts.length, proposed: entry, ...best });
      else clean.push(entry);
    }
    return { clean, conflicts };
  }

  mergeBranch(name, id, proposal) {
    const project = this.loadProject(name);
    const branch = this.branch(project, id);
    if (branch.status === 'archived') return { id, archived: true, alreadyMerged: true };
    const candidates = this.proposedEntries(branch, proposal.summary, proposal.entries);
    const { clean, conflicts } = this.detectConflicts(project.entries, candidates);
    if (!conflicts.length) return this.applyMerge(project, branch, clean, []);
    const pending = {
      token: randomUUID(), state: digest([project.entries, project.baseline]), clean, conflicts,
    };
    this.save(project, { branch: { ...branch, pending } });
    return { id, needsConfirmation: true, token: pending.token, conflicts };
  }

  resolveMerge(name, id, token, resolutions) {
    const project = this.loadProject(name);
    const branch = this.branch(project, id);
    if (branch.status === 'archived') return { id, archived: true, alreadyMerged: true };
    const pending = branch.pending;
    if (!pending || pending.token !== token || pending.state !== digest([project.entries, project.baseline])) {
      throw new Error('合并预览已失效，请重新预览并确认');
    }
    if (!Array.isArray(resolutions) || resolutions.length !== pending.conflicts.length) throw new Error('冲突决议不完整');
    const actions = new Map();
    for (const resolution of resolutions) {
      if (!resolution || !Number.isInteger(resolution.index) || !pending.conflicts[resolution.index] ||
          actions.has(resolution.index) || !['keepBoth', 'replace', 'drop'].includes(resolution.action)) {
        throw new Error('冲突决议无效或重复');
      }
      actions.set(resolution.index, resolution.action);
    }
    const conflicts = pending.conflicts.map(conflict => ({ ...conflict, action: actions.get(conflict.index) }));
    const replacements = conflicts.filter(conflict => conflict.action === 'replace');
    if (new Set(replacements.map(conflict => conflict.existing.id)).size !== replacements.length) {
      throw new Error('同一条主线记录只能被替换一次');
    }
    return this.applyMerge(project, branch, pending.clean, conflicts);
  }

  applyMerge(project, branch, clean, conflicts) {
    const { pending, ...meta } = branch;
    const accepted = [...clean];
    const archivedEntries = [];
    const replaced = new Set();
    for (const { action, existing, proposed } of conflicts) {
      if (action === 'drop') {
        archivedEntries.push({ ...proposed, id: randomUUID(), branchId: branch.id, status: 'rejected' });
        continue;
      }
      accepted.push(proposed);
      if (action === 'replace') {
        replaced.add(existing.id);
        archivedEntries.push({ ...existing, status: 'superseded' });
      }
    }
    const current = project.entries.filter(entry => !replaced.has(entry.id));
    const addedEntries = [];
    for (const proposed of accepted) {
      if (![...current, ...addedEntries].some(entry => entry.category === proposed.category && entry.text === proposed.text)) {
        addedEntries.push({ ...proposed, id: randomUUID(), branchId: branch.id, status: 'current' });
      }
    }
    const archived = { ...meta, status: 'archived', archivedAt: new Date().toISOString() };
    this.save(project, { addedEntries, removedIds: [...replaced], archivedEntries, branch: archived });
    return { id: branch.id, archived: true, decisions: conflicts.map(({ index, action }) => ({ index, action })) };
  }

  checkpoint(name, title = '阶段快照', review = '') {
    const project = this.loadProject(name);
    const id = `cp-${randomUUID()}`;
    const checkpoint = {
      id, title: text(title, 'title', 200), created: new Date().toISOString(),
      review: review === '' ? '' : text(review, 'review', 16000),
      entries: project.entries, previousBaseline: project.baseline,
    };
    this.save(project, { checkpoint });
    return { id, title: checkpoint.title, project: project.name };
  }

  getCheckpoint(name, id) {
    const project = this.loadProject(name);
    const checkpoint = project.checkpoints.get(id);
    if (checkpoint) return {
      id, title: checkpoint.title, created: checkpoint.created, previousBaseline: checkpoint.previousBaseline,
      markdown: [`# ${checkpoint.title}`, checkpoint.review, this.render({
        ...project, entries: checkpoint.entries, baseline: checkpoint.previousBaseline,
      })].filter(Boolean).join('\n\n'),
    };
    if (typeof id !== 'string' || !/^cp-[a-f0-9]{8}$/.test(id)) throw new Error('快照不存在');
    const markdown = readText(path.join(project.dir, 'checkpoints', `${id}.md`));
    if (!markdown) throw new Error('快照不存在');
    return { id, markdown };
  }

  recordChat(name, role, message) {
    const project = this.loadProject(name);
    if (!['user', 'assistant'].includes(role)) throw new Error('role 必须是 user 或 assistant');
    const chatDir = path.join(project.dir, 'chat');
    ensureDirectory(chatDir);
    const content = JSON.stringify({ role, text: text(message, 'message', 2000), time: new Date().toISOString() });
    publish(path.join(chatDir, `${Date.now()}-${randomUUID()}.json`), content);
    const files = list(chatDir).filter(entry => entry.isFile() && /^\d+-[a-f0-9-]{36}\.json$/.test(entry.name))
      .map(entry => entry.name).sort();
    for (const old of files.slice(0, -20)) {
      try {
        fs.unlinkSync(path.join(chatDir, old));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { stored: true };
  }

  projectNames() {
    return list(this.root).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name).filter(name => this.loadProject(name, false).exists);
  }

  search(query, { project, scope, includeHistorical = false, topK = 5 } = {}) {
    text(query, 'query', 2000);
    if (!Number.isInteger(topK) || topK < 1 || topK > 50) throw new Error('topK 必须是 1–50 的整数');
    if (typeof includeHistorical !== 'boolean' || (scope !== undefined && scope !== 'all') ||
        (scope === 'all') === (project !== undefined)) throw new Error('请指定 project，或使用 scope: all 进行跨项目检索');
    const index = new SemanticIndex();
    const metadata = new Map();
    for (const name of scope === 'all' ? this.projectNames() : [project]) {
      const snapshot = this.loadProject(name);
      const records = [...snapshot.entries];
      if (includeHistorical) {
        records.push(...snapshot.archivedEntries);
        for (const checkpoint of snapshot.checkpoints.values()) {
          for (const entry of checkpoint.entries) records.push({
            ...entry, id: `${checkpoint.id}:${entry.id}`, source: checkpoint.id, status: 'checkpoint',
          });
          markdownLines(checkpoint.review).forEach((value, line) => records.push({
            id: `${checkpoint.id}:review:${line}`, text: value, source: checkpoint.id,
            status: 'checkpoint', verification: 'unverified',
          }));
        }
        this.addLegacyHistory(snapshot, records);
      }
      for (const { id, category, source, text: value, ...details } of records) {
        metadata.set(`${name}:${id}`, details);
        index.add(id, name, category, source ?? 'mainline', value);
      }
    }
    return index.search(query, topK).map(hit => {
      const details = metadata.get(`${hit.project}:${hit.id}`);
      return { ...hit, ...details, historical: details.status !== 'current', text: hit.text.slice(0, 1200) };
    });
  }

  addLegacyHistory(project, records) {
    for (const branch of project.branches.values()) {
      if (!branch.legacy || branch.status !== 'archived') continue;
      const file = path.join(project.dir, 'branches', branch.id, 'conclusion.md');
      markdownLines(readText(file)).forEach((value, index) => records.push({
        id: `${branch.id}:${index}`, text: value, source: branch.id, status: 'legacy', verification: 'legacy',
      }));
    }
    const directory = path.join(project.dir, 'checkpoints');
    ensureDirectory(directory);
    for (const file of list(directory)) {
      if (!file.isFile() || !/^cp-[a-f0-9]{8}\.md$/.test(file.name)) continue;
      markdownLines(readText(path.join(directory, file.name))).forEach((value, index) => records.push({
        id: `${file.name}:${index}`, text: value, source: file.name, status: 'legacy', verification: 'legacy',
      }));
    }
  }

  status(name) {
    if (name === undefined) return { activeProject: this.activeProject, projects: this.projectNames() };
    const project = this.loadProject(name);
    return {
      project: project.name, revision: project.revision, baseline: project.baseline,
      mainline: Object.fromEntries(KEYS.map(key => [key, project.entries.filter(item => item.category === key).length])),
      activeBranches: [...project.branches.values()].filter(branch => branch.status === 'active')
        .map(({ id, title }) => ({ id, title })),
    };
  }
}
