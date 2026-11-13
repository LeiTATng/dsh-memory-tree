// dsh-memory-tree — 记忆树引擎（纯 Node 标准库，零依赖）
// 实现：隔离路由 / 记忆树（Root+Branch）/ Merge / Checkpoint / 三套上下文压缩策略
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { tokenize, tf, cosine, SemanticIndex } from './semantic.js';

const MERGE_CONFLICT_THRESHOLD = 0.5; // 支线新项与主线同类别已存在项的余弦相似度 >= 此值且非精确重复 → 判为冲突，需用户确认

const DEFAULT_IDLE = ['你好', '您好', 'hi', 'hello', '在吗', '在不在', '谢谢', '感谢', '哈哈',
  '哦哦', '好的', '了解', '辛苦了', '早上好', '晚安', '今天', '天气', '吃饭', '早', '晚安咯',
  '谢谢哈', '多谢', '拜拜', '再见', '嗯嗯', '啊这', '笑死', '666', '牛', '赞'];
const DEFAULT_PROJECT = ['项目', '代码', 'bug', '修复', '实现', '开发', '调研', '分析', '设计',
  '架构', '接口', '函数', '类', '模块', '部署', '测试', '优化', '重构', '需求', '方案', '文档',
  '报错', '异常', '日志', '服务端', '前端', '后端', '数据库', 'api', '算法', '性能', '样式',
  '组件', '路由', '状态', '配置', '脚本', '命令行', 'cli', 'git', '编译', '构建', '依赖'];

function nowISO() { return new Date().toISOString(); }
function rid(prefix) { return prefix + '-' + crypto.randomBytes(4).toString('hex'); }

export class MemoryTree {
  constructor(root) {
    this.root = root || path.join(os.homedir(), '.dsh', 'memory-tree');
    fs.mkdirSync(this.root, { recursive: true });
    this.configPath = path.join(this.root, '_config.json');
    this.config = this.loadConfig();
  }

