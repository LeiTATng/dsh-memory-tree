// dsh-memory-tree — 轻量本地语义检索（零依赖，离线可用）
//
// 说明：这是 lexical-semantic 检索（基于分词重叠 + 余弦），不是稠密向量嵌入。
// 在零依赖约束下，对中文采用「字 uni-gram + bi-gram」、对英文/数字采用「词 token」，
// 即可在无外部模型/网络的情况下提供可用的语义检索兜底，覆盖「忘了记忆落在哪棵子树」的场景。
//
// 质量边界：词法重叠对同义改写（如「鉴权」vs「认证」）不敏感；如需更高召回，可后续接入
// 外部 embedding API（但会破坏零依赖）。当前实现刻意保持纯标准库。

// 分词：英文/数字词 + 中文 uni/bi-gram（加前缀避免与英文 token 碰撞）
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  // 英文 / 数字词（带尾随数字的，额外产出一个去数字变体，提升 oauth2↔oauth 这类召回）
  const en = s.match(/[a-z0-9]+/g) || [];
  for (const w of en) {
    tokens.push(w);
    const m = w.match(/^([a-z]+?)\d+$/);
    if (m) tokens.push(m[1]);
  }
  // 中文：去非汉字后取 uni-gram 与 bi-gram
  const cn = s.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cn.length; i++) {
    tokens.push('u:' + cn[i]);
    if (i + 1 < cn.length) tokens.push('b:' + cn.slice(i, i + 2));
  }
  return tokens;
}

// 词频向量（term -> count）
export function tf(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// 余弦相似度（输入两个 term->weight 的 Map）
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  // 在较小向量上迭代
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const w2 = big.get(t);
    if (w2) dot += w * w2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 倒排/向量索引：doc = { id, project, type, source, text, vec }
export class SemanticIndex {
  constructor() { this.docs = []; }
  add(id, project, type, source, text) {
    const tokens = tokenize(text);
    if (!tokens.length) return;
    this.docs.push({ id, project, type, source, text, vec: tf(tokens) });
  }
  search(query, topK = 5, project = null) {
    const qv = tf(tokenize(query));
    if (!qv.size) return [];
    return this.docs
      .filter(d => !project || d.project === project)
      .map(d => ({ id: d.id, project: d.project, type: d.type, source: d.source, text: d.text, score: +cosine(qv, d.vec).toFixed(4) }))
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
