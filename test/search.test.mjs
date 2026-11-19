// Offline regression test for the browser search provider and its engine specs.
// Run:  <node> dsh-web-browser/test/search.test.mjs
import { desktopUserAgent } from '../lib/browser.js';
import { ENGINES, createBrowserSearchProvider, matchesQuery, queryTokens } from '../lib/search.js';

let failed = 0;
let total = 0;
function check(name, actual, expected) {
  total += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)));
}
function checkTrue(name, value, detail) {
  total += 1;
  const ok = value === true;
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + JSON.stringify(detail)));
}
function checkFalse(name, value, detail) {
  total += 1;
  const ok = value === false;
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + JSON.stringify(detail)));
}

// --- desktop User-Agent -----------------------------------------------------
// Headless Chromium advertises "HeadlessChrome", which makes search engines
// serve captchas; the override must keep the real build but drop that token.
const edgeUa = desktopUserAgent('Edg/157.0.4341.60');
checkTrue('edge UA keeps the Edge version', edgeUa.includes('Edg/157.0.4341.60'), edgeUa);
checkTrue('edge UA advertises the matching Chrome major', edgeUa.includes('Chrome/157.0.0.0'), edgeUa);
checkFalse('edge UA hides the headless token', /headless/i.test(edgeUa), edgeUa);
checkTrue('edge UA is a Mozilla browser string', edgeUa.startsWith('Mozilla/5.0 (') && edgeUa.includes('Safari/537.36'), edgeUa);

const chromeUa = desktopUserAgent('Chrome/140.0.7000.1');
checkTrue('chrome UA keeps the Chrome version', chromeUa.includes('Chrome/140.0.7000.1'), chromeUa);
checkFalse('chrome UA has no Edge token', chromeUa.includes('Edg/'), chromeUa);
const fallbackUa = desktopUserAgent(undefined);
checkFalse('fallback UA hides the headless token', /headless/i.test(fallbackUa), fallbackUa);
checkTrue('fallback UA is a Mozilla browser string', fallbackUa.startsWith('Mozilla/5.0 ('), fallbackUa);

// --- engine specs -----------------------------------------------------------
// www.bing.com answers headless Chromium with unrelated pages; cn.bing.com
// returns the real result list, with www kept as the fallback attempt.
checkTrue('bing uses the China host', ENGINES.bing.url('城乡居民医疗保险').startsWith('https://cn.bing.com/search?q='), ENGINES.bing.url('x'));
checkTrue('bing fallback uses www', ENGINES.bing.alt !== undefined && ENGINES.bing.alt.url('x').startsWith('https://www.bing.com/search?q='), ENGINES.bing.alt && ENGINES.bing.alt.url('x'));
checkTrue('bing extractor skips Bing-internal links', ENGINES.bing.script(5).includes('bing\\.com'), 'missing internal-link guard');
checkTrue('baidu extractor skips Baidu-internal links', ENGINES.baidu.script(5).includes('baidu\\.com'), 'missing internal-link guard');
checkTrue('baidu mobile fallback still exists', ENGINES.baidu.alt !== undefined && ENGINES.baidu.alt.url('x').startsWith('https://m.baidu.com/s?word='), ENGINES.baidu.alt && ENGINES.baidu.alt.url('x'));

// --- relevance filter -------------------------------------------------------
// Long CJK queries expand into overlapping bigrams; a page matching only two
// common grams (城乡 + 居民) must not be offered as a result.
{
  const tokens = queryTokens('城乡居民医保和大学生医保的区别');
  checkTrue('relevance: a topical result passes', matchesQuery({
    title: '大学生医保和城乡居民医保有什么区别',
    snippet: '两者都属城乡居民基本医疗保险，区别在参保地、缴费和门诊待遇',
  }, tokens));
  checkFalse('relevance: an unrelated statistics page is rejected', matchesQuery({
    title: '在统计上城乡是如何划分的 - 国家统计局',
    snippet: '城区是指市辖区和不设区的市，居民委员会和其他区域……',
  }, tokens));
  checkTrue('relevance: a short two-character query still matches', matchesQuery({ title: '医保区别', snippet: '' }, queryTokens('区别')));
  checkTrue('relevance: a latin query stays at two hits', matchesQuery({ title: 'DeepSeek Harness plugin docs', snippet: '' }, queryTokens('harness docs')));
}

