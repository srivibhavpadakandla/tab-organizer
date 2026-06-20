// psl.js — Public Suffix List helper (eTLD+1 resolution).
// Loads the bundled psl.dat once, lazily, and caches parsed rules in module
// scope. The service worker can be killed at any time; on the next wake the
// module re-initialises and re-parses on first use, so we never rely on
// persisted in-memory state across worker lifetimes — only within one.

let parsed = null; // { exceptions:Set, wildcards:Set, normal:Set }
let loading = null; // in-flight promise (dedupe concurrent callers)

async function ensureLoaded() {
  if (parsed) return parsed;
  if (loading) return loading;
  loading = (async () => {
    const url = chrome.runtime.getURL('psl.dat');
    const text = await (await fetch(url)).text();
    const exceptions = new Set();
    const wildcards = new Set();
    const normal = new Set();
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('!')) {
        exceptions.add(line.slice(1));
      } else if (line.startsWith('*.')) {
        wildcards.add(line);
      } else {
        normal.add(line);
      }
    }
    parsed = { exceptions, wildcards, normal };
    return parsed;
  })();
  return loading;
}

function isIpAddress(host) {
  // IPv6 literals arrive bracketed from URL.hostname only sometimes; treat any
  // colon as IPv6. IPv4 is four dotted decimal octets.
  if (host.includes(':')) return true;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

// Returns the array of labels that form the public suffix for `labels`,
// following the publicsuffix.org matching algorithm.
function publicSuffixLabels({ exceptions, wildcards, normal }, labels) {
  // 1. Exception rules win outright. The public suffix is the matched rule
  //    minus its left-most label.
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i);
    if (exceptions.has(suffix.join('.'))) return suffix.slice(1);
  }
  // 2. Longest matching normal or wildcard rule.
  let best = null;
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i);
    if (normal.has(suffix.join('.'))) {
      if (!best || suffix.length > best.length) best = suffix;
    }
    // A wildcard rule "*.x" matches "<anything>.x".
    const wildcard = ['*', ...suffix.slice(1)].join('.');
    if (wildcards.has(wildcard)) {
      if (!best || suffix.length > best.length) best = suffix;
    }
  }
  if (best) return best;
  // 3. Default rule "*": the public suffix is the right-most label.
  return labels.slice(-1);
}

// Resolves the registrable domain (eTLD+1), e.g.
//   news.ycombinator.com -> ycombinator.com
//   foo.bar.co.uk        -> bar.co.uk
// Returns null when there is no registrable domain (bare TLD, IP, localhost…),
// letting callers fall back to the raw host as a grouping key.
export async function registrableDomain(hostname) {
  if (!hostname) return null;
  hostname = hostname.toLowerCase().replace(/\.$/, '');
  if (isIpAddress(hostname)) return null;
  const labels = hostname.split('.');
  if (labels.length < 2) return null; // single label (localhost) has no eTLD+1
  const rules = await ensureLoaded();
  const psl = publicSuffixLabels(rules, labels);
  // The whole host is itself a public suffix → nothing registrable.
  if (labels.length <= psl.length) return null;
  return labels.slice(labels.length - psl.length - 1).join('.');
}

// Stable grouping key for a host: the eTLD+1, or the raw host when none.
export async function groupKeyForHost(hostname) {
  const reg = await registrableDomain(hostname);
  return reg || hostname || null;
}
