/*!
 * カピバラproxy — ヘッダ/Cookie 正規化 & SSRF/charset 処理
 * Copyright (c) 2026 kapibarazoku0022. All Rights Reserved.
 * Proprietary and confidential. Unauthorized copying, modification, or use prohibited.
 * See LICENSE. Watermark: KPBR-9f3a2c7e
 */
import dns from 'node:dns/promises';
import netmod from 'node:net';
import { decodeProxyUrl, PREFIX } from './rewrite.js';

// --- SSRF対策: プライベート/ループバック/リンクローカル宛を拒否 -----------
function ipToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
}
function isPrivateV4(ip) {
  const n = ipToInt(ip);
  const inR = (base, bits) => (n >>> (32 - bits)) === (ipToInt(base) >>> (32 - bits));
  return inR('10.0.0.0', 8) || inR('172.16.0.0', 12) || inR('192.168.0.0', 16) ||
         inR('127.0.0.0', 8) || inR('169.254.0.0', 16) || inR('0.0.0.0', 8) ||
         inR('100.64.0.0', 10) || inR('192.0.0.0', 24) || inR('255.255.255.255', 32);
}
function isPrivateV6(ip) {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
  const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateV4(m[1]);
  return false;
}
function isBlockedIP(ip) {
  const t = netmod.isIP(ip);
  if (t === 4) return isPrivateV4(ip);
  if (t === 6) return isPrivateV6(ip);
  return true;
}

// --- DNS キャッシュ（同一ホストへの繰り返しルックアップを排除）----------
const DNS_CACHE = new Map();
const DNS_TTL   = 30_000; // 30s（短めにしてDNSリバインディングリスクを抑制）
const DNS_MAX   = 2_000;

function dnsCacheGet(host) {
  const e = DNS_CACHE.get(host);
  if (!e) return undefined;
  if (Date.now() - e.t > DNS_TTL) { DNS_CACHE.delete(host); return undefined; }
  return e;
}
function dnsCacheSet(host, entry) {
  if (DNS_CACHE.size >= DNS_MAX) DNS_CACHE.delete(DNS_CACHE.keys().next().value);
  DNS_CACHE.set(host, { ...entry, t: Date.now() });
}

// 対象ホストが公開アドレスに解決できるか検証
export async function assertPublicHost(host) {
  // IP リテラルはキャッシュ不要、そのまま判定
  if (netmod.isIP(host)) {
    if (isBlockedIP(host)) throw new Error('blocked address');
    return;
  }

  // キャッシュヒット
  const cached = dnsCacheGet(host);
  if (cached !== undefined) {
    if (cached.blocked) throw new Error('blocked address');
    return;
  }

  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error('dns resolution failed'); }
  if (!addrs.length) throw new Error('no address');

  const blocked = addrs.some(({ address }) => isBlockedIP(address));
  dnsCacheSet(host, { blocked });
  if (blocked) throw new Error('blocked address');
}

// --- 文字コード判定とデコード（Shift_JIS/EUC-JP等の日本語サイト対応）---
export function decodeBody(buf, ctype) {
  let cs = (/charset=["']?\s*([\w-]+)/i.exec(ctype || '') || [])[1];
  if (!cs) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const m = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head) ||
              /charset=["']?\s*([\w-]+)/i.exec(head);
    if (m) cs = m[1];
  }
  cs = (cs || 'utf-8').trim().toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return buf.toString('utf-8');
  }
  try { return new TextDecoder(cs).decode(buf); }
  catch { return buf.toString('utf-8'); }
}

// --- Accept-Encoding: クライアントを尊重しつつ復号可能なものに限定 -------
const DECODABLE = ['gzip', 'deflate', 'br'];
export function safeAcceptEncoding(clientAE) {
  if (!clientAE) return 'gzip, deflate, br';
  const parts = clientAE.split(',')
    .map(s => s.trim().split(';')[0].toLowerCase())
    .filter(x => DECODABLE.includes(x));
  return parts.length ? parts.join(', ') : 'gzip, deflate, br';
}

// --- Referer / Origin: 元サイト基準に復元 --------------------------------
export function deriveRefererOrigin(headers, targetUrl) {
  const out = {};
  const r = headers['referer'];
  if (r) {
    const i = r.indexOf(PREFIX);
    if (i !== -1) {
      try { out.referer = decodeProxyUrl(r.slice(i + PREFIX.length)); } catch {}
    }
  }
  if (headers['origin'] !== undefined) {
    out.origin = out.referer ? new URL(out.referer).origin : targetUrl.origin;
  }
  return out;
}

// --- Cookie のサイト別名前空間化 -----------------------------------------
function hostKey(host) {
  return 'cp_' + Buffer.from(host, 'utf8').toString('base64url') + '_';
}

export function namespaceSetCookies(setCookies, host) {
  const pfx = hostKey(host);
  const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
  return arr.map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return c;
    const name = c.slice(0, eq).trim();
    const rest = c.slice(eq);
    let out = pfx + name + rest;
    out = out.replace(/;\s*domain=[^;]+/ig, '')
             .replace(/;\s*samesite=[^;]+/ig, '')
             .replace(/;\s*secure/ig, '')
             .replace(/;\s*path=[^;]+/ig, '');
    out += '; Path=/; SameSite=Lax';
    return out;
  });
}

export function upstreamCookie(cookieHeader, host) {
  if (!cookieHeader) return null;
  const pfx = hostKey(host);
  const out = [];
  for (const part of cookieHeader.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const name = eq === -1 ? s : s.slice(0, eq);
    if (name.startsWith(pfx)) {
      const realName = name.slice(pfx.length);
      out.push(eq === -1 ? realName : realName + s.slice(eq));
    }
  }
  return out.length ? out.join('; ') : null;
}
