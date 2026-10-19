'use strict';

const bridge = window.dock;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ui = {
  config: null,
  meta: null,
  site: null,
  adapter: null,
  pinned: false,
  moving: false,
  cropOn: true,
  zoom: 1,
  caps: null,
  viewReady: false,
  picker: false,
  popover: null,
  offline: false,
  readerActive: false,
  reader: null,
  readerFont: 16,
  readerTries: 0,
  readerView: 'auto',
  readerToc: [],
  localText: false,
  localTextData: null,
  localGallery: [],
  localKind: null,
  localPicking: false,
  windowId: 'main',
  extra: false,
  localSiteId: null,
  videoActive: false,
  video: { ready: false, duration: 0, current: 0, paused: true, volume: 1, muted: false, rate: 1 },
  videoMarkers: [],
  videoSeeking: false,
  audioActive: false,
  audioOpen: false,
  audioMarkers: [],
  audioSeeking: false,
  translate: { engine: null, source: 'auto', target: 'en', timer: null, lastInput: '', lastOutput: '', busy: false, pending: '', lastError: '' }
};

/* ------------------------------------------------------------------ 主题 */

function resolvedTheme() {
  const mode = ui.config?.theme?.mode || 'system';
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const root = document.documentElement;
  const theme = ui.config.theme;
  root.dataset.theme = resolvedTheme();
  root.dataset.motion = theme.motion;
  root.dataset.glass = theme.glass ? '1' : '0';
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--radius', `${theme.radius}px`);
  root.style.setProperty('--tip-delay', theme.motion === 'calm' ? '0ms' : '220ms');
  applyZoom();
  try {
    ui.view?.send('fd', {
      type: 'theme',
      dark: resolvedTheme() === 'dark' && ui.config.theme.dimSite !== false
    });
  } catch { /* webview 尚未就绪 */ }
}

function applyZoom() {
  if (!ui.view) return;
  const factor = Math.max(0.5, Math.min(2, ui.zoom * (ui.config.theme.fontScale || 1)));
  try { ui.view.setZoomFactor(factor); } catch { /* ignore */ }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (ui.config?.theme?.mode === 'system') applyTheme();
});

/* ------------------------------------------------------------- 站点 / 视图 */

function activeSite() {
  const cfg = ui.config;
  const wanted = ui.localSiteId || cfg.activeSiteId;
  return cfg.sites.find((site) => site.id === wanted) || cfg.sites[0] || null;
}

function sendInit() {
  if (!ui.view || !ui.site) return;
  const payload = {
    type: 'init',
    adapter: ui.adapter,
    overrides: ui.site.overrides || { hide: [], selectors: {}, css: '', js: '' },
    options: {
      fontScale: ui.config.theme.fontScale,
      autoRead: Boolean(ui.config.behavior.readAloud),
      dark: resolvedTheme() === 'dark' && ui.config.theme.dimSite !== false
    },
    crop: ui.cropOn && ui.adapter?.crop !== false
  };
  try {
    ui.view.send('fd', payload);
    ui.view.send('fd', { type: 'auto-read', on: Boolean(ui.config.behavior.readAloud) });
  } catch { /* ignore */ }
}

async function mountSite(options = {}) {
  const site = activeSite();
  if (!site) return;
  closePreview();
  ui.site = site;
  ui.adapter = await bridge.resolveAdapter(site.url, site.adapter, site.category);
  ui.cropOn = ui.adapter?.crop !== false;
  ui.caps = null;
  ui.viewReady = false;
  ui.zoom = 1;
  ui.localText = false;
  ui.localTextData = null;
  ui.localGallery = [];
  ui.localKind = null;
  applyTranslateMode();
  applyReaderMode();
  applyVideoMode();
  applyAudioMode();

  if (ui.view) {
    ui.view.remove();
    ui.view = null;
  }

  const view = document.createElement('webview');
  view.id = 'view';
  view.setAttribute('partition', 'persist:floatingdock');
  view.setAttribute('preload', ui.meta.paths.contentPreload);
  view.setAttribute('src', site.url);
  view.setAttribute('allowpopups', '');
  $('#view-host').appendChild(view);
  ui.view = view;

  wireView(view);
  buildTools();
  updateSiteChip();
  hideHint();
  showOverlay(false);
  $('#loading').classList.add('on');
  if (!options.silent) setZoom(1);
}

function wireView(view) {
  view.addEventListener('dom-ready', () => {
    ui.viewReady = true;
    sendInit();
    applyZoom();
    view.classList.add('ready');
    $('#loading').classList.remove('on');
    if (ui.readerActive) setTimeout(requestReader, 700);
    if (ui.videoActive) setTimeout(requestVideo, 600);
    if (ui.audioActive) setTimeout(requestVideo, 600);
  });

  view.addEventListener('did-start-loading', () => {
    $('#loading').classList.add('on');
  });

  view.addEventListener('did-stop-loading', () => {
    $('#loading').classList.remove('on');
  });

  view.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return;
    if (event.isMainFrame === false) return;
    $('#loading').classList.remove('on');
    const networkCodes = [-106, -105, -102, -109, -118, -137];
    if (!navigator.onLine || networkCodes.includes(event.errorCode)) {
      setOffline(true);
      return;
    }
    showOverlay(true, {
      title: '这个网站还没连上',
      text: `${event.errorDescription || '加载失败'}。检查网络后再试，或换一个站点。`
    });
  });

  view.addEventListener('did-finish-load', () => {
    if (navigator.onLine) setOffline(false);
    if (ui.readerActive) setTimeout(requestReader, 500);
    if (ui.videoActive) setTimeout(requestVideo, 500);
    if (ui.audioActive) setTimeout(requestVideo, 500);
  });

  view.addEventListener('did-navigate', () => {
    sendInit();
    if (ui.readerActive) {
      resetReaderView();
      setTimeout(requestReader, 900);
    }
    if (ui.videoActive) {
      resetVideoMarkers();
      setTimeout(requestVideo, 900);
    }
    if (ui.audioActive) {
      resetAudioMarkers();
      if (ui.audioOpen) setTimeout(requestVideo, 900);
    }
  });

  view.addEventListener('did-navigate-in-page', () => {
    sendInit();
    if (ui.readerActive) {
      resetReaderView();
      setTimeout(requestReader, 900);
    }
    if (ui.videoActive) {
      resetVideoMarkers();
      setTimeout(requestVideo, 900);
    }
    if (ui.audioActive) {
      resetAudioMarkers();
      if (ui.audioOpen) setTimeout(requestVideo, 900);
    }
  });

  view.addEventListener('ipc-message', (event) => {
    if (event.channel !== 'fd') return;
    handleContentMessage(event.args?.[0]);
  });
}

function handleContentMessage(message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'ready':
      ui.viewReady = true;
      break;
    case 'caps': {
      ui.caps = message.caps;
      renderHint();
      break;
    }
    case 'toast':
      toast(message.text);
      break;
    case 'reader':
      renderReader(message.payload);
      break;
    case 'video-state':
      setVideoState(message.state);
      break;
    case 'lightbox':
      bridge.lightbox({ url: message.url, alt: message.alt });
      break;
    case 'image-context':
      bridge.imageContext({ url: message.url, alt: message.alt });
      break;
    case 'preview':
      openPreview({ url: message.url, alt: message.alt });
      break;
    case 'navigate':
      if (/^https?:/i.test(message.url || '')) {
        ui.view.loadURL(message.url);
      }
      break;
    case 'speak-state':
      setSpeaking(Boolean(message.on), message.target);
      break;
    case 'zoom':
      setZoom(ui.zoom + (Number(message.delta) || 0));
      break;
    case 'tts':
      bridge.ttsSpeak({ text: message.text, lang: message.lang });
      break;
    case 'tts-stop':
      bridge.ttsStop();
      break;
    case 'host-click':
      if (ui.popover) closePopover();
      break;
    case 'picker-on':
      ui.picker = true;
      showHint('拾取模式：点击网页里的元素', null);
      break;
    case 'picked':
      ui.picker = false;
      hideHint();
      bridge.pickDone();
      bridge.sendPickResult(message);
      break;
    case 'pick-cancel':
      ui.picker = false;
      hideHint();
      bridge.pickDone();
      bridge.cancelPick();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ 提示 */

function showOverlay(show, content = {}) {
  const overlay = $('#overlay');
  if (!show) {
    overlay.classList.add('hidden');
    return;
  }
  $('#overlay-title').textContent = content.title || '这个网站还没连上';
  $('#overlay-text').textContent = content.text || '';
  overlay.classList.remove('hidden');
}

function setOffline(offline) {
  const on = Boolean(offline);
  ui.offline = on;
  document.body.classList.toggle('offline-mode', on);
  const translateActive = Boolean(ui.translate.engine);
  $('#offline').classList.toggle('hidden', !on || translateActive);
  if (on) {
    showOverlay(false);
    if (translateActive && !ui.translate.busy) {
      $('#tr-status').classList.add('err');
      $('#tr-status').textContent = '当前离线，联网后自动重试';
    }
  } else if (translateActive && !ui.translate.lastOutput && !ui.translate.busy) {
    $('#tr-status').classList.remove('err');
    $('#tr-status').textContent = '';
  }
}

function wireNetwork() {
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => {
    const wasOffline = ui.offline;
    setOffline(false);
    if (!wasOffline) return;
    toast('网络已恢复');
    if (ui.view) {
      try { ui.view.reload(); } catch { /* ignore */ }
    }
    if (ui.translate.engine) {
      const text = $('#tr-input').value.trim();
      if (text) setTimeout(() => scheduleTranslate(true), 2200);
    }
  });
  $('#offline-retry').addEventListener('click', () => {
    if (!navigator.onLine) {
      toast('仍然没有网络连接');
      return;
    }
    setOffline(false);
    if (ui.translate.engine) {
      const text = $('#tr-input').value.trim();
      if (text) scheduleTranslate(true);
    } else if (ui.view) {
      try { ui.view.reload(); } catch { /* ignore */ }
    }
  });
  if (!navigator.onLine) setOffline(true);
}

