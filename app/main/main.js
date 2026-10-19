'use strict';

const DEBUG = process.argv.includes('--autotest') || process.argv.includes('--dev') || process.argv.includes('--dump-dom') || process.argv.includes('--test-tray') || process.argv.includes('--test-pin');
const DBG = (msg) => {
  if (!DEBUG) return;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = require('electron').app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
};

const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, dialog,
  nativeImage, nativeTheme, session, clipboard, webContents, globalShortcut, net
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const store = require('./store');
const adapters = require('./adapters');

/**
 * 数据目录：默认放在程序旁边的 data/（绿色、纯 ASCII 路径），
 * 这样不会因为默认的 “%APPDATA%\\PANE” 含中文/空格而在部分 Windows 上启动失败；
 * 本地目录不可写时回退到旧的 %APPDATA%\\FloatingDock，兼容历史数据。
 * 显式传入 --user-data-dir 时尊重调用方（自检/多开调试用）。
 */
function initUserDataPath() {
  if (process.argv.some((arg) => arg.startsWith('--user-data-dir'))) return;
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'data'),
    path.join(app.getPath('appData'), 'FloatingDock')
  ];
  for (const dir of candidates) {
    try {
      const resolved = path.resolve(dir);
      fs.mkdirSync(resolved, { recursive: true });
      const probe = path.join(resolved, '.write-check');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      app.setPath('userData', resolved);
      return;
    } catch { /* 换下一个位置 */ }
  }
}

initUserDataPath();

const APP_DIR = path.join(__dirname, '..');
// 打包时会在 resources/app-files 放一份真实文件，优先用它，避免 asar 路径在不同版本上的差异
const FILE_ROOT = path.join(process.resourcesPath, 'app-files');
const HAS_FILES = fs.existsSync(path.join(FILE_ROOT, 'renderer', 'index.html'));
const RENDERER_DIR = HAS_FILES ? path.join(FILE_ROOT, 'renderer') : path.join(APP_DIR, 'renderer');
const ASSETS_DIR = HAS_FILES ? path.join(FILE_ROOT, 'assets') : path.join(APP_DIR, 'assets');

const APP_ICON = path.join(ASSETS_DIR, 'app.png');
const TRAY_ICON = path.join(ASSETS_DIR, 'tray.png');

let SHELL_PRELOAD = path.join(APP_DIR, 'preload', 'shell.js');
let CONTENT_PRELOAD = path.join(APP_DIR, 'preload', 'content.js');
let LIGHTBOX_PRELOAD = path.join(APP_DIR, 'preload', 'lightbox.js');
let TRAY_PRELOAD = path.join(APP_DIR, 'preload', 'tray.js');
let ADAPTER_DIR = path.join(APP_DIR, 'adapters');

/**
 * preload 与适配器都放到用户数据目录的可写副本里：
 *  - webview 的 preload 需要真实文件路径（asar 里也能读，但复制出来更好调试）
 *  - 适配器放在 userData/adapters，用户直接编辑即可，不用重新打包
 */
function prepareRuntime() {
  const userData = app.getPath('userData');
  const source = HAS_FILES ? FILE_ROOT : APP_DIR;

  const preloadDir = path.join(userData, 'preload');
  const copied = {};
  try { fs.mkdirSync(preloadDir, { recursive: true }); } catch { /* ignore */ }
  for (const file of ['shell.js', 'content.js', 'lightbox.js', 'tray.js']) {
    try {
      fs.copyFileSync(path.join(source, 'preload', file), path.join(preloadDir, file));
      copied[file] = true;
    } catch {
      copied[file] = false;
    }
  }
  SHELL_PRELOAD = copied['shell.js'] ? path.join(preloadDir, 'shell.js') : path.join(source, 'preload', 'shell.js');
  CONTENT_PRELOAD = copied['content.js'] ? path.join(preloadDir, 'content.js') : path.join(source, 'preload', 'content.js');
  LIGHTBOX_PRELOAD = copied['lightbox.js'] ? path.join(preloadDir, 'lightbox.js') : path.join(source, 'preload', 'lightbox.js');
  TRAY_PRELOAD = copied['tray.js'] ? path.join(preloadDir, 'tray.js') : path.join(source, 'preload', 'tray.js');

  ADAPTER_DIR = path.join(userData, 'adapters');
  try {
    fs.mkdirSync(ADAPTER_DIR, { recursive: true });
    const bundled = path.join(source, 'adapters');
    for (const file of fs.readdirSync(bundled)) {
      if (!file.endsWith('.adapter.js')) continue;
      const target = path.join(ADAPTER_DIR, file);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(bundled, file), target);
    }
  } catch { /* 打包后也能用内置适配器 */ }
}

let mainWin = null;
let settingsWin = null;
let lightboxWin = null;
let trayWin = null;
let tray = null;
let trayHelper = null;
let trayCommandFile = null;
let trayCommandTimer = null;
let trayHintShown = false;
let extraWins = new Set();
let extraSeq = 0;
let localPickOpen = false;
let quitting = false;
let saveBoundsTimer = null;

