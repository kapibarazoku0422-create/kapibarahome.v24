/*!
 * カピバラproxy — build: client.src.js を難読化して dist/client.js を生成
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, 'client.src.js'), 'utf8');

const result = await minify(src, {
  compress: { passes: 3, drop_console: true, booleans_as_integers: true },
  mangle: { toplevel: true },          // 変数名を潰す
  format: { comments: /^!/ },          // 著作権ヘッダ(/*! */)だけ残す
});

if (result.error) { console.error(result.error); process.exit(1); }

const banner = '/*! カピバラproxy (c) 2026 kapibarazoku0422. All Rights Reserved. KPBR-9f3a2c7e */';
const out = `${banner}\nexport const CLIENT_SCRIPT = ${JSON.stringify(result.code)};\n`;

fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist', 'client.js'), out);
console.log(`built dist/client.js (${result.code.length} bytes, minified+mangled)`);