function showHint(text, actionLabel, action) {
  const hint = $('#hint');
  $('#hint-text').textContent = text;
  const btn = $('#hint-action');
  if (actionLabel && action) {
    btn.textContent = actionLabel;
    btn.classList.remove('hidden');
    btn.onclick = action;
  } else {
    btn.classList.add('hidden');
    btn.onclick = null;
  }
  hint.classList.remove('hidden');
}

function hideHint() {
  $('#hint').classList.add('hidden');
}

function renderHint() {
  if (ui.translate.engine) {
    hideHint();
    return;
  }
  if (!ui.caps || ui.picker) return;
  const mode = ui.adapter?.mode || 'generic';
  if (mode === 'translate' && !ui.caps.hasSource) {
    showHint('没有识别到翻译输入框', '自定义', openSiteSettings);
  } else if (mode === 'gallery' && !ui.caps.gallery) {
    showHint('还没有加载到图片', '自定义', openSiteSettings);
  } else {
    hideHint();
  }
}

function openSiteSettings() {
  bridge.openSettings();
}

/* ------------------------------------------------------------------ 功能区 */

const TOOL_DEFS = {
  search: { icon: 'i-search', label: '搜索' },
  'speak-source': { icon: 'i-speak', label: '朗读原文' },
  'speak-target': { icon: 'i-speak', label: '朗读译文' },
  phonetic: { icon: 'i-phonetic', label: '拼音 / 音标' },
  crop: { icon: 'i-crop', label: '聚焦裁剪' },
  zoom: { icon: 'i-zoom', label: '缩放' },
  reader: { icon: 'i-reader', label: '阅读模式' },
  audio: { icon: 'i-headphone', label: '提取音频' },
  local: { icon: 'i-folder', label: '导入本地' },
  'open-external': { icon: 'i-external', label: '在浏览器打开' }
};

function buildTools() {
  const group = $('#tool-group');
  group.innerHTML = '';
  const textMode = ui.adapter?.mode === 'text';
  const audioMode = ui.adapter?.mode === 'audio';
  const videoMode = ui.adapter?.mode === 'video';
  const panelMode = Boolean(ui.adapter?.engine && ui.adapter?.mode === 'translate');
  let tools;
  if (panelMode) tools = ['open-external'];
  else if (textMode) tools = ['local', 'reader', 'open-external'];
  else if (audioMode) tools = ['local', 'audio', 'open-external'];
  else if (videoMode) tools = ['local', 'open-external'];
  else tools = ['local', ...(ui.adapter?.tools || []), 'open-external'];
  const seen = new Set();
  tools.forEach((tool) => {
    if (seen.has(tool) || !TOOL_DEFS[tool]) return;
    seen.add(tool);
    if (tool === 'search' && !ui.adapter?.search) return;
    const def = TOOL_DEFS[tool];
    const label = tool === 'reader' && document.body.classList.contains('reader-mode') ? '浏览原页' : def.label;
    const btn = document.createElement('button');
    btn.className = 'rail-btn';
    btn.dataset.act = `tool:${tool}`;
    btn.dataset.label = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<svg><use href="#${def.icon}"></use></svg>`;
    if (tool === 'crop' && ui.cropOn) btn.classList.add('active');
    if (tool === 'reader' && document.body.classList.contains('reader-mode')) btn.classList.add('active');
    group.appendChild(btn);
  });
  if (!group.children.length) group.classList.add('hidden');
  else group.classList.remove('hidden');
}

function setSpeaking(on, target) {
  const act = target === 'result' ? 'tool:speak-target' : 'tool:speak-source';
  const btn = $$('#tool-group .rail-btn').find((el) => el.dataset.act === act);
  if (!btn) return;
  btn.classList.toggle('active', on);
}

function setMoveMode(on) {
  ui.moving = on;
  document.body.classList.toggle('moving', on);
  const btn = $('.rail-btn[data-act="move"]');
  btn?.classList.toggle('active', on);
  if (!on) closePopover();
}

function updateSiteChip() {
  const btn = $('.rail-btn[data-act="site"]');
  if (!btn) return;
  btn.dataset.label = ui.site ? ui.site.name : '切换站点';
}

/* ------------------------------------------------------------------ 缩放 */

function setZoom(value) {
  ui.zoom = Math.max(0.6, Math.min(1.8, Math.round(value * 100) / 100));
  applyZoom();
  const label = $('#popover .zoom-value');
  if (label) label.textContent = `${Math.round(ui.zoom * 100)}%`;
}

/* -------------------------------------------------------------- 窗口内看图 */

const previewState = { url: '', alt: '', zoom: 1, x: 0, y: 0, dragging: false, start: null };

function previewTransform() {
  const img = $('#preview-image');
  img.style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.zoom})`;
  $('#preview-zoom').textContent = `${Math.round(previewState.zoom * 100)}%`;
}

function openPreview(payload = {}) {
  const url = typeof payload.url === 'string' ? payload.url : '';
  if (!url) return;
  const box = $('#preview');
  const img = $('#preview-image');
  previewState.url = url;
  previewState.alt = payload.alt || '';
  previewState.zoom = 1;
  previewState.x = 0;
  previewState.y = 0;
  img.src = url;
  img.alt = payload.alt || '';
  $('#preview-name').textContent = payload.alt || url.split('/').pop() || '图片预览';
  previewTransform();
  box.classList.remove('hidden');
  box.setAttribute('aria-hidden', 'false');
  closePopover();
}

function closePreview() {
  const box = $('#preview');
  if (!box || box.classList.contains('hidden')) return;
  box.classList.add('hidden');
  box.setAttribute('aria-hidden', 'true');
  const img = $('#preview-image');
  img.removeAttribute('src');
  img.style.transform = '';
  previewState.url = '';
  previewState.zoom = 1;
  previewState.x = 0;
  previewState.y = 0;
}

function setPreviewZoom(value) {
  previewState.zoom = Math.max(0.25, Math.min(6, value));
  if (previewState.zoom <= 1) {
    previewState.x = 0;
    previewState.y = 0;
  }
  previewTransform();
}

function wirePreview() {
  const box = $('#preview');
  const img = $('#preview-image');

  box.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-pv]');
    if (btn) {
      const action = btn.dataset.pv;
      if (action === 'close') closePreview();
      if (action === 'in') setPreviewZoom(previewState.zoom * 1.15);
      if (action === 'out') setPreviewZoom(previewState.zoom / 1.15);
      if (action === 'system' && previewState.url) {
        bridge.lightbox({ url: previewState.url, alt: previewState.alt });
      }
      if (action === 'save' && previewState.url) {
        bridge.saveImage({ url: previewState.url, name: previewState.url.split('/').pop() });
      }
      return;
    }
    if (event.target === box) closePreview();
  });

  img.addEventListener('wheel', (event) => {
    event.preventDefault();
    setPreviewZoom(previewState.zoom * (event.deltaY < 0 ? 1.08 : 0.92));
  }, { passive: false });

  img.addEventListener('dblclick', () => {
    if (previewState.zoom > 1.05) setPreviewZoom(1);
    else setPreviewZoom(2);
  });

  img.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    previewState.dragging = true;
    previewState.start = { x: event.clientX - previewState.x, y: event.clientY - previewState.y };
    img.classList.add('dragging');
    img.setPointerCapture(event.pointerId);
  });

  img.addEventListener('pointermove', (event) => {
    if (!previewState.dragging) return;
    previewState.x = event.clientX - previewState.start.x;
    previewState.y = event.clientY - previewState.start.y;
    previewTransform();
  });

  const endDrag = () => {
    previewState.dragging = false;
    img.classList.remove('dragging');
  };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  img.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (previewState.url) bridge.imageContext({ url: previewState.url, alt: previewState.alt });
  });
}

/* -------------------------------------------------------------- 翻译面板 */

const TR_LANGS = [
  { id: 'auto', label: '自动检测', site: '自动检测' },
  { id: 'zh', label: '中文', site: '中文(简体)' },
  { id: 'en', label: '英语', site: '英语' },
  { id: 'ja', label: '日语', site: '日语' },
  { id: 'ko', label: '韩语', site: '韩语' },
  { id: 'fr', label: '法语', site: '法语' },
  { id: 'de', label: '德语', site: '德语' },
  { id: 'ru', label: '俄语', site: '俄语' },
  { id: 'es', label: '西班牙语', site: '西班牙语' },
  { id: 'pt', label: '葡萄牙语', site: '葡萄牙语' },
  { id: 'it', label: '意大利语', site: '意大利语' },
  { id: 'ar', label: '阿拉伯语', site: '阿拉伯语' },
  { id: 'th', label: '泰语', site: '泰语' },
  { id: 'vi', label: '越南语', site: '越南语' }
];

const TR_SPEECH = {
  zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE',
  ru: 'ru-RU', es: 'es-ES', pt: 'pt-BR', it: 'it-IT', ar: 'ar-SA', th: 'th-TH', vi: 'vi-VN'
};

