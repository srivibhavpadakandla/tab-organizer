// background.js — MV3 service worker. Event-driven and disposable: it can be
// killed at any moment, so it reads settings/rules from chrome.storage on every
// run. The only cross-run state it keeps is the set of groups IT created, which
// lives in chrome.storage.session (session-scoped, like tab/group IDs) — never
// authoritative in-memory state.

import { groupKeyForHost } from './psl.js';

// ── Constants ──────────────────────────────────────────────────────────────
const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
// Palette for deterministic auto-colours. Grey is omitted so auto groups look
// lively; grey stays reachable through rules / colour normalisation.
const AUTO_PALETTE = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const TAB_GROUP_ID_NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
const DEBOUNCE_MS = 700; // batch rapid tab bursts into one (smart-auto) pass
const URL_TEST_CAP = 2000; // cap URL length fed to user regex/glob (ReDoS guard)
const OTHER_TITLE = 'Other'; // catch-all group for singleton tabs
const OTHER_COLOR = 'grey';
const OTHER_KEY = 'other';

const NATIVE_HOST = 'com.tab_organizer.claude';
const NATIVE_TIMEOUT_MS = 90000; // a CLI cluster call can take 10-40s
const OWNED_KEY = 'ownedGroups'; // storage.session: { [groupId]: { key, color } }

// smartAuto on by default: the automatic pass clusters tabs by topic with
// Claude (incrementally). Falls back to instant domain grouping with no backend.
const DEFAULT_SETTINGS = { autoGroupEnabled: true, smartAuto: true, minTabs: 2 };
const DEFAULT_RULES = [
  { type: 'domain', match: 'github.com', groupName: 'Code', color: 'blue' },
  { type: 'domain', match: 'gitlab.com', groupName: 'Code', color: 'blue' },
  { type: 'domain', match: 'youtube.com', groupName: 'Watch', color: 'red' },
  { type: 'domain', match: 'netflix.com', groupName: 'Watch', color: 'red' },
  { type: 'domain', match: 'docs.google.com', groupName: 'Docs', color: 'green' },
  { type: 'domain', match: 'notion.so', groupName: 'Docs', color: 'green' },
];

// ── Storage (always read fresh) ──────────────────────────────────────────────
async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getRules() {
  const { rules } = await chrome.storage.sync.get('rules');
  return Array.isArray(rules) ? rules : DEFAULT_RULES;
}
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return (apiKey || '').trim();
}
async function getOwned() {
  try { const o = await chrome.storage.session.get(OWNED_KEY); return o[OWNED_KEY] || {}; }
  catch { return {}; }
}
async function setOwned(map) {
  try { await chrome.storage.session.set({ [OWNED_KEY]: map }); } catch (e) {}
}

// ── Colour helpers ───────────────────────────────────────────────────────────
function hashString(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function autoColorForKey(key) {
  return AUTO_PALETTE[hashString(key) % AUTO_PALETTE.length];
}
const ENUM_RGB = {
  grey: [95, 99, 104], blue: [26, 115, 232], red: [217, 48, 37], yellow: [249, 171, 0],
  green: [24, 128, 56], pink: [208, 24, 132], purple: [161, 66, 244], cyan: [0, 123, 131], orange: [250, 144, 62],
};
const COLOR_SYNONYMS = {
  gray: 'grey', grey: 'grey', silver: 'grey', slate: 'grey',
  blue: 'blue', navy: 'blue', azure: 'blue', cobalt: 'blue', sky: 'blue',
  red: 'red', crimson: 'red', maroon: 'red', scarlet: 'red',
  yellow: 'yellow', gold: 'yellow',
  amber: 'orange', orange: 'orange', tangerine: 'orange', coral: 'orange',
  green: 'green', lime: 'green', emerald: 'green', mint: 'green', olive: 'green',
  teal: 'cyan', cyan: 'cyan', aqua: 'cyan', turquoise: 'cyan',
  pink: 'pink', magenta: 'pink', fuchsia: 'pink', rose: 'pink', salmon: 'pink',
  purple: 'purple', violet: 'purple', indigo: 'purple', lavender: 'purple', plum: 'purple',
};
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function nearestEnumColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = 'grey', bestD = Infinity;
  for (const [name, [R, G, B]] of Object.entries(ENUM_RGB)) {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}
function normalizeColor(input) {
  if (input == null) return null;
  const c = String(input).trim().toLowerCase();
  if (!c) return null;
  if (TAB_GROUP_COLORS.includes(c)) return c;
  if (COLOR_SYNONYMS[c]) return COLOR_SYNONYMS[c];
  if (/^#?[0-9a-f]{3}$/.test(c) || /^#?[0-9a-f]{6}$/.test(c)) return nearestEnumColor(c);
  return null;
}

// ── Title helper ─────────────────────────────────────────────────────────────
function titleFromKey(key) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(key) || key.includes(':')) return key; // IP / weird host
  const label = key.split('.')[0] || key; // registrable domain's first label is the SLD
  const pretty = label.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return (pretty || key).slice(0, 40);
}

