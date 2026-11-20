import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REVISION = /^\d{12}\.json$/;

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取记忆文件 ${path.basename(file)}：${error.message}`, { cause: error });
  }
}

export function list(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Publish a fully written record with an exclusive final name. Two MCP
// processes that read the same revision cannot both publish its successor.
export function publish(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.pending-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temporary, file);
  } finally {
    // An orphaned temporary file is ignored by readers and cannot block retry.
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      process.stderr.write(`记忆临时文件清理失败：${error.code || error.name}\n`);
    }
  }
}

export function revisions(dir) {
  return list(dir)
    .filter(entry => entry.isFile() && REVISION.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

export function commit(dir, revision, change) {
  const file = path.join(dir, `${String(revision + 1).padStart(12, '0')}.json`);
  try {
    publish(file, JSON.stringify(change, null, 2) + '\n');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('项目状态已变化，请重新读取后重试', { cause: error });
    throw error;
  }
  return file;
}
