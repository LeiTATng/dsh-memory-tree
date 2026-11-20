import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const name = 'dsh-memory-tree';
export const inject = ['mcpManager'];

export function apply(ctx) {
  const memoryRoot = process.env.MEMORY_TREE_ROOT ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory-tree');
  ctx.mcpManager.register('memory-tree', {
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.js', import.meta.url))],
    env: {
      MEMORY_TREE_ROOT: path.resolve(memoryRoot),
      // The desktop runtime uses Electron as its Node executable.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
}
