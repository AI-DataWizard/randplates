// scripts/lib/wall.mjs — P-443: the full regression wall as subprocesses.
// The harness never re-implements the unit goldens or the E2E checks —
// it invokes the existing harnesses and merges their summaries.
import { spawnSync } from 'node:child_process';
import { ROOT_DIR } from './engine-loader.mjs';

export function unitWall() {
  const r = spawnSync('node', ['tests/run-node.mjs'], { cwd: ROOT_DIR, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\/(\d+) scenarios/);
  return { pass: !!m && m[1] === m[2] && r.status === 0,
           summary: m ? m[1] + '/' + m[2] + ' unit scenarios' : out.trim().split('\n').pop() };
}

export function e2eWall() {
  spawnSync('bash', ['-c', 'cd ' + ROOT_DIR + ' && (setsid nohup python3 serve.py >/tmp/rp-serve.log 2>&1 < /dev/null &) ; sleep 2'], { encoding: 'utf8' });
  const r = spawnSync('bash', ['-c', 'cd ' + ROOT_DIR + ' && timeout 650 python3 scripts/qa-p404.py'], { encoding: 'utf8', timeout: 700000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) pass, (\d+) fail/);
  return { pass: !!m && m[2] === '0', summary: m ? m[1] + ' E2E, ' + m[2] + ' fail' : out.trim().split('\n').pop() };
}
