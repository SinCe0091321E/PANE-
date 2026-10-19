'use strict';

/* eslint-disable no-new-func */
const { ipcRenderer } = require('electron');

const state = {
  adapter: null,
  overrides: { hide: [], selectors: {}, css: '', js: '' },
  options: { fontScale: 1, autoRead: false, dark: false },
  cropOn: true,
  picker: false,
  tagged: new WeakSet(),
  cropped: [],
  caps: null,
  hadResult: false,
  resultEl: null,
  resultObserver: null,
  readTimer: null,
  lastSpoken: '',
  baseStyle: null,
  adapterStyle: null,
  hideStyle: null,
  userStyle: null,
  initTimer: null
};

function host(message) {
  try {
    ipcRenderer.sendToHost('fd', message);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ styles */

function ensureStyle(key, css) {
  let el = state[key];
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-fd-style', key);
    (document.head || document.documentElement).appendChild(el);
    state[key] = el;
  }
  el.textContent = css;
}

function baseCss() {
  const scale = state.options.fontScale || 1;
  return `
    :root { --fd-scale: ${scale}; }
    html { -webkit-text-size-adjust: 100%; }
    html, body { overflow-x: hidden !important; }
    body { min-width: 0 !important; }
    [data-fd-hscroll] { scrollbar-width: none; }
    [data-fd-hscroll]::-webkit-scrollbar { display: none; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 99px; }
    ::-webkit-scrollbar-track { background: transparent; }
    textarea, [contenteditable="true"], [class*="target-text"], [class*="source-text"] {
      font-size: calc(16px * var(--fd-scale)) !important;
      line-height: 1.7 !important;
    }
    [data-fd-hidden] { display: none !important; }
    [data-fd-cropped] { display: none !important; }
    [data-fd-pick-hover] { outline: 2px solid #4f7cff !important; outline-offset: -2px !important; }

    /* 深色主题下让文字型站点跟上外壳配色（gallery 模式不套用） */
    html.fd-dark { filter: invert(.93) hue-rotate(180deg); background: #ffffff !important; }
    html.fd-dark body { background: #ffffff; }
    html.fd-dark img,
    html.fd-dark video,
    html.fd-dark canvas,
    html.fd-dark picture,
    html.fd-dark svg image { filter: invert(1) hue-rotate(180deg) !important; }
  `;
}

function applyPageTheme() {
  if (!document.documentElement) return;
  const dark = Boolean(state.options.dark) && state.adapter?.mode !== 'gallery';
  document.documentElement.classList.toggle('fd-dark', dark);
}

function hideCss() {
  if (state.adapter?.mode === 'text') return '';
  const list = [...(state.adapter?.hide || []), ...(state.overrides.hide || [])];
  return list.length ? `${list.join(',\n')} { display: none !important; }` : '';
}

function applyStyles() {
  if (!document.head) return;
  ensureStyle('baseStyle', baseCss());
  ensureStyle('adapterStyle', state.adapter?.css || '');
  ensureStyle('hideStyle', hideCss());
  ensureStyle('userStyle', state.overrides.css || '');
  applyPageTheme();
}

function applyHideSelectors() {
  document.querySelectorAll('[data-fd-hidden]').forEach((el) => el.removeAttribute('data-fd-hidden'));
  if (state.adapter?.mode === 'text') return;
  for (const sel of [...(state.adapter?.hide || []), ...(state.overrides.hide || [])]) {
    try {
      document.querySelectorAll(sel).forEach((el) => el.setAttribute('data-fd-hidden', '1'));
    } catch { /* 非法选择器忽略 */ }
  }
}

/* ------------------------------------------------------------- 内容识别 */

function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
}

function firstMatch(selectors, check = visible) {
  for (const sel of selectors || []) {
    try {
      const found = Array.from(document.querySelectorAll(sel)).filter(check);
      if (found.length) return found[0];
    } catch { /* 非法选择器忽略 */ }
  }
  return null;
}

function findSource() {
  const bound = state.overrides.selectors?.source;
  if (bound) {
    const el = firstMatch([bound]);
    if (el) return el;
  }
  const fromAdapter = firstMatch(state.adapter?.selectors?.source || []);
  if (fromAdapter) return fromAdapter;

  const areas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
  return areas[0] || null;
}