// --- provider behaviour with a fake engine ----------------------------------
function makeProvider(options) {
  const state = {
    enabled: options.enabled !== false,
    providerId: 'browser',
    engineOrder: options.engineOrder === undefined ? ['bing', 'baidu'] : options.engineOrder,
  };
  const calls = [];
  const engine = {
    lastSearchFailure: undefined,
    available: () => options.available !== false,
    async searchFrom(query, extractor) {
      calls.push({ query, url: extractor.url, limit: extractor.limit });
      const rows = await options.rows(extractor.url, calls.length);
      if (Array.isArray(rows) && rows.length === 0 && typeof options.failure === 'string') {
        engine.lastSearchFailure = options.failure;
      }
      return rows;
    },
  };
  const provider = createBrowserSearchProvider({ settings: () => state, engine, log: () => {} });
  return { provider, calls, state };
}
const BING_URL = 'https://cn.bing.com/search?q=';
const BING_ALT_URL = 'https://www.bing.com/search?q=';
const BAIDU_URL = 'https://www.baidu.com/s?ie=utf-8&wd=';

// An engine that returns nothing falls through to the next configured engine.
{
  const { provider, calls } = makeProvider({
    engineOrder: ['bing', 'baidu'],
    rows: (url) => (url.startsWith(BAIDU_URL) ? [{ title: '城乡居民医保', url: 'https://example.com/a', snippet: '居民医保' }] : []),
  });
  const result = await provider.search({ query: '城乡居民医疗保险' });
  check('fallthrough: one source from the second engine', result.sources.length, 1);
  checkTrue('fallthrough: first engine was Bing China', calls[0].url.startsWith(BING_URL), calls[0].url);
  checkTrue('fallthrough: then the www fallback', calls[1].url.startsWith(BING_ALT_URL), calls[1].url);
  checkTrue('fallthrough: then Baidu', calls[2].url.startsWith(BAIDU_URL), calls[2].url);
}

// A rendered list with nothing relevant is the end of that engine: the other
// host of the same engine cannot answer this query, so skip its fallback.
{
  const { provider, calls } = makeProvider({
    engineOrder: ['bing', 'baidu'],
    rows: (url) => {
      if (url.startsWith(BAIDU_URL)) return [{ title: '城乡居民医保', url: 'https://example.com/d', snippet: '居民医保' }];
      return [{ title: '城乡（城镇和乡村的合称）', url: 'https://example.com/urban', snippet: '城乡划分' }];
    },
  });
  const result = await provider.search({ query: '城乡居民医疗保险' });
  check('irrelevant list: still one source from Baidu', result.sources.length, 1);
  check('irrelevant list: the alternate host was skipped', calls.length, 2);
  checkTrue('irrelevant list: second call is Baidu', calls[1].url.startsWith(BAIDU_URL), calls[1].url);
}

// Failure reasons travel into the error so a blocked engine is identifiable.
{
  const { provider } = makeProvider({
    engineOrder: ['bing', 'baidu'],
    failing: true,
    failure: '搜索引擎要求人机验证',
    rows: () => [],
  });
  let message = '';
  try {
    await provider.search({ query: '城乡居民医疗保险' });
  } catch (error) {
    message = String(error && error.message ? error.message : error);
  }
  checkTrue('failure reasons: the error names the captcha', message.includes('人机验证'), message);
  checkTrue('failure reasons: both engines are listed with reasons', message.includes('Bing：') && message.includes('百度：'), message);
}

// A throwing engine must not abort the whole search.
{
  const { provider } = makeProvider({
    engineOrder: ['bing', 'baidu'],
    rows: (url) => {
      if (url.startsWith(BAIDU_URL)) return [{ title: '城乡居民医保', url: 'https://example.com/b', snippet: '保险' }];
      throw new Error('搜索引擎要求人机验证');
    },
  });
  const result = await provider.search({ query: '城乡居民医疗保险' });
  check('throwing engine: the next engine still answers', result.sources.length, 1);
}

// All engines empty: the error names every engine that was tried.
{
  const { provider } = makeProvider({ engineOrder: ['bing', 'baidu'], rows: () => [] });
  let message = '';
  try {
    await provider.search({ query: '城乡居民医疗保险' });
  } catch (error) {
    message = String(error && error.message ? error.message : error);
  }
  checkTrue('all empty: error lists Bing and Baidu', message.includes('Bing') && message.includes('百度'), message);
}

// An empty engine order must still search with the defaults.
{
  const { provider } = makeProvider({
    engineOrder: [],
    rows: () => [{ title: 'x', url: 'https://example.com/c', snippet: 'x' }],
  });
  const result = await provider.search({ query: 'x' });
  check('empty order: defaults are used', result.sources.length, 1);
}

// The master switch still gates the provider.
{
  const { provider } = makeProvider({ enabled: false, rows: () => [] });
  let refused = false;
  try {
    await provider.search({ query: 'x' });
  } catch (error) {
    refused = /关闭状态/.test(String(error && error.message));
  }
  checkTrue('disabled switch: search refuses', refused);
}

// The provider reports itself unavailable when the engine cannot run.
{
  const { provider } = makeProvider({ available: false, rows: () => [] });
  check('provider unavailable without an engine', provider.available(), false);
}

console.log(failed === 0 ? 'SEARCH TEST OK (' + total + ' checks)' : 'SEARCH TEST FAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