const gotLock = app.requestSingleInstanceLock();
DBG(`lock=${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMain();
  });
}

function config() {
  return store.get();
}

function isDev() {
  return process.argv.includes('--dev');
}

/* ------------------------------------------------------------------ windows */

function workAreaFor(point) {
  try {
    return screen.getDisplayNearestPoint(point).workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

function initialBounds() {
  const saved = config().window.bounds;
  const point = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    ? { x: saved.x, y: saved.y }
    : screen.getCursorScreenPoint();
  const area = workAreaFor(point);
  const width = Math.min(Math.round(saved.width || 430), Math.max(360, area.width - 24));
  const height = Math.min(Math.round(saved.height || 720), Math.max(460, area.height - 24));
  let x = Number.isFinite(saved.x) ? saved.x : area.x + area.width - width - 28;
  let y = Number.isFinite(saved.y) ? saved.y : area.y + 60;

  x = Math.min(Math.max(x, area.x), area.x + area.width - width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function createMainWindow() {
  const bounds = initialBounds();
  const cfg = config();
  DBG(`bounds=${JSON.stringify(bounds)} area=${JSON.stringify(workAreaFor(screen.getCursorScreenPoint()))}`);

  mainWin = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 460,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'PANE',
    icon: APP_ICON,
    show: false,
    alwaysOnTop: Boolean(cfg.window.pinned),
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWin.loadFile(path.join(RENDERER_DIR, 'index.html'));

  mainWin.webContents.on('console-message', (event) => {
    DBG(`console[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  mainWin.webContents.on('preload-error', (event, preloadPath, error) => {
    DBG(`preload-error ${preloadPath} ${error && error.message}`);
  });
  mainWin.webContents.on('render-process-gone', (event, details) => {
    DBG(`main renderer gone ${details.reason} ${details.exitCode}`);
  });
  mainWin.webContents.on('did-fail-load', (event, code, desc, url) => {
    DBG(`did-fail-load ${code} ${desc} ${url}`);
  });

  mainWin.once('ready-to-show', () => {
    DBG('main ready-to-show');
    applyWindowGlass(mainWin);
    mainWin.show();
    if (cfg.window.pinned) applyPin(true, { silent: true });
    if (isDev()) mainWin.webContents.openDevTools({ mode: 'detach' });
  });

  mainWin.webContents.on('did-finish-load', () => DBG('main did-finish-load'));
  mainWin.webContents.on('dom-ready', () => DBG('main dom-ready'));
  mainWin.webContents.on('did-start-loading', () => DBG('main did-start-loading'));

  const persistBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
      const b = mainWin.getBounds();
      store.set({ window: { bounds: b } });
    }, 400);
  };

  mainWin.on('move', () => {
    persistBounds();
  });
  mainWin.on('resize', persistBounds);
  mainWin.on('closed', () => {
    mainWin = null;
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWin.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.preload = CONTENT_PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
    delete params.preload;
  });

  mainWin.on('focus', () => {
    sendToShell('state:focus', true);
  });
  mainWin.on('blur', () => {
    sendToShell('state:focus', false);
  });
}

function createExtraWindow() {
  if (extraWins.size >= 8) return null;
  const base = mainWin && !mainWin.isDestroyed() ? mainWin.getBounds() : null;
  const display = base ? screen.getDisplayMatching(base) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(base ? base.width : 430, Math.max(360, area.width - 24));
  const height = Math.min(base ? base.height : 720, Math.max(460, area.height - 24));
  const offset = 26 * (extraWins.size + 1);
  const x = base ? Math.min(base.x + offset, area.x + area.width - width) : area.x + 40;
  const y = base ? Math.min(base.y + offset, area.y + area.height - height) : area.y + 40;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 360,
    minHeight: 460,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'PANE',
    icon: APP_ICON,
    show: false,
    alwaysOnTop: Boolean(config().window.pinned),
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  const id = `extra-${Date.now()}-${extraSeq++}`;
  extraWins.add(win);
  DBG(`extra window ${id}`);
  win.loadFile(path.join(RENDERER_DIR, 'index.html'), { query: { win: id } });
  win.once('ready-to-show', () => {
    applyWindowGlass(win);
    win.show();
    win.focus();
  });
  win.on('closed', () => extraWins.delete(win));
  return win;
}

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWin;
}