function findResult() {
  const bound = state.overrides.selectors?.result;
  if (bound) {
    const el = firstMatch([bound], (node) => visible(node) && textOf(node).length > 0);
    if (el) return el;
  }
  const fromAdapter = firstMatch(state.adapter?.selectors?.result, (node) => visible(node) && textOf(node).length > 0);
  if (fromAdapter) return fromAdapter;

  const candidates = Array.from(document.querySelectorAll('div, p, span, section, article'))
    .filter((el) => {
      if (!visible(el)) return false;
      if (el.closest('header, nav, footer')) return false;
      const cls = `${el.className || ''} ${el.id || ''}`;
      if (!/(target|result|dst|translat|output)/i.test(cls)) return false;
      const text = textOf(el);
      return text.length > 0 && text.length < 5000;
    });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.textContent.length - a.textContent.length);
  return candidates[0];
}

function textOf(el) {
  if (!el) return '';
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
  return (el.innerText || el.textContent || '').trim();
}

function commonAncestor(a, b) {
  const chain = new Set();
  for (let node = a; node; node = node.parentElement) chain.add(node);
  for (let node = b; node; node = node.parentElement) {
    if (chain.has(node)) return node;
  }
  return null;
}

/* ------------------------------------------------------------------ 裁剪 */

function restoreCrop() {
  for (const { el, value } of state.cropped) {
    el.removeAttribute('data-fd-cropped');
    if (value) el.setAttribute('style', value);
    else el.removeAttribute('style');
  }
  state.cropped = [];
}

function keepSibling(el) {
  // 语言选择器常常和内容面板平级，裁掉就没法切换语言了
  try {
    const rect = el.getBoundingClientRect();
    if (rect.height > 260) return false;
    if (el.matches('[class*="lang"], [class*="language"], [id*="lang"], [class*="select"]')) return true;
    return Boolean(el.querySelector('select, [class*="lang"], [class*="language"], [id*="lang"]'));
  } catch {
    return false;
  }
}

function sourceRoot(el) {
  const vh = window.innerHeight || 800;
  const vw = window.innerWidth || 600;
  let node = el;
  while (node.parentElement && node.parentElement !== document.body) {
    const rect = node.parentElement.getBoundingClientRect();
    if (rect.height > vh * 0.92 || rect.width > vw * 0.98) break;
    node = node.parentElement;
  }
  return node;
}

const LANG_HINTS = ['自动检测', '中文', '英语', '日语', '韩语', '法语', '德语', '俄语', '西班牙语', '简体', '繁体', 'English', '日本語', '한국어'];

function findLangAnchor(source) {
  const srcRect = source.getBoundingClientRect();
  const list = document.querySelectorAll('button, [role="button"], [class*="lang"], [class*="select"], div, span');
  let best = null;
  for (const el of list) {
    if (!el || el.contains(source) || source.contains(el)) continue;
    const text = (el.innerText || '').trim();
    if (!text || text.length > 18) continue;
    if (!LANG_HINTS.some((hint) => text === hint || text.includes(hint))) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 12) continue;
    if (rect.bottom > srcRect.top + 24) continue;
    if (rect.top < 0) continue;
    if (!best || rect.top > best.getBoundingClientRect().top) best = el;
  }
  return best;
}

function cropFocus() {
  restoreCrop();
  if (!state.cropOn || !state.adapter || state.adapter.mode !== 'translate') return;
  if (state.overrides.selectors?.cropRoot) {
    const root = firstMatch([state.overrides.selectors.cropRoot]);
    if (root) {
      hideOthers(root);
      return;
    }
  }
  const source = findSource();
  if (!source) return;
  const result = findResult();
  let lca = result ? commonAncestor(source, result) : null;
  if (!lca) {
    const lang = findLangAnchor(source);
    if (lang) lca = commonAncestor(source, lang);
  }
  if (!lca) lca = sourceRoot(source);
  if (!lca || lca === document.body || lca === document.documentElement) return;

  let node = lca;
  const chain = [];
  while (node && node !== document.body) {
    chain.push(node);
    node = node.parentElement;
  }
  for (const kept of chain) {
    const parent = kept.parentElement;
    if (!parent) continue;
    Array.from(parent.children).forEach((sibling) => {
      if (sibling === kept) return;
      if (chain.includes(sibling)) return;
      if (keepSibling(sibling)) return;
      if (matchesKeep(sibling)) return;
      hideEl(sibling);
    });
  }
}

