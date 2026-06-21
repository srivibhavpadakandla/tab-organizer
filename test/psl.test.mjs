// eTLD+1 resolution against the real bundled public-suffix list.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const datPath = fileURLToPath(new URL('../psl.dat', import.meta.url));
globalThis.chrome = { runtime: { getURL: () => datPath } };
globalThis.fetch = async (p) => ({ text: async () => readFileSync(p, 'utf8') });
const { registrableDomain } = await import('../psl.js');

const cases = [
  ['news.ycombinator.com', 'ycombinator.com'],
  ['ycombinator.com', 'ycombinator.com'],
  ['a.b.bbc.co.uk', 'bbc.co.uk'],
  ['docs.google.com', 'google.com'],
  ['www.google.co.uk', 'google.co.uk'],
  ['sub.example.co.jp', 'example.co.jp'],
  ['user1.github.io', 'user1.github.io'],
  ['github.io', null],
  ['city.kobe.jp', 'city.kobe.jp'],
  ['a.foo.kobe.jp', 'a.foo.kobe.jp'],
  ['localhost', null],
  ['192.168.1.1', null],
  ['shop.example.com.au', 'example.com.au'],
];

let fails = 0;
for (const [host, want] of cases) {
  const got = await registrableDomain(host);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${host} -> ${got}${ok ? '' : ` (expected ${want})`}`);
}
console.log(fails ? `\n${fails} FAILURES` : '\nPSL: ALL PASS');
process.exit(fails ? 1 : 0);
