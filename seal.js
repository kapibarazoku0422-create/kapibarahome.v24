/*!
 * カピバラproxy — 独自暗号化エンジン v2 (AES-256-GCM + HKDF)
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. See LICENSE. Watermark: KPBR-9f3a2c7e
 *
 * 暗号化設計:
 *  - AES-256-GCM: 認証付き暗号（改ざん検知・整合性保証）
 *  - HKDF-SHA256: 用途別に独立した派生鍵を生成（URLシール用・データ用・画像用・プロキシ用）
 *  - 決定的IV: 同一入力→同一トークン（キャッシュ可能）
 *  - 有効期限付きトークン: TTL超過を自動検知して拒否
 */
import crypto from 'node:crypto';

const SECRET = process.env.PROXY_SECRET || 'dev-insecure-key';

// HKDF-SHA256 で用途別派生鍵を生成（32 byte = AES-256）
function deriveKey(purpose) {
  const prk = crypto.createHash('sha256').update('kapibara-v2:' + purpose + ':' + SECRET).digest();
  return crypto.createHmac('sha256', prk).update('kpbr-expand-' + purpose).digest();
}

const KEYS = {
  url:   deriveKey('url-seal-v2'),
  data:  deriveKey('data-seal-v2'),
  img:   deriveKey('img-proxy-v2'),
  proxy: deriveKey('url-proxy-v2'),
};

// 決定的IV: HMAC(key, payload) の先頭12byte
function deterministicIV(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest().subarray(0, 12);
}

// ランダムIV（有効期限付きトークンで使用）
function randomIV() {
  return crypto.randomBytes(12);
}

// ─────────────────────────────────────────────────────────
// 基本シール/アンシール（動画URLトークン用・後方互換維持）
// ─────────────────────────────────────────────────────────
// token = iv(12) | tag(16) | ciphertext
export function seal(url) {
  const key = KEYS.url;
  const iv = deterministicIV(key, url);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(url, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function unseal(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 28) throw new Error('bad token');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS.url, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────
// 画像URLシール（/img/<token> 用、決定的IV）
// ─────────────────────────────────────────────────────────
export function sealImg(url) {
  const key = KEYS.img;
  const iv = deterministicIV(key, url);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(url, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function unsealImg(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 28) throw new Error('bad img token');
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS.img, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────
// 汎用URLプロキシシール（/proxy/<token> 用）
// ─────────────────────────────────────────────────────────
export function sealProxy(url) {
  const key = KEYS.proxy;
  const iv = deterministicIV(key, url);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(url, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function unsealProxy(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 28) throw new Error('bad proxy token');
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS.proxy, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────
// データ暗号化（APIレスポンスの暗号化ラッパー用）
// ランダムIV使用（同一データでも毎回異なるトークン）
// ─────────────────────────────────────────────────────────
// token = iv(12) | tag(16) | ciphertext
export function sealData(obj) {
  const key = KEYS.data;
  const plain = JSON.stringify(obj);
  const iv = randomIV();
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function unsealData(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 28) throw new Error('bad data token');
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS.data, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  return JSON.parse(plain);
}

// ─────────────────────────────────────────────────────────
// 有効期限付きURLシール（sealEx/unsealEx）
// ─────────────────────────────────────────────────────────
// ペイロード: JSON { u: url, exp: unixMs }
// token = iv(12) | tag(16) | ciphertext
export function sealEx(url, ttlMs) {
  const key = KEYS.url;
  const payload = JSON.stringify({ u: url, exp: Date.now() + (ttlMs || 3 * 3600 * 1000) });
  const iv = randomIV();
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

export function unsealEx(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 28) throw new Error('bad token');
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS.url, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const obj = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  if (obj.exp && Date.now() > obj.exp) throw new Error('token expired');
  return obj.u;
}