function sendToShell(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function applyWindowGlass(win) {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  if (typeof win.setBackgroundMaterial !== 'function') return;
  try {
    win.setBackgroundMaterial(config().theme.glass ? 'acrylic' : 'none');
  } catch (error) {
    DBG(`glass material error ${error && error.message ? error.message : error}`);
  }
}

function applyGlassAll() {
  applyWindowGlass(mainWin);
  applyWindowGlass(settingsWin);
  for (const win of extraWins) applyWindowGlass(win);
}

function showMain() {
  hideTrayPanel();
  if (!mainWin || mainWin.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (tray) tray.setToolTip('PANE');
  if (config().window.pinned) applyPin(true, { silent: true });
}

function hideMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const hasTray = Boolean((tray && !tray.isDestroyed()) || trayHelper);
  if (!hasTray) {
    // 没有托盘图标时不要隐藏，否则窗口就找不回来了
    dialog.showMessageBox(mainWin, {
      type: 'warning',
      title: 'PANE',
      message: '系统托盘图标创建失败，暂时不能缩到后台。',
      detail: '可以直接使用窗口左上角的关闭按钮退出，或重启 PANE 再试。'
    });
    return;
  }
  // 缩到托盘前把窗口位置/大小落盘，下次打开保持原样
  try { store.set({ window: { bounds: mainWin.getBounds() } }); } catch { /* ignore */ }
  mainWin.hide();
  if (tray) tray.setToolTip('PANE · 已缩到托盘（左键恢复）');
  if (!trayHintShown) {
    trayHintShown = true;
    if (tray) {
      try {
        tray.displayBalloon({
          title: 'PANE 已缩到系统托盘',
          content: '左键托盘图标恢复窗口；右键打开菜单；找不到时点任务栏右下角的 ^ 展开隐藏图标。',
          iconType: 'info',
          noSound: true
        });
      } catch { /* 通知被系统禁用时忽略 */ }
    }
  }
}

/* ------------------------------------------------------------------- pin */

function applyPin(pinned, { silent = false } = {}) {
  const cfg = config();
  cfg.window.pinned = pinned;
  store.save();

  if (mainWin && !mainWin.isDestroyed()) {
    // 只把窗口钉在所有窗口最上层，不遮挡、不影响其它程序
    mainWin.setAlwaysOnTop(pinned);
  }
  if (!silent) sendToShell('state:pinned', pinned);
  if (tray) tray.setToolTip(pinned ? 'PANE · 已固定在最上层' : 'PANE');
  return pinned;
}

/* ------------------------------------------------------------------- tray */

function createTrayPanel() {
  if (trayWin && !trayWin.isDestroyed()) return;
  trayWin = new BrowserWindow({
    width: 196,
    height: 152,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      preload: TRAY_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  trayWin.setAlwaysOnTop(true, 'pop-up-menu');
  trayWin.loadFile(path.join(RENDERER_DIR, 'tray.html'));
  trayWin.webContents.on('did-finish-load', () => DBG('tray panel loaded'));
  trayWin.webContents.on('did-fail-load', (event, code, desc) => DBG(`tray panel fail ${code} ${desc}`));
  trayWin.on('blur', () => hideTrayPanel());
  trayWin.on('closed', () => { trayWin = null; });
}

function hideTrayPanel() {
  if (trayWin && !trayWin.isDestroyed()) trayWin.hide();
}

function showTrayPanel() {
  if (!trayWin || trayWin.isDestroyed()) createTrayPanel();
  if (!trayWin || trayWin.isDestroyed()) return;

  let anchor = null;
  if (tray && !tray.isDestroyed()) {
    try { anchor = tray.getBounds(); } catch { anchor = null; }
  }
  if (!anchor || !anchor.width || !anchor.height) {
    const point = screen.getCursorScreenPoint();
    anchor = { x: point.x - 12, y: point.y - 12, width: 24, height: 24 };
  }
  const display = screen.getDisplayMatching(anchor);
  const area = display.workArea;
  const [width, height] = trayWin.getSize();
  let x = Math.round(anchor.x + anchor.width / 2 - width / 2);
  x = Math.min(Math.max(x, area.x + 6), area.x + area.width - width - 6);
  let y = Math.round(anchor.y - height - 8);
  if (y < area.y + 6) y = Math.round(anchor.y + anchor.height + 8);
  trayWin.setPosition(x, y, false);
  trayWin.show();
  trayWin.focus();
}

function handleTrayCommand(command) {
  DBG(`tray command ${command}`);
  if (command === 'open') showMain();
  else if (command === 'panel') showTrayPanel();
  else if (command === 'settings') openSettings();
  else if (command === 'quit') quitApp();
}

function startTrayHelper() {
  const bundled = path.join(ASSETS_DIR, 'tray-helper.ps1');
  if (!fs.existsSync(bundled)) return false;

  // asar 里的脚本 PowerShell 读不到，复制到可写的用户目录再执行
  const workDir = app.getPath('userData');
  const script = path.join(workDir, 'tray-helper.ps1');
  try {
    fs.copyFileSync(bundled, script);
  } catch { /* 用户目录不可写时退回原路径 */ }

  let iconPath = path.join(ASSETS_DIR, 'app.ico');
  const writableIcon = path.join(workDir, 'tray-icon.ico');
  try {
    fs.copyFileSync(iconPath, writableIcon);
    iconPath = writableIcon;
  } catch { /* 用原路径 */ }

  trayCommandFile = path.join(workDir, 'tray-command.txt');
  try { fs.writeFileSync(trayCommandFile, '', 'utf8'); } catch { /* ignore */ }
  try {
    trayHelper = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', script,
      '-AppPid', String(process.pid),
      '-CmdFile', trayCommandFile,
      '-IconPath', iconPath,
      '-Tooltip', 'PANE'
    ], { windowsHide: true, stdio: 'ignore' });
  } catch (error) {
    DBG(`tray helper spawn failed ${error.message}`);
    trayHelper = null;
    return false;
  }
  DBG(`tray helper pid=${trayHelper.pid}`);
  trayHelper.on('error', (error) => DBG(`tray helper error ${error.message}`));
  trayHelper.on('exit', () => {
    trayHelper = null;
    if (quitting) return;
    DBG('tray helper exited, fallback to electron tray');
    if (!tray) createLegacyTray();
  });
  if (trayCommandTimer) clearInterval(trayCommandTimer);
  trayCommandTimer = setInterval(() => {
    if (!trayCommandFile) return;
    let text = '';
    try { text = fs.readFileSync(trayCommandFile, 'utf8').trim(); } catch { return; }
    if (!text) return;
    try { fs.writeFileSync(trayCommandFile, '', 'utf8'); } catch { /* ignore */ }
    handleTrayCommand(text);
  }, 300);
  return true;
}

function createLegacyTray() {
  let icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'app.ico'));
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(TRAY_ICON);
  }
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(APP_ICON);
  }
  DBG(`legacy tray icon empty=${icon.isEmpty()} size=${JSON.stringify(icon.getSize())}`);
  tray = new Tray(icon);
  tray.setToolTip('PANE');
  tray.on('click', () => {
    hideTrayPanel();
    showMain();
  });
  tray.on('double-click', () => {
    hideTrayPanel();
    showMain();
  });
  tray.on('right-click', () => { hideTrayPanel(); showTrayPanel(); });
}