  // ---------- 配置 ----------
  loadConfig() {
    if (fs.existsSync(this.configPath)) {
      try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch {}
    }
    return {
      activeProject: null,
      defaultProject: 'default',
      projects: {},
      routing: { idleWords: DEFAULT_IDLE.slice(), projectWords: DEFAULT_PROJECT.slice() }
    };
  }
  saveConfig() { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2)); }

  // ---------- 路径 ----------
  projDir(name) { const d = path.join(this.root, name); fs.mkdirSync(d, { recursive: true }); return d; }
  mainlineStatePath(name) { return path.join(this.projDir(name), 'mainline.state.json'); }
  mainlineMdPath(name) { return path.join(this.projDir(name), 'mainline.md'); }
  mainlineEventsPath(name) { return path.join(this.projDir(name), 'mainline.events.jsonl'); }
  branchesDir(name) { const d = path.join(this.projDir(name), 'branches'); fs.mkdirSync(d, { recursive: true }); return d; }
  branchDir(name, id) { const d = path.join(this.branchesDir(name), id); fs.mkdirSync(d, { recursive: true }); return d; }
  checkpointsDir(name) { const d = path.join(this.projDir(name), 'checkpoints'); fs.mkdirSync(d, { recursive: true }); return d; }
  chatPath(name) { return path.join(this.projDir(name || this.config.defaultProject), 'chat', 'chat.events.jsonl'); }

  // ---------- 项目/主线 ----------
  ensureProject(name) {
    if (!this.config.projects[name]) this.config.projects[name] = { created: nowISO(), root: name };
    this.saveConfig();
    if (!fs.existsSync(this.mainlineStatePath(name))) {
      const init = { constraints: [], decisions: [], results: [], openQuestions: [],
        updated: nowISO(), baselineCheckpoint: null };
      fs.writeFileSync(this.mainlineStatePath(name), JSON.stringify(init, null, 2));
    }
    return name;
  }
  getMainline(name) {
    this.ensureProject(name);
    return JSON.parse(fs.readFileSync(this.mainlineStatePath(name), 'utf8'));
  }
  saveMainline(name, state) {
    state.updated = nowISO();
    fs.writeFileSync(this.mainlineStatePath(name), JSON.stringify(state, null, 2));
    fs.writeFileSync(this.mainlineMdPath(name), this.renderMainline(name, state));
  }
  renderMainline(name, state) {
    const line = (a) => (a && a.length ? a.map((x, i) => `  ${i + 1}. ${x}`).join('\n') : '  (暂无)');
    return `# 项目主线状态：${name}\n\n> 最后更新：${state.updated}\n> 基线 Checkpoint：${state.baselineCheckpoint || '（无）'}\n\n` +
      `## 核心约束 (constraints)\n${line(state.constraints)}\n\n` +
      `## 关键决策 (decisions)\n${line(state.decisions)}\n\n` +
      `## 成果 (results)\n${line(state.results)}\n\n` +
      `## 待解问题 (openQuestions)\n${line(state.openQuestions)}\n`;
  }
  // 主线追加（结构化，不接受原始聊天）
  appendMainline(name, patch) {
    const s = this.getMainline(name);
    for (const k of ['constraints', 'decisions', 'results', 'openQuestions']) {
      if (patch[k] && Array.isArray(patch[k])) {
        for (const item of patch[k]) if (item && !s[k].includes(item)) s[k].push(item);
      }
    }
    this.saveMainline(name, s);
    return s;
  }
  // 主线事件日志（最近少量主线对话，用于 get_context 注入）
  recordMainlineTurn(name, role, text) {
    const p = this.mainlineEventsPath(name);
    fs.appendFileSync(p, JSON.stringify({ t: nowISO(), role, text: String(text).slice(0, 4000) }) + '\n');
    // 仅保留最近 40 条，避免无限增长（主线不靠滚动摘要，靠结构化 state + 最近少量）
    this.trimLines(p, 40);
  }
  trimLines(p, keep) {
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (lines.length > keep) fs.writeFileSync(p, lines.slice(lines.length - keep).join('\n') + '\n');
  }

  // ---------- 隔离路由 ----------
  classify(message) {
    const msg = String(message || '').toLowerCase();
    let score = 0;
    for (const w of this.config.routing.idleWords) if (msg.includes(w.toLowerCase())) score -= 2;
    for (const w of this.config.routing.projectWords) if (msg.toLowerCase().includes(w.toLowerCase())) score += 2;
    if (/[`~]|\/|\.js|\.ts|\.py|\.go|\.java|\.md|function|def |class |import |http[s]?:\/\//.test(msg)) score += 1;
    if (msg.length > 120) score += 1;
    return score;
  }
  route(message, projectHint) {
    const score = this.classify(message);
    if (score <= 0) {
      return { route: 'chat', project: null, score,
        context: '（闲聊分区，不写入项目主线；激进压缩，细节可丢）' };
    }
    const project = projectHint || this.config.activeProject || this.config.defaultProject;
    this.ensureProject(project);
    const ctx = this.getContext(project, 6);
    return { route: 'project', project, score, context: ctx };
  }
  setActiveProject(name) { this.config.activeProject = name; this.ensureProject(name); this.saveConfig(); return name; }

  // ---------- 支线 ----------
  openBranch(name, title, fromMainline = true) {
    this.ensureProject(name);
    const id = rid('branch');
    const meta = { id, project: name, title: title || '(未命名支线)', parent: fromMainline ? 'mainline' : null,
      created: nowISO(), status: 'active' };
    fs.writeFileSync(path.join(this.branchDir(name, id), 'meta.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(this.branchDir(name, id), 'events.jsonl'), '');
    return meta;
  }
  appendBranchEvent(name, id, role, text) {
    const p = path.join(this.branchDir(name, id), 'events.jsonl');
    fs.appendFileSync(p, JSON.stringify({ t: nowISO(), role, text: String(text).slice(0, 8000) }) + '\n');
  }
  getBranch(name, id) {
    const meta = JSON.parse(fs.readFileSync(path.join(this.branchDir(name, id), 'meta.json'), 'utf8'));
    const ev = fs.existsSync(path.join(this.branchDir(name, id), 'events.jsonl'))
      ? fs.readFileSync(path.join(this.branchDir(name, id), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    return { meta, events: ev };
  }
  listBranches(name) {
    const bd = this.branchesDir(name);
    return fs.readdirSync(bd).filter(d => fs.existsSync(path.join(bd, d, 'meta.json')))
      .map(d => { try { return JSON.parse(fs.readFileSync(path.join(bd, d, 'meta.json'), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  }
  archiveBranch(name, id) {
    const meta = JSON.parse(fs.readFileSync(path.join(this.branchDir(name, id), 'meta.json'), 'utf8'));
    meta.status = 'archived'; meta.archivedAt = nowISO();
    fs.writeFileSync(path.join(this.branchDir(name, id), 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  // ---------- Merge：支线 → 主线（只存结构化结论，不复制原始聊天）----------

  // 支线新项与主线同类别已存在项的最佳匹配（余弦），用于冲突检测
  bestMatch(arr, text) {
    const qv = tf(tokenize(text));
    let best = null;
    arr.forEach((existing, i) => {
      const s = cosine(qv, tf(tokenize(existing)));
      if (!best || s > best.score) best = { index: i, text: existing, score: s };
    });
    return best;
  }
  // 检测冲突：支线结论中，与主线同类别已存在项语义高度相似（非完全重复）的，标记为冲突
  detectMergeConflicts(name, id, summary) {
    const { meta, events } = this.getBranch(name, id);
    const conclusion = summary || this.heuristicExtract(events);
    const patch = this.parseStructured(conclusion);
    const state = this.getMainline(name);
    const conflicts = [];
    const clean = { constraints: [], decisions: [], results: [], openQuestions: [] };
    let ci = 0;
    for (const k of ['constraints', 'decisions', 'results', 'openQuestions']) {
      for (const item of (patch[k] || [])) {
        if (state[k].includes(item)) continue; // 精确重复：静默跳过，不冲突
        const best = this.bestMatch(state[k], item);
        if (best && best.score >= MERGE_CONFLICT_THRESHOLD) {
          conflicts.push({ index: ci++, category: k, newText: item, existingIndex: best.index,
            existingText: best.text, score: +best.score.toFixed(3), action: null, customText: null });
        } else {
          clean[k].push(item);
        }
      }
    }
    return { meta, conclusion, clean, conflicts };
  }
  // 执行合并（写入 conclusion.md + 主线 state + 归档）。conflicts 里带 action/customText 的按决议处理
  applyMerge(name, id, conclusion, clean, conflicts) {
    const { meta } = this.getBranch(name, id);
    const md = `# 支线结论：${meta.title}\n\n> 来源支线：${id}\n> 合并时间：${nowISO()}\n\n${conclusion}\n`;
    fs.writeFileSync(path.join(this.branchDir(name, id), 'conclusion.md'), md);
    const s = this.getMainline(name);
    for (const k of ['constraints', 'decisions', 'results', 'openQuestions'])
      for (const item of clean[k]) if (!s[k].includes(item)) s[k].push(item);
    const applied = [];
    for (const c of (conflicts || [])) {
      const text = (c.customText && c.customText.trim()) ? c.customText.trim() : c.newText;
      if (c.action === 'drop') { applied.push({ category: c.category, action: 'drop' }); continue; }
      if (c.action === 'replace') {
        if (c.existingIndex >= 0 && c.existingIndex < s[c.category].length) s[c.category][c.existingIndex] = text;
        else if (!s[c.category].includes(text)) s[c.category].push(text);
        applied.push({ category: c.category, action: 'replace', text });
      } else { // keepBoth（默认）
        if (!s[c.category].includes(text)) s[c.category].push(text);
        applied.push({ category: c.category, action: 'keepBoth', text });
      }
    }
    this.saveMainline(name, s);
    this.archiveBranch(name, id);
    return { id, title: meta.title, conclusion, appliedClean: clean, appliedConflicts: applied, archived: true };
  }
  // 合并入口：检测到冲突且非强制 → 返回 needsConfirmation，不改动主线；否则直接合并
  mergeBranch(name, id, summary, force = false) {
    const det = this.detectMergeConflicts(name, id, summary);
    if (det.conflicts.length && !force) {
      return { needsConfirmation: true, branchId: id, title: det.meta.title, conclusion: det.conclusion,
        conflicts: det.conflicts,
        hint: '向用户逐条展示 conflicts（newText 与 existingText 对比），征询每项选择：keepBoth(保留两者) / replace(用 newText 覆盖 existingIndex 指向的旧项) / drop(丢弃新项)。然后用 mt_merge_resolve 提交决议。若 mt_merge 用了 summary 触发检测，resolve 时务必传相同 summary。' };
    }
    return this.applyMerge(name, id, det.conclusion, det.clean, det.conflicts);
  }
  // 用户确认后提交决议：resolutions = [{ index, action:'keepBoth'|'replace'|'drop', customText? }]
  resolveMerge(name, id, resolutions, summary = null) {
    const det = this.detectMergeConflicts(name, id, summary);
    if (!det.conflicts.length) return this.applyMerge(name, id, det.conclusion, det.clean, []);
    const map = new Map((resolutions || []).map(r => [r.index, r]));
    if (det.conflicts.some(c => !map.has(c.index))) {
      return { error: 'conflict_mismatch', message: '冲突项与上次检测不一致（支线可能已变动），请重新调用 mt_merge 获取最新 conflicts 再 resolve。' };
    }
    for (const c of det.conflicts) {
      const r = map.get(c.index);
      c.action = (r && r.action) || 'keepBoth';
      c.customText = (r && r.customText) || null;
    }
    return this.applyMerge(name, id, det.conclusion, det.clean, det.conflicts);
  }
  // 启发式抽取：从支线事件里抓决策/结论/风险相关文本
  heuristicExtract(events) {
    const bullets = [];
    for (const e of events) {
      if (e.role !== 'assistant') continue;
      const lines = String(e.text).split('\n');
      for (const ln of lines) {
        const t = ln.trim().replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '');
        if (/决定|结论|建议|结果|结论|方案|根因|修复|注意|风险|约束|必须|应当|不要/.test(t) && t.length > 6 && t.length < 300) bullets.push(t);
      }
    }
    if (!bullets.length && events.length) {
      const last = events[events.length - 1];
      bullets.push(String(last.text).slice(0, 280));
    }
    const uniq = [...new Set(bullets)].slice(0, 12);
    return '## 关键结论\n' + (uniq.length ? uniq.map(b => `- ${b}`).join('\n') : '- (支线未产出明确结论)') + '\n';
  }
  // 把结构化 markdown 解析为 constraints/decisions/results/openQuestions
  // 支持「## 小节标题 + 下方 bullet」写法：标题决定后续 bullet 的归类，直到下一个 ##
  parseStructured(md) {
    const out = { constraints: [], decisions: [], results: [], openQuestions: [] };
    const map = [
      [/约束|constraint/i, 'constraints'], [/决策|决定|decision/i, 'decisions'],
      [/结果|成果|result/i, 'results'], [/问题|疑问|待解|open/i, 'openQuestions']
    ];
    let cur = 'results'; // 默认归类
    for (const ln of String(md).split('\n')) {
      const head = ln.trim().match(/^#{1,3}\s*(.*)$/);
      if (head) {
        let matched = false;
        for (const [re, key] of map) { if (re.test(head[1])) { cur = key; matched = true; break; } }
        if (!matched) cur = 'results';
        continue;
      }
      const m = ln.trim().match(/^[-*]\s+(.*)$/);
      if (!m) continue;
      const text = m[1].trim();
      if (text) out[cur].push(text);
    }
    return out;
  }

  // ---------- Checkpoint： freezing 主线 → 复盘文档 → 新基线 ----------
  checkpoint(name, title, reviewText) {
    this.ensureProject(name);
    const state = this.getMainline(name);
    const id = rid('cp');
    const review = reviewText || this.renderMainline(name, state);
    const doc = `# Checkpoint：${title || id}\n\n> 项目：${name}\n> 冻结时间：${nowISO()}\n> Checkpoint ID：${id}\n\n` +
      `## 复盘\n\n${review}\n\n---\n本 Checkpoint 已作为新基线。本阶段支线引用已清空，原始支线日志保留备查。\n`;
    fs.writeFileSync(path.join(this.checkpointsDir(name), `${id}.md`), doc);
    // 设为新基线，清空主线 openQuestions 之外的阶段性引用（保留结构化 state）
    state.baselineCheckpoint = id;
    this.saveMainline(name, state);
    // 清空主线事件日志（最近对话），以 checkpoint 为新起点
    const ep = this.mainlineEventsPath(name);
    if (fs.existsSync(ep)) fs.writeFileSync(ep, '');
    return { id, path: path.join(this.checkpointsDir(name), `${id}.md`), title: title || id };
  }

  // ---------- 闲聊分区：激进压缩 ----------
  recordChat(project, role, text) {
    const p = this.chatPath(project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ t: nowISO(), role, text: String(text).slice(0, 2000) }) + '\n');
    // 激进压缩：超过 20 条即压成一条摘要占位，细节丢弃（符合设计：闲聊可接受丢细节）
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 20) {
      const keep = lines.slice(-5);
      const summary = `# 闲聊压缩摘要 @${nowISO()}\n前 ${lines.length - 5} 条闲聊已压缩丢弃（激进压缩策略）。近期 ${keep.length} 条保留。`;
      fs.writeFileSync(p, summary + '\n' + keep.join('\n') + '\n');
    }
  }

  // ---------- 上下文获取（主线：结构化 state + 最近少量主线对话）----------
  getContext(name, maxRecent = 6) {
    const state = this.getMainline(name);
    const md = this.renderMainline(name, state);
    let recent = '';
    const ep = this.mainlineEventsPath(name);
    if (fs.existsSync(ep)) {
      const lines = fs.readFileSync(ep, 'utf8').split('\n').filter(Boolean).slice(-maxRecent);
      if (lines.length) {
        recent = '\n## 最近主线对话（仅少量，不滚动摘要）\n' +
          lines.map(l => { try { const o = JSON.parse(l); return `- [${o.role}] ${o.text.slice(0, 300)}`; } catch { return ''; } }).filter(Boolean).join('\n');
      }
    }
    return md + recent + '\n\n> 注：支线原始日志默认不注入本上下文窗口；需合并请调用 mt_merge。';
  }

  // ---------- 语义检索（轻量本地向量，零依赖，覆盖全部项目记忆）----------
  // 检索范围：主线结构化条目 + 各支线结论(conclusion.md) + 各 Checkpoint 复盘全文
  semanticSearch(query, topK = 5, project = null) {
    const idx = new SemanticIndex();
    const projects = Object.keys(this.config.projects);
    for (const p of projects) {
      if (project && p !== project) continue;
      const s = this.getMainline(p);
      for (const k of ['constraints', 'decisions', 'results', 'openQuestions'])
        s[k].forEach((item, i) => idx.add(`main:${p}:${k}:${i}`, p, k, 'mainline', item));
      // 支线结论
      const bd = this.branchesDir(p);
      if (fs.existsSync(bd)) for (const d of fs.readdirSync(bd)) {
        const cp = path.join(bd, d, 'conclusion.md');
        if (!fs.existsSync(cp)) continue;
        for (const ln of fs.readFileSync(cp, 'utf8').split('\n')) {
          const t = ln.trim().replace(/^[-*]\s*/, '');
          if (t && !ln.startsWith('#') && !ln.startsWith('>') && t.length > 4) idx.add(`branch:${p}:${d}`, p, 'conclusion', `branch:${d}`, t);
        }
      }
      // Checkpoint 复盘
      const cd = this.checkpointsDir(p);
      if (fs.existsSync(cd)) for (const f of fs.readdirSync(cd).filter(f => f.endsWith('.md'))) {
        for (const ln of fs.readFileSync(path.join(cd, f), 'utf8').split('\n')) {
          const t = ln.trim().replace(/^[-*]\s*/, '');
          if (t && !ln.startsWith('#') && !ln.startsWith('>') && t.length > 4) idx.add(`cp:${p}:${f}`, p, 'checkpoint', f, t);
        }
      }
    }
    return idx.search(query, topK, project);
  }

  // ---------- 状态总览 ----------
  status() {
    const active = this.config.activeProject || this.config.defaultProject;
    const branches = this.listBranches(active).filter(b => b.status === 'active');
    const s = this.getMainline(active);
    return {
      activeProject: active,
      mainline: { constraints: s.constraints.length, decisions: s.decisions.length,
        results: s.results.length, openQuestions: s.openQuestions.length, baseline: s.baselineCheckpoint },
      activeBranches: branches.map(b => ({ id: b.id, title: b.title, created: b.created })),
      routing: { idleWords: this.config.routing.idleWords.length, projectWords: this.config.routing.projectWords.length }
    };
  }
}