function trLangById(id) {
  return TR_LANGS.find((item) => item.id === id) || null;
}

function trSiteLabel(id) {
  const item = trLangById(id);
  return item ? item.site : id;
}

function trSpeech(id) {
  return TR_SPEECH[id] || 'en-US';
}

function containsCjk(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(text || ''));
}

function detectSpeechLang(text) {
  const t = String(text || '');
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh-CN';
  if (/[\u3040-\u30ff]/.test(t)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko-KR';
  if (/[\u0400-\u04ff]/.test(t)) return 'ru-RU';
  return 'en-US';
}

function pinyinFor(text) {
  if (!window.pinyinPro) return '';
  const t = String(text || '').trim();
  if (!t || !containsCjk(t)) return '';
  try {
    const arr = window.pinyinPro.pinyin(t, { type: 'array', toneType: 'symbol', nonZh: 'consecutive' });
    return arr.join(' ');
  } catch {
    return '';
  }
}

function applyTranslateMode() {
  const engine = ui.adapter?.engine || (ui.adapter?.id === 'baidu-fanyi' ? 'baidu' : null);
  const active = Boolean(engine) && ui.adapter?.mode === 'translate';
  ui.translate.engine = active ? engine : null;
  document.body.classList.toggle('translate-mode', active);
  $('#translate').classList.toggle('hidden', !active);
  $('#hint').classList.add('hidden');
  if (active) {
    const src = $('#tr-source');
    const dst = $('#tr-target');
    src.innerHTML = '';
    dst.innerHTML = '';
    TR_LANGS.forEach((lang) => {
      const opt = document.createElement('option');
      opt.value = lang.id;
      opt.textContent = lang.label;
      src.appendChild(opt);
      if (lang.id !== 'auto') {
        const opt2 = document.createElement('option');
        opt2.value = lang.id;
        opt2.textContent = lang.label;
        dst.appendChild(opt2);
      }
    });
    src.value = ui.translate.source;
    dst.value = ui.translate.target;
  }
}

function scheduleTranslate(force) {
  clearTimeout(ui.translate.timer);
  const text = $('#tr-input').value.trim();
  if (!text) {
    ui.translate.lastInput = '';
    ui.translate.lastOutput = '';
    ui.translate.pending = '';
    $('#tr-output').textContent = '';
    $('#tr-target-ph').textContent = '';
    $('#tr-status').textContent = '';
    $('#tr-status').classList.remove('busy', 'err');
    return;
  }
  if (ui.translate.busy) {
    ui.translate.pending = text;
    return;
  }
  if (!force && text === ui.translate.lastInput && ui.translate.lastOutput) return;
  ui.translate.timer = setTimeout(() => {
    ui.translate.lastInput = text;
    runTranslate(text);
  }, 500);
}

async function runTranslate(text, retried) {
  if (!ui.translate.engine || !text) return;
  if (ui.translate.busy) {
    ui.translate.pending = text;
    return;
  }
  ui.translate.busy = true;
  ui.translate.pending = '';
  ui.translate.lastError = '';
  $('#tr-status').classList.remove('err');
  $('#tr-status').textContent = '翻译中…';
  $('#tr-status').classList.add('busy');

  const started = Date.now();
  const result = await bridge.translate({
    engine: ui.translate.engine,
    text,
    source: trSiteLabel($('#tr-source').value),
    target: trSiteLabel($('#tr-target').value)
  });
  ui.translate.busy = false;
  $('#tr-status').classList.remove('busy');

  // 等待期间输入又变了：丢弃这次结果，按最新内容重译
  const current = $('#tr-input').value.trim();
  if (current !== text) {
    scheduleTranslate(true);
    return;
  }

  if (!result || result.error || result.timeout) {
    if (!retried && result && result.error === 'engine-not-ready') {
      $('#tr-status').textContent = '引擎加载中…';
      setTimeout(() => runTranslate(text, true), 1200);
      return;
    }
    if (result && result.error === 'offline') {
      $('#tr-status').classList.add('err');
      $('#tr-status').textContent = '当前离线 · 点此重试';
      return;
    }
    ui.translate.lastError = result && result.error ? result.error : 'timeout';
    $('#tr-status').classList.add('err');
    $('#tr-status').textContent = result && result.error === 'engine-not-ready'
      ? '引擎未就绪 · 点此重试'
      : (result && result.timeout ? '超时 · 点此重试' : '翻译失败 · 点此重试');
    return;
  }

  const output = (result.text || '').trim();
  $('#tr-output').textContent = output;
  ui.translate.lastOutput = output;
  $('#tr-status').textContent = result.cached ? '缓存' : '';
  updateTargetPhonetic(output);

  const pending = ui.translate.pending;
  if (pending && pending !== text) scheduleTranslate(true);
}

async function updateTargetPhonetic(text) {
  const t = String(text || '').trim();
  if (!t) {
    $('#tr-target-ph').textContent = '';
    return;
  }
  if (containsCjk(t)) {
    $('#tr-target-ph').textContent = pinyinFor(t);
    return;
  }
  const words = t.match(/[a-zA-Z']+/g) || [];
  if (!words.length) {
    $('#tr-target-ph').textContent = '';
    return;
  }
  try {
    const map = await bridge.ipa(t);
    const parts = words.map((word) => map[word.toLowerCase()] || '');
    const joined = parts.filter(Boolean).join('  ');
    $('#tr-target-ph').textContent = joined ? `/${joined}/`.replace(/\/\//g, '/') : '';
  } catch {
    $('#tr-target-ph').textContent = '';
  }
}

function updateSourcePhonetic(text) {
  const t = String(text || '').trim();
  $('#tr-source-ph').textContent = containsCjk(t) ? pinyinFor(t) : '';
}

function speakText(text, lang) {
  const t = String(text || '').trim();
  if (!t) {
    toast('没有可朗读的内容');
    return;
  }
  bridge.ttsSpeak({ text: t, lang: lang || detectSpeechLang(t) });
}

async function siteSnapshot() {
  if (!ui.view) return { source: '', result: '' };
  const source = Array.from(new Set([...(ui.adapter?.selectors?.source || []), 'textarea', '[contenteditable="true"]']));
  const result = Array.from(new Set([
    ...(ui.adapter?.selectors?.result || []),
    '.scroll-y-dst',
    '[class*="target"] [class*="text"]',
    '[class*="result"]'
  ]));
  const code = `(() => {
    const pick = (list) => {
      for (const sel of list) {
        try {
          const el = document.querySelector(sel);
          if (!el) continue;
          const t = String(el.value ?? el.innerText ?? el.textContent ?? '').trim();
          if (t) return t;
        } catch { /* ignore */ }
      }
      return '';
    };
    return JSON.stringify({ source: pick(${JSON.stringify(source)}), result: pick(${JSON.stringify(result)}) });
  })()`;
  try {
    return JSON.parse(await ui.view.executeJavaScript(code)) || { source: '', result: '' };
  } catch {
    return { source: '', result: '' };
  }
}

function cleanSiteResult(text) {
  const t = String(text || '').trim();
  const cut = t.search(/\n?(编辑译文|段落对照|复制译文|复制|朗读|重新生成)/);
  return (cut >= 0 ? t.slice(0, cut) : t)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[英美]\s*\/.*\/$/.test(line))
    .join('\n')
    .trim();
}

async function speakSite(target, btn) {
  if (btn.classList.contains('active')) {
    bridge.ttsStop();
    setSpeaking(false, target);
    return;
  }
  const snapshot = await siteSnapshot();
  const text = String(target === 'source' ? snapshot.source : cleanSiteResult(snapshot.result) || '').trim();
  if (!text) {
    toast(target === 'source' ? '还没有原文可以朗读' : '还没有译文可以朗读');
    return;
  }
  setSpeaking(false, 'source');
  setSpeaking(false, 'result');
  setSpeaking(true, target);
  bridge.ttsSpeak({ text: text.slice(0, 4000), lang: detectSpeechLang(text) });
}

async function phoneticFor(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (containsCjk(t)) return pinyinFor(t);
  const words = t.match(/[a-zA-Z']+/g) || [];
  if (!words.length) return '';
  try {
    const map = await bridge.ipa(t);
    const parts = words
      .map((word) => String(map[word.toLowerCase()] || '').replace(/\//g, ''))
      .filter(Boolean);
    return parts.length ? `/${parts.join(' ')}/` : '';
  } catch {
    return '';
  }
}

async function showPhoneticPopover(anchor) {
  if (!ui.view) return;
  const snapshot = await siteSnapshot();
  if (!snapshot.source && !snapshot.result) {
    toast('没有读取到原文或译文');
    return;
  }
  const sourceText = String(snapshot.source || '').trim();
  const resultText = cleanSiteResult(snapshot.result);
  const [srcPh, dstPh] = await Promise.all([
    phoneticFor(sourceText),
    phoneticFor(resultText)
  ]);
  if (!srcPh && !dstPh) {
    toast('原文/译文暂时没有可标注的读音');
    return;
  }
  openPopover(anchor, `
    <div class="pop-title"><span>拼音 / 音标</span></div>
    <div class="ph-row">
      <span class="ph-label">原文</span>
      <p class="ph-value">${escapeHtml((srcPh || '—').slice(0, 320))}</p>
    </div>
    <div class="ph-row">
      <span class="ph-label">译文</span>
      <p class="ph-value">${escapeHtml((dstPh || '—').slice(0, 320))}</p>
    </div>
  `);
}

function copyText(text) {
  const t = String(text || '').trim();
  if (!t) {
    toast('没有可复制的内容');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => toast('复制失败'));
  } else {
    toast('复制失败');
  }
}

function wireTranslate() {
  const input = $('#tr-input');
  input.addEventListener('input', () => {
    $('#tr-count').textContent = String(input.value.length);
    updateSourcePhonetic(input.value);
    scheduleTranslate(false);
  });
  $('#tr-source').addEventListener('change', () => {
    ui.translate.source = $('#tr-source').value;
    updateSourcePhonetic(input.value);
    scheduleTranslate(true);
  });
  $('#tr-target').addEventListener('change', () => {
    ui.translate.target = $('#tr-target').value;
    scheduleTranslate(true);
  });
  $('#tr-swap').addEventListener('click', () => {
    if ($('#tr-source').value === 'auto') return;
    const source = $('#tr-source').value;
    $('#tr-source').value = $('#tr-target').value;
    $('#tr-target').value = source;
    ui.translate.source = $('#tr-source').value;
    ui.translate.target = $('#tr-target').value;
    scheduleTranslate(true);
  });
  $('#translate').addEventListener('click', (event) => {
    const status = event.target.closest('#tr-status');
    if (status && status.classList.contains('err')) {
      const text = input.value.trim();
      if (text) {
        ui.translate.lastInput = '';
        runTranslate(text, true);
      }
      return;
    }
    const btn = event.target.closest('[data-tr]');
    if (!btn) return;
    const action = btn.dataset.tr;
    if (action === 'speak-src') speakText(input.value, trSpeech($('#tr-source').value));
    if (action === 'speak-out') speakText(ui.translate.lastOutput, trSpeech($('#tr-target').value));
    if (action === 'copy') copyText(ui.translate.lastOutput);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      scheduleTranslate(true);
    }
  });
}

/* -------------------------------------------------------------- 文本阅读 */

function applyReaderMode() {
  const reader = ui.adapter?.mode === 'text' && (ui.adapter?.engine === 'reader' || ui.adapter?.id === 'oalib');
  ui.readerActive = reader;
  hideSelToolbar();
  if (!reader) {
    document.body.classList.remove('reader-mode');
    $('#reader').classList.add('hidden');
    return;
  }
  ui.reader = null;
  ui.readerTries = 0;
  ui.readerView = 'auto';
  ui.readerToc = [];
  document.body.classList.remove('reader-mode');
  $('#reader').classList.add('hidden');
  $('#rd-toc').classList.add('hidden');
  $('#rd-title').textContent = '文本阅读';
  $('#rd-article').innerHTML = '<p class="rd-empty">正在提取正文…</p>';
  applyReaderFont();
}

function resetReaderView() {
  ui.readerView = 'auto';
  ui.readerTries = 0;
  document.body.classList.remove('reader-mode');
  $('#reader').classList.add('hidden');
  $('#rd-toc').classList.add('hidden');
  hideSelToolbar();
}

function setReaderView(view) {
  const showReader = view === 'reader';
  ui.readerView = showReader ? 'reader' : 'site';
  document.body.classList.toggle('reader-mode', showReader);
  $('#reader').classList.toggle('hidden', !showReader);
  if (showReader) {
    if (!ui.reader) requestReader();
    setTimeout(updateReaderProgress, 30);
  } else {
    $('#rd-toc').classList.add('hidden');
    hideSelToolbar();
  }
  const btn = $$('#tool-group .rail-btn').find((el) => el.dataset.act === 'tool:reader');
  if (btn) {
    const label = showReader ? '浏览原页' : '阅读模式';
    btn.dataset.label = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('active', showReader);
  }
}

function updateReaderProgress() {
  const body = $('#rd-body');
  const bar = $('#rd-progress');
  if (!body || !bar) return;
  const max = body.scrollHeight - body.clientHeight;
  bar.style.width = `${max > 0 ? Math.min(100, (body.scrollTop / max) * 100) : 0}%`;
}

function wireReaderProgress() {
  const track = $('.rd-progress');
  const body = $('#rd-body');
  if (!track || !body) return;
  let dragging = false;

  const scrollTo = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const max = body.scrollHeight - body.clientHeight;
    body.scrollTop = ratio * Math.max(0, max);
    updateReaderProgress();
  };

  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    document.body.classList.add('rd-scrubbing');
    try { track.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    scrollTo(event.clientX);
    event.preventDefault();
  });
  track.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    scrollTo(event.clientX);
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('rd-scrubbing');
    try { track.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  };
  track.addEventListener('pointerup', stop);
  track.addEventListener('pointercancel', stop);
}

function requestReader() {
  if (!ui.readerActive || !ui.view || !ui.viewReady) return;
  try {
    ui.view.send('fd', { type: 'reader:extract' });
  } catch { /* ignore */ }
}

function applyReaderFont() {
  const body = $('#rd-body');
  if (body) body.style.fontSize = `${ui.readerFont}px`;
}

function renderReader(payload) {
  if (!ui.readerActive) return;
  const body = $('#rd-body');
  const article = $('#rd-article');
  const small = !ui.localText && (!payload || payload.error || !Array.isArray(payload.blocks) || payload.blocks.length < 3 || (payload.length || 0) < 600);
  if (small) {
    if (ui.readerView === 'reader') {
      if (ui.readerTries < 3) {
        ui.readerTries += 1;
        article.innerHTML = '<p class="rd-empty">正在提取正文…</p>';
        setTimeout(requestReader, 1200);
        return;
      }
      article.innerHTML = '<p class="rd-empty">这个页面没有可提取的正文，点「原页」使用网站搜索，或点「刷新」重试。</p>';
      return;
    }
    // 没有正文的页面（首页 / 列表页）保持原站，不自动进入阅读模式
    if (ui.readerTries < 2) {
      ui.readerTries += 1;
      article.innerHTML = '<p class="rd-empty">正在提取正文…</p>';
      setTimeout(requestReader, 900);
      return;
    }
    setReaderView('site');
    return;
  }
  ui.readerTries = 0;
  ui.reader = payload;
  if (payload.title) $('#rd-title').textContent = payload.title;
  const frag = document.createDocumentFragment();
  const toc = [];
  let tocIndex = 0;
  for (const block of payload.blocks) {
    if (block.t === 'img') {
      if (!block.src) continue;
      const img = document.createElement('img');
      img.src = block.src;
      img.alt = block.alt || '';
      img.loading = 'lazy';
      frag.appendChild(img);
      continue;
    }
    const tag = ['h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'li'].includes(block.t) ? block.t : 'p';
    const el = document.createElement(tag);
    el.textContent = block.text;
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const id = `rd-h-${tocIndex}`;
      tocIndex += 1;
      el.id = id;
      toc.push({ id, level: Number(tag[1]), text: block.text.slice(0, 120) });
    }
    frag.appendChild(el);
  }
  article.innerHTML = '';
  article.appendChild(frag);
  ui.readerToc = toc.slice(0, 80);
  $('#rd-toc').classList.add('hidden');
  renderToc();
  body.scrollTop = 0;
  applyReaderFont();
  updateReaderProgress();
}

function renderToc() {
  const list = $('#rd-toc-list');
  if (!list) return;
  list.innerHTML = '';
  if (!ui.readerToc.length) {
    list.innerHTML = '<p class="rd-toc-empty">这篇内容没有小标题。</p>';
    return;
  }
  const top = document.createElement('button');
  top.className = 'rd-toc-item';
  top.dataset.toc = 'top';
  top.textContent = '回到顶部';
  list.appendChild(top);
  for (const item of ui.readerToc) {
    const btn = document.createElement('button');
    const level = Math.min(4, Math.max(1, item.level || 2));
    btn.className = `rd-toc-item lvl${level}`;
    btn.dataset.toc = item.id;
    btn.textContent = item.text;
    list.appendChild(btn);
  }
}

function hideSelToolbar() {
  const bar = $('#rd-sel');
  if (bar) bar.classList.add('hidden');
}

function updateSelToolbar() {
  const bar = $('#rd-sel');
  if (!bar || !ui.readerActive) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    bar.classList.add('hidden');
    return;
  }
  const range = sel.getRangeAt(0);
  if (!range || !$('#rd-body').contains(range.commonAncestorContainer)) {
    bar.classList.add('hidden');
    return;
  }
  const rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const width = bar.offsetWidth || 220;
  const height = bar.offsetHeight || 34;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
  let top = rect.top - height - 10;
  if (top < 8) top = rect.bottom + 10;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function wrapSelection(color) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const article = $('#rd-article');
  if (!article.contains(range.commonAncestorContainer)) return;

  // 按文本节点逐个包 <mark>：跨段落/多行选择时不会把整块内容抽走
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
  const jobs = [];
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue || '';
    if (value.trim() && range.intersectsNode(node)) {
      let start = 0;
      let end = value.length;
      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;
      if (start < end) jobs.push({ node, start, end });
    }
    node = walker.nextNode();
  }
  if (!jobs.length) return;

  for (const job of jobs) {
    const parent = job.node.parentElement;
    if (!parent) continue;
    const existing = parent.closest('mark.rd-mark');
    if (existing) {
      existing.className = `rd-mark ${color}`;
      continue;
    }
    let target = job.node;
    try {
      if (job.end < target.nodeValue.length) target.splitText(job.end);
      if (job.start > 0) target = target.splitText(job.start);
    } catch { /* 节点已变化则跳过 */ continue; }
    const mark = document.createElement('mark');
    mark.className = `rd-mark ${color}`;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }
  sel.removeAllRanges();
  hideSelToolbar();
}

function clearReaderMarks() {
  const article = $('#rd-article');
  if (!article) return;
  article.querySelectorAll('mark.rd-mark').forEach((mark) => mark.replaceWith(...mark.childNodes));
  hideSelToolbar();
}

function removeSelectionMarks() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  let marks = [...$('#rd-article').querySelectorAll('mark.rd-mark')].filter((mark) => range.intersectsNode(mark));
  if (!marks.length) {
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const mark = el && el.closest('mark.rd-mark');
    if (mark) marks = [mark];
  }
  marks.forEach((mark) => mark.replaceWith(...mark.childNodes));
  sel.removeAllRanges();
  hideSelToolbar();
  return marks.length > 0;
}

