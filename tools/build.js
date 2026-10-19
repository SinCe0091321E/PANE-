'use strict';

/**
 * 构建：把 app/ 打包成 runtime/resources/app.asar，然后（可选）启动。
 *   node tools/build.js            仅打包
 *   node tools/build.js --run      打包并启动
 *   node tools/build.js --watch    监听源码变化自动重打包（不启动）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pack } = require('./asar-pack');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'app');
const RESOURCES = path.join(ROOT, 'runtime', 'resources');
const OUT = path.join(RESOURCES, 'app.asar');
const FILES = path.join(RESOURCES, 'app-files');
const APP_DIR = path.join(RESOURCES, 'app');
const EXE = path.join(ROOT, 'runtime', 'FloatingDock.exe');

function build() {
  fs.mkdirSync(RESOURCES, { recursive: true });
  // 旧的解包目录会让加载路径变得不确定，直接移除
  try {
    const stat = fs.lstatSync(APP_DIR);
    if (stat.isSymbolicLink() || stat.isDirectory()) fs.unlinkSync(APP_DIR);
  } catch { /* 不存在 */ }

  const started = Date.now();
  const result = pack(SRC, OUT);
  // 额外放一份真实文件：主进程读 preload / 渲染页面时更稳，也方便排查
  fs.rmSync(FILES, { recursive: true, force: true });
  fs.cpSync(SRC, FILES, { recursive: true });
  console.log(`[build] ${new Date().toLocaleTimeString()} 打包 ${result.files} 个文件，` +
    `${(result.bytes / 1024).toFixed(1)} KB，用时 ${Date.now() - started} ms → ${OUT}`);
  return result;
}

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [], { detached: true, stdio: 'ignore', env });
  child.unref();
  console.log('[run] 已启动 PANE');
}

function watch() {
  build();
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { build(); } catch (error) { console.error('[watch] 打包失败：', error.message); }
    }, 180);
  };
  for (const dir of [SRC]) {
    fs.watch(dir, { recursive: true }, rebuild);
  }
  console.log('[watch] 监听 app/ 变化，Ctrl+C 退出');
}

const args = process.argv.slice(2);
if (args.includes('--watch')) watch();
else build();
if (args.includes('--run')) launch();