function createTray() {
  if (startTrayHelper()) return;
  createLegacyTray();
}

/* --------------------------------------------------------------- settings */

function openSettings() {
  hideTrayPanel();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  if (config().window.pinned) applyPin(false);

  settingsWin = new BrowserWindow({
    width: 820,
    height: 600,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: '设置 · PANE',
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  settingsWin.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    applyWindowGlass(settingsWin);
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    store.load();
    broadcastConfig('revert');
    sendToShell('settings:closed');
  });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

/* --------------------------------------------------------------- lightbox */

function openLightbox(payload = {}) {
  const src = typeof payload.url === 'string' ? payload.url : '';
  if (!/^(https?:|data:image\/|file:)/i.test(src)) return;

  if (lightboxWin && !lightboxWin.isDestroyed()) {
    lightboxWin.close();
    lightboxWin = null;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  lightboxWin = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#0b0c10',
    fullscreen: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '图片预览',
    webPreferences: {
      preload: LIGHTBOX_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  lightboxWin.setAlwaysOnTop(true, 'screen-saver');
  lightboxWin.loadFile(path.join(RENDERER_DIR, 'lightbox.html'), {
    query: { src, alt: String(payload.alt || '') }
  });
  lightboxWin.once('ready-to-show', () => {
    if (!lightboxWin || lightboxWin.isDestroyed()) return;
    lightboxWin.show();
    lightboxWin.focus();
    lightboxWin.setFullScreen(true);
  });
  lightboxWin.on('closed', () => { lightboxWin = null; });
}

function closeLightbox() {
  if (lightboxWin && !lightboxWin.isDestroyed()) lightboxWin.close();
}

/* -------------------------------------------------------------- 系统朗读 */

let ttsProcess = null;

function stopTts() {
  if (ttsProcess && !ttsProcess.killed) {
    try { ttsProcess.kill(); } catch { /* ignore */ }
  }
  ttsProcess = null;
}

function speakWithSystem(text, lang) {
  const content = String(text || '').trim();
  if (!content) return false;
  stopTts();

  const ttsFile = path.join(app.getPath('userData'), 'tts.txt');
  fs.writeFileSync(ttsFile, content.slice(0, 4000), 'utf8');
  const culture = /^[a-z]{2}-[A-Z]{2}$/.test(String(lang || '')) ? String(lang) : '';
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    culture
      ? `try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('${culture}')) } catch {};`
      : '',
    `$t = [System.IO.File]::ReadAllText('${ttsFile.replace(/'/g, "''")}');`,
    '$s.Speak($t);'
  ].join(' ');

  try {
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    });
    ttsProcess = proc;
    const done = () => {
      if (ttsProcess !== proc) return;
      ttsProcess = null;
      sendToShell('state:tts-done');
    };
    proc.on('exit', done);
    proc.on('error', done);
    return true;
  } catch {
    ttsProcess = null;
    return false;
  }
}

/* -------------------------------------------------------------- downloads */

function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return '';
}

function fileNameFromUrl(url, fallback = 'image') {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (name && /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(name)) return name;
  } catch { /* ignore */ }
  return `${fallback}-${Date.now()}.png`;
}

async function saveImageAs(url, suggested) {
  const clean = sanitizeUrl(url);
  if (!clean) return false;
  const win = BrowserWindow.getFocusedWindow() || mainWin;
  const result = await dialog.showSaveDialog(win, {
    title: '保存图片',
    defaultPath: path.join(app.getPath('downloads'), suggested || fileNameFromUrl(clean)),
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] }]
  });
  if (result.canceled || !result.filePath) return false;
  try {
    if (clean.startsWith('file://')) {
      const { fileURLToPath } = require('node:url');
      fs.copyFileSync(fileURLToPath(clean), result.filePath);
      return true;
    }
    const response = await session.defaultSession.fetch(clean);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(result.filePath, buffer);
    return true;
  } catch (error) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '下载失败',
      message: '图片保存失败',
      detail: String(error && error.message ? error.message : error)
    });
    return false;
  }
}

function showImageContextMenu(payload = {}) {
  const url = sanitizeUrl(payload.url);
  if (!url) return;
  const target = BrowserWindow.getFocusedWindow() || mainWin;
  const menu = Menu.buildFromTemplate([
    { label: '在窗口内查看', click: () => { if (target && !target.isDestroyed()) target.webContents.send('preview:open', { url, alt: payload.alt }); } },
    { label: '系统全屏', click: () => openLightbox({ url, alt: payload.alt }) },
    { type: 'separator' },
    { label: '保存图片…', click: () => saveImageAs(url, fileNameFromUrl(url)) },
    { label: '复制图片地址', click: () => clipboard.writeText(url) },
    { type: 'separator' },
    { label: '取消', role: 'close' }
  ]);
  menu.popup({ window: BrowserWindow.getFocusedWindow() || mainWin || undefined });
}