function readerText() {
  if (!ui.reader) return '';
  const parts = [];
  if (ui.reader.title) parts.push(ui.reader.title, '');
  for (const block of ui.reader.blocks || []) {
    if (block.t === 'img') continue;
    if (block.t === 'h1') parts.push(`# ${block.text}`);
    else if (block.t === 'h2') parts.push(`## ${block.text}`);
    else if (block.t === 'h3') parts.push(`### ${block.text}`);
    else if (block.t === 'h4') parts.push(`#### ${block.text}`);
    else parts.push(block.text);
    parts.push('');
  }
  if (ui.reader.url) parts.push(`来源：${ui.reader.url}`);
  return parts.join('\n');
}

async function downloadReader() {
  const text = readerText();
  if (!text.trim()) {
    toast('还没有可下载的正文');
    return;
  }
  const name = (ui.reader.title || '文本阅读').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60).trim() || '文本阅读';
  const result = await bridge.saveText({ name: `${name}.txt`, text });
  if (result && result.ok) toast('已保存到文件');
  else if (result && result.error) toast('保存失败');
}

function wireReader() {
  $('#reader').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-rd]');
    if (btn) {
      const action = btn.dataset.rd;
      if (action === 'bigger') {
        ui.readerFont = Math.min(24, ui.readerFont + 1);
        applyReaderFont();
      } else if (action === 'smaller') {
        ui.readerFont = Math.max(13, ui.readerFont - 1);
        applyReaderFont();
      } else if (action === 'mark') {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount && $('#rd-article').contains(sel.getRangeAt(0).commonAncestorContainer)) {
          updateSelToolbar();
        } else {
          toast('先选中一段文字，再点颜色即可标注');
        }
      } else if (action === 'unmark') {
        if (!removeSelectionMarks()) toast('先选中已标注的文字，再点「去标」');
      } else if (action === 'toc') {
        const toc = $('#rd-toc');
        toc.classList.toggle('hidden');
        if (!toc.classList.contains('hidden')) renderToc();
      } else if (action === 'clear') {
        clearReaderMarks();
        toast('已清除本次标注');
      } else if (action === 'download') {
        downloadReader();
      } else if (action === 'site') {
        setReaderView('site');
      } else if (action === 'reload') {
        if (ui.localText && ui.localTextData) openLocalText(ui.localTextData);
        else requestReader();
      }
      return;
    }
    const dot = event.target.closest('[data-color]');
    if (dot) {
      wrapSelection(dot.dataset.color);
      return;
    }
    const tool = event.target.closest('[data-sel]');
    if (tool) {
      if (tool.dataset.sel === 'remove') {
        removeSelectionMarks();
      }
    }
  });

  $('#rd-toc-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-toc]');
    if (!item) return;
    const id = item.dataset.toc;
    $('#rd-toc').classList.add('hidden');
    if (id === 'top') {
      $('#rd-body').scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  const body = $('#rd-body');
  body.addEventListener('scroll', updateReaderProgress, { passive: true });
  wireReaderProgress();
  body.addEventListener('mouseup', () => setTimeout(updateSelToolbar, 10));
  body.addEventListener('keyup', () => updateSelToolbar());
  body.addEventListener('click', (event) => {
    const mark = event.target.closest('mark.rd-mark');
    if (!mark) return;
    mark.replaceWith(...mark.childNodes);
    hideSelToolbar();
  });
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#rd-sel') || event.target.closest('#rd-body')) return;
    hideSelToolbar();
  });
  window.addEventListener('resize', hideSelToolbar);
  window.addEventListener('scroll', hideSelToolbar, true);
}

