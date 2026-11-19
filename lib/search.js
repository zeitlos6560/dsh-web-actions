/**
 * Browser-backed web search: the `web` seam provider that replaces the
 * DeepSeek Search API by driving the controlled browser to a search engine and
 * reading the result list out of the rendered page.
 *
 * Engines are tried in the configured order until one yields sources, so a
 * blocked or captcha page falls through instead of failing the search.
 */

/** Engines in default preference order, each with a URL builder and extractor. */
export const ENGINES = {
  bing: {
    id: 'bing',
    title: 'Bing',
    // `www.bing.com` answers headless Chromium with unrelated "related to your
    // previous query" pages; the China host returns the real server-rendered
    // result list. Outside China cn.bing.com redirects to the regional host.
    url: (query) => 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&mkt=zh-CN&count=10',
    script: (limit) => `(() => {
      const textOf = (el) => el === null || el === undefined ? '' : (el.innerText && el.innerText.trim() !== '' ? el.innerText : (el.textContent || ''));
      const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const row of Array.from(document.querySelectorAll('#b_results > li.b_algo, #b_results li.b_algo'))) {
        const anchor = row.querySelector('h2 a') || row.querySelector('a[href]');
        if (!anchor || !/^https?:/.test(anchor.href || '')) continue;
        // The "related searches" strip links back into Bing itself.
        if (/^https?:\\/\\/(www|cn)\\.bing\\.com\\/(search\\?|$)/i.test(anchor.href || '')) continue;
        const snippet = textOf(row.querySelector('.b_caption p, .b_algoSlug, .b_snippet, p')) || textOf(row);
        out.push({
          title: norm(textOf(anchor)).slice(0, 200),
          url: anchor.href,
          snippet: norm(snippet).slice(0, 320),
        });
        if (out.length >= ${String(limit)}) break;
      }
      return out;
    })()`,
    alt: {
      url: (query) => 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&mkt=zh-CN&count=10',
      script: (limit) => `(() => {
      const textOf = (el) => el === null || el === undefined ? '' : (el.innerText && el.innerText.trim() !== '' ? el.innerText : (el.textContent || ''));
      const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const row of Array.from(document.querySelectorAll('#b_results > li.b_algo, #b_results li.b_algo'))) {
        const anchor = row.querySelector('h2 a') || row.querySelector('a[href]');
        if (!anchor || !/^https?:/.test(anchor.href || '')) continue;
        if (/^https?:\\/\\/(www|cn)\\.bing\\.com\\/(search\\?|$)/i.test(anchor.href || '')) continue;
        const snippet = textOf(row.querySelector('.b_caption p, .b_algoSlug, .b_snippet, p')) || textOf(row);
        out.push({
          title: norm(textOf(anchor)).slice(0, 200),
          url: anchor.href,
          snippet: norm(snippet).slice(0, 320),
        });
        if (out.length >= ${String(limit)}) break;
      }
      return out;
    })()`,
    },
  },

  baidu: {
    id: 'baidu',
    title: '百度',
    url: (query) => 'https://www.baidu.com/s?ie=utf-8&wd=' + encodeURIComponent(query) + '&rn=10',
    script: (limit) => `(() => {
      const textOf = (el) => el === null || el === undefined ? '' : (el.innerText && el.innerText.trim() !== '' ? el.innerText : (el.textContent || ''));
      const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const row of Array.from(document.querySelectorAll('#content_left > div, #content_left .result, .result-op'))) {
        const anchor = row.querySelector('h3 a') || row.querySelector('a[href]');
        if (!anchor || !/^https?:/.test(anchor.href || '')) continue;
        // The 相关搜索 / 热榜 widgets sit in the same column and link back into
        // Baidu's own search; they are not results and must not become sources.
        if (/^https?:\\/\\/(www|m|wap)\\.baidu\\.com\\/(s\\?|s\\/|$)/i.test(anchor.href || '')) continue;
        const snippet = textOf(row.querySelector('.c-abstract, [class*="abstract"], .content-right_8Zs40, .c-span-last')) || textOf(row);
        const title = norm(textOf(anchor)).slice(0, 200);
        if (title === '') continue;
        out.push({ title, url: anchor.href, snippet: norm(snippet).slice(0, 320) });
        if (out.length >= ${String(limit)}) break;
      }
      return out;
    })()`,
    alt: {
      // Mobile Baidu is less aggressive with the desktop captcha interstitial.
      url: (query) => 'https://m.baidu.com/s?word=' + encodeURIComponent(query),
      script: (limit) => `(() => {
        const textOf = (el) => el === null || el === undefined ? '' : (el.innerText && el.innerText.trim() !== '' ? el.innerText : (el.textContent || ''));
        const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
        const out = [];
        for (const row of Array.from(document.querySelectorAll('#page .c-result, .c-result, .result-op'))) {
          const anchor = row.querySelector('a[href]');
          if (!anchor) continue;
          let href = anchor.href || '';
          // Mobile Baidu wraps targets in a /from=... src=<encoded> link; prefer
          // the real target and drop Baidu-internal recommendation links.
          const srcMatch = href.match(/[?&]src=([^&]+)/);
          if (srcMatch !== null) {
            try { href = decodeURIComponent(srcMatch[1]); } catch (error) { /* keep raw */ }
          }
          if (!/^https?:/.test(href)) continue;
          if (/^https?:\\/\\/(m|www|wap)\\.baidu\\.com/i.test(href)) continue;
          const title = norm(textOf(anchor.querySelector('div, span, p') || anchor)).slice(0, 200);
          if (title === '') continue;
          out.push({ title, url: href, snippet: norm(textOf(row)).slice(0, 320) });
          if (out.length >= ${String(limit)}) break;
        }
        return out;
      })()`,
    },
  },
  duckduckgo: {
    id: 'duckduckgo',
    title: 'DuckDuckGo',
    url: (query) => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    script: (limit) => `(() => {
      const textOf = (el) => el === null || el === undefined ? '' : (el.innerText && el.innerText.trim() !== '' ? el.innerText : (el.textContent || ''));
      const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const row of Array.from(document.querySelectorAll('.result, .web-result, .result__body'))) {
        const anchor = row.querySelector('a.result__a, a[href]');
        if (!anchor) continue;
        let href = anchor.href || '';
        const redirect = href.indexOf('uddg=');
        if (redirect >= 0) {
          try { href = decodeURIComponent(href.slice(redirect + 5).split('&')[0]); } catch (error) { /* keep raw */ }
        }
        if (!/^https?:/.test(href)) continue;
        const snippet = textOf(row.querySelector('.result__snippet')) || textOf(row);
        out.push({
          title: norm(textOf(anchor)).slice(0, 200),
          url: href,
          snippet: norm(snippet).slice(0, 320),
        });
        if (out.length >= ${String(limit)}) break;
      }
      return out;
    })()`,
  },
};