// ── Eligibility & rule matching ──────────────────────────────────────────────
function isEligibleTab(tab) {
  if (!tab || tab.pinned || tab.id == null) return false;
  const url = tab.url || tab.pendingUrl || '';
  return /^https?:\/\//i.test(url); // skips chrome://, new tab, extension, file://, about:
}
function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function globToRegex(glob) {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}
// Compile each rule once per grouping pass into a cheap test() closure. This
// hoists RegExp construction out of the per-tab loop and length-caps the tested
// URL so a pathological user regex can't wedge the worker (ReDoS guard).
function compileRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => {
    const match = (rule && rule.match ? String(rule.match) : '').trim();
    const groupName = (String((rule && rule.groupName) || '').trim() || 'Group').slice(0, 40);
    const color = normalizeColor(rule && rule.color) || autoColorForKey(groupName);
    const type = (rule && rule.type) || 'domain';
    let test;
    if (!match) {
      test = () => false;
    } else if (type === 'regex' || type === 'glob') {
      let re = null;
      try { re = type === 'regex' ? new RegExp(match, 'i') : globToRegex(match); } catch { re = null; }
      test = (url) => {
        if (!re) return false;
        const u = url.length > URL_TEST_CAP ? url.slice(0, URL_TEST_CAP) : url;
        return re.test(u);
      };
    } else {
      const m = match.toLowerCase().replace(/^\*?\.?/, '');
      test = (_url, host) => host === m || host.endsWith('.' + m);
    }
    return { test, groupName, color };
  });
}

// Decide the target group for a tab: { key, title, color, fromRule } or null.
async function computeTarget(tab, compiled) {
  const url = tab.url || tab.pendingUrl || '';
  const host = hostnameOf(url);
  for (const r of compiled) {
    if (r.test(url, host)) return { key: 'rule:' + r.groupName, title: r.groupName, color: r.color, fromRule: true };
  }
  const key = await groupKeyForHost(host);
  if (!key) return null;
  return { key: 'dom:' + key, title: titleFromKey(key), color: autoColorForKey(key), fromRule: false };
}

// ── Core: group one window ───────────────────────────────────────────────────
async function groupWindow(windowId) {
  const [settings, rules] = await Promise.all([getSettings(), getRules()]);
  const compiled = compileRules(rules);
  const tabs = await chrome.tabs.query({ windowId });
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const existingIds = new Set(existingGroups.map((g) => g.id));

  const owned = await getOwned();
  let changed = false;
  for (const idStr of Object.keys(owned)) {
    if (!existingIds.has(Number(idStr))) { delete owned[idStr]; changed = true; }
  }
  // Reuse groups by stable bucket KEY (not display title) and only ones WE own.
  const groupsByKey = new Map();
  for (const g of existingGroups) {
    const rec = owned[g.id];
    if (rec && !groupsByKey.has(rec.key)) groupsByKey.set(rec.key, g);
  }

  const buckets = new Map(); // key -> { key, title, color, fromRule, tabs:[] }
  for (const tab of tabs) {
    if (!isEligibleTab(tab)) continue;
    const target = await computeTarget(tab, compiled);
    if (!target) continue;
    let b = buckets.get(target.key);
    if (!b) { b = { key: target.key, title: target.title, color: target.color, fromRule: target.fromRule, tabs: [] }; buckets.set(target.key, b); }
    b.tabs.push(tab);
  }

  for (const [, b] of buckets) {
    const meets = b.fromRule ? b.tabs.length >= 1 : b.tabs.length >= Math.max(1, settings.minTabs || 2);
    // Below threshold → leave for consolidateSingletons(), which sweeps it into
    // the shared "Other" group (or back out once it reaches 2 tabs).
    if (!meets) continue;
    const existing = groupsByKey.get(b.key);
    let groupId = existing ? existing.id : null;
    const toAdd = b.tabs.filter((t) => t.groupId !== groupId).map((t) => t.id); // skip already-correct tabs
    if (groupId === null) {
      if (!toAdd.length) continue;
      groupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds: toAdd });
      await chrome.tabGroups.update(groupId, { title: b.title, color: b.color });
      owned[groupId] = { key: b.key, color: b.color };
      groupsByKey.set(b.key, { id: groupId, title: b.title, color: b.color });
      changed = true;
    } else {
      if (toAdd.length) await chrome.tabs.group({ groupId, tabIds: toAdd });
      const rec = owned[groupId] || { key: b.key, color: existing.color };
      if (existing.color !== b.color && existing.color === rec.color) {
        // We still own the colour (user hasn't recoloured) → apply our intent.
        try { await chrome.tabGroups.update(groupId, { color: b.color }); } catch (e) {}
        rec.color = b.color;
      } else if (existing.color !== rec.color) {
        // User recoloured it → adopt their colour and stop fighting.
        rec.color = existing.color;
      }
      rec.key = b.key;
      owned[groupId] = rec;
      changed = true;
    }
  }
  if (changed) await setOwned(owned);
  await consolidateSingletons(windowId);
}