/* -------------------------------------------------------------- 视频控制 */

function fmtVideoTime(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function applyVideoMode() {
  const active = ui.adapter?.mode === 'video';
  ui.videoActive = active;
  document.body.classList.toggle('video-mode', active);
  $('#videodock').classList.toggle('hidden', !active);
  $('#vd-marker-list').classList.add('hidden');
  if (!active) return;
  ui.video = { ready: false, duration: 0, current: 0, paused: true, volume: 1, muted: false, rate: 1 };
  ui.videoMarkers = [];
  renderVideoMarkers();
  updateVideoUI();
}

function requestVideo() {
  if ((!ui.videoActive && !ui.audioActive) || !ui.view || !ui.viewReady) return;
  try { ui.view.send('fd', { type: 'video:query' }); } catch { /* ignore */ }
}

function videoCmd(action, value) {
  if ((!ui.videoActive && !ui.audioActive) || !ui.view) return;
  try { ui.view.send('fd', { type: 'video:cmd', action, value }); } catch { /* ignore */ }
}

function resetVideoMarkers() {
  ui.videoMarkers = [];
  $('#vd-marker-list').classList.add('hidden');
  renderVideoMarkers();
}

function setVideoState(state) {
  if (!state) return;
  ui.video = { ...ui.video, ...state };
  updateVideoUI();
  renderVideoTicks();
  if (ui.audioActive) {
    updateAudioUI();
    renderAudioTicks();
  }
}

function setRangeFill(input, ratio) {
  if (!input) return;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
  input.style.setProperty('--p', `${pct}%`);
}

function updateVideoUI() {
  const video = ui.video || {};
  $('#vd-time').textContent = `${fmtVideoTime(video.current)} / ${fmtVideoTime(video.duration)}`;
  const progress = $('#vd-progress');
  if (progress && !ui.videoSeeking) {
    progress.value = video.duration ? Math.round((video.current / video.duration) * 1000) : 0;
    setRangeFill(progress, video.duration ? video.current / video.duration : 0);
  }
  $('#vd-play').innerHTML = `<svg><use href="#${video.paused ? 'i-play' : 'i-pause'}"></use></svg>`;
  $('#vd-mute').innerHTML = `<svg><use href="#${video.muted || video.volume === 0 ? 'i-mute' : 'i-volume'}"></use></svg>`;
  const volume = $('#vd-volume');
  if (volume) volume.value = Math.round((video.muted ? 0 : (video.volume ?? 1)) * 100);
  const rate = $('#vd-rate');
  if (rate) rate.value = String(video.rate || 1);
}

function renderVideoTicks() {
  const ticks = $('#vd-ticks');
  if (!ticks) return;
  ticks.innerHTML = '';
  const duration = ui.video?.duration || 0;
  if (!duration) return;
  for (const marker of ui.videoMarkers) {
    const dot = document.createElement('span');
    dot.className = 'vd-tick';
    dot.style.left = `${Math.min(100, Math.max(0, (marker.time / duration) * 100))}%`;
    ticks.appendChild(dot);
  }
}

function renderVideoMarkers() {
  const button = $('#vd-marks');
  if (button) button.textContent = `标记 ${ui.videoMarkers.length}`;
  const list = $('#vd-marker-list');
  if (!list) return;
  list.innerHTML = '';
  if (!ui.videoMarkers.length) {
    list.innerHTML = '<p class="vd-marker-empty">还没有标记。播放到需要的位置，点「标记」。</p>';
  } else {
    for (const marker of ui.videoMarkers) {
      const row = document.createElement('div');
      row.className = 'vd-marker';
      const time = document.createElement('button');
      time.className = 'vd-marker-time';
      time.dataset.time = String(marker.time);
      time.textContent = fmtVideoTime(marker.time);
      const del = document.createElement('button');
      del.className = 'vd-marker-del';
      del.dataset.del = marker.id;
      del.textContent = '×';
      row.append(time, del);
      list.appendChild(row);
    }
  }
  renderVideoTicks();
}

function wireVideo() {
  const progress = $('#vd-progress');
  let lastSeek = 0;
  progress.addEventListener('pointerdown', () => { ui.videoSeeking = true; });
  progress.addEventListener('input', () => {
    ui.videoSeeking = true;
    const duration = ui.video?.duration || 0;
    const time = (Number(progress.value) / 1000) * duration;
    ui.video.current = time;
    setRangeFill(progress, duration ? time / duration : 0);
    $('#vd-time').textContent = `${fmtVideoTime(time)} / ${fmtVideoTime(duration)}`;
    const now = performance.now();
    if (now - lastSeek >= 60) {
      lastSeek = now;
      videoCmd('seek', time);
    }
  });
  progress.addEventListener('change', () => {
    const duration = ui.video?.duration || 0;
    const time = (Number(progress.value) / 1000) * duration;
    ui.videoSeeking = false;
    setRangeFill(progress, duration ? time / duration : 0);
    videoCmd('seek', time);
  });

  $('#vd-play').addEventListener('click', () => videoCmd('toggle'));
  $('#vd-mute').addEventListener('click', () => videoCmd('mute'));
  $('#vd-volume').addEventListener('input', (event) => {
    videoCmd('volume', Number(event.target.value) / 100);
  });
  $('#vd-rate').addEventListener('change', (event) => videoCmd('rate', Number(event.target.value)));

  $('#vd-mark').addEventListener('click', () => {
    const time = Number(ui.video?.current) || 0;
    ui.videoMarkers.push({ id: `${Date.now()}-${Math.round(time * 10)}`, time });
    ui.videoMarkers.sort((a, b) => a.time - b.time);
    renderVideoMarkers();
    toast(`已标记 ${fmtVideoTime(time)}`);
  });

  $('#vd-marks').addEventListener('click', () => {
    const list = $('#vd-marker-list');
    list.classList.toggle('hidden');
    if (!list.classList.contains('hidden')) renderVideoMarkers();
  });

  $('#vd-marker-list').addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      ui.videoMarkers = ui.videoMarkers.filter((marker) => marker.id !== del.dataset.del);
      renderVideoMarkers();
      return;
    }
    const time = event.target.closest('[data-time]');
    if (time) {
      videoCmd('seek', Number(time.dataset.time));
      $('#vd-marker-list').classList.add('hidden');
    }
  });
}