/* -------------------------------------------------------------- 翻译引擎 */

function translateWebContents(host) {
  const all = webContents.getAllWebContents().filter((item) => item.getType() === 'webview');
  if (host) {
    const own = all.find((item) => {
      try { return item.hostWebContents === host.id; } catch { return false; }
    });
    if (own) return own;
  }
  return all[0] || null;
}

const translateLangState = new WeakMap();
const translateResultCache = new Map();
const TRANSLATE_CACHE_LIMIT = 240;
let translateChain = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function translateCacheKey(payload) {
  return `${payload.engine}|${payload.source}|${payload.target}|${payload.text}`;
}

function rememberTranslation(key, text) {
  if (!key) return;
  translateResultCache.set(key, text);
  if (translateResultCache.size > TRANSLATE_CACHE_LIMIT) {
    const first = translateResultCache.keys().next().value;
    translateResultCache.delete(first);
  }
}

async function ensureTranslateEditor(wc, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await wc.executeJavaScript(`Boolean(document.querySelector('[contenteditable="true"][role="textbox"]'))`);
      if (ok) return true;
    } catch { /* ignore */ }
    await sleep(200);
  }
  return false;
}

async function baiduSetLang(wc, side, label) {
  const index = side === 'source' ? 0 : 1;
  const js = `(async () => {
    const label = ${JSON.stringify(label)};
    const ctrls = [...document.querySelectorAll('.pLdMpdki')];
    const ctrl = ctrls[${index}];
    if (!ctrl) return false;
    if ((ctrl.innerText || '').trim() === label) return true;
    ctrl.click();
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 120));
      const all = [...document.querySelectorAll('span, li, div')].filter((e) => (e.innerText || '').trim() === label);
      const item = all.find((e) => e.children.length === 0) || all[0];
      if (item) {
        try { item.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        item.click();
        await new Promise((r) => setTimeout(r, 260));
        return true;
      }
    }
    return false;
  })()`;
  try {
    return await wc.executeJavaScript(js);
  } catch {
    return false;
  }
}

function baiduReadResult() {
  return `(() => {
    const dst = document.querySelector('.scroll-y-dst');
    if (!dst) return '';
    return (dst.innerText || '').replace(/\\s+/g, ' ').trim();
  })()`;
}

function cleanTranslation(raw) {
  const markers = ['编辑译文', '段落对照', '试一试', '重点词汇', '以上为AI翻译结果', '以上为机器翻译结果'];
  let cut = -1;
  for (const marker of markers) {
    const index = raw.indexOf(marker);
    if (index >= 0 && (cut < 0 || index < cut)) cut = index;
  }
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim();
}

async function baiduTranslate(wc, payload) {
  const text = String(payload.text || '').trim();
  if (!text) return { text: '' };

  const key = translateCacheKey(payload);
  if (translateResultCache.has(key)) return { text: translateResultCache.get(key), cached: true };
  if (!net.isOnline()) return { error: 'offline' };

  if (!await ensureTranslateEditor(wc)) return { error: 'engine-not-ready' };

  const state = translateLangState.get(wc) || { url: '', source: '', target: '' };
  const url = wc.getURL();
  if (state.url !== url) {
    state.url = url;
    state.source = '';
    state.target = '';
  }
  if (payload.target && payload.target !== '自动检测' && state.target !== payload.target) {
    if (await baiduSetLang(wc, 'target', payload.target)) state.target = payload.target;
  }
  if (payload.source && payload.source !== '自动检测' && state.source !== payload.source) {
    if (await baiduSetLang(wc, 'source', payload.source)) state.source = payload.source;
  }
  translateLangState.set(wc, state);

  const before = await wc.executeJavaScript(baiduReadResult());
  const injected = await wc.executeJavaScript(`(() => {
    const el = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber = key ? el[key] : null;
    let editor = null;
    while (fiber) {
      if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
      fiber = fiber.return;
    }
    if (!editor) return false;
    const blocks = editor.children || [];
    if (!blocks.length) return false;
    const lastIndex = blocks.length - 1;
    const kids = blocks[lastIndex].children || [];
    const lastLeaf = Math.max(0, kids.length - 1);
    const lastText = kids[lastLeaf] ? (kids[lastLeaf].text || '') : '';
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [lastIndex, lastLeaf], offset: lastText.length }
    };
    editor.deleteFragment();
    editor.insertText(${JSON.stringify(text)});
    return true;
  })()`);
  if (!injected) return { error: 'engine-not-ready' };

  const beforeClean = cleanTranslation(before);
  const started = Date.now();
  let lastClean = '';
  let stable = 0;
  let latest = '';

  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    let raw = '';
    try {
      raw = await wc.executeJavaScript(baiduReadResult());
    } catch { /* ignore */ }
    if (!raw) continue;
    const clean = cleanTranslation(raw);
    if (!clean) continue;
    if (clean === beforeClean) {
      stable = 0;
      // 同义句可能译出来完全一样：等一会儿直接复用旧译文
      if (beforeClean && Date.now() - started > 5000) {
        rememberTranslation(key, beforeClean);
        return { text: beforeClean, unchanged: true };
      }
      continue;
    }
    latest = clean;
    if (clean === lastClean) stable += 1;
    else {
      lastClean = clean;
      stable = 0;
    }
    // 结果连续稳定 750ms 才认为翻译完成，避免拿到上一句的旧结果
    if (stable >= 3) {
      rememberTranslation(key, clean);
      return { text: clean };
    }
  }
  if (latest) {
    rememberTranslation(key, latest);
    return { text: latest, partial: true };
  }
  return { text: '', timeout: true };
}

