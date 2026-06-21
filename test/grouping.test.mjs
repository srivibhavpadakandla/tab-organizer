// Drives the REAL background.js service worker against an in-memory mock of the
// Chrome extension APIs. Covers domain + smart grouping, the "Other" catch-all,
// the learned cache, privacy (denylist / URL sanitisation), and undo.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const DAT = fileURLToPath(new URL('../psl.dat', import.meta.url));

let tabs = [], groups = new Map(), nextGroup = 1000;
let syncStore = {}, localStore = {}, sessionStore = {};
let nativeResponder = null, clusterCalls = 0, lastClusterMsg = null;
const L = {};
const addL = (n) => ({ addListener: (fn) => { L[n] = fn; } });

function gc() {
  const live = new Set(tabs.filter((t) => t.groupId !== -1).map((t) => t.groupId));
  for (const id of [...groups.keys()]) if (!live.has(id)) groups.delete(id);
}
function mkStore(store) {
  return {
    get: async (keys) => { if (keys == null) return { ...store }; const arr = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of arr) if (k in store) o[k] = store[k]; return o; },
    set: async (obj) => { Object.assign(store, obj); },
    remove: async (key) => { for (const k of (Array.isArray(key) ? key : [key])) delete store[k]; },
  };
}

globalThis.fetch = async () => ({ text: async () => readFileSync(DAT, 'utf8') });
globalThis.chrome = {
  runtime: {
    getURL: () => DAT, onInstalled: addL('i'), onStartup: addL('s'), onMessage: addL('m'), lastError: null,
    sendNativeMessage: (h, msg, cb) => { Promise.resolve().then(() => { chrome.runtime.lastError = null; if (msg.type === 'cluster') { clusterCalls++; lastClusterMsg = msg; } cb(nativeResponder ? nativeResponder(msg) : undefined); }); },
  },
  commands: { onCommand: addL('c') },
  tabs: {
    onCreated: addL('tC'), onUpdated: addL('tU'), onRemoved: addL('tR'), onAttached: addL('tA'), onDetached: addL('tD'),
    query: async (q = {}) => tabs.filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId) && (q.active === undefined || t.active === q.active)),
    group: async ({ createProperties, groupId, tabIds }) => {
      let gid = groupId;
      if (gid == null) { gid = nextGroup++; const wid = createProperties?.windowId ?? tabs.find((t) => tabIds.includes(t.id))?.windowId; groups.set(gid, { id: gid, windowId: wid, title: '', color: 'grey', collapsed: false }); }
      for (const id of tabIds) { const t = tabs.find((x) => x.id === id); if (t) t.groupId = gid; }
      gc(); return gid;
    },
    ungroup: async (ids) => { for (const id of ids) { const t = tabs.find((x) => x.id === id); if (t) t.groupId = -1; } gc(); },
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    query: async (q = {}) => [...groups.values()].filter((g) => q.windowId === undefined || g.windowId === q.windowId),
    update: async (gid, p) => { const g = groups.get(gid); if (g) Object.assign(g, p); },
  },
  windows: { getAll: async () => [...new Set(tabs.map((t) => t.windowId))].map((id) => ({ id })), getLastFocused: async () => ({ id: tabs[0]?.windowId ?? 1 }) },
  storage: { sync: mkStore(syncStore), local: mkStore(localStore), session: mkStore(sessionStore) },
};

