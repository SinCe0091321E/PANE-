'use strict';

/**
 * 极简 asar 打包器（零依赖）。
 * asar 结构： [uint32 4][uint32 headerBufLen][uint32 headerPayloadLen][uint32 jsonLen][json][files...]
 * json 用空格补齐到 4 字节，保证文件数据紧跟在 header 之后。
 */

const fs = require('node:fs');
const path = require('node:path');

function walk(dir, prefix = '', files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel, files);
    } else if (entry.isFile()) {
      files.push({ rel, full, size: fs.statSync(full).size });
    }
  }
  return files;
}

function buildTree(files) {
  const root = { files: {} };
  let offset = 0;
  for (const file of files) {
    const parts = file.rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!node.files[part]) node.files[part] = { files: {} };
      node = node.files[part];
    }
    node.files[parts[parts.length - 1]] = { size: file.size, offset: String(offset) };
    file.offset = offset;
    offset += file.size;
  }
  return { tree: root, total: offset };
}

function pack(srcDir, outFile) {
  const files = walk(srcDir);
  const { tree, total } = buildTree(files);

  let headerString = JSON.stringify(tree);
  while (headerString.length % 4 !== 0) headerString += ' ';
  const headerBuf = Buffer.from(headerString, 'utf8');

  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  // sizePickle 里写的是 headerBuf 的总长度：8 字节 pickle 头 + JSON
  head.writeUInt32LE(8 + headerBuf.length, 4);
  // headerBuf 的 payload 长度：4 字节字符串长度 + JSON
  head.writeUInt32LE(4 + headerBuf.length, 8);
  head.writeUInt32LE(headerBuf.length, 12);

  const out = fs.openSync(outFile, 'w');
  try {
    fs.writeSync(out, head);
    fs.writeSync(out, headerBuf);
    for (const file of files) {
      const data = fs.readFileSync(file.full);
      if (data.length !== file.size) throw new Error(`文件在打包过程中被修改：${file.rel}`);
      fs.writeSync(out, data);
    }
  } finally {
    fs.closeSync(out);
  }

  return { files: files.length, bytes: total, headerBytes: headerBuf.length, outFile };
}

module.exports = { pack };

if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('用法: node asar-pack.js <源目录> <输出 app.asar>');
    process.exit(1);
  }
  const result = pack(src, out);
  console.log(`已打包 ${result.files} 个文件 → ${result.outFile}（${(result.bytes / 1024).toFixed(1)} KB）`);
}
