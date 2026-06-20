// options.js — CRUD editor for custom rules, grouping threshold, and API key.

const ENUM_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const COLOR_HEX = {
  grey: '#9aa0b0', blue: '#5b9bff', red: '#ff6b6b', yellow: '#f7c948',
  green: '#3ecf8e', pink: '#ff79c6', purple: '#b48cff', cyan: '#34d0d8', orange: '#ff9f45',
};
const RULE_TYPES = ['domain', 'glob', 'regex'];

const DEFAULT_SETTINGS = { autoGroupEnabled: true, smartAuto: true, minTabs: 2 };
const DEFAULT_RULES = [
  { type: 'domain', match: 'github.com', groupName: 'Code', color: 'blue' },
  { type: 'domain', match: 'gitlab.com', groupName: 'Code', color: 'blue' },
  { type: 'domain', match: 'youtube.com', groupName: 'Watch', color: 'red' },
  { type: 'domain', match: 'netflix.com', groupName: 'Watch', color: 'red' },
  { type: 'domain', match: 'docs.google.com', groupName: 'Docs', color: 'green' },
  { type: 'domain', match: 'notion.so', groupName: 'Docs', color: 'green' },
];

const $ = (id) => document.getElementById(id);

function toast(el, msg, isErr) {
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { el.className = 'toast' + (isErr ? ' err' : ''); }, 2200);
}

function makeSelect(options, value) {
  const sel = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt;
    if (opt === value) o.selected = true;
    sel.append(o);
  }
  return sel;
}

function ruleRow(rule = { type: 'domain', match: '', groupName: '', color: 'blue' }) {
  const row = document.createElement('div');
  row.className = 'rule-row';

  const match = document.createElement('input');
  match.type = 'text'; match.placeholder = 'github.com'; match.value = rule.match || '';
  match.dataset.k = 'match';

  const type = makeSelect(RULE_TYPES, RULE_TYPES.includes(rule.type) ? rule.type : 'domain');
  type.dataset.k = 'type';

  const name = document.createElement('input');
  name.type = 'text'; name.placeholder = 'Code'; name.value = rule.groupName || '';
  name.dataset.k = 'groupName';

  const colorWrap = document.createElement('div');
  colorWrap.className = 'swatch-wrap';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  const color = makeSelect(ENUM_COLORS, ENUM_COLORS.includes(rule.color) ? rule.color : 'blue');
  color.dataset.k = 'color';
  const paint = () => { swatch.style.background = COLOR_HEX[color.value] || COLOR_HEX.grey; };
  color.addEventListener('change', paint);
  paint();
  colorWrap.append(swatch, color);

  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'Delete rule';
  del.addEventListener('click', () => row.remove());

  row.append(match, type, name, colorWrap, del);
  return row;
}

function renderRules(rules) {
  const body = $('rulesBody');
  body.innerHTML = '';
  for (const r of rules) body.append(ruleRow(r));
}

