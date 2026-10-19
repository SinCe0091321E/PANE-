'use strict';

const bridge = window.dock;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clone = (value) => JSON.parse(JSON.stringify(value));

const THEMES = [
  { id: 'light', name: '浅色', bg: '#f7f8fb', rail: '#eef0f6', canvas: '#ffffff', ink: '#1b1e25', line: '#e2e5ee' },
  { id: 'dark', name: '深色', bg: '#191c22', rail: '#15171d', canvas: '#1f232b', ink: '#e9edf6', line: '#2b303a' },
  { id: 'gray', name: '灰色', bg: '#e8eaee', rail: '#dde0e6', canvas: '#f2f3f6', ink: '#262932', line: '#cfd3dc' },
  { id: 'paper', name: '纸张黄', bg: '#f7f0dd', rail: '#f0e7d1', canvas: '#fcf7ea', ink: '#3b3226', line: '#e0d3b4' },
  { id: 'system', name: '跟随系统', bg: '#f7f8fb', rail: '#eef0f6', canvas: '#ffffff', ink: '#1b1e25', line: '#e2e5ee', split: '#191c22' }
];

const ACCENTS = ['#4f7cff', '#7c5cff', '#2fa36b', '#e08a2c', '#d9485f', '#3c9bd6'];

let meta = null;
let saved = null;
let draft = null;
let editingId = null;
let pickSiteId = null;
let previewTimer = null;
let toastTimer = null;

/* ------------------------------------------------------------------ 基础 */

function adapterLabel(id) {
  if (!id || id === 'auto') return '自动识别';
  if (id === 'generic') return '通用网页';
  const adapter = meta.adapters.find((item) => item.id === id);
  return adapter ? adapter.name : id;
}

function adapterInfo(id) {
  return meta.adapters.find((item) => item.id === id) || null;
}

function applySelfTheme() {
  const root = document.documentElement;
  const mode = draft.theme.mode;
  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  root.dataset.theme = resolved;
  root.dataset.motion = draft.theme.motion;
  root.dataset.glass = draft.theme.glass ? '1' : '0';
  root.style.setProperty('--accent', draft.theme.accent);
  root.style.setProperty('--radius', `${draft.theme.radius}px`);
}

function isDirty() {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

function refreshDirty() {
  $('#dirty').classList.toggle('hidden', !isDirty());
}

function markChanged() {
  applySelfTheme();
  refreshDirty();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    bridge.preview(draft).catch(() => {});
  }, 110);
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ------------------------------------------------------------------ 页面切换 */

function switchPage(page) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $('#pages').scrollTop = 0;
}

/* ------------------------------------------------------------------ 站点 */

function renderSiteList() {
  const list = $('#site-list');
  list.innerHTML = '';
  draft.sites.forEach((site) => {
    const current = site.id === draft.activeSiteId;
    const row = document.createElement('div');
    row.className = `site-row${current ? ' current' : ''}`;
    row.dataset.id = site.id;
    const adapter = adapterInfo(site.adapter);
    row.innerHTML = `
      <div class="site-avatar">${escapeHtml((site.name || '·').trim().slice(0, 1).toUpperCase())}</div>
      <div class="site-meta">
        <div class="site-name">
          <span>${escapeHtml(site.name)}</span>
          <span class="tag">${escapeHtml(categoryLabel(site.category))}</span>
          <span class="tag ${current ? 'on' : ''}">${escapeHtml(adapterLabel(site.adapter))}</span>
        </div>
        <div class="site-url" title="${escapeHtml(site.url)}">${escapeHtml(site.url)}</div>
      </div>
      <div class="site-ops">
        <button class="btn tiny ${current ? '' : 'ghost'}" data-op="use" ${current ? 'disabled' : ''}>${current ? '使用中' : '使用'}</button>
        <button class="btn tiny ghost" data-op="edit">编辑</button>
        <button class="icon-btn" data-op="pick" title="在页面上拾取元素"><svg><use href="#i-pick"></use></svg></button>
        <button class="icon-btn danger" data-op="del" title="删除站点" ${draft.sites.length === 1 ? 'disabled' : ''}><svg><use href="#i-trash"></use></svg></button>
      </div>`;
    list.appendChild(row);
  });
}

