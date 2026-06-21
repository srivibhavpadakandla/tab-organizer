// popup.js — talks to the service worker; holds no grouping logic of its own.

// Display hex for each tab-group enum colour (tuned for a dark UI).
const COLOR_HEX = {
  grey: '#9aa0b0', blue: '#5b9bff', red: '#ff6b6b', yellow: '#f7c948',
  green: '#3ecf8e', pink: '#ff79c6', purple: '#b48cff', cyan: '#34d0d8', orange: '#ff9f45',
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function send(type) {
  return chrome.runtime.sendMessage({ type });
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { autoGroupEnabled: true, smartAuto: true, minTabs: 2, ...(settings || {}) };
}

async function refreshGroups() {
  const list = $('groupList');
  try {
    const res = await send('list-groups');
    const groups = (res && res.groups) || [];
    $('groupCount').textContent = String(groups.length);
    list.innerHTML = '';
    $('emptyState').style.display = groups.length ? 'none' : 'block';
    for (const g of groups) {
      const li = document.createElement('li');
      li.className = 'group-row';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = COLOR_HEX[g.color] || COLOR_HEX.grey;

      const title = document.createElement('span');
      title.className = 'group-title' + (g.title === '(untitled)' ? ' untitled' : '');
      title.textContent = g.title;

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = g.count + (g.count === 1 ? ' tab' : ' tabs');

      li.append(dot, title);
      if (g.collapsed) {
        const tag = document.createElement('span');
        tag.className = 'collapsed-tag';
        tag.textContent = 'collapsed';
        li.append(tag);
      }
      li.append(count);
      list.append(li);
    }
  } catch (e) {
    setStatus('Could not read groups', 'err');
  }
}

function render(settings) {
  const on = !!settings.autoGroupEnabled;
  const smart = settings.smartAuto !== false;
  $('autoToggle').checked = on;
  $('segSmart').classList.toggle('active', smart);
  $('segDomain').classList.toggle('active', !smart);
  $('segSmart').disabled = !on;
  $('segDomain').disabled = !on;
  $('autoLabel').textContent = on ? 'Auto-grouping on · ' + (smart ? 'Smart' : 'Domain') : 'Auto-grouping off';
}

async function init() {
  let settings = await getSettings();
  render(settings);

  // Master auto-grouping toggle (persisted; the worker reads it fresh each run).
  $('autoToggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    settings = { ...(await getSettings()), autoGroupEnabled: on };
    await chrome.storage.sync.set({ settings });
    render(settings);
    if (on) {
      const smart = settings.smartAuto !== false;
      setStatus(smart ? 'Smart grouping…' : 'Grouping…');
      try {
        await send(smart ? 'smart-group' : 'group-all');
        setStatus('Auto-grouping enabled', 'ok');
      } catch (e) {
        setStatus(String((e && e.message) || e), 'err');
      } finally {
        refreshGroups();
      }
    } else {
      setStatus('Auto-grouping paused', 'ok');
    }
  });

  // Smart / Domain mode segments.
  for (const seg of [$('segSmart'), $('segDomain')]) {
    seg.addEventListener('click', async () => {
      const smart = seg.dataset.mode === 'smart';
      settings = { ...(await getSettings()), smartAuto: smart };
      await chrome.storage.sync.set({ settings });
      render(settings);
      if (!settings.autoGroupEnabled) return;
      setStatus(smart ? 'Smart grouping…' : 'Grouping by domain…');
      try {
        const res = await send(smart ? 'smart-group' : 'group-all');
        if (smart && res && res.fellBack) setStatus('Claude CLI not set up — using domain. See ⚙', 'ok');
        else setStatus(smart ? 'Smart mode on' : 'Domain mode on', 'ok');
      } catch (e) {
        setStatus(String((e && e.message) || e), 'err');
      } finally {
        refreshGroups();
      }
    });
  }

  // Action buttons.
  for (const btn of document.querySelectorAll('.btn[data-msg]')) {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.msg;
      const others = [...document.querySelectorAll('.btn[data-msg]')];
      others.forEach((b) => (b.disabled = true));
      btn.classList.add('busy');
      const labels = {
        'group-all': 'Grouping all tabs…',
        'smart-group': 'Asking Claude to cluster…',
        'collapse-all': 'Collapsing…',
        'ungroup-all': 'Ungrouping…',
      };
      setStatus(labels[type] || 'Working…');
      try {
        const res = await chrome.runtime.sendMessage({ type });
        if (res && res.ok === false) {
          setStatus(res.error || 'Failed', 'err');
        } else if (type === 'smart-group') {
          if (res && res.fellBack) setStatus('Smart grouping unavailable — grouped by domain. Set up the Claude CLI in ⚙', 'ok');
          else if (res && res.note) setStatus(res.note, 'ok');
          else {
            const eng = res && res.via === 'cli' ? ' · Claude CLI' : res && res.via === 'api' ? ' · API' : '';
            setStatus('Smart-grouped into ' + ((res && res.groups) || 0) + ' groups' + eng, 'ok');
          }
        } else {
          setStatus('Done', 'ok');
        }
      } catch (e) {
        setStatus(String((e && e.message) || e), 'err');
      } finally {
        btn.classList.remove('busy');
        others.forEach((b) => (b.disabled = false));
        refreshGroups();
      }
    });
  }

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('undoBtn').addEventListener('click', async () => {
    setStatus('Undoing…');
    try {
      const res = await send('undo');
      setStatus(res && res.ok ? 'Restored previous grouping' : (res && res.error) || 'Nothing to undo', res && res.ok ? 'ok' : 'err');
    } catch (e) {
      setStatus(String((e && e.message) || e), 'err');
    } finally {
      refreshGroups();
    }
  });

  refreshGroups();
}

document.addEventListener('DOMContentLoaded', init);