function matchesKeep(el) {
  const keep = state.adapter?.keep || [];
  for (const selector of keep) {
    try {
      if (el.matches(selector) || el.querySelector(selector)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function hideOthers(root) {
  let node = root;
  while (node && node.parentElement && node !== document.body) {
    const parent = node.parentElement;
    Array.from(parent.children).forEach((sibling) => {
      if (sibling !== node) hideEl(sibling);
    });
    node = parent;
  }
}

function hideEl(el) {
  if (!el || el.hasAttribute('data-fd-cropped')) return;
  state.cropped.push({ el, value: el.getAttribute('style') || '' });
  el.setAttribute('data-fd-cropped', '1');
}

/* ---------------------------------------------------------------- 图片 */

function cssUrl(el) {
  const bg = getComputedStyle(el).backgroundImage;
  const match = /url\(["']?(.*?)["']?\)/i.exec(bg || '');
  return match ? match[1] : '';
}

function imageUrlFor(el) {
  if (!el) return '';
  if (el.tagName === 'IMG') {
    return el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
  }
  return cssUrl(el);
}

function tagGallery() {
  if (!state.adapter || state.adapter.mode !== 'gallery') return;
  const selectors = state.adapter.selectors?.galleryItem?.length
    ? state.adapter.selectors.galleryItem
    : ['img'];
  let count = 0;
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.tagName !== 'IMG') return;
        if (!state.tagged.has(el)) {
          state.tagged.add(el);
          el.setAttribute('data-fd-gallery', '1');
        }
        count += 1;
      });
    } catch { /* ignore */ }
  }
  return count;
}

/* ---------------------------------------------------------------- 朗读 */

function detectLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru-RU';
  return 'en-US';
}

function pickVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
    || null;
}

function speak(target) {
  const synth = window.speechSynthesis;
  const el = target === 'result' ? findResult() : findSource();
  let text = textOf(el).trim();
  if (target === 'result') {
    text = text.replace(/\n?(编辑译文|段落对照|复制译文|复制|朗读|重新生成)[\s\S]*$/, '').trim();
  }
  if (!text) {
    host({ type: 'toast', text: target === 'result' ? '还没有译文可以朗读' : '还没有原文可以朗读' });
    return;
  }
  const lang = detectLang(text);
  if (!synth) {
    speakWithSystem(text, lang, target);
    return;
  }
  synth.cancel();
  const voices = synth.getVoices ? synth.getVoices() : [];
  if (voices.length > 0) {
    playUtterance(synth, text, lang, target);
    return;
  }
  // 有些环境里语音列表是异步加载的，等一小会儿；仍然没有就走系统朗读
  let settled = false;
  const fallback = () => {
    if (settled) return;
    settled = true;
    speakWithSystem(text, lang, target);
  };
  const onVoices = () => {
    if (settled) return;
    settled = true;
    const available = synth.getVoices ? synth.getVoices() : [];
    if (available.length) playUtterance(synth, text, lang, target);
    else fallback();
  };
  try {
    synth.addEventListener('voiceschanged', onVoices, { once: true });
  } catch { /* ignore */ }
  setTimeout(fallback, 450);
}

function speakWithSystem(text, lang, target) {
  host({ type: 'tts', text: text.slice(0, 4000), lang });
  host({ type: 'speak-state', on: true, target });
}

function playUtterance(synth, text, lang, target) {
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 4000));
  utterance.lang = lang;
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.02;
  utterance.pitch = 1;
  utterance.onstart = () => host({ type: 'speak-state', on: true, target });
  utterance.onend = () => host({ type: 'speak-state', on: false, target });
  utterance.onerror = () => host({ type: 'speak-state', on: false, target });
  state.lastSpoken = text;
  synth.speak(utterance);
}

