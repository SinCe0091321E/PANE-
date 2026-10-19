'use strict';

const fs = require('node:fs');
const path = require('node:path');

let ADAPTER_DIR = path.join(__dirname, '..', 'adapters');

const GENERIC = {
  id: 'generic',
  name: '通用网页',
  description: '保留网站原样，只做沉浸式处理（去滚动条、放大正文）。',
  mode: 'generic',
  match: ['*'],
  tools: ['zoom', 'open-external'],
  hide: [],
  css: '',
  selectors: {},
  custom: true
};

let registry = null;

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function normalizeAdapter(raw, file) {
  if (!raw || typeof raw !== 'object' || !raw.id) {
    throw new Error(`适配器缺少 id：${file}`);
  }
  const match = Array.isArray(raw.match) ? raw.match.filter((m) => typeof m === 'string') : [];
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    description: String(raw.description || ''),
    mode: ['translate', 'gallery', 'generic', 'text', 'video', 'audio'].includes(raw.mode) ? raw.mode : 'generic',
    engine: typeof raw.engine === 'string' ? raw.engine : null,
    match,
    matchers: match.map(globToRegExp),
    tools: Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === 'string') : ['zoom', 'open-external'],
    search: raw.search && typeof raw.search.url === 'string' ? raw.search : null,
    hide: Array.isArray(raw.hide) ? raw.hide.filter((s) => typeof s === 'string') : [],
    keep: Array.isArray(raw.keep) ? raw.keep.filter((s) => typeof s === 'string') : [],
    css: typeof raw.css === 'string' ? raw.css : '',
    selectors: raw.selectors && typeof raw.selectors === 'object' ? raw.selectors : {},
    pageScript: typeof raw.pageScript === 'string' ? raw.pageScript : '',
    crop: raw.crop !== false,
    window: raw.window && typeof raw.window === 'object' ? raw.window : null,
    custom: true,
    file: file ? path.basename(file) : null
  };
}

function load(dir) {
  if (dir) ADAPTER_DIR = dir;
  const list = [];
  let files = [];
  try {
    files = fs.readdirSync(ADAPTER_DIR).filter((name) => name.endsWith('.adapter.js'));
  } catch {
    files = [];
  }

  for (const file of files) {
    const full = path.join(ADAPTER_DIR, file);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      const adapter = normalizeAdapter(mod, full);
      if (adapter.id === 'generic') continue;
      list.push(adapter);
    } catch (error) {
      console.error(`[adapter] 载入失败 ${file}:`, error.message);
    }
  }

  registry = { list, generic: normalizeAdapter(GENERIC, null) };
  return registry;
}

function list() {
  if (!registry) load();
  return registry.list;
}

function generic() {
  if (!registry) load();
  return registry.generic;
}

function matchesUrl(adapter, url) {
  const target = String(url || '');
  return (adapter.matchers || []).some((re) => re.test(target));
}

function findById(id) {
  if (!id || id === 'auto') return null;
  return list().find((adapter) => adapter.id === id) || null;
}

function detect(url) {
  return list().find((adapter) => matchesUrl(adapter, url)) || null;
}

function toolsForMode(mode, chosen) {
  if (mode === 'translate') return ['speak-source', 'speak-target', 'phonetic', 'crop', 'zoom'];
  if (mode === 'text') return ['open-external'];
  if (mode === 'video') return ['open-external'];
  if (mode === 'audio') return ['open-external'];
  if (mode === 'gallery') {
    const tools = [];
    if (chosen.search) tools.push('search');
    tools.push('zoom', 'open-external');
    return tools;
  }
  return ['zoom', 'open-external'];
}

function resolveFor(url, adapterId, category) {
  let adapter = null;
  if (adapterId && adapterId !== 'auto') {
    adapter = findById(adapterId);
  }
  if (!adapter) adapter = detect(url);
  const chosen = adapter || generic();
  // 翻译类直接显示网站本身：保留翻译工具，但不再套自有面板
  const requestedMode = category && category.mode ? category.mode : chosen.mode;
  const mode = requestedMode === 'translate' ? 'generic' : requestedMode;

  return {
    id: chosen.id,
    name: chosen.name,
    description: chosen.description,
    mode,
    engine: chosen.engine || null,
    tools: category ? toolsForMode(requestedMode, chosen) : chosen.tools,
    category: category ? { id: category.id, name: category.name, mode: category.mode } : null,
    search: chosen.search,
    hide: requestedMode === 'translate' ? [] : chosen.hide,
    keep: chosen.keep || [],
    css: chosen.css,
    selectors: chosen.selectors,
    pageScript: chosen.pageScript,
    crop: chosen.crop,
    window: chosen.window,
    custom: chosen.custom,
    matched: Boolean(adapter)
  };
}

function reload() {
  registry = null;
  return list();
}

module.exports = { load, list, generic, detect, resolveFor, reload };
