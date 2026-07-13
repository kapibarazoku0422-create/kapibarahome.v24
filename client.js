/*!
 * カピバラproxy — client script loader
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. See LICENSE. Watermark: KPBR-9f3a2c7e
 *
 * 本番(build後): dist/client.js の難読化済みスクリプトを使用。
 * 開発(build前):  client.src.js の生ソースをそのまま使用（npm run build 不要で動く）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let script;
try {
  // ビルド済みの難読化版を優先
  ({ CLIENT_SCRIPT: script } = await import('./dist/client.js'));
} catch {
  // フォールバック: 生ソース（先頭の著作権コメントは付いたまま）
  script = fs.readFileSync(path.join(dir, 'client.src.js'), 'utf8');
}

export const CLIENT_SCRIPT = script;
