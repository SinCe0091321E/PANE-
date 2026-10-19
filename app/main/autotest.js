'use strict';

/**
 * 开发期自检：启动后自动走一遍主要界面并截图，便于在没有人工点击的情况下核对。
 * 只在 `--autotest` 时被 main.js 调用。
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(ctx) {
  const outDir = ctx.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const shot = async (getWin, name) => {
    const win = typeof getWin === 'function' ? getWin() : getWin;
    if (!win || win.isDestroyed()) return false;
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
      return true;
    } catch (error) {
      ctx.log(`截图失败 ${name}: ${error.message}`);
      return false;
    }
  };

  const views = () => ctx.webContents.getAllWebContents().filter((item) => item.getType() === 'webview');
  const execView = async (code) => {
    const list = views();
    if (!list.length) return null;
    try {
      return await list[list.length - 1].executeJavaScript(code);
    } catch (error) {
      ctx.log(`页面执行失败: ${error.message}`);
      return null;
    }
  };
  const execShell = async (code) => {
    const win = ctx.mainWin();
    if (!win || win.isDestroyed()) return null;
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (error) {
      ctx.log(`外壳执行失败: ${error.message}`);
      return null;
    }
  };
  const execSettings = async (code) => {
    const win = ctx.settingsWin();
    if (!win || win.isDestroyed()) return null;
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (error) {
      ctx.log(`设置窗口执行失败: ${error.message}`);
      return null;
    }
  };

  const theme = async (mode) => {
    ctx.store.set({ theme: { mode } });
    ctx.broadcastConfig('apply');
    await wait(700);
  };

  try {
    ctx.log('autotest 开始');
    await wait(1200);

    const fixture = (name) => pathToFileURL(path.join(ctx.fixtures, name)).href;
    ctx.store.set({
      sites: [
        {
          id: 'demo-translate', name: '演示 · 百度翻译', url: fixture('translate.html'), adapter: 'baidu-fanyi',
          enabled: true, overrides: { hide: [], selectors: {}, css: '', js: '' }
        },
        {
          id: 'demo-gallery', name: '演示 · 花瓣', url: fixture('gallery.html'), adapter: 'huaban',
          enabled: true, overrides: { hide: [], selectors: {}, css: '', js: '' }
        }
      ],
      activeSiteId: 'demo-translate',
      theme: { mode: 'light' }
    });
    ctx.broadcastConfig('apply');
    await wait(2800);
    await shot(ctx.mainWin, '01-translate-light');

    await execView(`
      const box = document.querySelector('#srcText');
      box.value = '悬浮窗可以把网站留在桌面上。';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      'ok'
    `);
    await wait(500);
    await shot(ctx.mainWin, '02-translate-filled');

    await theme('dark');
    await shot(ctx.mainWin, '03-translate-dark');

    await theme('paper');
    await shot(ctx.mainWin, '04-translate-paper');

    ctx.openSettings();
    await wait(2000);
    await shot(ctx.settingsWin, '05-settings-sites');

    await execSettings(`
      document.querySelector('#cat-name').value = '视频';
      document.querySelector('#cat-mode').value = 'generic';
      document.querySelector('#cat-add-btn').click();
      'ok'
    `);
    await wait(700);
    await shot(ctx.settingsWin, '05b-settings-category');

    await execSettings(`document.querySelector('#add-site').click()`);
    await wait(600);
    await shot(ctx.settingsWin, '06-settings-editor');
    await execSettings(`document.querySelector('#editor-cancel').click()`);

    await execSettings(`document.querySelector('.nav-item[data-page="theme"]').click()`);
    await wait(600);
    await shot(ctx.settingsWin, '07-settings-theme');

    await execSettings(`document.querySelectorAll('.theme-tile')[1].click()`);
    await wait(700);
    await shot(ctx.settingsWin, '08-settings-theme-dark');

    await execSettings(`document.querySelectorAll('.theme-tile')[3].click()`);
    await wait(700);
    await execSettings(`document.querySelector('.nav-item[data-page="look"]').click()`);
    await wait(500);
    await shot(ctx.settingsWin, '09-settings-look');

    await execSettings(`document.querySelector('.nav-item[data-page="about"]').click()`);
    await wait(500);
    await shot(ctx.settingsWin, '10-settings-about');

    await theme('light');
    ctx.closeSettings();
    await wait(800);

    ctx.store.set({ activeSiteId: 'demo-gallery' });
    ctx.broadcastConfig('apply');
    await wait(3200);
    await shot(ctx.mainWin, '11-gallery');

    await execShell(`document.querySelector('.rail-btn[data-act="tool:search"]').click()`);
    await wait(500);
    await shot(ctx.mainWin, '12-search-popover');
    await execShell(`document.querySelector('.rail-btn[data-act="tool:search"]').click()`);

    await execShell(`document.querySelector('.rail-btn[data-act="site"]').click()`);
    await wait(500);
    await shot(ctx.mainWin, '13-site-popover');
    await execShell(`document.querySelector('.rail-btn[data-act="site"]').click()`);

    await execShell(`document.querySelector('.rail-btn[data-act="move"]').click()`);
    await wait(500);
    await shot(ctx.mainWin, '14-move-mode');
    await execShell(`document.querySelector('.rail-btn[data-act="move"]').click()`);

    await execView(`document.querySelector('img').click(); 'ok'`);
    await wait(1600);
    await shot(ctx.mainWin, '15-preview');

    await execShell(`document.querySelector('#preview [data-pv="system"]').click()`);
    await wait(1600);
    await shot(ctx.lightboxWin, '16-system-fullscreen');
    ctx.closeLightbox();
    await wait(500);
    await execShell(`document.querySelector('#preview [data-pv="close"]').click()`);
    await wait(400);

    ctx.applyPin(true);
    await wait(1000);
    await shot(ctx.mainWin, '17-pinned');
    ctx.applyPin(false);
    await wait(400);

    ctx.log('autotest 结束');
  } catch (error) {
    ctx.log(`autotest 失败 ${error && error.stack ? error.stack : error}`);
  } finally {
    await wait(300);
    ctx.quit();
  }
}

module.exports = { run };