function openEditor(site) {
  editingId = site ? site.id : null;
  $('#editor-title').textContent = site ? `编辑「${site.name}」` : '新增网站';
  $('#f-name').value = site ? site.name : '';
  $('#f-url').value = site ? site.url : '';
  renderCategoryOptions(site ? site.category : 'auto');
  renderAdapterOptions(site ? site.adapter : 'auto');
  $('#f-hide').value = site ? (site.overrides.hide || []).join('\n') : '';
  $('#f-css').value = site ? site.overrides.css || '' : '';
  $('#f-js').value = site ? site.overrides.js || '' : '';
  $('#site-editor').classList.remove('hidden');
  $('#site-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#f-name').focus();
}

function closeEditor() {
  editingId = null;
  $('#site-editor').classList.add('hidden');
}

function renderAdapterOptions(selected) {
  const select = $('#f-adapter');
  select.innerHTML = '';
  const options = [{ id: 'auto', name: '自动识别（按网址匹配）' }, { id: 'generic', name: '通用网页（原样保留）' }]
    .concat(meta.adapters.map((adapter) => ({ id: adapter.id, name: `${adapter.name} · ${adapter.description || adapter.mode}` })));
  options.forEach((option) => {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.name;
    select.appendChild(node);
  });
  select.value = selected || 'auto';
  updateAdapterHint();
}

function updateAdapterHint() {
  const id = $('#f-adapter').value;
  if (id === 'auto') {
    $('#adapter-hint').textContent = '会按网址自动选择下面的适配器；没有匹配时使用通用网页。';
    return;
  }
  if (id === 'generic') {
    $('#adapter-hint').textContent = '不做任何裁剪，只提供缩放和「在浏览器打开」。';
    return;
  }
  const adapter = adapterInfo(id);
  $('#adapter-hint').textContent = adapter
    ? `${adapter.description || ''}（${adapter.mode} 模式）`
    : '';
}

/* ------------------------------------------------------------------ 种类 */

const MODE_LABELS = { translate: '翻译', gallery: '图片', text: '文本', video: '视频', audio: '音频', generic: '通用' };

function categoryLabel(id) {
  if (!id || id === 'auto') return '跟随适配器';
  const category = (draft.categories || []).find((item) => item.id === id);
  return category ? category.name : id;
}

function categoryModeLabel(mode) {
  return MODE_LABELS[mode] || mode;
}

function renderCategoryOptions(selected) {
  const select = $('#f-category');
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = '跟随适配器（自动）';
  select.appendChild(auto);
  (draft.categories || []).forEach((category) => {
    const node = document.createElement('option');
    node.value = category.id;
    node.textContent = `${category.name} · ${categoryModeLabel(category.mode)}`;
    select.appendChild(node);
  });
  select.value = selected || 'auto';
}

function renderCategories() {
  const box = $('#cat-list');
  if (!box) return;
  box.innerHTML = '';
  (draft.categories || []).forEach((category) => {
    const chip = document.createElement('span');
    chip.className = 'cat-chip';
    const modeLabel = categoryModeLabel(category.mode);
    chip.innerHTML = `<span>${escapeHtml(category.name)}</span>` +
      (category.name === modeLabel ? '' : `<em>${escapeHtml(modeLabel)}</em>`);
    if (!category.builtin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '删除这个种类';
      remove.addEventListener('click', () => removeCategory(category.id));
      chip.appendChild(remove);
    }
    box.appendChild(chip);
  });
}

function addCategory() {
  const name = $('#cat-name').value.trim();
  const mode = $('#cat-mode').value;
  if (!name) {
    toast('先给种类起个名字');
    return;
  }
  if ((draft.categories || []).some((category) => category.name === name)) {
    toast('已经有同名种类了');
    return;
  }
  const category = { id: `cat-${Date.now().toString(36)}`, name, mode, builtin: false };
  draft.categories = [...(draft.categories || []), category];
  $('#cat-name').value = '';
  renderCategories();
  renderSiteList();
  if (!$('#site-editor').classList.contains('hidden')) renderCategoryOptions($('#f-category').value);
  markChanged();
  toast(`已添加种类「${name}」，点「应用」生效`);
}