// Funnel singleton groups into one shared "Other" group, and pull tabs back out
// once their own group reaches 2 tabs. Only touches groups WE created (never
// user/manual groups) and never explicit rule groups. "Other" only exists when
// it would hold >= 2 tabs; a single lonely tab is left ungrouped.
async function consolidateSingletons(windowId) {
  const owned = await getOwned();
  const groups = await chrome.tabGroups.query({ windowId });
  const tabs = await chrome.tabs.query({ windowId });
  const existingIds = new Set(groups.map((g) => g.id));
  for (const idStr of Object.keys(owned)) if (!existingIds.has(Number(idStr))) delete owned[idStr];

  const byGroup = {};
  for (const t of tabs) if (t.groupId !== TAB_GROUP_ID_NONE) (byGroup[t.groupId] || (byGroup[t.groupId] = [])).push(t);

  const otherGroup = groups.find((g) => owned[g.id] && owned[g.id].key === OTHER_KEY) || null;

  // Tabs that should live in "Other": singletons in owned auto groups (not rule,
  // not Other), plus any currently-ungrouped eligible tabs.
  const singletons = [];
  for (const g of groups) {
    if (otherGroup && g.id === otherGroup.id) continue;
    const rec = owned[g.id];
    if (!rec || rec.key.startsWith('rule:')) continue;
    const gt = byGroup[g.id] || [];
    if (gt.length === 1) singletons.push(gt[0].id);
  }
  const ungrouped = tabs.filter((t) => isEligibleTab(t) && t.groupId === TAB_GROUP_ID_NONE).map((t) => t.id);
  const otherResidents = otherGroup ? (byGroup[otherGroup.id] || []).map((t) => t.id) : [];

  const incoming = [...new Set([...singletons, ...ungrouped])]; // not yet in Other
  const want = [...new Set([...otherResidents, ...incoming])];

  if (want.length >= 2) {
    if (!otherGroup) {
      const gid = await chrome.tabs.group({ createProperties: { windowId }, tabIds: incoming });
      await chrome.tabGroups.update(gid, { title: OTHER_TITLE, color: OTHER_COLOR });
      owned[gid] = { key: OTHER_KEY, color: OTHER_COLOR };
    } else if (incoming.length) {
      await chrome.tabs.group({ groupId: otherGroup.id, tabIds: incoming });
    }
  } else {
    // Fewer than 2 tabs destined for Other → don't keep a 1-tab Other group.
    if (want.length) { try { await chrome.tabs.ungroup(want); } catch (e) {} }
    if (otherGroup) delete owned[otherGroup.id];
  }
  await setOwned(owned);
}

async function groupAllWindows() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const w of wins) {
    try { await groupWindow(w.id); } catch (e) { console.warn('[TabOrganizer] group failed', w.id, e); }
  }
}

// Run the automatic pass (smart or domain, per settings) over every window.
async function autoPassAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const w of wins) {
    try { await autoPass(w.id); } catch (e) { console.warn('[TabOrganizer] auto pass failed', w.id, e); }
  }
}

async function ungroupAll() {
  const tabs = await chrome.tabs.query({});
  const ids = tabs.filter((t) => t.groupId != null && t.groupId !== TAB_GROUP_ID_NONE && !t.pinned).map((t) => t.id);
  if (ids.length) { try { await chrome.tabs.ungroup(ids); } catch (e) { console.warn(e); } }
  await setOwned({}); // we no longer own anything
}

