'use strict';
// Native-messaging host for Tab Organizer.
// Chrome launches this (via the generated claude-host.sh wrapper), sends one
// length-prefixed JSON message, waits for one length-prefixed JSON reply, then
// closes us. We shell out to the local `claude` CLI in headless print mode to
// cluster tabs — so smart-grouping uses the user's existing Claude auth and no
// API key is needed.

const { spawn } = require('child_process');

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const SYSTEM =
  'You are a pure function that clusters browser tabs into 3-6 groups by topic, ' +
  'project, or intent (e.g. "Job search", "Side project", "Reading"). ' +
  'Input is a JSON array of tabs (each {id:int, title, url}), or an object ' +
  '{tabs:[...], existingGroups:[names]}. When existingGroups is given, prefer ' +
  'assigning tabs to those exact names when they fit; only create a new group ' +
  'for tabs that fit none. ' +
  'Output ONLY a JSON array — no prose, no markdown fences, no questions: ' +
  '[{"groupName":string up to 18 chars,"color":one of grey|blue|red|yellow|green|pink|purple|cyan|orange,' +
  '"tabIds":[int]}] using the integer id of each tab. Every input tab id must appear in exactly one group.';

// ── Native messaging framing (4-byte LE length prefix + UTF-8 JSON) ───────────
function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let needed = null;
    process.stdin.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (needed === null && buf.length >= 4) needed = buf.readUInt32LE(0);
      if (needed !== null && buf.length >= 4 + needed) {
        try { resolve(JSON.parse(buf.slice(4, 4 + needed).toString('utf8'))); }
        catch (e) { reject(e); }
      }
    });
    process.stdin.on('end', () => { if (needed === null) reject(new Error('empty stdin')); });
    process.stdin.on('error', reject);
  });
}
function sendMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function extractArray(text) {
  let t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  const arr = JSON.parse(t);
  if (!Array.isArray(arr)) throw new Error('model did not return a JSON array');
  return arr;
}

function runClaude(input) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', MODEL,
      '--output-format', 'json',
      '--system-prompt', SYSTEM,
      '--exclude-dynamic-system-prompt-sections',
      '--allowedTools', '',
    ];
    const child = spawn(CLAUDE, args, {
      // Chrome gives native hosts a minimal env; rebuild a usable PATH so the
      // CLI and its helpers resolve. HOME is inherited (claude reads ~/.claude).
      env: {
        ...process.env,
        PATH: [
          process.env.HOME + '/.local/bin',
          '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
          process.env.PATH || '',
        ].join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', errOut = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e) => reject(new Error('cannot launch claude: ' + e.message)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('claude exited ' + code + ': ' + errOut.slice(0, 400)));
      let env;
      try { env = JSON.parse(out); }
      catch (e) { return reject(new Error('claude output not JSON: ' + out.slice(0, 300))); }
      if (env.is_error) return reject(new Error('claude error: ' + String(env.result || '').slice(0, 300)));
      try { resolve(extractArray(env.result)); }
      catch (e) { reject(new Error('parse failed: ' + e.message)); }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

(async () => {
  try {
    const msg = await readMessage();
    if (msg && msg.type === 'ping') {
      sendMessage({ ok: true, pong: true, model: MODEL });
      return;
    }
    const tabs = Array.isArray(msg && msg.tabs) ? msg.tabs.slice(0, 300) : [];
    if (!tabs.length) { sendMessage({ ok: false, error: 'no tabs supplied' }); return; }
    const existingGroups = Array.isArray(msg && msg.existingGroups) ? msg.existingGroups : [];
    const input = existingGroups.length ? { tabs, existingGroups } : tabs;
    const clusters = await runClaude(input);
    sendMessage({ ok: true, clusters });
  } catch (e) {
    sendMessage({ ok: false, error: String((e && e.message) || e) });
  } finally {
    // Give stdout a tick to flush before exit.
    setTimeout(() => process.exit(0), 30);
  }
})();