function stopSpeak() {
  window.speechSynthesis?.cancel?.();
  host({ type: 'speak-state', on: false });
  host({ type: 'tts-stop' });
}

function watchResult() {
  if (state.resultObserver) state.resultObserver.disconnect();
  state.resultObserver = null;
  if (!state.options.autoRead) return;
  const el = findResult();
  if (!el) return;
  state.resultEl = el;
  state.resultObserver = new MutationObserver(() => {
    clearTimeout(state.readTimer);
    state.readTimer = setTimeout(() => {
      const text = textOf(el).trim();
      if (text && text !== state.lastSpoken) speak('result');
    }, 900);
  });
  state.resultObserver.observe(el, { childList: true, subtree: true, characterData: true });
}

/* ------------------------------------------------------------- 元素拾取 */

const picker = {
  box: null,
  label: null,
  current: null,
  move: null,
  down: null,
  key: null
};

function startPicker() {
  if (state.picker) return;
  state.picker = true;
  document.documentElement.style.cursor = 'crosshair';

  picker.box = document.createElement('div');
  picker.box.setAttribute('data-fd-picker', 'box');
  Object.assign(picker.box.style, {
    position: 'fixed', zIndex: 2147483646, pointerEvents: 'none',
    border: '2px solid #4f7cff', background: 'rgba(79,124,255,.12)',
    borderRadius: '4px', transition: 'all .06s linear'
  });

  picker.label = document.createElement('div');
  picker.label.setAttribute('data-fd-picker', 'label');
  Object.assign(picker.label.style, {
    position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
    background: '#1f2430', color: '#fff', font: '12px/1.4 "Segoe UI", sans-serif',
    padding: '4px 8px', borderRadius: '6px', transform: 'translateY(-120%)',
    maxWidth: '70vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  });

  document.documentElement.append(picker.box, picker.label);

  picker.move = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target === picker.box || target === picker.label) return;
    if (target.closest('[data-fd-picker]')) return;
    picker.current = target;
    const rect = target.getBoundingClientRect();
    picker.box.style.left = `${rect.left}px`;
    picker.box.style.top = `${rect.top}px`;
    picker.box.style.width = `${rect.width}px`;
    picker.box.style.height = `${rect.height}px`;
    const tag = target.tagName.toLowerCase();
    const cls = String(target.className || '').trim().split(/\s+/).slice(0, 2).join('.');
    picker.label.textContent = cls ? `${tag}.${cls}` : tag;
    picker.label.style.left = `${Math.max(6, rect.left)}px`;
    picker.label.style.top = `${Math.max(22, rect.top)}px`;
  };

  picker.down = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-fd-picker]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const selector = cssPath(target);
    stopPicker();
    host({
      type: 'picked',
      selector,
      label: `${target.tagName.toLowerCase()}${target.className ? `.${String(target.className).trim().split(/\s+/)[0]}` : ''}`,
      text: textOf(target).slice(0, 120)
    });
  };

  picker.key = (event) => {
    if (event.key === 'Escape') {
      stopPicker();
      host({ type: 'pick-cancel' });
    }
  };

  window.addEventListener('mousemove', picker.move, true);
  window.addEventListener('pointerdown', picker.down, true);
  window.addEventListener('keydown', picker.key, true);
  host({ type: 'picker-on' });
}

function stopPicker() {
  if (!state.picker) return;
  state.picker = false;
  document.documentElement.style.cursor = '';
  window.removeEventListener('mousemove', picker.move, true);
  window.removeEventListener('pointerdown', picker.down, true);
  window.removeEventListener('keydown', picker.key, true);
  picker.box?.remove();
  picker.label?.remove();
  picker.box = null;
  picker.label = null;
}

function cssPath(el) {
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && node !== document.documentElement && depth < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(' > ');
    }
    const classes = Array.from(node.classList || [])
      .filter((name) => /^[A-Za-z][\w-]*$/.test(name))
      .slice(0, 2);
    if (classes.length) part += `.${classes.map((name) => CSS.escape(name)).join('.')}`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

/* --------------------------------------------------------------- 监听器 */

