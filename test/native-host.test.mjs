// Smoke test: the native host must launch and answer a ping. This guards
// against regressions like the host file being loaded under the wrong module
// system (CommonJS vs ESM) — which silently breaks "Smart group".
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const host = fileURLToPath(new URL('../native/claude_host.js', import.meta.url));

function ping() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [host], { stdio: ['pipe', 'pipe', 'pipe'] });
    const body = Buffer.from(JSON.stringify({ type: 'ping' }), 'utf8');
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(body.length, 0);
    const chunks = []; let need = null, errOut = '';
    const to = setTimeout(() => { child.kill(); reject(new Error('host did not respond' + (errOut ? ': ' + errOut.slice(0, 200) : ''))); }, 8000);
    child.stdout.on('data', (d) => {
      chunks.push(d); const b = Buffer.concat(chunks);
      if (need === null && b.length >= 4) need = b.readUInt32LE(0);
      if (need !== null && b.length >= 4 + need) { clearTimeout(to); try { resolve(JSON.parse(b.slice(4, 4 + need).toString('utf8'))); } catch (e) { reject(e); } }
    });
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', reject);
    child.stdin.write(Buffer.concat([hdr, body])); child.stdin.end();
  });
}

let fails = 0;
const check = (l, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) fails++; };
try {
  const r = await ping();
  check('host launches and replies to ping', r && r.ok === true && r.pong === true);
} catch (e) {
  check('host launches and replies to ping (' + e.message + ')', false);
}
console.log(fails ? `\n${fails} FAILURES` : '\nNATIVE HOST: ALL PASS');
process.exit(fails ? 1 : 0);