/* -------------------------------------------------------------- 音频参考 */

function applyAudioMode() {
  const active = ui.adapter?.mode === 'audio';
  ui.audioActive = active;
  if (!active) {
    ui.audioOpen = false;
    document.body.classList.remove('audio-mode');
    $('#audiopanel').classList.add('hidden');
    $('#au-marker-list').classList.add('hidden');
    return;
  }
  ui.audioMarkers = [];
  ui.audioOpen = false;
  document.body.classList.remove('audio-mode');
  $('#audiopanel').classList.add('hidden');
  $('#au-marker-list').classList.add('hidden');
  renderAudioMarkers();
  updateAudioUI();
}

function resetAudioMarkers() {
  ui.audioMarkers = [];
  $('#au-marker-list').classList.add('hidden');
  renderAudioMarkers();
}

function setAudioView(open) {
  if (!ui.audioActive) return;
  ui.audioOpen = Boolean(open);
  document.body.classList.toggle('audio-mode', ui.audioOpen);
  $('#audiopanel').classList.toggle('hidden', !ui.audioOpen);
  if (ui.audioOpen) {
    requestVideo();
    renderAudioMarkers();
    updateAudioUI();
  } else {
    $('#au-marker-list').classList.add('hidden');
  }
  const btn = $$('#tool-group .rail-btn').find((el) => el.dataset.act === 'tool:audio');
  if (btn) {
    const label = ui.audioOpen ? '返回原页' : '提取音频';
    btn.dataset.label = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('active', ui.audioOpen);
  }
}

function updateAudioUI() {
  const video = ui.video || {};
  const title = (video.title || ui.site?.name || '音频参考').replace(/\s*-\s*YouTube\s*$/, '');
  $('#au-title').textContent = title;
  $('#au-time').textContent = `${fmtVideoTime(video.current)} / ${fmtVideoTime(video.duration)}`;
  const progress = $('#au-progress');
  if (progress && !ui.audioSeeking) {
    progress.value = video.duration ? Math.round((video.current / video.duration) * 1000) : 0;
    setRangeFill(progress, video.duration ? video.current / video.duration : 0);
  }
  $('#au-play').innerHTML = `<svg><use href="#${video.paused ? 'i-play' : 'i-pause'}"></use></svg>`;
  $('#au-mute').innerHTML = `<svg><use href="#${video.muted || video.volume === 0 ? 'i-mute' : 'i-volume'}"></use></svg>`;
  const volume = $('#au-volume');
  if (volume) volume.value = Math.round((video.muted ? 0 : (video.volume ?? 1)) * 100);
}

function renderAudioTicks() {
  const ticks = $('#au-ticks');
  if (!ticks) return;
  ticks.innerHTML = '';
  const duration = ui.video?.duration || 0;
  if (!duration) return;
  for (const marker of ui.audioMarkers) {
    const dot = document.createElement('span');
    dot.className = 'vd-tick';
    dot.style.left = `${Math.min(100, Math.max(0, (marker.time / duration) * 100))}%`;
    ticks.appendChild(dot);
  }
}

function renderAudioMarkers() {
  const button = $('#au-marks');
  if (button) button.textContent = `标记 ${ui.audioMarkers.length}`;
  const list = $('#au-marker-list');
  if (!list) return;
  list.innerHTML = '';
  if (!ui.audioMarkers.length) {
    list.innerHTML = '<p class="vd-marker-empty">还没有标记。播放到需要的位置，点「标记」。</p>';
  } else {
    for (const marker of ui.audioMarkers) {
      const row = document.createElement('div');
      row.className = 'vd-marker';
      const time = document.createElement('button');
      time.className = 'vd-marker-time';
      time.dataset.atime = String(marker.time);
      time.textContent = fmtVideoTime(marker.time);
      const del = document.createElement('button');
      del.className = 'vd-marker-del';
      del.dataset.adel = marker.id;
      del.textContent = '×';
      row.append(time, del);
      list.appendChild(row);
    }
  }
  renderAudioTicks();
}

function wireAudio() {
  const progress = $('#au-progress');
  let lastSeek = 0;
  progress.addEventListener('pointerdown', () => { ui.audioSeeking = true; });
  progress.addEventListener('input', () => {
    ui.audioSeeking = true;
    const duration = ui.video?.duration || 0;
    const time = (Number(progress.value) / 1000) * duration;
    ui.video.current = time;
    setRangeFill(progress, duration ? time / duration : 0);
    $('#au-time').textContent = `${fmtVideoTime(time)} / ${fmtVideoTime(duration)}`;
    const now = performance.now();
    if (now - lastSeek >= 60) {
      lastSeek = now;
      videoCmd('seek', time);
    }
  });
  progress.addEventListener('change', () => {
    const duration = ui.video?.duration || 0;
    const time = (Number(progress.value) / 1000) * duration;
    ui.audioSeeking = false;
    setRangeFill(progress, duration ? time / duration : 0);
    videoCmd('seek', time);
  });

  $('#au-play').addEventListener('click', () => videoCmd('toggle'));
  $('#au-back').addEventListener('click', () => videoCmd('seek', Math.max(0, (ui.video?.current || 0) - 10)));
  $('#au-fwd').addEventListener('click', () => videoCmd('seek', (ui.video?.current || 0) + 10));
  $('#au-mute').addEventListener('click', () => videoCmd('mute'));
  $('#au-volume').addEventListener('input', (event) => videoCmd('volume', Number(event.target.value) / 100));

  $('#au-mark').addEventListener('click', () => {
    const time = Number(ui.video?.current) || 0;
    ui.audioMarkers.push({ id: `${Date.now()}-${Math.round(time * 10)}`, time });
    ui.audioMarkers.sort((a, b) => a.time - b.time);
    renderAudioMarkers();
    toast(`已标记 ${fmtVideoTime(time)}`);
  });

  $('#au-marks').addEventListener('click', () => {
    const list = $('#au-marker-list');
    list.classList.toggle('hidden');
    if (!list.classList.contains('hidden')) renderAudioMarkers();
  });

  $('#au-marker-list').addEventListener('click', (event) => {
    const del = event.target.closest('[data-adel]');
    if (del) {
      ui.audioMarkers = ui.audioMarkers.filter((marker) => marker.id !== del.dataset.adel);
      renderAudioMarkers();
      return;
    }
    const time = event.target.closest('[data-atime]');
    if (time) {
      videoCmd('seek', Number(time.dataset.atime));
      $('#au-marker-list').classList.add('hidden');
    }
  });

  $('#audiopanel').addEventListener('click', (event) => {
    if (event.target.closest('[data-au="close"]')) setAudioView(false);
  });
}

/* -------------------------------------------------------------- 本地导入 */

function localFileUrl(filePath) {
  return encodeURI(`file:///${String(filePath).replace(/\\/g, '/')}`).replace(/#/g, '%23');
}

function localBaseName(filePath) {
  const text = String(filePath || '');
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || text;
}

function textToBlocks(text) {
  const blocks = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const joined = buffer.join(' ').trim();
    if (joined) blocks.push({ t: 'p', text: joined });
    buffer = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: `h${heading[1].length}`, text: heading[2] });
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function closeLocalImport() {
  const kind = ui.localKind;
  if (!kind) return;
  try { closePreview(); } catch { /* ignore */ }

  if (kind === 'text') {
    document.body.classList.remove('reader-mode');
    $('#reader').classList.add('hidden');
    $('#rd-toc').classList.add('hidden');
    ui.localText = false;
    ui.localTextData = null;
    ui.readerActive = false;
    ui.reader = null;
    ui.readerToc = [];
    hideSelToolbar();
  }

  if (kind === 'video' || kind === 'audio') {
    if (ui.view) {
      try { ui.view.remove(); } catch { /* ignore */ }
      ui.view = null;
    }
    ui.viewReady = false;
    document.body.classList.remove('video-mode', 'audio-mode', 'reader-mode');
    $('#videodock').classList.add('hidden');
    $('#audiopanel').classList.add('hidden');
    $('#vd-marker-list').classList.add('hidden');
    $('#au-marker-list').classList.add('hidden');
    ui.videoActive = false;
    ui.audioActive = false;
    ui.audioOpen = false;
    ui.videoMarkers = [];
    ui.audioMarkers = [];
    ui.video = { ready: false, duration: 0, current: 0, paused: true, volume: 1, muted: false, rate: 1 };
  }

  ui.localKind = null;
}

