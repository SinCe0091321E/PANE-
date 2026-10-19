'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const PRESET_SITES = [
  {
    id: 'baidu-fanyi',
    name: '百度翻译',
    url: 'https://fanyi.baidu.com/mtpe-individual/multimodal?ext_channel=BingSearch',
    adapter: 'baidu-fanyi',
    category: 'translate',
    enabled: true,
    overrides: { hide: [], selectors: {}, css: '', js: '' }
  },
  {
    id: 'huaban',
    name: '花瓣',
    url: 'https://huaban.com/discovery',
    adapter: 'huaban',
    category: 'gallery',
    enabled: true,
    overrides: { hide: [], selectors: {}, css: '', js: '' }
  },
  {
    id: 'oalib',
    name: 'OALib 文献',
    url: 'https://www.oalib.com/',
    adapter: 'oalib',
    category: 'text',
    enabled: true,
    overrides: { hide: [], selectors: {}, css: '', js: '' }
  },
  {
    id: 'youtube',
    name: 'YouTube 视频',
    url: 'https://www.youtube.com/watch?v=P9sQZLtsfp8',
    adapter: 'youtube',
    category: 'video',
    enabled: true,
    overrides: { hide: [], selectors: {}, css: '', js: '' }
  }
];

const PRESET_CATEGORIES = [
  { id: 'translate', name: '翻译', mode: 'translate', builtin: true },
  { id: 'gallery', name: '图片', mode: 'gallery', builtin: true },
  { id: 'text', name: '文本', mode: 'text', builtin: true },
  { id: 'video', name: '视频', mode: 'video', builtin: true },
  { id: 'audio', name: '音频', mode: 'audio', builtin: true },
  { id: 'generic', name: '通用', mode: 'generic', builtin: true }
];

const DEFAULTS = {
  version: 1,
  theme: {
    mode: 'system', // light | dark | gray | paper | system
    accent: '#4f7cff',
    radius: 14,
    fontScale: 1,
    dimSite: true,
    glass: false, // 毛玻璃材质（Windows 11 亚克力）
    motion: 'normal' // full | normal | calm
  },
  window: {
    bounds: { x: null, y: null, width: 430, height: 720 },
    pinned: false,
    opacity: 1
  },
  sites: PRESET_SITES,
  categories: PRESET_CATEGORIES,
  activeSiteId: 'baidu-fanyi',
  behavior: {
    readAloud: false
  }
};

let config = null;
let configFile = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isPlainObject(patch)) return clone(base);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = merge(base[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalize(input) {
  const cfg = merge(DEFAULTS, input || {});

  cfg.theme.mode = ['light', 'dark', 'gray', 'paper', 'system'].includes(cfg.theme.mode)
    ? cfg.theme.mode
    : 'system';
  cfg.theme.accent = /^#[0-9a-f]{6}$/i.test(String(cfg.theme.accent)) ? cfg.theme.accent : DEFAULTS.theme.accent;
  cfg.theme.radius = clampNumber(cfg.theme.radius, 0, 24, 14);
  cfg.theme.fontScale = clampNumber(cfg.theme.fontScale, 0.8, 1.6, 1);
  cfg.theme.motion = ['full', 'normal', 'calm'].includes(cfg.theme.motion) ? cfg.theme.motion : 'normal';
  cfg.theme.dimSite = cfg.theme.dimSite !== false;
  cfg.theme.glass = Boolean(cfg.theme.glass);

  const b = cfg.window.bounds || {};
  cfg.window.bounds = {
    x: Number.isFinite(Number(b.x)) ? Math.round(Number(b.x)) : null,
    y: Number.isFinite(Number(b.y)) ? Math.round(Number(b.y)) : null,
    width: clampNumber(b.width, 360, 1600, 430),
    height: clampNumber(b.height, 480, 1200, 720)
  };
  cfg.window.pinned = Boolean(cfg.window.pinned);
  cfg.window.opacity = clampNumber(cfg.window.opacity, 0.6, 1, 1);

  // 网站种类：内置种类固定存在，自定义种类追加在后面
  const modes = ['translate', 'gallery', 'text', 'video', 'audio', 'generic'];
  const rawCategories = Array.isArray(cfg.categories) ? cfg.categories : [];
  const builtinCategories = PRESET_CATEGORIES.map((item) => ({ ...item }));
  const customCategories = [];
  const seenCategories = new Set(builtinCategories.map((item) => item.id));
  for (const item of rawCategories) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    const mode = modes.includes(item.mode) ? item.mode : 'generic';
    if (!id || !name || seenCategories.has(id)) continue;
    seenCategories.add(id);
    customCategories.push({ id, name, mode, builtin: false });
  }
  cfg.categories = [...builtinCategories, ...customCategories];

  if (!Array.isArray(cfg.sites) || cfg.sites.length === 0) cfg.sites = clone(PRESET_SITES);
  const validCategory = (id) => (seenCategories.has(id) ? id : 'auto');
  // 老配置没有 category：按内置适配器推断一次，避免百度/花瓣丢掉原有行为
  const inferCategory = (adapterId) => {
    if (adapterId === 'baidu-fanyi') return 'translate';
    if (adapterId === 'huaban' || adapterId === 'pixiv') return 'gallery';
    return 'auto';
  };
  cfg.sites = cfg.sites
    .filter((site) => site && typeof site === 'object' && typeof site.url === 'string')
    .map((site, index) => {
      const adapter = String(site.adapter || 'auto');
      return {
        id: String(site.id || `site-${index + 1}`),
        name: String(site.name || site.url),
        url: String(site.url),
        adapter,
        category: site.category ? validCategory(String(site.category)) : inferCategory(adapter),
        enabled: site.enabled !== false,
        overrides: {
          hide: Array.isArray(site.overrides?.hide) ? site.overrides.hide.filter((s) => typeof s === 'string') : [],
          selectors: isPlainObject(site.overrides?.selectors) ? site.overrides.selectors : {},
          css: typeof site.overrides?.css === 'string' ? site.overrides.css : '',
          js: typeof site.overrides?.js === 'string' ? site.overrides.js : ''
        }
      };
    });

  if (!cfg.sites.some((site) => site.id === cfg.activeSiteId)) {
    cfg.activeSiteId = cfg.sites[0]?.id || null;
  }
  cfg.behavior = merge(DEFAULTS.behavior, cfg.behavior);
  return cfg;
}

function getConfigFile() {
  if (!configFile) {
    configFile = path.join(app.getPath('userData'), 'config.json');
  }
  return configFile;
}

function load() {
  const file = getConfigFile();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  config = normalize(raw);
  if (!fs.existsSync(file)) save();
  return config;
}

function get() {
  if (!config) load();
  return config;
}

function save() {
  const file = getConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return config;
}

function set(patch, { persist = true } = {}) {
  config = normalize(merge(config || DEFAULTS, patch));
  if (persist) save();
  return config;
}

function reset() {
  config = normalize(DEFAULTS);
  save();
  return config;
}

function configPath() {
  return getConfigFile();
}

module.exports = { load, get, set, save, reset, configPath, DEFAULTS, PRESET_SITES };