function globToRegex(glob) {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}
// Reject patterns prone to catastrophic backtracking (a quantified group that
// itself contains a quantifier, e.g. (a+)+ ) or absurd length, before they can
// be saved and run on the worker thread against every tab URL.
function looksUnsafeRegex(src) {
  if (src.length > 200) return true;
  return /\([^()]*[+*][^()]*\)[*+{]/.test(src);
}

function collectRules() {
  const rows = [...document.querySelectorAll('#rulesBody .rule-row')];
  const out = [];
  const issues = [];
  for (const row of rows) {
    const get = (k) => row.querySelector(`[data-k="${k}"]`).value.trim();
    const match = get('match');
    const groupName = get('groupName');
    if (!match || !groupName) continue; // skip incomplete rows
    const type = get('type') || 'domain';
    if (type === 'domain' && !match.includes('.')) {
      issues.push(`"${match}" — domain needs a dot (e.g. example.com)`);
      continue;
    }
    if (type === 'regex') {
      try { new RegExp(match, 'i'); } catch { issues.push(`"${match}" — invalid regex`); continue; }
      if (looksUnsafeRegex(match)) { issues.push(`"${match}" — unsafe regex (nested quantifier)`); continue; }
    }
    if (type === 'glob') {
      try { globToRegex(match); } catch { issues.push(`"${match}" — invalid glob`); continue; }
    }
    out.push({ type, match, groupName, color: get('color') || 'blue' });
  }
  return { rules: out, issues };
}

async function load() {
  const sync = await chrome.storage.sync.get(['settings', 'rules']);
  const local = await chrome.storage.local.get('apiKey');
  const settings = { ...DEFAULT_SETTINGS, ...(sync.settings || {}) };
  const rules = Array.isArray(sync.rules) ? sync.rules : DEFAULT_RULES;

  $('minTabs').value = settings.minTabs;
  $('autoEnabled').checked = !!settings.autoGroupEnabled;
  $('smartAuto').checked = settings.smartAuto !== false;
  $('apiKey').value = local.apiKey || '';
  renderRules(rules);
}

async function saveSettings() {
  const sync = await chrome.storage.sync.get('settings');
  const current = { ...DEFAULT_SETTINGS, ...(sync.settings || {}) };
  let minTabs = parseInt($('minTabs').value, 10);
  if (!Number.isFinite(minTabs) || minTabs < 1) minTabs = 1;
  if (minTabs > 20) minTabs = 20;
  $('minTabs').value = minTabs;
  await chrome.storage.sync.set({
    settings: { ...current, minTabs, autoGroupEnabled: $('autoEnabled').checked, smartAuto: $('smartAuto').checked },
  });
}

function regroupNow() {
  const type = $('smartAuto').checked ? 'smart-group' : 'group-all';
  chrome.runtime.sendMessage({ type }).catch(() => {});
}

async function checkCli(interactive) {
  const dot = $('cliDot'), label = $('cliStatus'), btn = $('testCli');
  dot.className = 'status-dot';
  label.className = 'muted';
  label.textContent = interactive ? 'Testing…' : 'Checking Claude CLI…';
  if (interactive) btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'test-native' });
    if (res && res.available) {
      dot.className = 'status-dot ok';
      label.className = '';
      label.textContent = 'Claude CLI connected' + (res.info && res.info.model ? ' · ' + res.info.model : '');
    } else {
      dot.className = 'status-dot bad';
      label.className = 'muted';
      label.textContent = 'Claude CLI not set up — run native/install.sh, then restart the browser';
    }
  } catch (e) {
    dot.className = 'status-dot bad';
    label.textContent = 'Could not reach the service worker';
  } finally {
    if (interactive) btn.disabled = false;
  }
}

function init() {
  load();
  checkCli(false);
  $('testCli').addEventListener('click', () => checkCli(true));

  $('addRule').addEventListener('click', () => $('rulesBody').append(ruleRow()));

  $('restoreRules').addEventListener('click', () => {
    renderRules(DEFAULT_RULES);
    toast($('rulesToast'), 'Defaults restored — press Save');
  });

  $('saveRules').addEventListener('click', async () => {
    try {
      const { rules, issues } = collectRules();
      const bytes = new Blob([JSON.stringify(rules)]).size;
      if (bytes > 7800) { // chrome.storage.sync per-item quota is 8192 bytes
        toast($('rulesToast'), 'Too many rules to sync (~8KB limit). Remove some.', true);
        return;
      }
      await chrome.storage.sync.set({ rules });
      await saveSettings();
      if (issues.length) {
        toast($('rulesToast'), `Saved ${rules.length} · skipped ${issues.length}: ${issues[0]}`, true);
      } else {
        toast($('rulesToast'), 'Saved ' + rules.length + ' rules');
      }
      // Re-group immediately so the change is visible.
      chrome.runtime.sendMessage({ type: 'group-all' }).catch(() => {});
    } catch (e) {
      toast($('rulesToast'), String((e && e.message) || e), true);
    }
  });

  // Save settings on direct change too.
  $('minTabs').addEventListener('change', saveSettings);
  $('autoEnabled').addEventListener('change', async () => {
    await saveSettings();
    if ($('autoEnabled').checked) regroupNow();
  });
  $('smartAuto').addEventListener('change', async () => {
    await saveSettings();
    if ($('autoEnabled').checked) regroupNow();
  });

  $('showKey').addEventListener('change', (e) => {
    $('apiKey').type = e.target.checked ? 'text' : 'password';
  });

  $('saveKey').addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
      toast($('keyToast'), $('apiKey').value.trim() ? 'Key saved' : 'Key cleared');
    } catch (e) {
      toast($('keyToast'), String((e && e.message) || e), true);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