await import('../background.js');
const send = (type) => new Promise((res) => L.m({ type }, {}, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => { const o = {}; for (const g of groups.values()) o[g.title || '(untitled)'] = tabs.filter((t) => t.groupId === g.id).length; return { groups: o, ungrouped: tabs.filter((t) => t.groupId === -1 && /^https?:/.test(t.url)).length }; };
function reset(list, settings) {
  tabs = list.map((t, i) => ({ id: i + 1, windowId: 1, pinned: false, incognito: false, groupId: -1, title: t.title || t.url, ...t }));
  groups = new Map();
  for (const k in sessionStore) delete sessionStore[k];
  for (const k in localStore) delete localStore[k];
  for (const k in syncStore) delete syncStore[k];
  if (settings) syncStore.settings = settings;
}
let fails = 0;
const check = (l, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) fails++; };

// A: domain singletons -> Other
reset([{ url: 'https://github.com/a' }, { url: 'https://github.com/b' }, { url: 'https://example.com/x' }, { url: 'https://test.org/y' }, { url: 'https://foo.net/z' }]);
await send('group-all');
let s = snap(); console.log('A', JSON.stringify(s));
check('A Code(2)', s.groups.Code === 2); check('A Other(3)', s.groups.Other === 3); check('A none ungrouped', s.ungrouped === 0);

// B: single singleton stays ungrouped
reset([{ url: 'https://github.com/a' }, { url: 'https://github.com/b' }, { url: 'https://example.com/x' }]);
await send('group-all');
s = snap(); console.log('B', JSON.stringify(s));
check('B no Other', !('Other' in s.groups)); check('B lone ungrouped', s.ungrouped === 1);

// C: reform on 2
reset([{ url: 'https://example.com/x' }, { url: 'https://test.org/y' }, { url: 'https://foo.net/z' }]);
await send('group-all');
tabs.push({ id: 99, windowId: 1, pinned: false, incognito: false, groupId: -1, url: 'https://example.com/x2', title: 'ex2' });
await send('group-all');
s = snap(); console.log('C', JSON.stringify(s));
check('C Example(2)', s.groups.Example === 2); check('C Other(2)', s.groups.Other === 2);

// D: smart, singleton cluster -> Other
nativeResponder = (m) => m.type === 'ping' ? { ok: true, pong: true } : { ok: true, clusters: [{ groupName: 'Work', color: 'blue', tabIds: [0, 1] }, { groupName: 'Reading', color: 'green', tabIds: [2] }] };
reset([{ url: 'https://github.com/a' }, { url: 'https://stackoverflow.com/q' }, { url: 'https://nytimes.com/a' }, { url: 'https://random.io/z' }]);
await send('smart-group');
s = snap(); console.log('D', JSON.stringify(s));
check('D Work(2)', s.groups.Work === 2); check('D Other(2)', s.groups.Other === 2);

// E: Other dissolves to nothing
reset([{ url: 'https://test.org/y' }, { url: 'https://foo.net/z' }]);
await send('group-all');
tabs = tabs.filter((t) => t.url !== 'https://foo.net/z'); gc();
await send('group-all');
s = snap(); console.log('E', JSON.stringify(s));
check('E Other gone', !('Other' in s.groups)); check('E remaining ungrouped', s.ungrouped === 1);

// F: incremental event path
nativeResponder = (m) => m.type === 'ping' ? { ok: true, pong: true } : { ok: true, clusters: [{ groupName: 'Work', color: 'blue', tabIds: [0, 1] }] };
reset([{ url: 'https://github.com/a' }, { url: 'https://stackoverflow.com/q' }, { url: 'https://nytimes.com/x' }, { url: 'https://random.io/z' }]);
L.tC(tabs[0]); await sleep(900);
s = snap(); console.log('F', JSON.stringify(s));
check('F Work(2)', s.groups.Work === 2); check('F Other(2)', s.groups.Other === 2);

// G: learned cache — repeat domain grouped with NO new AI call
nativeResponder = (m) => m.type === 'ping' ? { ok: true, pong: true } : { ok: true, clusters: [{ groupName: 'Code', color: 'blue', tabIds: [0, 1] }, { groupName: 'Watch', color: 'red', tabIds: [2, 3] }] };
reset([{ url: 'https://github.com/a' }, { url: 'https://stackoverflow.com/q' }, { url: 'https://youtube.com/v' }, { url: 'https://netflix.com/t' }]);
await send('smart-group');         // learns github->Code, etc.
const callsBefore = clusterCalls;
tabs.push({ id: 50, windowId: 1, pinned: false, incognito: false, groupId: -1, url: 'https://github.com/c', title: 'gh3' });
L.tC(tabs.at(-1)); await sleep(900);
s = snap(); console.log('G', JSON.stringify(s), 'aiCalls+', clusterCalls - callsBefore);
check('G new github joined Code(3)', s.groups.Code === 3);
check('G NO extra AI call (instant cache)', clusterCalls === callsBefore);

// H + I: denylist excluded & not sent; URLs sanitised (no query string)
nativeResponder = (m) => m.type === 'ping' ? { ok: true, pong: true } : { ok: true, clusters: [{ groupName: 'Work', color: 'blue', tabIds: [0, 1] }] };
reset([
  { url: 'https://github.com/a?token=abc#frag' }, { url: 'https://stackoverflow.com/q?s=1' },
  { url: 'https://mybank.com/account?id=9' },
], { autoGroupEnabled: true, smartAuto: true, minTabs: 2, denylist: ['mybank.com'] });
await send('smart-group');
s = snap(); console.log('H/I', JSON.stringify(s));
const sentUrls = (lastClusterMsg.tabs || []).map((t) => t.url);
check('H denylisted bank not grouped', tabs.find((t) => t.url.includes('mybank')).groupId === -1);
check('H bank not sent to AI', !sentUrls.some((u) => u.includes('mybank')));
check('I URLs sanitised (no ? or #)', sentUrls.every((u) => !u.includes('?') && !u.includes('#')));

// J: undo restores pre-grouping state
reset([{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }, { url: 'https://example.com/3' }]);
await send('group-all');
check('J grouped first', snap().groups.Example === 3);
await send('undo');
s = snap(); console.log('J', JSON.stringify(s));
check('J undo cleared groups', Object.keys(s.groups).length === 0);
check('J undo left tabs ungrouped', s.ungrouped === 3);

console.log('\n' + (fails ? `${fails} FAILURES` : 'GROUPING: ALL PASS'));
process.exit(fails ? 1 : 0);