async function collapseAllButActive() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const w of wins) {
    const [active] = await chrome.tabs.query({ windowId: w.id, active: true });
    const activeGroup = active ? active.groupId : TAB_GROUP_ID_NONE;
    const groups = await chrome.tabGroups.query({ windowId: w.id });
    for (const g of groups) {
      const collapsed = g.id !== activeGroup;
      if (g.collapsed !== collapsed) { try { await chrome.tabGroups.update(g.id, { collapsed }); } catch (e) {} }
    }
  }
}

async function listGroups(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  const tabs = await chrome.tabs.query({ windowId });
  const counts = {};
  for (const t of tabs) if (t.groupId != null && t.groupId !== TAB_GROUP_ID_NONE) counts[t.groupId] = (counts[t.groupId] || 0) + 1;
  return groups
    .map((g) => ({ id: g.id, title: g.title || '(untitled)', color: g.color, count: counts[g.id] || 0, collapsed: g.collapsed }))
    .sort((a, b) => b.count - a.count);
}

// ── AI smart grouping (on-demand) ────────────────────────────────────────────
function parseJsonArray(text) {
  let t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('['), end = t.lastIndexOf(']');
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  const arr = JSON.parse(t);
  if (!Array.isArray(arr)) throw new Error('AI response was not a JSON array');
  return arr;
}

// Path A: local `claude` CLI via the native-messaging host (no API key).
function callClaudeViaNative(payload, existingGroups) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('Claude CLI timed out')); } }, NATIVE_TIMEOUT_MS);
    try {
      const message = { type: 'cluster', tabs: payload };
      if (existingGroups && existingGroups.length) message.existingGroups = existingGroups;
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (resp) => {
        if (done) return;
        done = true; clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message || 'native host unavailable'));
        if (!resp) return reject(new Error('no response from Claude CLI host'));
        if (resp.ok === false) return reject(new Error(resp.error || 'Claude CLI error'));
        if (!Array.isArray(resp.clusters)) return reject(new Error('Claude CLI returned no clusters'));
        resolve(resp.clusters);
      });
    } catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
  });
}

function pingNative() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'ping' }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return resolve({ ok: true, available: false, error: err.message });
        resolve({ ok: true, available: !!(resp && resp.ok), info: resp || null });
      });
    } catch (e) { resolve({ ok: true, available: false, error: String((e && e.message) || e) }); }
  });
}