function removeCategory(id) {
  const category = (draft.categories || []).find((item) => item.id === id);
  if (!category) return;
  const used = draft.sites.filter((site) => site.category === id);
  const hint = used.length ? `\n有 ${used.length} 个站点会改成「跟随适配器」。` : '';
  if (!window.confirm(`删除种类「${category.name}」？${hint}`)) return;
  draft.categories = draft.categories.filter((item) => item.id !== id);
  draft.sites = draft.sites.map((site) => (site.category === id ? { ...site, category: 'auto' } : site));
  renderCategories();
  renderSiteList();
  if (!$('#site-editor').classList.contains('hidden')) renderCategoryOptions($('#f-category').value);
  markChanged();
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[a-z]+:\/\//i.test(raw)) return `https://${raw}`;
  return raw;
}

function saveEditor() {
  const name = $('#f-name').value.trim();
  const url = normalizeUrl($('#f-url').value);
  if (!url) {
    toast('先填一个网址');
    return;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    toast('网址格式不太对');
    return;
  }

  const previous = draft.sites.find((site) => site.id === editingId);
  const site = {
    id: editingId || `site-${Date.now().toString(36)}`,
    name: name || new URL(url).hostname,
    url,
    adapter: $('#f-adapter').value,
    category: $('#f-category').value || 'auto',
    enabled: true,
    overrides: {
      hide: $('#f-hide').value.split('\n').map((line) => line.trim()).filter(Boolean),
      selectors: previous ? previous.overrides.selectors : {},
      css: $('#f-css').value,
      js: $('#f-js').value
    }
  };

  if (previous) draft.sites = draft.sites.map((item) => (item.id === site.id ? site : item));
  else draft.sites.push(site);
  if (!draft.activeSiteId) draft.activeSiteId = site.id;

  closeEditor();
  renderSiteList();
  markChanged();
  toast('已保存到草稿，点「应用」生效');
}

function deleteSite(id) {
  const site = draft.sites.find((item) => item.id === id);
  if (!site) return;
  if (draft.sites.length <= 1) {
    toast('至少保留一个站点');
    return;
  }
  if (!window.confirm(`删除「${site.name}」？`)) return;
  draft.sites = draft.sites.filter((item) => item.id !== id);
  if (draft.activeSiteId === id) draft.activeSiteId = draft.sites[0].id;
  renderSiteList();
  markChanged();
}

function pickFromSite(id) {
  const site = draft.sites.find((item) => item.id === id);
  if (!site) return;
  pickSiteId = id;
  bridge.pick(id);
}

function handlePickResult(payload) {
  if (!payload || payload.canceled) {
    bridge.pickDone();
    return;
  }
  const site = draft.sites.find((item) => item.id === pickSiteId);
  if (!site) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>拾取到了这个元素</h3>
      <p>决定它在「${escapeHtml(site.name)}」里扮演什么角色，选择会写进草稿。</p>
      <code>${escapeHtml(payload.selector)}</code>
      <div class="row-actions">
        <button class="btn" data-choice="hide">隐藏它</button>
        <button class="btn" data-choice="source">设为原文</button>
        <button class="btn" data-choice="result">设为译文</button>
        <button class="btn ghost" data-choice="cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) backdrop.remove();
    const button = event.target.closest('[data-choice]');
    if (!button) return;
    const choice = button.dataset.choice;
    if (choice === 'hide') site.overrides.hide = Array.from(new Set([...(site.overrides.hide || []), payload.selector]));
    if (choice === 'source') site.overrides.selectors.source = payload.selector;
    if (choice === 'result') site.overrides.selectors.result = payload.selector;
    backdrop.remove();
    if (choice !== 'cancel') {
      renderSiteList();
      markChanged();
      toast('已写进草稿，点「应用」就能看到效果');
    }
  });
}