function isHorizontalScroller(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.scrollWidth <= el.clientWidth + 8) return false;
  const overflowX = getComputedStyle(el).overflowX;
  return overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden';
}

function navLikeScroller(start) {
  let node = start instanceof Element ? start : null;
  while (node && node !== document.body) {
    if (node.scrollWidth > node.clientWidth + 16 && node.clientHeight > 16 && node.clientHeight < 160) {
      const count = node.querySelectorAll('a, button, [role="tab"], li').length;
      if (count >= 3) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 把「发现 / 关注 / …」这类放不下的横向栏目收进自己的容器，
 * 避免它们画到页面外面、和别的文字叠在一起。
 */
function constrainHorizontalNavs() {
  const candidates = document.querySelectorAll('div, nav, ul, section');
  for (const el of candidates) {
    if (el.hasAttribute('data-fd-hscroll')) continue;
    if (el.scrollWidth <= el.clientWidth + 16) continue;
    if (el.clientHeight < 16 || el.clientHeight > 220) continue;
    const items = el.querySelectorAll('a, button, [role="tab"], li');
    if (items.length < 3) continue;
    const style = getComputedStyle(el);
    if (style.overflowX !== 'visible') continue;
    el.setAttribute('data-fd-hscroll', '1');
    el.style.overflowX = 'auto';
  }
}

/**
 * 「发现 / 关注 / …」这类横栏：鼠标在它上面时用滚轮横向滚动，
 * 而不是让整个网页左右乱跑。页面本身已经禁用了横向滚动。
 */
function setupHorizontalWheel() {
  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    let scroller = null;
    let node = target;
    while (node && node !== document.body) {
      if (isHorizontalScroller(node)) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }

    if (!scroller) {
      const nav = navLikeScroller(target);
      if (nav) {
        nav.setAttribute('data-fd-hscroll', '1');
        nav.style.overflowX = 'auto';
        scroller = nav;
      }
    }

    if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 2) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    scroller.scrollLeft += delta;
  }, { passive: false, capture: true });
}

function setupGlobalListeners() {
  document.addEventListener('mousedown', () => {
    // 网页里的任何点击都通知外壳，用于收起左侧二级菜单
    host({ type: 'host-click' });
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (state.adapter?.mode === 'gallery') {
      const img = target.closest('img[data-fd-gallery]');
      if (img) {
        const url = imageUrlFor(img);
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          host({ type: 'preview', url, alt: img.alt || '' });
          return;
        }
      }
    }

    const anchor = target.closest('a[href]');
    if (anchor && anchor.target === '_blank' && /^https?:/i.test(anchor.href)) {
      event.preventDefault();
      host({ type: 'navigate', url: anchor.href });
    }
  }, true);

  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const img = target.closest('img');
    if (!img) return;
    const big = (img.naturalWidth || img.width) >= 180 && (img.naturalHeight || img.height) >= 120;
    if (state.adapter?.mode !== 'gallery' && !big) return;
    const url = imageUrlFor(img);
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    host({ type: 'image-context', url, alt: img.alt || '' });
  }, true);
}

function reportCaps() {
  const source = findSource();
  const result = findResult();
  const galleryCount = state.adapter?.mode === 'gallery' ? tagGallery() : 0;
  const next = {
    mode: state.adapter?.mode || 'generic',
    hasSource: Boolean(source),
    hasResult: Boolean(result),
    gallery: galleryCount || 0,
    title: document.title,
    url: location.href
  };
  if (JSON.stringify(next) === JSON.stringify(state.caps)) return;
  state.caps = next;
  host({ type: 'caps', caps: next });
}

function settle() {
  applyStyles();
  applyHideSelectors();
  cropFocus();
  state.hadResult = Boolean(findResult());
  tagGallery();
  constrainHorizontalNavs();
  setupVideo();
  reportCaps();
  watchResult();
  if (state.overrides.js) {
    try {
      new Function('dock', state.overrides.js)({ host, document, window });
    } catch (error) {
      host({ type: 'toast', text: `自定义脚本出错：${error.message}` });
    }
  }
  if (state.adapter?.pageScript) {
    try {
      new Function('dock', state.adapter.pageScript)({ host, document, window });
    } catch (error) {
      host({ type: 'toast', text: `站点脚本出错：${error.message}` });
    }
  }
}