function openLocalText(payload) {
  if (!payload) return;
  const blocks = textToBlocks(payload.text || '');
  if (!blocks.length) {
    toast('这个文件里没有可读文本');
    return;
  }
  closeLocalImport();
  ui.localKind = 'text';
  ui.localText = true;
  ui.localTextData = payload;
  ui.readerActive = true;
  ui.reader = null;
  ui.readerToc = [];
  ui.readerTries = 0;
  ui.readerView = 'reader';
  document.body.classList.add('reader-mode');
  $('#reader').classList.remove('hidden');
  $('#rd-title').textContent = payload.name || '本地文本';
  renderReader({
    title: payload.name || '本地文本',
    url: payload.path || '',
    blocks,
    length: (payload.text || '').length
  });
  setReaderView('reader');
  $('#rd-toc').classList.add('hidden');
  toast(`已导入本地文本：${payload.name || ''}`);
}

function openLocalImages(paths) {
  if (!paths || !paths.length) return;
  closeLocalImport();
  ui.localKind = 'image';
  ui.localGallery = paths.slice();
  openPreview({ url: localFileUrl(paths[0]), alt: localBaseName(paths[0]) });
}

function openLocalMedia(kind, filePath) {
  const name = localBaseName(filePath);
  const url = localFileUrl(filePath);
  closeLocalImport();
  ui.localKind = kind;
  if (ui.view) {
    ui.view.remove();
    ui.view = null;
  }
  ui.localText = false;
  ui.localTextData = null;
  ui.site = {
    id: `local-${kind}`,
    name,
    url,
    adapter: 'youtube',
    category: kind === 'audio' ? 'audio' : 'video'
  };
  ui.adapter = {
    id: `local-${kind}`,
    name,
    mode: kind === 'audio' ? 'audio' : 'video',
    engine: 'video',
    tools: [],
    hide: [],
    keep: [],
    css: '',
    selectors: {},
    crop: false
  };
  ui.cropOn = false;
  ui.caps = null;
  ui.viewReady = false;
  ui.zoom = 1;
  applyTranslateMode();
  applyReaderMode();
  applyVideoMode();
  applyAudioMode();

  const view = document.createElement('webview');
  view.id = 'view';
  view.setAttribute('partition', 'persist:floatingdock');
  view.setAttribute('preload', ui.meta.paths.contentPreload);
  view.setAttribute('src', url);
  $('#view-host').appendChild(view);
  ui.view = view;

  wireView(view);
  buildTools();
  updateSiteChip();
  hideHint();
  showOverlay(false);
  $('#loading').classList.add('on');
  if (kind === 'audio') setTimeout(() => setAudioView(true), 900);
  toast(`已导入本地${kind === 'audio' ? '音频' : '视频'}：${name}`);
}

async function pickLocal(kind) {
  if (ui.localPicking) return;
  ui.localPicking = true;
  try {
    const paths = await bridge.pickLocal(kind);
    if (!paths || !paths.length) return;
    $('#offline').classList.add('hidden');
    const filePath = paths[0];
    if (kind === 'image') {
      openLocalImages([filePath]);
      return;
    }
    if (kind === 'text') {
      const data = await bridge.readTextFile(filePath);
      if (!data || !data.ok) {
        toast('读取本地文本失败');
        return;
      }
      openLocalText({ name: data.name, path: filePath, text: data.text });
      return;
    }
    openLocalMedia(kind, filePath);
  } finally {
    ui.localPicking = false;
  }
}

function openLocalMenu(anchor) {
  openPopover(anchor, `
    <div class="pop-title"><span>导入本地文件</span></div>
    <div class="pop-list">
      <button class="pop-item" data-local="image"><svg><use href="#i-image"></use></svg><span class="name">图片</span></button>
      <button class="pop-item" data-local="text"><svg><use href="#i-reader"></use></svg><span class="name">文本</span></button>
      <button class="pop-item" data-local="video"><svg><use href="#i-play"></use></svg><span class="name">视频</span></button>
      <button class="pop-item" data-local="audio"><svg><use href="#i-headphone"></use></svg><span class="name">音频</span></button>
    </div>
  `);
  if (ui.popover) ui.popover.dataset.kind = 'local';
}

function wireLocal() {
  // 只绑定一次：弹层元素会被复用，重复绑定会导致一次点击弹出多个文件对话框
  $('#popover').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-local]');
    if (!btn) return;
    closePopover();
    pickLocal(btn.dataset.local);
  });
  $$('#offline [data-local]').forEach((btn) => {
    btn.addEventListener('click', () => pickLocal(btn.dataset.local));
  });
}

/* ------------------------------------------------------------------ 弹层 */
function closePopover() {
  const popover = $('#popover');
  popover.classList.add('hidden');
  popover.innerHTML = '';
  ui.popover = null;
}

function openPopover(anchor, html, onMount) {
  const popover = $('#popover');
  closePopover();
  popover.innerHTML = html;
  popover.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const width = 268;
  const height = Math.min(popover.scrollHeight || 200, window.innerHeight - 40);
  let top = rect.top - 6;
  top = Math.max(12, Math.min(top, window.innerHeight - height - 18));
  popover.style.left = `${Math.min(rect.right + 10, window.innerWidth - width - 12)}px`;
  popover.style.top = `${top}px`;
  ui.popover = popover;
  if (onMount) onMount(popover);
}

function toggleSitePopover(anchor) {
  if (ui.popover) {
    const wasSite = ui.popover.dataset.kind === 'site';
    closePopover();
    if (wasSite) return;
  }
  const items = ui.config.sites.map((site) => `
    <button class="pop-item ${site.id === ui.site?.id ? 'active' : ''}" data-site="${escapeHtml(site.id)}">
      <span class="dots"></span>
      <span class="meta">
        <span class="name">${escapeHtml(site.name)}</span>
        <span class="url">${escapeHtml(site.url)}</span>
      </span>
    </button>`).join('');
  openPopover(anchor, `
    <div class="pop-title"><span>接入的网站</span><span>${ui.config.sites.length} 个</span></div>
    <div class="pop-list">${items}</div>
    <div class="pop-foot">
      <button class="btn ghost" data-pop="manage" style="flex:1">管理站点…</button>
    </div>
  `, (popover) => {
    popover.dataset.kind = 'site';
    popover.addEventListener('click', (event) => {
      const siteBtn = event.target.closest('[data-site]');
      if (siteBtn) {
        switchSite(siteBtn.dataset.site);
        closePopover();
        return;
      }
      if (event.target.closest('[data-pop="manage"]')) {
        closePopover();
        bridge.openSettings();
      }
    });
  });
}

function toggleSearchPopover(anchor) {
  if (ui.popover?.dataset.kind === 'search') return closePopover();
  const search = ui.adapter?.search;
  if (!search) return;
  openPopover(anchor, `
    <div class="pop-title"><span>${escapeHtml(search.label || '搜索')}</span><span>Enter 打开</span></div>
    <div class="field">
      <input id="search-input" type="search" placeholder="${escapeHtml(search.placeholder || '输入关键词')}" autocomplete="off" />
    </div>
  `, (popover) => {
    popover.dataset.kind = 'search';
    const input = $('#search-input', popover);
    input.focus();
    const submit = () => {
      const query = input.value.trim();
      if (!query) return;
      const url = String(search.url).replace('{query}', encodeURIComponent(query));
      ui.view.loadURL(url);
      closePopover();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') closePopover();
    });
  });
}

function toggleZoomPopover(anchor) {
  if (ui.popover?.dataset.kind === 'zoom') return closePopover();
  openPopover(anchor, `
    <div class="pop-title"><span>页面缩放</span><span>Ctrl + 滚轮</span></div>
    <div class="zoom-row">
      <button class="btn sq" data-zoom="-0.1" aria-label="缩小">−</button>
      <span class="zoom-value">${Math.round(ui.zoom * 100)}%</span>
      <button class="btn sq" data-zoom="0.1" aria-label="放大">+</button>
    </div>
    <div class="pop-foot"><button class="btn ghost" data-zoom="reset" style="flex:1">恢复 100%</button></div>
  `, (popover) => {
    popover.dataset.kind = 'zoom';
    popover.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-zoom]');
      if (!btn) return;
      if (btn.dataset.zoom === 'reset') setZoom(1);
      else setZoom(ui.zoom + Number(btn.dataset.zoom));
    });
  });
}

/* ------------------------------------------------------------------ 事件 */

async function switchSite(siteId) {
  if (!ui.config.sites.some((site) => site.id === siteId)) return;
  if (ui.extra) {
    // 独立窗口只切换自己的站点，不影响主窗口与其它窗口
    ui.localSiteId = siteId;
    ui.config.activeSiteId = siteId;
    await mountSite();
    return;
  }
  ui.config.activeSiteId = siteId;
  try {
    const next = await bridge.apply({ activeSiteId: siteId });
    ui.config = next.config;
  } catch { /* 离线也要能切 */ }
  await mountSite();
}