/** Deduplicate and normalize one engine's rows into the seam's source shape. */
export function toSources(rows, limit) {
  const seen = new Set();
  const sources = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue;
    const url = typeof row.url === 'string' ? row.url : '';
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : undefined;
    const snippet = typeof row.snippet === 'string' && row.snippet.trim() !== '' ? row.snippet.trim() : undefined;
    const source = { url };
    if (title !== undefined) source.title = title;
    if (snippet !== undefined) { source.snippet = snippet; source.summary = snippet; }
    sources.push(source);
    if (Number.isFinite(limit) && sources.length >= limit) break;
  }
  return sources;
}

/**
 * Split a query into match tokens: whole words for latin text, overlapping
 * two-character grams for CJK. Used only to reject a result list that clearly
 * belongs to some other page (an engine redirect, a captcha or a home page).
 */
export function queryTokens(query) {
  const text = String(query || '').trim();
  const tokens = [];
  for (const word of text.split(/[\s,，。；;、/]+/)) {
    if (word === '') continue;
    if (/^[a-z0-9_+-]+$/i.test(word)) {
      if (word.length >= 2) tokens.push(word.toLowerCase());
      continue;
    }
    const chars = Array.from(word.replace(/\s+/g, ''));
    if (chars.length <= 2) tokens.push(word);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/** Whether a source plausibly belongs to this query (tokens in title/snippet). */
export function matchesQuery(source, tokens) {
  if (tokens.length === 0) return true;
  // Latin tokens are lowercased by `queryTokens`; compare case-insensitively or
  // a normally capitalized title would be rejected as unrelated.
  const haystack = (String(source.title || '') + ' ' + String(source.snippet || '')).toLowerCase();
  // CJK queries expand into overlapping bigrams, so an unrelated page can match
  // two common grams (城乡 + 居民) and slip through; demand one more hit there.
  // Latin word tokens stay at two hits: they are far more specific.
  const cjk = tokens.some((token) => /[\u3400-\u9fff]/.test(token));
  const required = Math.min(cjk ? 3 : 2, tokens.length);
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
    if (hits >= required) return true;
  }
  return false;
}

/**
 * Build the `ctx.web` search provider for the controlled browser.
 * @param options - settings reader, engine, and the logger used for engine fallbacks.
 */
export function createBrowserSearchProvider({ settings, engine, log }) {
  const describe = {
    en: 'Searches by driving the controlled browser on this machine, then reads the rendered result list. No search API key is used. Needs the Web actions switch turned on.',
    zh: '通过驱动本机的受控浏览器打开搜索引擎，读取渲染后的结果列表，不消耗搜索 API 额度。需要开启「Web操作」开关。',
  };
  return {
    id: settings().providerId,
    title: '受控浏览器',
    description: describe,
    available() {
      try {
        const current = settings();
        return current.enabled === true && engine.available();
      } catch {
        return false;
      }
    },
    async search(request, signal) {
      const query = String(request && request.query ? request.query : '').trim();
      if (query === '') throw new Error('空搜索词');
      if (settings().enabled !== true) {
        throw new Error('Web 操作当前是关闭状态：请在输入框的「Web操作」开关或 设置 → Web操作 中启用后再搜索');
      }
      const limit = Number.isFinite(request && request.maxResults) ? Math.max(1, Math.min(10, request.maxResults)) : 10;
      const configured = settings().engineOrder;
      // Defensive fallback: an empty list would otherwise mean "try nothing".
      const order = Array.isArray(configured) && configured.length > 0 ? configured : Object.keys(ENGINES);
      const tokens = queryTokens(query);
      const failures = [];
      for (const id of order) {
        const spec = ENGINES[id];
        if (spec === undefined) continue;
        if (signal !== undefined && signal.aborted) throw new Error('搜索已取消');
        let reason;
        const attempts = [{ url: spec.url(query), script: spec.script }];
        if (spec.alt !== undefined) attempts.push({ url: spec.alt.url(query), script: spec.alt.script });
        for (const attempt of attempts) {
          if (signal !== undefined && signal.aborted) throw new Error('搜索已取消');
          try {
            const rows = await engine.searchFrom(query, { url: attempt.url, script: attempt.script, limit });
            const sources = toSources(rows, limit).filter((source) => matchesQuery(source, tokens));
            if (sources.length > 0) {
              log('search ok via ' + spec.id + ': ' + String(sources.length) + ' sources');
              return { sources, truncated: false };
            }
            // A rendered result list that holds nothing relevant is the engine's
            // answer for this query; its other host cannot do better, so move on
            // to the next engine instead of paying another navigation.
            if (rows.length > 0) { reason = '结果与查询无关'; break; }
            reason = typeof engine.lastSearchFailure === 'string' && engine.lastSearchFailure !== ''
              ? engine.lastSearchFailure
              : '没有结果';
            log('search empty via ' + spec.id + ' (' + reason + ')');
          } catch (error) {
            reason = String(error && error.message ? error.message : error);
            log('search failed via ' + spec.id + ': ' + reason);
          }
        }
        failures.push(spec.title + '：' + (reason === undefined ? '没有结果' : reason));
      }
      throw new Error('浏览器搜索没有拿到结果（' + failures.join('；') + '）。可能是网络受限、引擎验证码或页面结构变化。');
    },
  };
}
