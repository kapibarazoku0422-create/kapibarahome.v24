/*!
 * カピバラproxy — URL書き換えロジック
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. Unauthorized copying, modification, or use prohibited.
 * See LICENSE. Watermark: KPBR-9f3a2c7e
 */
import { seal, unseal } from './seal.js';

export const PREFIX = '/p/';

// 絶対URL -> プロキシURL（AES-256-GCMで封印。鍵はサーバのみ）
export function encodeProxyUrl(absUrl) {
  return PREFIX + seal(absUrl);
}

// プロキシのパスセグメント -> 元の絶対URL（改ざん時は例外）
export function decodeProxyUrl(seg) {
  // クエリやハッシュが付いていても落とす（基本付かない想定）
  const q = seg.search(/[?#]/);
  const clean = q === -1 ? seg : seg.slice(0, q);
  return unseal(clean);
}

// 書き換え不要スキームの先頭1文字での粗フィルタ用
const SKIP_RE = /^(?:data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

// 相対/絶対URLを base で解決し、プロキシ経由URLに変換（cacheでメモ化）
function toProxy(u, base, cache) {
  if (!u) return u;
  // 同一ページ内の重複URLはキャッシュ命中で URL/Buffer 処理を丸ごとスキップ
  const cached = cache.get(u);
  if (cached !== undefined) return cached;

  let out = u;
  const s = u.trim();
  if (s !== '' && !SKIP_RE.test(s) && !s.startsWith(PREFIX)) {
    try {
      out = encodeProxyUrl(new URL(s, base).href);
    } catch { out = 'about:blank'; }
  }
  cache.set(u, out);
  return out;
}

// srcset (a.jpg 1x, b.jpg 2x) を変換
function rewriteSrcset(val, base, cache) {
  return val.split(',').map(part => {
    const m = part.trim().match(/^(\S+)(\s+.+)?$/);
    if (!m) return part;
    return toProxy(m[1], base, cache) + (m[2] || '');
  }).join(', ');
}

// 属性ごとの正規表現を一度だけコンパイル（毎ページの new RegExp を排除）
const URL_ATTRS = ['href', 'src', 'poster', 'action', 'formaction', 'data-src', 'data-href', 'data-url', 'background'];
const ATTR_RE = URL_ATTRS.map(attr =>
  new RegExp(`(<[^>]+\\b${attr}\\s*=\\s*)(["'])(.*?)\\2`, 'ig'));
const SRCSET_RE = /(<[^>]+\bsrcset\s*=\s*)(["'])(.*?)\2/ig;
const META_REFRESH_RE = /(<meta[^>]+content\s*=\s*)(["'])(\s*\d+\s*;\s*url=)([^"']+)\2/ig;
const STYLE_ATTR_RE = /(\bstyle\s*=\s*)(["'])(.*?)\2/ig;
const STYLE_BLOCK_RE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/ig;
const CSP_META_RE = /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/ig;
const INTEGRITY_RE = /\sintegrity=(["'])[^"']*\1/ig;
const NONCE_RE = /\snonce=(["'])[^"']*\1/ig;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/ig;
const CSS_IMPORT_RE = /@import\s+(["'])([^"']+)\1/ig;

const BASE_TAG_RE = /<base\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/i;
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*[\w-]+["']?[^>]*>/ig;
const META_HTTP_CT_RE = /<meta[^>]+http-equiv=["']?content-type["']?[^>]*>/ig;

export function rewriteHtml(html, base) {
  const cache = new Map(); // ページ内メモ化

  // <base href> があれば相対URL解決の基準にし、タグ自体は除去（プロキシ下で誤動作するため）
  const bm = BASE_TAG_RE.exec(html);
  if (bm) {
    try { base = new URL(bm[2], base).href; } catch {}
    html = html.replace(BASE_TAG_RE, '');
  }

  // 文字コードは常にutf-8で出力するので meta の宣言もutf-8へ統一
  html = html.replace(META_HTTP_CT_RE, '');
  html = html.replace(META_CHARSET_RE, '<meta charset="utf-8">');

  // CSP / SRI を無効化
  html = html.replace(CSP_META_RE, '');
  html = html.replace(INTEGRITY_RE, '');
  html = html.replace(NONCE_RE, '');

  // 各URL属性
  for (const re of ATTR_RE) {
    html = html.replace(re, (m, pre, q, val) => pre + q + toProxy(val, base, cache) + q);
  }

  html = html.replace(SRCSET_RE, (m, pre, q, val) => pre + q + rewriteSrcset(val, base, cache) + q);
  html = html.replace(META_REFRESH_RE, (m, pre, q, head, u) => pre + q + head + toProxy(u, base, cache) + q);
  html = html.replace(STYLE_ATTR_RE, (m, pre, q, val) => pre + q + rewriteCssWith(val, base, cache) + q);
  html = html.replace(STYLE_BLOCK_RE, (m, open, css, close) => open + rewriteCssWith(css, base, cache) + close);

  // クライアント傍受スクリプトを注入
  const inject = `<script src="/__proxy__/client.js" data-base-token="${seal(base)}"></script>`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, m => m + inject);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, m => m + inject);
  } else {
    html = inject + html;
  }
  return html;
}

function rewriteCssWith(css, base, cache) {
  css = css.replace(CSS_URL_RE, (m, q, u) => `url(${q}${toProxy(u, base, cache)}${q})`);
  css = css.replace(CSS_IMPORT_RE, (m, q, u) => `@import ${q}${toProxy(u, base, cache)}${q}`);
  return css;
}

export function rewriteCss(css, base) {
  return rewriteCssWith(css, base, new Map());
}
