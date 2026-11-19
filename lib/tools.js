/**
 * Model-facing `browser` tool: one tool, one `action` switch, so the agent gets
 * page operation without adding a dozen schemas to every request.
 *
 * Every action returns a short rendered report; page content caps are applied
 * here so a huge page cannot flood the conversation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACTIONS = ['open', 'state', 'read', 'click', 'act', 'type', 'press', 'scroll', 'wait', 'screenshot', 'eval', 'back', 'forward', 'reload', 'close', 'providers'];

/** Directory screenshots are written to; the model reads them with read_image. */
export function screenshotDir() {
  return path.join(os.homedir(), '.dsh', 'web-browser', 'shots');
}

function formatState(snapshot) {
  const lines = [
    '状态：' + (snapshot.enabled ? '已启用' : '已关闭'),
    '浏览器：' + (snapshot.running ? '运行中' : '未启动') + (snapshot.executableFound ? '' : '（未找到可执行文件）'),
    '页面：' + (snapshot.title ? snapshot.title + ' — ' : '') + (snapshot.url || 'about:blank'),
  ];
  if (snapshot.loading) lines.push('加载中…');
  return lines.join('\n');
}

/**
 * Build the `browser` tool definition.
 * @param options - engine, settings reader, and logger.
 */
export function createBrowserTool({ engine, settings, log, ctx, provider }) {
  /** Images prepared during execute, attached by projectContent (keyed by call). */
  const pendingImages = new WeakMap();
  /** Whether one model route declares image input; resolved once per route. */
  const visionModels = new Map();

  /**
   * Resolve whether the calling model accepts images, plus the service needed
   * to store one. Undefined means "text only": the caller must not attach.
   */
  async function imageAttachmentSupport(exec) {
    if (exec === undefined || exec === null) return undefined;
    let attachments;
    let llm;
    try {
      attachments = ctx.get('attachments');
      llm = ctx.get('llm');
    } catch {
      return undefined;
    }
    if (attachments === undefined || attachments === null || llm === undefined || llm === null) return undefined;
    const agent = exec.agent;
    if (agent === undefined || agent === null) return undefined;
    let config;
    try {
      const routed = typeof agent.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
      config = routed !== undefined && routed !== null ? routed.config : undefined;
    } catch {
      config = undefined;
    }
    const options = agent.options !== undefined && agent.options !== null ? agent.options : {};
    const providerId = config !== undefined && config !== null && config.provider !== undefined ? config.provider : options.provider;
    const modelId = config !== undefined && config !== null && config.model !== undefined ? config.model : options.model;
    if (providerId === undefined || modelId === undefined) return undefined;
    const key = String(providerId) + '/' + String(modelId);
    if (visionModels.has(key)) return visionModels.get(key) === true ? { attachments } : undefined;
    let supported = false;
    try {
      const info = await llm.resolveModelInfo(providerId, modelId);
      supported = info !== undefined && info !== null && Array.isArray(info.inputModalities) && info.inputModalities.includes('image');
    } catch {
      supported = false;
    }
    visionModels.set(key, supported);
    return supported ? { attachments } : undefined;
  }

  return {
    name: 'browser',
    description: [
      'Operate the DSH controlled browser (Edge/Chrome, headless) shown in the right sidebar.',
      'Actions: open(url) | state | read(mode=text|links|html, selector?, maxChars?) | click(selector?|text?|x,y?) |',
      'type(text, selector?, submit?) | press(key) | scroll(dy) | wait(waitFor, value, timeoutMs?) |',
      'act(steps) | screenshot(quality?, inline?) | eval [expression; disabled unless enabled in settings] | back | forward | reload | close.',
      'act runs several inputs in one call (click/clickText/key/type/scroll/navigate/wait), the fast path for games and repetitive forms.',
      'screenshot returns the page as an image in this same result when the calling model accepts image input.',
      'providers shows which web search providers are registered and configured.',
      'The browser is shared with the user-visible sidebar preview, so a click or navigation is visible to them.',
      'If the user turned Web actions off, actions fail with that reason.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
        url: { type: 'string', description: 'URL for open (http/https; a bare host gets https://).' },
        selector: { type: 'string', description: 'CSS selector for read/click/type.' },
        text: { type: 'string', description: 'Visible label to click, or text to type.' },
        x: { type: 'number', description: 'Viewport x in CSS pixels for click.' },
        y: { type: 'number', description: 'Viewport y in CSS pixels for click.' },
        key: { type: 'string', description: 'Key name for press: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space.' },
        dy: { type: 'number', description: 'Wheel delta for scroll; positive scrolls down. Defaults to 600.' },
        mode: { type: 'string', enum: ['text', 'links', 'html'], description: 'read output kind; defaults to text.' },
        maxChars: { type: 'number', description: 'Cap on returned characters for read (default 20000).' },
        expression: { type: 'string', description: 'JavaScript expression for eval; the result must be JSON-serializable.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        waitFor: { type: 'string', enum: ['selector', 'text', 'url'], description: 'Condition kind for wait; defaults to selector.' },
        value: { type: 'string', description: 'Selector, text, or URL fragment for wait.' },
        timeoutMs: { type: 'number', description: 'Timeout for wait in milliseconds (default 10000).' },
        steps: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'Batch for act, executed in order: {op:"click",x,y} | {op:"clickText",selector?,text?} | {op:"key",key} | {op:"type",text,selector?,submit?} | {op:"scroll",dy} | {op:"navigate",url} | {op:"wait",ms}.',
        },
        quality: { type: 'number', description: 'JPEG quality for screenshot, 20-90 (default 62).' },
        inline: { type: 'boolean', description: 'Attach the screenshot as an image in the tool result when the calling model accepts images (default true).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Human-readable report for the model.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    /** Attach the image captured during execute, when there is one. */
    projectContent(exec, result) {
      const attachment = pendingImages.get(exec);
      if (attachment === undefined) return undefined;
      const textContent = Array.isArray(result.content)
        ? result.content.filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
        : [];
      return [...textContent, { type: 'image', attachment }];
    },
    async execute(args, exec) {
      const action = String(args && args.action ? args.action : '');
      if (!ACTIONS.includes(action)) throw new Error('unknown browser action: ' + action);
      // Diagnostics and teardown stay available while the switch is off; every
      // action that touches the browser (including `open`) refuses, so a failed
      // call cannot silently launch a browser or reveal the sidebar view.
      if (settings().enabled !== true && action !== 'state' && action !== 'close' && action !== 'providers') {
        throw new Error('Web 操作当前是关闭状态：请在输入框的「Web操作」开关或 设置 → Web操作 中启用');
      }
      const report = (text) => ({ text });
      // Record model-driven activity so the UI can reveal its view on demand;
      // passive diagnostics do not count as "operating the web".
      if (action !== 'state' && action !== 'providers' && action !== 'close') {
        engine.lastActionAt = Date.now();
      }

      if (action === 'state') {
        return report(formatState(engine.status()));
      }
      if (action === 'open') {
        const result = await engine.navigate(args.url);
        return report('已打开：' + (result.title ? result.title + ' — ' : '') + result.url);
      }
      if (action === 'read') {
        const requested = Number(args.maxChars);
        const maxChars = args.maxChars === undefined || !Number.isFinite(requested)
          ? 20000
          : Math.max(1, Math.min(200000, Math.round(requested)));
        const result = await engine.read({ mode: args.mode, selector: args.selector, maxChars });
        if (result.ok === false) return report('读取失败：' + result.reason + '（' + result.url + '）');
        if (args.mode === 'links') {
          const lines = (result.links || []).map((link, index) => String(index + 1) + '. ' + (link.text || '(无文字)') + ' — ' + link.href);
          return report('页面：' + (result.title || '') + ' — ' + result.url + '\n链接 ' + String(lines.length) + ' 个：\n' + lines.join('\n'));
        }
        if (args.mode === 'html') {
          return report('页面：' + (result.title || '') + ' — ' + result.url + '\n\n' + result.html);
        }
        return report('页面：' + (result.title || '') + ' — ' + result.url + '\n\n' + result.text);
      }
      if (action === 'click') {
        const result = await engine.click({ selector: args.selector, text: args.text, x: args.x, y: args.y });
        if (result.ok !== true) return report('点击失败：' + result.reason + '（' + (result.url || engine.status().url) + '）');
        return report('已点击 ' + (result.label ? '"' + result.label + '" ' : '') + '(' + result.method + ')；当前页面：' + engine.status().url);
      }
      if (action === 'type') {
        const result = await engine.typeText({ selector: args.selector, text: args.text, submit: args.submit });
        if (result.ok !== true) return report('输入失败：' + result.reason);
        return report('已输入到 ' + result.target + (args.submit === true ? ' 并提交' : '') + '；当前页面：' + (engine.status().url || '(未变)'));
      }
      if (action === 'press') {
        try {
          await engine.pressKey(args.key);
        } catch (error) {
          return report(String(error && error.message ? error.message : error));
        }
        return report('已按下 ' + args.key + '；当前页面：' + engine.status().url);
      }
      if (action === 'scroll') {
        await engine.scroll(args.dy);
        return report('已滚动 ' + String(Number.isFinite(args.dy) ? args.dy : 600) + ' 像素');
      }
      if (action === 'wait') {
        const result = await engine.waitFor({ kind: args.waitFor, value: args.value, timeoutMs: args.timeoutMs });
        return report(result.ok ? '条件已满足（' + String(result.waitedMs) + 'ms）' : '等待超时（' + String(result.waitedMs) + 'ms）：' + String(args.value));
      }
      if (action === 'screenshot') {
        const quality = Number.isFinite(args.quality) ? args.quality : 62;
        const shot = await engine.captureJpeg(quality);
        const dir = screenshotDir();
        fs.mkdirSync(dir, { recursive: true });
        const mediaType = shot.mediaType === 'image/png' ? 'image/png' : 'image/jpeg';
        const extension = mediaType === 'image/png' ? '.png' : '.jpg';
        const file = path.join(dir, 'browser-' + new Date().toISOString().replace(/[:.]/g, '-') + extension);
        fs.writeFileSync(file, shot.buffer);
        // Keep the shots directory bounded: newest 20 captures only.
        try {
          const names = fs.readdirSync(dir).filter((name) => /\.(jpe?g|png)$/i.test(name));
          if (names.length > 20) {
            const ordered = names
              .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
              .sort((left, right) => right.at - left.at);
            for (const stale of ordered.slice(20)) fs.rmSync(path.join(dir, stale.name), { force: true });
          }
        } catch { /* pruning is best effort */ }
        let note = '';
        if (args.inline === false) {
          note = '\n（已关闭内联图片）';
        } else {
          const support = await imageAttachmentSupport(exec);
          if (support === undefined) {
            note = '\n（当前模型没有声明图片输入，画面未附加；请用 read 取文字，或看右侧面板）';
          } else {
            try {
              const attachment = await support.attachments.saveImage({
                data: shot.buffer,
                mediaType: mediaType,
                name: 'browser-shot' + extension,
              });
              pendingImages.set(exec, attachment);
              note = '\n（画面已作为图片附在本结果里）';
            } catch (error) {
              note = '\n（图片附加失败：' + String(error && error.message ? error.message : error) + '）';
            }
          }
        }
        return report('截图已保存：' + file + '\n页面：' + (shot.title || '') + ' — ' + shot.url + note + '\n（' + shot.buffer.length + ' 字节 ' + (mediaType === 'image/png' ? 'PNG' : 'JPEG') + '，质量 ' + shot.quality + '）');
      }
      if (action === 'act') {
        const steps = Array.isArray(args.steps) ? args.steps.slice(0, 24) : [];
        if (steps.length === 0) {
          return report('act 需要 steps 数组，例如 [{"op":"click","x":100,"y":200},{"op":"key","key":"ArrowRight"},{"op":"wait","ms":120}]');
        }
        const log = [];
        let failures = 0;
        for (const step of steps) {
          const op = step !== null && typeof step === 'object' && step.op !== undefined ? String(step.op) : '';
          const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          if (op === 'click') {
            const x = Number(step.x);
            const y = Number(step.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              // A missing coordinate used to reach the engine as NaN and fail
              // the whole batch with an opaque CDP error.
              failures += 1;
              log.push('skip click（坐标不是数字）');
            } else {
              const result = await engine.clickAt(x, y);
              if (result !== undefined && result.ok === false) failures += 1;
              log.push('click ' + Math.round(x) + ',' + Math.round(y));
            }
          } else if (op === 'clickText') {
            const result = await engine.click({ selector: step.selector, text: step.text });
            if (result !== undefined && result.ok === false) failures += 1;
            log.push('click «' + String(step.text !== undefined ? step.text : step.selector !== undefined ? step.selector : '') + '»');
          } else if (op === 'key' || op === 'press') {
            const key = String(step.key === undefined ? 'Enter' : step.key);
            await engine.pressKey(key);
            log.push('key ' + key);
          } else if (op === 'type') {
            const value = String(step.text === undefined ? '' : step.text);
            await engine.typeText({ text: value, selector: step.selector, submit: step.submit === true });
            log.push('type ' + JSON.stringify(value).slice(0, 40) + (step.submit === true ? ' +Enter' : ''));
          } else if (op === 'scroll') {
            const dy = step.dy === undefined ? 600 : Number(step.dy);
            await engine.scroll(Number.isFinite(dy) ? dy : 600);
            log.push('scroll ' + String(step.dy === undefined ? 600 : step.dy));
          } else if (op === 'navigate' || op === 'open') {
            const result = await engine.navigate(step.url);
            log.push('open ' + String(result.url));
          } else if (op === 'wait') {
            const raw = Number(step.ms);
            const ms = Number.isFinite(raw) ? Math.max(0, Math.min(5000, Math.round(raw))) : 0;
            await pause(ms);
            log.push('wait ' + ms + 'ms');
          } else if (op === 'screenshot') {
            log.push('screenshot(已忽略，如需画面请在 act 之后单独调用 screenshot)');
          } else {
            failures += 1;
            log.push('skip ' + op);
          }
          if (op !== 'wait') await pause(op === 'key' || op === 'press' ? 20 : 40);
        }
        const status = engine.status();
        return report('已执行 ' + log.length + ' 步：' + log.join(' → ') + '\n页面：' + (status.title ? status.title + ' — ' : '') + (status.url || 'about:blank') + (failures > 0 ? '\n（其中 ' + failures + ' 步失败）' : ''));
      }
      if (action === 'eval') {
        if (settings().allowEval !== true) {
          return report('页面脚本执行（eval）当前被禁用。需要时请在 设置 → Web操作 里打开「允许页面脚本执行」。');
        }
        const value = await engine.evaluate(String(args.expression === undefined ? '' : args.expression));
        let text;
        try { text = JSON.stringify(value); } catch { text = String(value); }
        if (text === undefined) text = 'undefined';
        return report(text.length > 20000 ? text.slice(0, 20000) + '…' : text);
      }
      if (action === 'back' || action === 'forward') {
        // Facade commands, so the native engine navigates through its own bridge.
        await engine[action]();
        await engine.waitFor({ kind: 'selector', value: 'body', timeoutMs: 5000 }).catch(() => undefined);
        return report('已' + (action === 'back' ? '后退' : '前进') + '；当前页面：' + engine.status().url);
      }
      if (action === 'reload') {
        await engine.reload();
        return report('已刷新：' + engine.status().url);
      }
      if (action === 'close') {
        await engine.stop();
        log('browser stopped by tool');
        return report('受控浏览器已关闭');
      }
      if (action === 'providers') {
        let registered = '不可读（web 服务不可用）';
        try {
          const list = ctx.web.listProviders();
          registered = (list.search || []).map((entry) => entry.id).join(', ') || '(无)';
        } catch { /* keep the diagnostic text */ }
        let configured = '(未配置，默认按唯一可用提供方选择)';
        try {
          const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
          if (editor !== undefined && editor !== null) {
            for (const row of editor.configuration()) {
              const merged = { ...(row.inherited || {}), ...(row.override || {}) };
              if (Object.prototype.hasOwnProperty.call(merged, 'searchProvider')) {
                configured = merged.searchProvider === undefined ? '(未配置)' : String(merged.searchProvider);
                break;
              }
            }
          }
        } catch { /* diagnostics only */ }
        return report([
          '本插件搜索提供方 id：' + settings().providerId,
          '已注册的搜索提供方：' + registered,
          '当前配置的搜索提供方：' + configured,
          '是否由本插件接管：' + (configured === settings().providerId ? '是' : '否'),
          '开关状态：' + (settings().enabled ? '已启用' : '已关闭'),
          '引擎可用：' + (engine.available() ? '是' : '否（未找到浏览器可执行文件）'),
        ].join('\n'));
      }
      return report('未执行');
    },
  };
}