// Path B: direct Anthropic API (optional fallback when the CLI host isn't set up).
async function callClaudeApi(payload, apiKey, existingGroups) {
  const system =
    'You organise browser tabs. Cluster the given tabs (each {id:int,title,url}) into 3-6 groups ' +
    'by topic, project, or intent (e.g. "Job search", "Side project", "Reading"). ' +
    'If an "Existing groups" list is given, prefer assigning tabs to those exact names when they fit; ' +
    'only create a new group for tabs that fit none. ' +
    'Respond with ONLY a JSON array — no prose, no markdown fences. Each element: ' +
    '{"groupName": string (max 18 chars), "color": one of grey|blue|red|yellow|green|pink|purple|cyan|orange, ' +
    '"tabIds": int[] using the provided integer ids}. Every input tab id must appear in exactly one group.';
  const userText =
    (existingGroups && existingGroups.length ? 'Existing groups: ' + JSON.stringify(existingGroups) + '\n' : '') +
    'Tabs:\n' + JSON.stringify(payload);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', // required for browser/extension CORS
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Anthropic API ' + res.status + ' ' + body.slice(0, 300));
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to cluster these tabs');
  if (data.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (too many tabs)');
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('Claude returned an empty response');
  return parseJsonArray(text);
}

function clusterTabIds(cl) {
  if (Array.isArray(cl.tabIds)) return cl.tabIds;
  if (Array.isArray(cl.tabIndices)) return cl.tabIndices;
  return [];
}

// CLI first (no key), then API key if present. Throws if neither works.
async function requestClusters(payload, existingGroups) {
  let lastErr = null;
  try { return { clusters: await callClaudeViaNative(payload, existingGroups), via: 'cli' }; }
  catch (e) { lastErr = e; }
  const apiKey = await getApiKey();
  if (apiKey) {
    try { return { clusters: await callClaudeApi(payload, apiKey, existingGroups), via: 'api' }; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no AI backend');
}

// Incremental auto-pass: cluster only the window's currently-ungrouped tabs and
// route them into existing topic groups by name (no full re-shuffle, small/fast
// prompt). Returns true if AI ran (or there was nothing to do), false if no
// backend is available so the caller can fall back to domain grouping.
async function smartAutoClassify(windowId) {
  const eligible = (await chrome.tabs.query({ windowId })).filter(isEligibleTab);
  const ungrouped = eligible.filter((t) => t.groupId === TAB_GROUP_ID_NONE);
  // Only spend an AI call when there's a genuinely new (ungrouped) tab. Otherwise
  // just reconcile the "Other" group (e.g. a group that dropped to 1 tab).
  if (!ungrouped.length) { await consolidateSingletons(windowId); return true; }

  const owned = await getOwned();
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const existingIds = new Set(existingGroups.map((g) => g.id));
  for (const idStr of Object.keys(owned)) if (!existingIds.has(Number(idStr))) delete owned[idStr];

  const otherGroup = existingGroups.find((g) => owned[g.id] && owned[g.id].key === OTHER_KEY) || null;
  // Reconsider new tabs AND current "Other" residents, so a singleton can rejoin
  // a real topic group once a sibling appears.
  const otherResidents = otherGroup ? eligible.filter((t) => t.groupId === otherGroup.id) : [];
  const candidates = [...ungrouped, ...otherResidents];
  const ownedTitles = [...new Set(existingGroups.filter((g) => owned[g.id] && owned[g.id].key !== OTHER_KEY && g.title).map((g) => g.title))];

  const payload = candidates.map((t, i) => ({ id: i, title: (t.title || '').slice(0, 200), url: t.url }));
  let clusters;
  try { ({ clusters } = await requestClusters(payload, ownedTitles)); }
  catch (e) { return false; } // no CLI/key → let caller use domain grouping

  const groupsByKey = new Map();
  for (const g of existingGroups) { const rec = owned[g.id]; if (rec && rec.key !== OTHER_KEY && !groupsByKey.has(rec.key)) groupsByKey.set(rec.key, g); }
  for (const cl of (Array.isArray(clusters) ? clusters : [])) {
    const title = (String((cl && cl.groupName) || 'Group').trim() || 'Group').slice(0, 40);
    const color = normalizeColor(cl && cl.color) || autoColorForKey(title);
    const ids = clusterTabIds(cl).map((i) => candidates[i]).filter(Boolean).map((t) => t.id);
    if (ids.length < 2) continue; // singletons → "Other" via consolidateSingletons
    const key = 'ai:' + title;
    const existing = groupsByKey.get(key);
    let groupId = existing ? existing.id : null;
    if (groupId === null) {
      groupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds: ids });
      await chrome.tabGroups.update(groupId, { title, color });
      groupsByKey.set(key, { id: groupId, title, color });
    } else {
      await chrome.tabs.group({ groupId, tabIds: ids });
    }
    owned[groupId] = { key, color };
  }
  await setOwned(owned);
  await consolidateSingletons(windowId);
  return true;
}

// The debounced automatic pass: smart (incremental AI) when enabled & available,
// otherwise instant domain grouping.
async function autoPass(windowId) {
  const settings = await getSettings();
  if (!settings.autoGroupEnabled) return;
  if (settings.smartAuto) {
    let ran = false;
    try { ran = await smartAutoClassify(windowId); } catch (e) { ran = false; }
    if (!ran) await groupWindow(windowId);
  } else {
    await groupWindow(windowId);
  }
}

// Full re-cluster of ALL eligible tabs (manual "Smart group" / switching to
// smart mode). Reconciles leftovers so it is idempotent.
async function smartGroupWindow(windowId) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(isEligibleTab);
  if (tabs.length < 2) return { ok: true, groups: 0, note: 'Not enough tabs to cluster' };
  // Stable integer id per tab — avoids the URL-collision / verbatim-echo
  // fragility of matching the model's reply back by URL string.
  const payload = tabs.map((t, i) => ({ id: i, title: (t.title || '').slice(0, 200), url: t.url }));

  let clusters, via;
  try { ({ clusters, via } = await requestClusters(payload, [])); }
  catch (e) {
    await groupWindow(windowId); // graceful fall back to domain grouping
    return { ok: true, fellBack: true, via: 'domain', reason: String((e && e.message) || e) };
  }

  const owned = await getOwned();
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const existingIds = new Set(existingGroups.map((g) => g.id));
  for (const idStr of Object.keys(owned)) if (!existingIds.has(Number(idStr))) delete owned[idStr];
  const groupsByKey = new Map();
  for (const g of existingGroups) { const rec = owned[g.id]; if (rec && rec.key !== OTHER_KEY && !groupsByKey.has(rec.key)) groupsByKey.set(rec.key, g); }

  const placed = new Set();
  let applied = 0;
  for (const cl of clusters) {
    const title = (String((cl && cl.groupName) || 'Group').trim() || 'Group').slice(0, 40);
    const color = normalizeColor(cl && cl.color) || autoColorForKey(title);
    const ids = clusterTabIds(cl).map((i) => tabs[i]).filter(Boolean).map((t) => t.id);
    if (ids.length < 2) continue; // singleton clusters fall through to "Other"
    ids.forEach((id) => placed.add(id));
    const key = 'ai:' + title;
    const existing = groupsByKey.get(key);
    let groupId = existing ? existing.id : null;
    if (groupId === null) {
      groupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds: ids });
      await chrome.tabGroups.update(groupId, { title, color });
      groupsByKey.set(key, { id: groupId, title, color });
    } else {
      await chrome.tabs.group({ groupId, tabIds: ids });
      try { await chrome.tabGroups.update(groupId, { color }); } catch (e) {}
    }
    owned[groupId] = { key, color };
    applied++;
  }
  // Free every owned (non-Other) tab that didn't land in a real (>=2) group;
  // consolidateSingletons then sweeps leftovers + singletons into "Other".
  const toFree = tabs
    .filter((t) => !placed.has(t.id) && t.groupId !== TAB_GROUP_ID_NONE && owned[t.groupId] && owned[t.groupId].key !== OTHER_KEY)
    .map((t) => t.id);
  if (toFree.length) { try { await chrome.tabs.ungroup(toFree); } catch (e) {} }
  await setOwned(owned);
  await consolidateSingletons(windowId);
  return { ok: true, groups: applied, via, placed: placed.size, total: tabs.length };
}