function scheduleSettle() {
  clearTimeout(state.initTimer);
  settle();
  [300, 900, 2000].forEach((delay) => {
    setTimeout(() => {
      applyHideSelectors();
      tagGallery();
      constrainHorizontalNavs();
      setupVideo();
      reportCaps();
    }, delay);
  });
}

/* ---------------------------------------------------------------- 入口 */

/* --------------------------------------------------------------- 文本阅读 */

function readerPickContainer() {
  const selectors = state.adapter?.selectors || {};
  if (selectors.content) {
    for (const raw of String(selectors.content).split(',')) {
      const sel = raw.trim();
      if (!sel) continue;
      try {
        const el = document.querySelector(sel);
        if (el && (el.textContent || '').trim().length > 400) return el;
      } catch { /* ignore */ }
    }
  }

  // 按「段落文字量」给祖先容器打分，避免选到导航/页脚
  const scores = new Map();
  for (const p of document.querySelectorAll('p')) {
    const text = (p.textContent || '').trim();
    if (text.length < 30) continue;
    let node = p.parentElement;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      if (node === document.body) break;
      scores.set(node, (scores.get(node) || 0) + text.length);
    }
  }

  let best = null;
  let bestScore = 0;
  for (const [el, score] of scores) {
    if (score < 400) continue;
    let linkText = 0;
    for (const a of el.querySelectorAll('a')) linkText += (a.textContent || '').length;
    const adjusted = score - linkText * 1.5;
    if (adjusted > bestScore) {
      bestScore = adjusted;
      best = el;
    }
  }
  if (best) {
    // 往上合并一层，避免只抓到单个段落组
    const parent = best.parentElement;
    if (parent && parent !== document.body) {
      const parentScore = scores.get(parent) || 0;
      if (parentScore > bestScore * 0.9) return parent;
    }
  }
  return best || document.body;
}

function readerExtract() {
  const container = readerPickContainer();
  if (!container) return { error: 'no-content' };
  let titleEl = null;
  try {
    if (state.adapter?.selectors?.title) titleEl = document.querySelector(state.adapter.selectors.title);
  } catch { /* ignore */ }
  if (!titleEl) titleEl = container.querySelector('h1') || document.querySelector('h1');
  const title = ((titleEl && titleEl.innerText) || document.title || '').trim();
  const blocks = [];
  const seen = new Set();
  let lastText = '';
  const nodes = container.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, img');
  for (const node of nodes) {
    if (blocks.length > 900) break;
    const tag = node.tagName.toLowerCase();
    if (node.closest('nav, header, footer, aside, form, script, style')) continue;
    if (tag === 'img') {
      const src = node.currentSrc || node.src;
      if (src && /^(https?:|data:)/.test(src) && node.clientWidth >= 80) {
        blocks.push({ t: 'img', src, alt: (node.alt || '').slice(0, 120) });
      }
      continue;
    }
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    if (node.closest('li') && tag !== 'li') continue;
    if (node.closest('blockquote') && tag !== 'blockquote') continue;
    if (node.closest('pre') && tag !== 'pre') continue;
    // 导航式短链接文字不进入正文
    if (node.closest('a') && text.length < 40) continue;
    if (text === lastText || seen.has(text)) continue;
    seen.add(text);
    lastText = text;
    blocks.push({ t: tag, text: text.slice(0, 4000) });
  }
  return {
    title,
    url: location.href,
    blocks,
    length: blocks.reduce((sum, block) => sum + (block.text ? block.text.length : 0), 0)
  };
}

/* ---------------------------------------------------------------- 视频引擎 */

function videoEl() {
  return document.querySelector('video.html5-main-video, video, audio');
}

function videoState() {
  const video = videoEl();
  if (!video) return { ready: false };
  return {
    ready: true,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    current: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    paused: Boolean(video.paused),
    volume: Number.isFinite(video.volume) ? video.volume : 1,
    muted: Boolean(video.muted),
    rate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
    title: document.title || ''
  };
}

