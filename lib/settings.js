/**
 * Plugin settings and the master switch state.
 *
 * Persisted as JSON under the user's DSH home so browser logins and the switch
 * survive a restart. The plugin reads the file synchronously at activation and
 * writes it on every change (small file, low frequency).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directory owning this plugin's persisted state. */
export function dataDir() {
  return path.join(os.homedir(), '.dsh', 'web-browser');
}

/** Defaults for every setting field. */
export const DEFAULTS = {
  /** Master switch: while off, the browser tools refuse and the search provider is unavailable. */
  enabled: true,
  /** Run the controlled browser without a visible window; the right sidebar shows its frames. */
  headless: true,
  /**
   * Execution engine: 'classic' (standalone Chromium driven over CDP),
   * 'native' (the Desktop built-in renderer, experimental), or 'auto'
   * (native while its view is mounted, classic otherwise / on fallback).
   */
  engineMode: 'classic',
  /** Explicit Chromium executable; empty means auto-detect. */
  browserPath: '',
  /** Search engines tried in order until one returns results. */
  engineOrder: ['baidu', 'bing', 'duckduckgo'],
  /** Page viewport in CSS pixels; the sidebar preview keeps this aspect ratio. */
  viewport: { width: 1100, height: 820 },
  /** Provider id this plugin registers with ctx.web. */
  providerId: 'browser',
  /** Optional fixed user-data directory; empty uses the plugin data directory. */
  profileDir: '',
  /** Refuse navigation to loopback / private / link-local hosts unless explicitly allowed. */
  blockPrivateAddresses: true,
  /** Allow the `browser` tool's eval action to run arbitrary page JavaScript. */
  allowEval: false,
  /** Delete the browser profile (cookies, logins, cache) when the master switch turns off. */
  clearProfileOnDisable: false,
};

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Coerce one persisted boolean. Hand edits and older files sometimes carry
 * `"false"`/`0` instead of a real boolean; a strict `!== false` test would read
 * them as true, so accept the obvious spellings and fall back otherwise.
 */
function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'on' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'off' || text === 'no') return false;
  }
  return fallback;
}

/** Coerce unknown persisted data onto the known shape. */
export function normalizeSettings(raw) {
  const next = { ...copy(DEFAULTS), ...(raw && typeof raw === 'object' ? raw : {}) };
  next.enabled = toBoolean(next.enabled, true);
  next.headless = toBoolean(next.headless, true);
  // Unknown persisted values (older files, hand edits) fall back to 'classic':
  // the stable engine is always the safe choice.
  next.engineMode = next.engineMode === 'native' || next.engineMode === 'auto' ? next.engineMode : 'classic';
  next.browserPath = typeof next.browserPath === 'string' ? next.browserPath : '';
  next.profileDir = typeof next.profileDir === 'string' ? next.profileDir : '';
  // Deduplicate and drop junk. An empty list would leave search with no engine
  // at all, so it falls back to the defaults instead.
  const order = Array.isArray(next.engineOrder) ? next.engineOrder.filter((id) => typeof id === 'string' && id !== '') : [];
  next.engineOrder = order.length > 0 ? Array.from(new Set(order)) : copy(DEFAULTS.engineOrder);
  const vp = next.viewport && typeof next.viewport === 'object' ? next.viewport : {};
  next.viewport = {
    width: Number.isFinite(vp.width) ? Math.min(1920, Math.max(480, Math.round(vp.width))) : DEFAULTS.viewport.width,
    height: Number.isFinite(vp.height) ? Math.min(1600, Math.max(360, Math.round(vp.height))) : DEFAULTS.viewport.height,
  };
  next.providerId = typeof next.providerId === 'string' && next.providerId !== '' ? next.providerId : DEFAULTS.providerId;
  next.blockPrivateAddresses = toBoolean(next.blockPrivateAddresses, true);
  next.allowEval = toBoolean(next.allowEval, false);
  next.clearProfileOnDisable = toBoolean(next.clearProfileOnDisable, false);
  return next;
}

/** Settings file owner for one process. */
export class SettingsStore {
  constructor() {
    this.dir = dataDir();
    this.file = path.join(this.dir, 'settings.json');
    this.value = normalizeSettings(undefined);
    this.#load();
  }

  #load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      this.value = normalizeSettings(JSON.parse(text));
    } catch {
      this.value = normalizeSettings(undefined);
    }
  }

  /** Current settings snapshot. */
  get() {
    return copy(this.value);
  }

  /** Whether the master switch is on. */
  isEnabled() {
    return this.value.enabled;
  }

  /** Merge one partial update, persist it, and return the new snapshot. */
  update(patch) {
    const merged = normalizeSettings({ ...this.value, ...(patch || {}) });
    if (patch && patch.viewport && typeof patch.viewport === 'object') {
      merged.viewport = normalizeSettings({ viewport: { ...this.value.viewport, ...patch.viewport } }).viewport;
    }
    this.value = merged;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Write-then-rename: a crash mid-write must not truncate the file the next
      // start reads (a broken file silently falls back to defaults).
      const temp = this.file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(merged, null, 2), 'utf8');
      fs.renameSync(temp, this.file);
    } catch {
      // A read-only home still leaves the in-memory value usable for this run.
    }
    return copy(merged);
  }

  /** Set the master switch. */
  setEnabled(enabled) {
    return this.update({ enabled: enabled === true });
  }
}