/* ------------------------------------------------------------------ 主题 */

function renderThemeGrid() {
  const grid = $('#theme-grid');
  grid.innerHTML = '';
  THEMES.forEach((theme) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `theme-tile${draft.theme.mode === theme.id ? ' active' : ''}`;
    button.dataset.mode = theme.id;
    const darkTheme = THEMES.find((item) => item.id === 'dark');
    button.innerHTML = `
      <div class="tile-preview" style="background:${theme.split ? `linear-gradient(90deg, ${theme.bg} 50%, ${theme.split} 50%)` : theme.bg}">
        <div class="tile-rail" style="background:${theme.split ? `linear-gradient(90deg, ${theme.rail} 50%, #15171d 50%)` : theme.rail}">
          <i style="background:${theme.ink}"></i><i style="background:${theme.ink}"></i><i style="background:${theme.ink}"></i>
        </div>
        <div class="tile-canvas" style="background:${theme.split ? 'transparent' : theme.canvas}; border-radius:5px">
          <i style="background:${theme.ink}"></i><i style="background:${theme.ink}"></i><i style="background:${theme.ink}"></i><i style="background:${theme.ink}"></i>
        </div>
      </div>
      <div class="tile-label"><span>${theme.name}</span>${draft.theme.mode === theme.id ? '<em>当前</em>' : ''}</div>`;
    button.addEventListener('click', () => {
      draft.theme.mode = theme.id;
      renderThemeGrid();
      markChanged();
    });
    grid.appendChild(button);
    // 深色文字在浅色画布上的可读性
    if (theme.id === 'dark') button.querySelectorAll('.tile-canvas i').forEach((line) => { line.style.background = darkTheme.ink; });
  });
}

function renderSwatches() {
  const box = $('#swatches');
  box.innerHTML = '';
  ACCENTS.forEach((color) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `swatch${draft.theme.accent.toLowerCase() === color.toLowerCase() ? ' active' : ''}`;
    button.style.background = color;
    button.title = color;
    button.addEventListener('click', () => {
      draft.theme.accent = color;
      renderSwatches();
      markChanged();
    });
    box.appendChild(button);
  });
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = '自定义颜色';
  custom.innerHTML = `<input type="color" id="accent-color" value="${escapeHtml(draft.theme.accent)}" />`;
  custom.querySelector('input').addEventListener('input', (event) => {
    draft.theme.accent = event.target.value;
    renderSwatches();
    markChanged();
  });
  box.appendChild(custom);
}

/* ------------------------------------------------------------------ 外观 */

function fillLook() {
  $('#f-radius').value = String(draft.theme.radius);
  $('#o-radius').textContent = `${draft.theme.radius} px`;
  $('#f-font').value = String(draft.theme.fontScale);
  $('#o-font').textContent = `${Math.round(draft.theme.fontScale * 100)}%`;
  $('#f-motion').value = draft.theme.motion;
  $('#f-dim').checked = draft.theme.dimSite !== false;
  $('#f-glass').checked = Boolean(draft.theme.glass);
  $('#f-read').checked = Boolean(draft.behavior.readAloud);
}

/* ------------------------------------------------------------------ 关于 */

function fillAbout() {
  $('#a-version').textContent = meta.version;
  $('#a-runtime').textContent = `Electron ${meta.electron} · Chromium ${String(meta.chrome).split('.')[0]}`;
  $('#a-data').textContent = meta.paths.data;
  $('#a-data').title = meta.paths.data;
}

/* ------------------------------------------------------------------ 事件 */

function bind() {
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => switchPage(item.dataset.page)));

  $('#add-site').addEventListener('click', () => openEditor(null));
  $('#editor-close').addEventListener('click', closeEditor);
  $('#editor-cancel').addEventListener('click', closeEditor);
  $('#site-editor').addEventListener('submit', (event) => {
    event.preventDefault();
    saveEditor();
  });
  $('#f-adapter').addEventListener('change', updateAdapterHint);
  $('#pick-element').addEventListener('click', () => {
    if (!editingId) {
      toast('先把站点保存到草稿，再拾取元素');
      return;
    }
    pickFromSite(editingId);
  });
  $('#open-adapters').addEventListener('click', () => bridge.openAdapters());
  $('#cat-add-btn').addEventListener('click', addCategory);
  $('#cat-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addCategory();
    }
  });

  $('#site-list').addEventListener('click', (event) => {
    const row = event.target.closest('.site-row');
    if (!row) return;
    const id = row.dataset.id;
    const button = event.target.closest('[data-op]');
    if (!button) return;
    const op = button.dataset.op;
    if (op === 'use') {
      draft.activeSiteId = id;
      renderSiteList();
      markChanged();
    } else if (op === 'edit') {
      openEditor(draft.sites.find((site) => site.id === id));
    } else if (op === 'pick') {
      pickFromSite(id);
    } else if (op === 'del') {
      deleteSite(id);
    }
  });

  $('#f-radius').addEventListener('input', (event) => {
    draft.theme.radius = Number(event.target.value);
    $('#o-radius').textContent = `${draft.theme.radius} px`;
    markChanged();
  });
  $('#f-font').addEventListener('input', (event) => {
    draft.theme.fontScale = Number(event.target.value);
    $('#o-font').textContent = `${Math.round(draft.theme.fontScale * 100)}%`;
    markChanged();
  });
  $('#f-motion').addEventListener('change', (event) => {
    draft.theme.motion = event.target.value;
    markChanged();
  });
  $('#f-dim').addEventListener('change', (event) => {
    draft.theme.dimSite = event.target.checked;
    markChanged();
  });
  $('#f-glass').addEventListener('change', (event) => {
    draft.theme.glass = event.target.checked;
    applySelfTheme();
    markChanged();
  });
  $('#f-read').addEventListener('change', (event) => {
    draft.behavior.readAloud = event.target.checked;
    markChanged();
  });

  $('#open-data').addEventListener('click', () => bridge.openDataDir());
  $('#a-open-data').addEventListener('click', () => bridge.openDataDir());
  $('#a-open-adapters').addEventListener('click', () => bridge.openAdapters());
  $('#reset-all').addEventListener('click', async () => {
    if (!window.confirm('恢复默认会清空所有站点与自定义，确定吗？')) return;
    const state = await bridge.reset();
    saved = clone(state.config);
    draft = clone(state.config);
    renderAll();
    toast('已恢复默认设置');
  });

  $('#apply').addEventListener('click', async () => {
    const state = await bridge.apply(draft);
    saved = clone(state.config);
    draft = clone(state.config);
    refreshDirty();
    toast('已应用');
    setTimeout(() => bridge.closeSettings(), 240);
  });
  $('#cancel').addEventListener('click', async () => {
    await bridge.cancel();
    bridge.closeSettings();
  });
  $('#close').addEventListener('click', async () => {
    await bridge.cancel();
    bridge.closeSettings();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.querySelector('.modal-backdrop')) {
        document.querySelector('.modal-backdrop').remove();
        return;
      }
      if (!$('#site-editor').classList.contains('hidden')) {
        closeEditor();
        return;
      }
      bridge.cancel().finally(() => bridge.closeSettings());
    }
  });

  bridge.onPickResult(handlePickResult);
}

/* ------------------------------------------------------------------ 启动 */

function renderAll() {
  renderSiteList();
  renderCategories();
  renderThemeGrid();
  renderSwatches();
  fillLook();
  fillAbout();
  refreshDirty();
  applySelfTheme();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function boot() {
  const state = await bridge.state();
  meta = state.meta;
  saved = clone(state.config);
  draft = clone(state.config);
  if (!document.documentElement.style.getPropertyValue('--radius')) {
    document.documentElement.style.setProperty('--radius', `${draft.theme.radius}px`);
  }
  renderAll();
  bind();
}

window.addEventListener('DOMContentLoaded', boot);