function sendVideoState() {
  host({ type: 'video-state', state: videoState() });
}

function setupVideo() {
  if (state.adapter?.engine !== 'video' && state.adapter?.mode !== 'audio') return;
  const video = videoEl();
  if (!video) {
    sendVideoState();
    return;
  }
  if (state.videoBound === video) {
    sendVideoState();
    return;
  }
  state.videoBound = video;
  const events = ['timeupdate', 'durationchange', 'play', 'pause', 'volumechange', 'ratechange', 'loadedmetadata', 'seeking', 'seeked'];
  for (const name of events) {
    video.addEventListener(name, () => {
      clearTimeout(state.videoTimer);
      state.videoTimer = setTimeout(sendVideoState, 60);
    });
  }
  sendVideoState();
}

function applyVideoCommand(message) {
  const video = videoEl();
  if (!video) {
    sendVideoState();
    return;
  }
  const action = message.action;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  if (action === 'toggle') {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (action === 'play') {
    video.play().catch(() => {});
  } else if (action === 'pause') {
    video.pause();
  } else if (action === 'seek') {
    const time = Number(message.value);
    if (Number.isFinite(time)) {
      const max = Number.isFinite(video.duration) ? video.duration : time;
      video.currentTime = clamp(time, 0, max);
    }
  } else if (action === 'volume') {
    video.volume = clamp(Number(message.value), 0, 1);
    if (video.volume > 0) video.muted = false;
  } else if (action === 'mute') {
    video.muted = !video.muted;
  } else if (action === 'rate') {
    const rate = Number(message.value);
    if (Number.isFinite(rate)) video.playbackRate = clamp(rate, 0.25, 3);
  }
  clearTimeout(state.videoTimer);
  state.videoTimer = setTimeout(sendVideoState, 60);
}

ipcRenderer.on('fd', (event, message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'init': {
      state.adapter = message.adapter || null;
      state.overrides = message.overrides || { hide: [], selectors: {}, css: '', js: '' };
      state.options = { fontScale: 1, autoRead: false, dark: false, ...(message.options || {}) };
      state.cropOn = message.crop !== false;
      scheduleSettle();
      break;
    }
    case 'theme':
      state.options.dark = Boolean(message.dark);
      applyPageTheme();
      break;
    case 'speak':
      speak(message.target === 'result' ? 'result' : 'source');
      break;
    case 'stop-speak':
      stopSpeak();
      break;
    case 'tts-done':
      host({ type: 'speak-state', on: false });
      break;
    case 'pick':
      if (message.on) startPicker();
      else stopPicker();
      break;
    case 'crop':
      state.cropOn = Boolean(message.on);
      cropFocus();
      reportCaps();
      break;
    case 'reader:extract':
      host({ type: 'reader', payload: readerExtract() });
      break;
    case 'video:query':
      setupVideo();
      sendVideoState();
      break;
    case 'video:cmd':
      applyVideoCommand(message);
      break;
    case 'font':
      state.options.fontScale = Number(message.scale) || 1;
      applyStyles();
      break;
    case 'auto-read':
      state.options.autoRead = Boolean(message.on);
      watchResult();
      break;
    default:
      break;
  }
});

function boot() {
  setupGlobalListeners();
  setupHorizontalWheel();
  applyStyles();
  reportCaps();

  const observer = new MutationObserver(() => {
    clearTimeout(state.reportTimer);
    state.reportTimer = setTimeout(() => {
      tagGallery();
      constrainHorizontalNavs();
      setupVideo();
      reportCaps();
      if (state.adapter?.mode === 'translate' && state.cropOn) {
        const hasResult = Boolean(findResult());
        if (!state.cropped.length || (hasResult && !state.hadResult)) {
          cropFocus();
          state.hadResult = hasResult;
        }
      }
    }, 400);
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* ignore */ }

  window.addEventListener('load', () => {
    scheduleSettle();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.picker) {
      stopPicker();
      host({ type: 'pick-cancel' });
    }
  });

  window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    host({ type: 'zoom', delta: event.deltaY < 0 ? 0.05 : -0.05 });
  }, { passive: false });

  host({ type: 'ready', url: location.href });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