async function runTranslate(payload = {}, host) {
  const wc = translateWebContents(host);
  if (!wc) return { error: 'engine-unavailable' };
  try {
    if (payload.engine === 'baidu') return await baiduTranslate(wc, payload);
    return { error: 'unsupported-engine' };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

let ipaCache = {};

function ipaCacheFile() {
  return path.join(app.getPath('userData'), 'ipa-cache.json');
}

function loadIpaCache() {
  try {
    ipaCache = JSON.parse(fs.readFileSync(ipaCacheFile(), 'utf8')) || {};
  } catch {
    ipaCache = {};
  }
}

function saveIpaCache() {
  try {
    fs.writeFileSync(ipaCacheFile(), JSON.stringify(ipaCache));
  } catch { /* ignore */ }
}

async function ipaFor(text) {
  const words = [...new Set(String(text || '').toLowerCase().match(/[a-z']+/g) || [])].slice(0, 24);
  const out = {};
  for (const word of words) {
    if (Object.prototype.hasOwnProperty.call(ipaCache, word)) {
      out[word] = ipaCache[word];
      continue;
    }
    let value = '';
    try {
      const res = await session.defaultSession.fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (res.ok) {
        const data = await res.json();
        const phonetics = Array.isArray(data) ? data[0]?.phonetics : null;
        value = (Array.isArray(phonetics) && phonetics.find((p) => p && p.text)?.text) || '';
      }
    } catch { /* ignore */ }
    ipaCache[word] = value;
    out[word] = value;
  }
  saveIpaCache();
  return out;
}

/* -------------------------------------------------------------- app actions */

function quitApp() {
  quitting = true;
  hideTrayPanel();
  stopTts();
  if (trayCommandTimer) {
    clearInterval(trayCommandTimer);
    trayCommandTimer = null;
  }
  if (trayHelper) {
    try { trayHelper.kill(); } catch { /* ignore */ }
    trayHelper = null;
  }
  for (const win of extraWins) {
    if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }
  extraWins.clear();
  // 设置窗口里没点「应用」的预览不应该被顺带保存
  if (settingsWin && !settingsWin.isDestroyed()) store.load();
  store.save();
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  stopTts();
  if (trayCommandTimer) {
    clearInterval(trayCommandTimer);
    trayCommandTimer = null;
  }
  if (trayHelper) {
    try { trayHelper.kill(); } catch { /* ignore */ }
    trayHelper = null;
  }
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
});

app.on('window-all-closed', () => {
  // 订阅了这个事件就由我们自己决定是否退出：托盘还在，正常关窗不退出
  if (quitting) app.quit();
});

app.on('activate', () => {
  showMain();
});

/* --------------------------------------------------------------- IPC wiring */

function statePayload() {
  return {
    config: config(),
    meta: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      adapters: adapters.list().map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description || '',
        mode: a.mode || 'generic',
        custom: Boolean(a.custom)
      })),
      paths: { contentPreload: pathToFileURL(CONTENT_PRELOAD).href, data: app.getPath('userData') },      dark: nativeTheme.shouldUseDarkColors,
      pinned: Boolean(mainWin && mainWin.isAlwaysOnTop())
    }
  };
}

function registerIpc() {
  ipcMain.handle('app:state', () => statePayload());

  ipcMain.handle('config:preview', (event, patch) => {
    store.set(patch, { persist: false });
    broadcastConfig('preview');
    return statePayload();
  });

  ipcMain.handle('config:apply', (event, patch) => {
    store.set(patch, { persist: true });
    broadcastConfig('apply');
    return statePayload();
  });

  ipcMain.handle('config:cancel', () => {
    store.load();
    broadcastConfig('revert');
    return statePayload();
  });

  ipcMain.handle('config:reset', () => {
    store.reset();
    broadcastConfig('apply');
    return statePayload();
  });

  ipcMain.handle('adapter:resolve', (event, { url, adapterId, categoryId }) => {
    const category = (config().categories || []).find((item) => item.id === categoryId) || null;
    return adapters.resolveFor(url, adapterId, category);
  });

  ipcMain.handle('window:bounds', (event) => {
    const win = windowFromEvent(event);
    if (!win || win.isDestroyed()) return null;
    return win.getBounds();
  });

  ipcMain.on('window:set-bounds', (event, bounds) => {
    const win = windowFromEvent(event);
    if (!win || win.isDestroyed() || !bounds) return;
    const current = win.getBounds();
    const area = workAreaFor({ x: bounds.x ?? current.x, y: bounds.y ?? current.y });
    const next = {
      x: Math.round(Number.isFinite(bounds.x) ? bounds.x : current.x),
      y: Math.round(Number.isFinite(bounds.y) ? bounds.y : current.y),
      width: Math.round(Math.min(1600, Math.max(360, Number(bounds.width) || current.width))),
      height: Math.round(Math.min(1400, Math.max(460, Number(bounds.height) || current.height)))
    };
    if (next.width > area.width) {
      next.width = area.width;
      next.x = area.x;
    }
    if (next.height > area.height) {
      next.height = area.height;
      next.y = area.y;
    }
    win.setBounds(next, false);
  });

  ipcMain.handle('window:pin', (event, pinned) => {
    const win = windowFromEvent(event);
    if (win && win !== mainWin) {
      const next = typeof pinned === 'boolean' ? pinned : !win.isAlwaysOnTop();
      win.setAlwaysOnTop(next);
      try { event.sender.send('state:pinned', next); } catch { /* ignore */ }
      return { pinned: next };
    }
    const next = typeof pinned === 'boolean' ? pinned : !config().window.pinned;
    applyPin(next);
    return { pinned: next };
  });

  ipcMain.on('window:minimize', (event) => {
    const win = windowFromEvent(event);
    if (win && win !== mainWin) {
      win.minimize();
      return;
    }
    hideMain();
  });

  ipcMain.on('window:close', (event) => {
    const win = windowFromEvent(event);
    if (win && win !== mainWin) {
      win.close();
      return;
    }
    quitApp();
  });

  ipcMain.on('window:new', () => createExtraWindow());

  ipcMain.on('window:show', () => showMain());
  ipcMain.on('window:hide', () => hideMain());

  ipcMain.on('settings:open', () => openSettings());
  ipcMain.on('settings:close', () => closeSettings());

  ipcMain.on('tray:action', (event, action) => {
    hideTrayPanel();
    if (action === 'open') showMain();
    else if (action === 'settings') openSettings();
    else if (action === 'quit') quitApp();
  });
  ipcMain.on('tray:close', () => hideTrayPanel());
  ipcMain.on('settings:pick', (event, { siteId }) => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
      sendToShell('picker:start', { siteId });
    }
  });
  ipcMain.on('settings:pick-done', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show();
      settingsWin.focus();
    }
  });

  ipcMain.on('lightbox:open', (event, payload) => openLightbox(payload));
  ipcMain.on('lightbox:close', () => closeLightbox());
  ipcMain.on('image:context', (event, payload) => showImageContextMenu(payload));
  ipcMain.handle('image:save', (event, payload) => saveImageAs(payload?.url, payload?.name));

  ipcMain.on('tts:speak', (event, payload) => {
    if (payload && payload.text) speakWithSystem(payload.text, payload.lang);
  });

  ipcMain.on('tts:stop', () => stopTts());

  ipcMain.handle('translate:run', (event, payload) => {
    const run = translateChain.then(() => runTranslate(payload, event.sender));
    translateChain = run.catch(() => {});
    return run;
  });
  ipcMain.handle('phonetic:ipa', (event, text) => ipaFor(text));

  ipcMain.handle('local:pick', async (event, kind) => {
    if (localPickOpen) return [];
    localPickOpen = true;
    try {
      const presets = {
        image: { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'] },
        text: { name: '文本', extensions: ['txt', 'md', 'markdown', 'log', 'json', 'csv'] },
        video: { name: '视频', extensions: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'] },
        audio: { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }
      };
      const preset = presets[kind] || presets.text;
      const owner = windowFromEvent(event) || mainWin || undefined;
      const picked = await dialog.showOpenDialog(owner, {
        title: `导入本地${preset.name}`,
        properties: ['openFile'],
        filters: [
          { name: `${preset.name}文件`, extensions: preset.extensions },
          { name: '所有文件', extensions: ['*'] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return [];
      return picked.filePaths;
    } finally {
      localPickOpen = false;
    }
  });

  ipcMain.handle('local:read-text', async (event, filePath) => {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return { ok: true, name: path.basename(filePath), text: text.slice(0, 2000000) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('reader:save', async (event, payload = {}) => {
    const text = String(payload.text || '');
    if (!text) return { ok: false };
    const name = String(payload.name || '文本阅读.txt').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120);
    const target = await dialog.showSaveDialog(mainWin || undefined, {
      title: '保存文本',
      defaultPath: name,
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (target.canceled || !target.filePath) return { ok: false };
    try {
      fs.writeFileSync(target.filePath, text, 'utf8');
      return { ok: true, path: target.filePath };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.on('open:external', (event, url) => {
    const clean = sanitizeUrl(url);
    if (clean) shell.openExternal(clean);
  });

  ipcMain.on('app:open-data', () => shell.openPath(app.getPath('userData')));
  ipcMain.on('app:open-adapters', () => shell.openPath(ADAPTER_DIR));
  ipcMain.on('app:quit', () => quitApp());
  ipcMain.on('app:relaunch', () => {
    app.relaunch();
    quitApp();
  });

  ipcMain.on('picker:result', (event, payload) => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show();
      settingsWin.focus();
      settingsWin.webContents.send('picker:result', payload);
    } else {
      sendToShell('picker:result', payload);
    }
  });

  ipcMain.on('picker:cancel', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show();
      settingsWin.focus();
      settingsWin.webContents.send('picker:result', { canceled: true });
    }
  });

  ipcMain.on('app:devtools', () => {
    if (settingsWin && settingsWin.isFocused()) settingsWin.webContents.openDevTools({ mode: 'detach' });
    else mainWin?.webContents.openDevTools({ mode: 'detach' });
  });
}

function broadcastConfig(reason) {
  const payload = { config: config(), reason };
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('config:changed', payload);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('config:changed', payload);
  for (const win of extraWins) {
    if (win && !win.isDestroyed()) win.webContents.send('config:changed', payload);
  }
  applyGlassAll();
  if (tray) tray.setToolTip(config().window.pinned ? 'PANE · 已固定在桌面最上层' : 'PANE');
}

/* --------------------------------------------------------------- lifecycle */

app.setAppUserModelId('com.pane.desktop');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  DBG('whenReady');
  prepareRuntime();
  DBG('prepareRuntime done');
  store.load();
  loadIpaCache();
  DBG('store loaded');
  adapters.load(ADAPTER_DIR);
  registerIpc();
  DBG('ipc ready');
  createMainWindow();
  DBG('main window created');
  createTray();
  DBG('tray created');
  try {
    const ok = globalShortcut.register('Alt+Shift+F', () => showMain());
    DBG(`global shortcut Alt+Shift+F = ${ok}`);
  } catch (error) {
    DBG(`global shortcut error ${error.message}`);
  }

  if (process.argv.includes('--test-pin')) {
    setTimeout(async () => {
      DBG(`windows before pin: ${BrowserWindow.getAllWindows().map((win) => win.getTitle()).join(' | ')}`);
      applyPin(true, { silent: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      DBG(`after pin isAlwaysOnTop=${mainWin.isAlwaysOnTop()} windows=${BrowserWindow.getAllWindows().length}`);
      applyPin(false, { silent: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      DBG(`after unpin isAlwaysOnTop=${mainWin.isAlwaysOnTop()} windows=${BrowserWindow.getAllWindows().length}`);
      quitApp();
    }, 5000);
  }

  if (process.argv.includes('--test-tray')) {
    setTimeout(async () => {
      DBG(`tray=${Boolean(tray)} destroyed=${tray ? tray.isDestroyed() : 'n/a'}`);
      DBG('hideMain()');
      hideMain();
      await new Promise((resolve) => setTimeout(resolve, 800));
      showTrayPanel();
      await new Promise((resolve) => setTimeout(resolve, 800));
      DBG(`panel visible=${trayWin ? trayWin.isVisible() : 'null'} bounds=${trayWin ? JSON.stringify(trayWin.getBounds()) : 'n/a'}`);
      hideTrayPanel();
      showMain();
      await new Promise((resolve) => setTimeout(resolve, 800));
      DBG(`after show visible=${mainWin ? mainWin.isVisible() : 'null'} panelVisible=${trayWin ? trayWin.isVisible() : 'null'}`);
      quitApp();
    }, 5000);
  }

  if (process.argv.includes('--dump-dom')) {
    setTimeout(async () => {
      try {
        const views = webContents.getAllWebContents().filter((item) => item.getType() === 'webview');
        DBG(`dump-dom webviews=${views.length}`);
        if (views.length) {
          const html = await views[0].executeJavaScript('document.documentElement.outerHTML');
          fs.writeFileSync(path.resolve('dump-dom.html'), html, 'utf8');
          DBG(`dump-dom bytes=${html.length}`);
        }
      } catch (error) {
        DBG(`dump-dom error ${error && error.message}`);
      }
      quitApp();
    }, 14000);
  }

  if (process.argv.includes('--autotest')) {
    const argOf = (name) => {
      const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
      return found ? found.slice(name.length + 3) : null;
    };
    const fixtures = argOf('fixtures') || path.resolve('tools/fixtures');
    const outDir = argOf('shots') || path.resolve('_shots');
    mainWin.once('ready-to-show', () => {
      DBG('ready-to-show');
      // eslint-disable-next-line global-require
      require('./autotest').run({
        store,
        log: DBG,
        outDir,
        fixtures,
        webContents,
        broadcastConfig,
        openSettings,
        closeSettings,
        applyPin,
        closeLightbox,
        mainWin: () => mainWin,
        settingsWin: () => settingsWin,
        lightboxWin: () => lightboxWin,
        quit: quitApp
      }).catch((error) => DBG(`autotest 失败 ${error && error.stack ? error.stack : error}`));
    });
  }

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.on('will-download', (event, item) => {
    const name = item.getFilename();
    const target = path.join(app.getPath('downloads'), name);
    item.setSavePath(target);
    item.once('done', (e, state) => {
      if (state === 'completed' && mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('download:done', { name, path: target });
      }
    });
  });

  screen.on('display-removed', () => {
    if (mainWin && !mainWin.isDestroyed() && config().window.pinned) mainWin.moveTop();
  });
  screen.on('display-metrics-changed', () => {
    if (mainWin && !mainWin.isDestroyed() && config().window.pinned) mainWin.moveTop();
  });
});

process.on('uncaughtException', (error) => {
  DBG(`uncaught: ${error && error.stack ? error.stack : error}`);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `[${new Date().toISOString()}] ${error.stack || error}\n`);
  } catch { /* ignore */ }
});

app.on('child-process-gone', (event, details) => {
  DBG(`child-process-gone ${details.type} reason=${details.reason} exit=${details.exitCode}`);
});

app.on('render-process-gone', (event, contents, details) => {
  DBG(`render-process-gone reason=${details.reason} exit=${details.exitCode}`);
});

app.on('will-quit', () => DBG('will-quit'));
app.on('before-quit', () => DBG('before-quit'));