// ── Debounce ─────────────────────────────────────────────────────────────────
const debounceTimers = new Map();
function scheduleGroup(windowId) {
  if (windowId == null || windowId < 0) return;
  const prev = debounceTimers.get(windowId);
  if (prev) clearTimeout(prev);
  const id = setTimeout(async () => {
    debounceTimers.delete(windowId);
    try { await autoPass(windowId); }
    catch (e) { console.warn('[TabOrganizer] scheduled group failed', e); }
  }, DEBOUNCE_MS);
  debounceTimers.set(windowId, id);
}

// ── Event wiring ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(['settings', 'rules']);
  const toSet = {};
  if (!cur.settings) toSet.settings = DEFAULT_SETTINGS;
  if (!Array.isArray(cur.rules)) toSet.rules = DEFAULT_RULES;
  if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
  await autoPassAll();
});

chrome.runtime.onStartup.addListener(async () => {
  await autoPassAll();
});

chrome.tabs.onCreated.addListener((tab) => scheduleGroup(tab.windowId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Act only when navigation settles or the URL changes — group membership
  // changes do not set these, so we never re-trigger ourselves.
  if (changeInfo.status === 'complete' || changeInfo.url) scheduleGroup(tab.windowId);
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) scheduleGroup(removeInfo.windowId);
});
chrome.tabs.onAttached.addListener((tabId, info) => scheduleGroup(info.newWindowId));
chrome.tabs.onDetached.addListener((tabId, info) => scheduleGroup(info.oldWindowId));

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'group-all') await groupAllWindows();
    else if (command === 'ungroup-all') await ungroupAll();
    else if (command === 'collapse-all') await collapseAllButActive();
  } catch (e) { console.warn('[TabOrganizer] command failed', command, e); }
});

async function focusedWindowId() {
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  return w.id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async response
});

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'group-all': await groupAllWindows(); return { ok: true };
    case 'group-current': { await groupWindow(await focusedWindowId()); return { ok: true }; }
    case 'ungroup-all': await ungroupAll(); return { ok: true };
    case 'collapse-all': await collapseAllButActive(); return { ok: true };
    case 'smart-group': return await smartGroupWindow(await focusedWindowId());
    case 'list-groups': return { ok: true, groups: await listGroups(await focusedWindowId()) };
    case 'test-native': return await pingNative();
    default: return { ok: false, error: 'unknown message: ' + (msg && msg.type) };
  }
}
