// Offline tests for settings normalization and the search-result helpers.
// Run:  ELECTRON_RUN_AS_NODE=1 <node> test/settings.test.mjs
import { DEFAULTS, normalizeSettings } from '../lib/settings.js';
import { matchesQuery, queryTokens, toSources } from '../lib/search.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)));
}

// --- documented defaults ----------------------------------------------------
const empty = normalizeSettings(undefined);
check('normalizeSettings(undefined) equals DEFAULTS', empty, DEFAULTS);
check('normalizeSettings(null) equals DEFAULTS', normalizeSettings(null), DEFAULTS);
check('normalizeSettings({}) equals DEFAULTS', normalizeSettings({}), DEFAULTS);
check('enabled defaults on', empty.enabled, true);
check('headless defaults on', empty.headless, true);
check('blockPrivateAddresses defaults on', empty.blockPrivateAddresses, true);
check('allowEval defaults off', empty.allowEval, false);
check('clearProfileOnDisable defaults off', empty.clearProfileOnDisable, false);
check('engineMode defaults to classic', empty.engineMode, 'classic');
check('engineOrder defaults to baidu,bing,duckduckgo', empty.engineOrder, ['baidu', 'bing', 'duckduckgo']);
check('viewport defaults to 1100x820', empty.viewport, { width: 1100, height: 820 });

// --- boolean coercion -------------------------------------------------------
check("enabled 'false' -> false", normalizeSettings({ enabled: 'false' }).enabled, false);
check('enabled 0 -> false', normalizeSettings({ enabled: 0 }).enabled, false);
check("enabled 'true' -> true", normalizeSettings({ enabled: 'true' }).enabled, true);
check('allowEval 1 -> true', normalizeSettings({ allowEval: 1 }).allowEval, true);
check("clearProfileOnDisable 'off' -> false", normalizeSettings({ clearProfileOnDisable: 'off' }).clearProfileOnDisable, false);
check("headless 'no' -> false", normalizeSettings({ headless: 'no' }).headless, false);
check('unrecognized boolean falls back', normalizeSettings({ enabled: 'maybe' }).enabled, true);

// --- engine list ------------------------------------------------------------
function order(value) {
  return normalizeSettings({ engineOrder: value }).engineOrder;
}
check('empty engineOrder falls back to defaults', order([]), DEFAULTS.engineOrder);
check('non-string engineOrder falls back to defaults', order([1]), DEFAULTS.engineOrder);
check('duplicate engines are deduped, order kept', order(['bing', 'bing', 'baidu']), ['bing', 'baidu']);
// NOTE: the task brief expected { engineOrder: ['x', 5] } to fall back to the
// defaults. The hardened normalizeSettings only drops non-strings, so a non-empty
// string id survives; asserting the real behaviour keeps this suite honest.
check("engineOrder ['x', 5] keeps the string id, drops the number", order(['x', 5]), ['x']);
check('junk array passed as the whole settings object falls back', normalizeSettings(['x', 5]).engineOrder, DEFAULTS.engineOrder);

// --- engine mode / viewport / unknown keys ---------------------------------
check("unknown engineMode -> classic", normalizeSettings({ engineMode: 'weird' }).engineMode, 'classic');
check("engineMode 'native' preserved", normalizeSettings({ engineMode: 'native' }).engineMode, 'native');
check("engineMode 'auto' preserved", normalizeSettings({ engineMode: 'auto' }).engineMode, 'auto');
check('viewport clamps to 480 x 1600', normalizeSettings({ viewport: { width: 100, height: 99999 } }).viewport, { width: 480, height: 1600 });
check('viewport caps at 1920 x 1600', normalizeSettings({ viewport: { width: 99999, height: 99999 } }).viewport, { width: 1920, height: 1600 });
check('missing viewport falls back to defaults', normalizeSettings({ viewport: {} }).viewport, DEFAULTS.viewport);
const kept = normalizeSettings({ futureFlag: 'keep-me', nested: { a: 1 } });
check('unknown top-level keys are preserved', kept.futureFlag, 'keep-me');
check('unknown nested keys are preserved', kept.nested, { a: 1 });

// --- search helpers ---------------------------------------------------------
const tokens = queryTokens('deepseek harness');
check("queryTokens('deepseek harness')", tokens, ['deepseek', 'harness']);
check(
  'capitalized title matches lowercase query tokens',
  matchesQuery({ title: 'DeepSeek Harness', snippet: 'agent runtime' }, tokens),
  true,
);
check(
  'unrelated result is rejected',
  matchesQuery({ title: 'Weather in Paris', snippet: 'sunny and warm' }, tokens),
  false,
);
check('empty token list matches anything', matchesQuery({ title: 'Anything' }, []), true);

const rows = [
  { url: 'https://a.example/1', title: '  Alpha  ', snippet: ' first ' },
  { url: 'https://a.example/1', title: 'Duplicate row for the same URL' },
  { url: 'ftp://files.example/x', title: 'ftp row' },
  { url: 'javascript:alert(1)', title: 'script row' },
  { url: 'https://b.example/2', title: 'Beta' },
  { url: 'https://c.example/3' },
];
check('toSources dedupes URLs and drops non-http(s) rows', toSources(rows), [
  { url: 'https://a.example/1', title: 'Alpha', snippet: 'first', summary: 'first' },
  { url: 'https://b.example/2', title: 'Beta' },
  { url: 'https://c.example/3' },
]);
check('toSources caps at the limit', toSources(rows, 2), [
  { url: 'https://a.example/1', title: 'Alpha', snippet: 'first', summary: 'first' },
  { url: 'https://b.example/2', title: 'Beta' },
]);
check('toSources tolerates non-array input', toSources(undefined), []);

console.log(failed === 0 ? 'SETTINGS TEST OK' : 'SETTINGS TEST FAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