function wireRail() {
  $('#rail').addEventListener('click', async (event) => {
    const btn = event.target.closest('.rail-btn');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'site') return toggleSitePopover(btn);
    if (act === 'settings') return bridge.openSettings();
    if (act === 'new-window') return bridge.newWindow();
    if (act === 'move') return setMoveMode(!ui.moving);
    if (act === 'minimize') return bridge.minimize();
    if (act === 'close') return bridge.close();
    if (act === 'pin') {
      const next = !ui.pinned;
      await bridge.pin(next);
      return;
    }

    if (act === 'back') {
      if (ui.view?.canGoBack?.()) ui.view.goBack();
      return;
    }
    if (act === 'forward') {
      if (ui.view?.canGoForward?.()) ui.view.goForward();
      return;
    }
    if (act === 'reload') {
      showOverlay(false);
      return ui.view?.reload();
    }
    if (act === 'home') {
      if (ui.site) ui.view.loadURL(ui.site.url);
      return;
    }

    if (act.startsWith('tool:')) {
      const tool = act.slice(5);
      if (tool === 'search') return toggleSearchPopover(btn);
      if (tool === 'zoom') return toggleZoomPopover(btn);
      if (tool === 'open-external') {
        const url = ui.view?.getURL?.() || ui.site?.url;
        if (url) bridge.openExternal(url);
        return;
      }
      if (tool === 'crop') {
        ui.cropOn = !ui.cropOn;
        btn.classList.toggle('active', ui.cropOn);
        ui.view?.send('fd', { type: 'crop', on: ui.cropOn });
        toast(ui.cropOn ? '已聚焦到内容区' : '已恢复整页');
        return;
      }
      if (tool === 'reader') {
        const showing = document.body.classList.contains('reader-mode');
        setReaderView(showing ? 'site' : 'reader');
        return;
      }
      if (tool === 'audio') {
        setAudioView(!ui.audioOpen);
        return;
      }
      if (tool === 'local') {
        if (ui.popover?.dataset.kind === 'local') {
          closePopover();
          return;
        }
        openLocalMenu(btn);
        return;
      }
      if (tool === 'speak-source' || tool === 'speak-target') {
        const target = tool === 'speak-source' ? 'source' : 'result';
        if (ui.adapter?.mode === 'translate') {
          if (btn.classList.contains('active')) ui.view?.send('fd', { type: 'stop-speak' });
          else ui.view?.send('fd', { type: 'speak', target });
        } else {
          speakSite(target, btn);
        }
        return;
      }
      if (tool === 'phonetic') {
        showPhoneticPopover(btn);
        return;
      }
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!ui.popover) return;
    if (event.target.closest('#popover') || event.target.closest('.rail-btn')) return;
    closePopover();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#preview').classList.contains('hidden')) closePreview();
      else if (ui.popover) closePopover();
      else if (ui.moving) setMoveMode(false);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      bridge.openSettings();
    }
  });

  $('#overlay-retry').addEventListener('click', () => {
    showOverlay(false);
    ui.view?.reload();
  });

  wireResizeHandles();
}

function setPinned(pinned) {
  ui.pinned = pinned;
  document.body.classList.toggle('pinned', pinned);
  const btn = $('.rail-btn[data-act="pin"]');
  btn?.classList.toggle('active', pinned);
  if (btn) btn.dataset.label = pinned ? '取消固定' : '固定在最上层';
  if (pinned) toast('已固定 · 窗口保持在所有程序最上层，再点一次图钉解除');
}

function wireResizeHandles() {
  $$('.rz').forEach((handle) => {
    handle.addEventListener('pointerdown', async (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const dir = handle.dataset.dir;
      const start = await bridge.getBounds();
      if (!start) return;
      const origin = { x: event.screenX, y: event.screenY };
      let pending = null;
      let frame = 0;

      const flush = () => {
        frame = 0;
        if (!pending) return;
        bridge.setBounds(pending);
        pending = null;
      };

      const onMove = (moveEvent) => {
        const dx = moveEvent.screenX - origin.x;
        const dy = moveEvent.screenY - origin.y;
        let { x, y, width, height } = start;
        if (dir.includes('e')) width = start.width + dx;
        if (dir.includes('s')) height = start.height + dy;
        if (dir.includes('w')) {
          width = start.width - dx;
          x = start.x + dx;
        }
        if (dir.includes('n')) {
          height = start.height - dy;
          y = start.y + dy;
        }
        if (width < 360) {
          if (dir.includes('w')) x = start.x + start.width - 360;
          width = 360;
        }
        if (height < 460) {
          if (dir.includes('n')) y = start.y + start.height - 460;
          height = 460;
        }
        pending = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
        if (!frame) frame = requestAnimationFrame(flush);
      };

      const onUp = () => {
        if (frame) cancelAnimationFrame(frame);
        flush();
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  });
}

/* ------------------------------------------------------------------ 跟随提示 */

const tipState = { timer: null, target: null, x: 0, y: 0 };

function hideRailTip() {
  clearTimeout(tipState.timer);
  tipState.timer = null;
  tipState.target = null;
  const el = $('#tip');
  if (!el) return;
  el.classList.remove('show');
  el.classList.add('hidden');
}

function placeRailTip(el, x, y) {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const margin = 8;
  const gap = 14;
  let left = x + gap;
  if (left + width > window.innerWidth - margin) left = x - width - gap;
  if (left < margin) left = margin;
  let top = y + gap;
  if (top + height > window.innerHeight - margin) top = y - height - gap;
  if (top < margin) top = margin;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showRailTip(btn) {
  const el = $('#tip');
  if (!el || !btn?.dataset.label) return;
  el.textContent = btn.dataset.label;
  el.classList.remove('hidden');
  placeRailTip(el, tipState.x, tipState.y);
  el.classList.add('show');
}

function bindRailTip() {
  const rail = $('#rail');
  if (!rail) return;

  rail.addEventListener('pointerover', (event) => {
    const btn = event.target.closest('.rail-btn[data-label]');
    if (!btn) return;
    tipState.x = event.clientX;
    tipState.y = event.clientY;
    if (tipState.target === btn) return;
    hideRailTip();
    tipState.target = btn;
    tipState.timer = setTimeout(() => {
      tipState.timer = null;
      if (tipState.target === btn) showRailTip(btn);
    }, 660);
  });

  rail.addEventListener('pointermove', (event) => {
    if (!tipState.target) return;
    tipState.x = event.clientX;
    tipState.y = event.clientY;
    const el = $('#tip');
    if (el && !el.classList.contains('hidden')) placeRailTip(el, tipState.x, tipState.y);
  });

  rail.addEventListener('pointerout', (event) => {
    const btn = event.target.closest('.rail-btn[data-label]');
    if (!btn) return;
    const next = event.relatedTarget;
    if (next && btn.contains(next)) return;
    if (tipState.target === btn) hideRailTip();
  });

  rail.addEventListener('pointerdown', hideRailTip);
  rail.addEventListener('scroll', hideRailTip);
  window.addEventListener('blur', hideRailTip);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#rail')) hideRailTip();
  }, true);
}

/* ------------------------------------------------------------------ 工具 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(text) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  box.appendChild(el);
  clearTimeout(toastTimer);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  const params = new URLSearchParams(location.search);
  ui.windowId = params.get('win') || 'main';
  ui.extra = ui.windowId !== 'main';
  const state = await bridge.state();
  ui.config = state.config;
  ui.meta = state.meta;
  ui.pinned = Boolean(state.meta.pinned);

  applyTheme();
  setPinned(ui.pinned);
  wireRail();
  bindRailTip();
  if (ui.extra) {
    const closeBtn = document.querySelector('[data-act="close"]');
    if (closeBtn) {
      closeBtn.dataset.label = '关闭此窗口';
      closeBtn.setAttribute('aria-label', '关闭此窗口');
      closeBtn.title = '关闭此窗口';
    }
    const minBtn = document.querySelector('[data-act="minimize"]');
    if (minBtn) {
      minBtn.dataset.label = '最小化';
      minBtn.setAttribute('aria-label', '最小化');
      minBtn.title = '最小化';
    }
  }
  wirePreview();
  wireTranslate();
  wireReader();
  wireVideo();
  wireAudio();
  wireLocal();
  wireNetwork();
  await mountSite({ silent: true });

  if (state.meta.dark && ui.config.theme.mode === 'system') applyTheme();
  else applyTheme();

  bridge.onConfig(({ config }) => {
    const previousSite = ui.site?.id;
    const previousUrl = ui.site?.url;
    const previousAdapter = ui.site?.adapter;
    const previousCategory = ui.site?.category;
    const previousOverrides = JSON.stringify(ui.site?.overrides || {});
    const previousRead = Boolean(ui.config?.behavior?.readAloud);
    ui.config = config;
    applyTheme();

    const site = activeSite();
    if (!site) return;
    const changedSite = site.id !== previousSite;
    const changedTarget = site.url !== previousUrl || site.adapter !== previousAdapter || site.category !== previousCategory;
    if (changedSite || changedTarget) {
      mountSite({ silent: true });
      return;
    }
    ui.site = site;
    const overridesChanged = JSON.stringify(site.overrides || {}) !== previousOverrides;
    if (overridesChanged) {
      sendInit();
    } else {
      ui.view?.send('fd', { type: 'font', scale: config.theme.fontScale });
      if (Boolean(config.behavior.readAloud) !== previousRead) {
        ui.view?.send('fd', { type: 'auto-read', on: Boolean(config.behavior.readAloud) });
      }
    }
    buildTools();
  });

  bridge.onPinned((pinned) => setPinned(Boolean(pinned)));

  bridge.onPickStart(() => {
    setMoveMode(false);
    ui.view?.send('fd', { type: 'pick', on: true });
    showHint('拾取模式：点击网页里的元素', null);
  });

  bridge.onDownloadDone(({ name }) => toast(`已保存 ${name}`));

  bridge.onPreview((payload) => openPreview(payload || {}));

  bridge.onTtsDone(() => {
    ui.view?.send('fd', { type: 'tts-done' });
    setSpeaking(false, 'source');
    setSpeaking(false, 'result');
  });

  bridge.onFocus((focused) => {
    if (!focused) closePopover();
  });
}

window.addEventListener('DOMContentLoaded', boot);
