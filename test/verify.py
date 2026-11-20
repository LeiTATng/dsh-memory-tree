"""Run syntax, engine and real subprocess MCP checks in temporary stores."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
node = os.environ.get('DSH_TEST_NODE', 'node')
commands = [[node, '--check', str(file)] for file in sorted((root / 'src').glob('*.js'))]
commands.extend([[node, 'test/regression.mjs'], [sys.executable, '-B', 'test/protocol.py']])
for command in commands:
    subprocess.run(command, cwd=root, check=True, timeout=40)
print('All isolated checks passed')
