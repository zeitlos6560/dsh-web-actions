// Offline tests for the security helpers and for settings/locale wiring.
import { displayUrl, isPrivateHost, resolveProfileDir } from '../lib/browser.js';
import { DEFAULTS } from '../lib/settings.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | got ' + JSON.stringify(actual)));
}

const privateCases = [
  ['localhost', true], ['app.localhost', true], ['intranet.local', true], ['printer.internal', true],
  ['127.0.0.1', true], ['127.9.9.9', true], ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.255', true],
  ['172.32.0.1', false], ['192.168.0.10', true], ['169.254.1.1', true], ['100.64.0.1', true], ['100.128.0.1', false],
  ['0.0.0.0', true], ['8.8.8.8', false], ['1.1.1.1', false], ['example.com', false], ['gov.cn', false],
  ['[::1]', true], ['::', true], ['fe80::1', true], ['fc00::1', true], ['fd12:3456::1', true],
];
for (const [host, expected] of privateCases) check('isPrivateHost(' + host + ')', isPrivateHost(host), expected);

// Hardened classifier cases: trailing-dot DNS names, zoned link-local literals and
// IPv4-mapped/compatible IPv6 spellings that used to slip past the block list,
// plus public addresses that must stay allowed.
const hardenedPrivateCases = [
  ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.1', true], ['192.168.1.1', true],
  ['169.254.1.1', true], ['100.64.0.1', true], ['localhost', true], ['localhost.', true],
  ['foo.local', true], ['foo.internal.', true], ['::1', true], ['[::1]', true], ['::', true],
  ['fe80::1', true], ['fe80::1%eth0', true], ['fd00::1', true],
  ['::ffff:127.0.0.1', true], ['[::ffff:7f00:1]', true], ['::ffff:192.168.0.1', true],
  ['0:0:0:0:0:ffff:7f00:1', true], ['::127.0.0.1', true],
  ['8.8.8.8', false], ['172.32.0.1', false], ['::ffff:8.8.8.8', false], ['2001:db8::1', false],
  ['2001:4860:4860::8888', false], ['example.com', false], ['example.com.', false],
];
// The block above already asserts some of these hosts; assert every host exactly once.
const coveredPrivateHosts = new Set(privateCases.map(([host]) => host));
for (const [host, expected] of hardenedPrivateCases) {
  if (coveredPrivateHosts.has(host)) continue;
  check('isPrivateHost(' + host + ')', isPrivateHost(host), expected);
}

// A look-alike URL must never be relabeled as the hosted Edge new-tab page.
const displayCases = [
  ['https://status.example.com/edge/ntp', 'https://status.example.com/edge/ntp'],
  ['https://example.com/x?next=/edge/ntp', 'https://example.com/x?next=/edge/ntp'],
  ['https://ntp.msn.com/edge/ntp?locale=zh-CN', 'edge://newtab'],
  ['https://www.msn.com/edge/ntp', 'edge://newtab'],
  ['edge://newtab', 'edge://newtab'],
  ['about:blank', 'about:blank'],
  ['https://www.bing.com/', 'https://www.bing.com/'],
];
for (const [url, expected] of displayCases) check('displayUrl(' + url + ')', displayUrl(url), expected);

const home = resolveProfileDir({ profileDir: '' });
check('default profile dir under .dsh/web-browser', /[\\/]\.dsh[\\/]web-browser[\\/]profile$/.test(home), true);
check('trimmed custom profile dir', resolveProfileDir({ profileDir: '  C:\\tmp\\wb-profile  ' }), 'C:\\tmp\\wb-profile');
check('undefined settings falls back to default', typeof resolveProfileDir(undefined), 'string');

check('blockPrivateAddresses defaults on', DEFAULTS.blockPrivateAddresses, true);
check('allowEval defaults off', DEFAULTS.allowEval, false);
check('clearProfileOnDisable defaults off', DEFAULTS.clearProfileOnDisable, false);

// Every locale key used by t() must exist in both dictionaries, with equal key sets.
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');
const zhStart = source.indexOf('const zh = {');
const enStart = source.indexOf('const en = {');
function dictionary(start) {
  const end = source.indexOf('\n    };', start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}
const zhBlock = dictionary(zhStart);
const enBlock = dictionary(enStart);
const keyPattern = /^\s*'([^']+)':/gm;
const zhKeys = new Set([...zhBlock.matchAll(keyPattern)].map((match) => match[1]));
const enKeys = new Set([...enBlock.matchAll(keyPattern)].map((match) => match[1]));
check('zh/en key count equal', zhKeys.size, enKeys.size);
check('no zh-only keys', [...zhKeys].filter((key) => !enKeys.has(key)), []);
check('no en-only keys', [...enKeys].filter((key) => !zhKeys.has(key)), []);
const used = new Set([...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]));
check('all t() keys exist in zh', [...used].filter((key) => !zhKeys.has(key)), []);

console.log(failed === 0 ? 'SECURITY TEST OK' : 'SECURITY TEST FAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
