/*!
 * カピバラproxy — URL書き換え型 web proxy
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. Unauthorized copying, modification, or use prohibited.
 * See LICENSE. Watermark: KPBR-9f3a2c7e
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { spawn, execSync, spawnSync } from 'node:child_process';
import { request, Agent, setGlobalDispatcher } from 'undici';
import pg from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import { rewriteHtml, rewriteCss, encodeProxyUrl, decodeProxyUrl, PREFIX } from './rewrite.js';
import { safeAcceptEncoding, deriveRefererOrigin, namespaceSetCookies, upstreamCookie, assertPublicHost, decodeBody } from './net.js';
import { seal, unseal, sealImg, unsealImg, sealProxy, unsealProxy, sealData, sealEx } from './seal.js';
import { CLIENT_SCRIPT } from './client.js';
import { makeHomePage } from './home.js';

const MAX_BODY = 25 * 1024 * 1024; // リクエストボディ上限 25MB
const PORT = process.env.PORT || 8080;

// --- 起動ゲート: 秘密の環境変数が無ければ起動拒否 ----------------------
if (!process.env.PROXY_SECRET) {
  console.error('\n  [起動拒否] 環境変数 PROXY_SECRET が未設定です。');
  console.error('  例: PROXY_SECRET=your-long-secret npm start\n');
  process.exit(1);
}
// 短い場合は固定サフィックスで補完して最低8文字を確保
if (process.env.PROXY_SECRET.length < 8) {
  process.env.PROXY_SECRET = process.env.PROXY_SECRET + '-kapibara-proxy-secret-padding';
}

// --- undici グローバル Agent: コネクションプールで keep-alive 再利用 ----
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 20_000,
  keepAliveMaxTimeout: 60_000,
  connections: 256,
  pipelining: 1,
}));

// --- PostgreSQL ランキング DB ---
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});
pool.query(`CREATE TABLE IF NOT EXISTS rankings (
  id SERIAL PRIMARY KEY,
  name VARCHAR(20) NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  gold INTEGER NOT NULL DEFAULT 0,
  kill_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(e => console.error('[DB] ランキングテーブル初期化エラー:', e.message));

// イベント状態（期間限定ステージ / 経験値イベント）— 全端末で共有する設定を 1行で保持
pool.query(`CREATE TABLE IF NOT EXISTS event_state (
  id INTEGER PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
)`).then(() => pool.query(
  `INSERT INTO event_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
  [JSON.stringify({ stage: { active: false }, xp: { mult: 1, until: 0 } })]
)).catch(e => console.error('[DB] イベントテーブル初期化エラー:', e.message));

// プレイヤー遠隔指令（管理者がランキング名で指定 → 対象端末がポーリングで受け取り適用）
pool.query(`CREATE TABLE IF NOT EXISTS player_commands (
  name TEXT PRIMARY KEY,
  cmd JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
)`).catch(e => console.error('[DB] 指令テーブル初期化エラー:', e.message));

// --- Google Classroom 認証セッション DB ---
pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  google_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  is_teacher BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
)`).then(() =>
  pool.query(`ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS is_teacher BOOLEAN NOT NULL DEFAULT FALSE`)
).catch(e => console.error('[DB] auth_sessions初期化エラー:', e.message));
// 期限切れセッションを1時間ごとに削除
setInterval(() => {
  pool.query("DELETE FROM auth_sessions WHERE expires_at < NOW()").catch(() => {});
}, 3_600_000);

// --- Google OAuth2 / Classroom 設定 ---
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// 確認するClassroomのクラスID（Base64デコード: 868294163023）
const CLASSROOM_CLASS_ID   = process.env.CLASSROOM_CLASS_ID || '868294163023';
// 認証なしでアクセスできるパスのプレフィックス（静的ファイルなど）
const AUTH_BYPASS = ['/auth/', '/assets/', '/monaco-min/', '/favicon.ico', '/apple-touch-icon', '/manifest'];

function getOAuthBase(req) {
  // Render/Replitなどのリバースプロキシが通知する公開URLを優先する。
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || '';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0].trim().toLowerCase();
  const isHostedHttps = host.includes('kapibarahome.com') ||
    host.includes('replit.app') || host.includes('onrender.com');
  const protocol = forwardedProto === 'https' || isHostedHttps ? 'https' : 'http';
  return `${protocol}://${host}`;
}

async function getAuthSession(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const m = cookieHeader.match(/(?:^|;\s*)kp_session=([^;]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  try {
    const r = await pool.query(
      'SELECT * FROM auth_sessions WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    return r.rows[0] || null;
  } catch { return null; }
}

async function checkClassroomMembership(accessToken) {
  // 成功/失敗を区別するため { ok, courses } を返す
  async function fetchCourses(query) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await request(
          `https://classroom.googleapis.com/v1/courses?${query}&pageSize=50`,
          { headers: { 'Authorization': 'Bearer ' + accessToken }, headersTimeout: 8000, bodyTimeout: 10000 }
        );
        const buf = [];
        for await (const chunk of r.body) buf.push(chunk);
        const text = Buffer.concat(buf).toString();
        if (r.statusCode !== 200) {
          console.warn('[auth] Classroom API non-200:', r.statusCode, text.slice(0, 100));
          if (attempt === 0) { await new Promise(r => setTimeout(r, 800)); continue; }
          return { ok: false, courses: [] };
        }
        return { ok: true, courses: JSON.parse(text).courses || [] };
      } catch (e) {
        console.warn('[auth] Classroom API error:', e.message);
        if (attempt === 0) { await new Promise(r => setTimeout(r, 800)); continue; }
        return { ok: false, courses: [] };
      }
    }
    return { ok: false, courses: [] };
  }
  const [resStudent, resTeacher] = await Promise.all([
    fetchCourses('studentId=me'),
    fetchCourses('teacherId=me'),
  ]);
  // 両方のAPI呼び出しが失敗した場合は「不明」として扱う（メンバー外と断定しない）
  const apiOk = resStudent.ok || resTeacher.ok;
  const all = [...resStudent.courses, ...resTeacher.courses];
  console.log('[auth] Classroom API ok:', apiOk, 'courses found:', all.map(c => c.id + '(' + c.name + ')').join(', ') || '(none)');
  const isMember = apiOk ? all.some(c => c.id === CLASSROOM_CLASS_ID) : null; // nullはAPI失敗
  const isTeacher = resTeacher.courses.some(c => c.id === CLASSROOM_CLASS_ID);
  return { isMember, isTeacher };
}

// ─── HLS セグメント配信（ISGC対策: 大きなストリームを小さなセグメントに分割） ─────────
// ffmpeg で mp4→HLS に変換し、4秒×Nセグメントとして配信する。
// ISGC は各リクエストが小さく短時間で完了するため動画ストリームと判定しにくい。
const HLS_BASE = path.join(os.tmpdir(), 'kphls');
try { fs.rmSync(HLS_BASE, { recursive: true, force: true }); } catch {}
fs.mkdirSync(HLS_BASE, { recursive: true });
const hlsSessions = new Map(); // token → { dir, done, failed }

// ffmpegのパスを解決（本番環境でPATHに無い場合もNixストアから探す）
let FFMPEG_BIN = null;
try {
  FFMPEG_BIN = execSync('which ffmpeg 2>/dev/null').toString().trim() || null;
} catch {}
if (!FFMPEG_BIN) {
  // Nix ストアの既知パスを試す
  for (const p of [
    '/nix/store/pw6ics1b6b6kkfwnspggdlgwi636sn2p-replit-runtime-path/bin/ffmpeg',
    '/run/current-system/sw/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]) {
    if (fs.existsSync(p)) { FFMPEG_BIN = p; break; }
  }
}
console.log('[hls] ffmpeg:', FFMPEG_BIN || 'NOT FOUND — HLS disabled');

async function ensureHlsSession(token, streamUrl, audioUrl = null, audioToken = null) {
  if (hlsSessions.has(token)) return hlsSessions.get(token);
  if (!FFMPEG_BIN) throw new Error('ffmpeg not available');
  const id = 'h' + token.slice(0, 18).replace(/[^a-zA-Z0-9]/g, '_');
  const dir = path.join(HLS_BASE, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = { dir, done: false, failed: false };
  hlsSessions.set(token, session);
  // ffmpegは自サーバーの /s/ プロキシ経由でストリームを取得する。
  // Invidiousに直接アクセスするとISGCフィルタや403で失敗するため、
  // localhost経由にすることでフィルタをバイパスしつつサーバー側でプロキシする。
  const localStream = `http://127.0.0.1:5000/s/${token}`;
  const localAudio = audioToken ? `http://127.0.0.1:5000/s/${audioToken}` : null;
  // 映像+音声が別ストリームの場合（adaptiveFormats）: ffmpegで同時入力してmux
  const ffArgs = [
    '-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', localStream,
  ];
  if (localAudio) {
    ffArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', localAudio);
  }
  ffArgs.push('-c', 'copy', '-f', 'hls', '-hls_time', '4',
    '-hls_list_size', '0', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, '%d.ts'),
    path.join(dir, 'p.m3u8'));
  const proc = spawn(FFMPEG_BIN, ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', d => console.log('[hls]', d.toString().trimEnd()));
  proc.on('error', err => {
    session.done = true; session.failed = true;
    console.error('[hls] spawn error:', err.message);
  });
  proc.on('exit', code => { session.done = true; console.log('[hls] exit code=' + code + ' id=' + id); });
  // 15分後に強制終了
  setTimeout(() => { try { proc.kill(); } catch {} }, 900_000);
  return session;
}

async function hlsWaitFile(filePath, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(filePath)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// 期限切れの設定を 落としてから返す
function normalizeEventState(data) {
  const now = Date.now();
  const out = {
    stage: (data && data.stage) ? data.stage : { active: false },
    xp: (data && data.xp) ? data.xp : { mult: 1, until: 0 },
  };
  if (out.stage.active && out.stage.until && out.stage.until < now) out.stage = { active: false };
  if (out.xp.mult > 1 && out.xp.until && out.xp.until < now) out.xp = { mult: 1, until: 0 };
  return out;
}
async function readEventState() {
  try {
    const r = await pool.query('SELECT data FROM event_state WHERE id=1');
    return normalizeEventState(r.rows[0] ? r.rows[0].data : null);
  } catch {
    return { stage: { active: false }, xp: { mult: 1, until: 0 } };
  }
}
async function writeEventState(state) {
  await pool.query(
    `INSERT INTO event_state (id, data, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=NOW()`,
    [JSON.stringify(state)]
  );
}

// --- 非同期圧縮（イベントループをブロックしない） ----------------------
const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress   = promisify(zlib.gzip);

async function sendBody(req, res, status, headers, buf) {
  const ae = (req.headers['accept-encoding'] || '').toLowerCase();
  const out = { ...headers };
  let body = buf;
  if (buf.length > 512 && ae.includes('br')) {
    body = await brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3 } });
    out['content-encoding'] = 'br';
  } else if (buf.length > 512 && ae.includes('gzip')) {
    body = await gzipCompress(buf, { level: 4 });
    out['content-encoding'] = 'gzip';
  }
  out['content-length'] = body.length;
  out['vary'] = 'Accept-Encoding';
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : body);
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dir, 'assets');

// --- アセットをメモリにプリキャッシュ（ディスク I/O を起動時1回に集約）---
const ASSET_CACHE = new Map();
const MIME = {
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
};
try {
  for (const f of fs.readdirSync(ASSET_DIR)) {
    const ext = path.extname(f).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    ASSET_CACHE.set(f, { data: fs.readFileSync(path.join(ASSET_DIR, f)), ct });
  }
} catch { /* アセットディレクトリが無くても起動は続行 */ }

function serveAsset(res, name) {
  const entry = ASSET_CACHE.get(path.basename(name));
  if (!entry) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {
    'content-type': entry.ct,
    'cache-control': 'public, max-age=86400',
  });
  res.end(entry.data);
}

// ホームページHTML（起動時に一度だけ生成。seal()をリクエストごとに呼ばない）
const HOME_HTML = makeHomePage(encodeProxyUrl);

// PWA マニフェスト
const MANIFEST = JSON.stringify({
  name: 'カピバラの学習サイト',
  short_name: 'カピバラの学習サイト',
  description: 'のんびり最強の web proxy',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#0f172a',
  icons: [
    { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

// --- メモリキャッシュ（HTML/CSS/静的リソース高速化）-------------------
const CACHE = new Map();
const CACHE_MAX     = 800;
const CACHE_TTL_HTML = 180_000;  // HTML: 3min
const CACHE_TTL_CSS  = 600_000;  // CSS:  10min
const CACHE_TTL_JS   = 300_000;  // JS:   5min

function cacheGet(key, ttl) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.t > ttl) { CACHE.delete(key); return null; }
  CACHE.delete(key); CACHE.set(key, e); // LRU
  return e;
}
function cacheSet(key, val) {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { ...val, t: Date.now() });
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding',
  'content-length', 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'set-cookie',
]);
const URL_LEAK_HEADERS = new Set([
  'location', 'content-location', 'link', 'refresh', 'report-to', 'nel',
  'x-pingback', 'source-map', 'sourcemap',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// yt-dlp 経由で動画情報＋ストリームURL（自IP署名なのでRange対応で確実に再生可）を取得
const YTDLP_BIN = process.env.YTDLP_BIN || '/home/runner/workspace/.pythonlibs/bin/yt-dlp';
const YTDLP_FALLBACK = 'yt-dlp'; // PATH 上のバイナリ（環境変化時の保険）
const YTINFO_CACHE = new Map(); // vid -> { json, expires }
const YTINFO_INFLIGHT = new Map(); // vid -> Promise（同一動画の重複起動を防ぐ）
const YTINFO_CACHE_MAX = 500; // メモリ肥大防止（public エンドポイントの資源枯渇対策）
const YTSEARCH_CACHE = new Map(); // normalized query -> { json, expires }
const YTSEARCH_CACHE_MAX = 120;
const YTSHORTS_CACHE = new Map();

function cacheYtInfo(vid, payload, ttlMs) {
  // 古いエントリを間引いてから追加（簡易LRU: 挿入順）
  if (YTINFO_CACHE.size >= YTINFO_CACHE_MAX) {
    const drop = YTINFO_CACHE.size - YTINFO_CACHE_MAX + 1;
    let i = 0;
    for (const k of YTINFO_CACHE.keys()) { YTINFO_CACHE.delete(k); if (++i >= drop) break; }
  }
  YTINFO_CACHE.set(vid, { json: payload, expires: Date.now() + ttlMs });
}

function runYtDlp(vid) {
  return new Promise((resolve, reject) => {
    const args = [
      '-j', '--no-warnings', '--no-playlist',
      '--extractor-args', 'youtube:player_client=android_vr,web',
      `https://www.youtube.com/watch?v=${vid}`,
    ];
    let bin = YTDLP_BIN, triedFallback = false;
    const launch = () => {
      const proc = spawn(bin, args, { timeout: 30000 });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      proc.on('error', (e) => {
        // バイナリが見つからない等は PATH 上のyt-dlpで一度だけ再試行
        if (!triedFallback && (e.code === 'ENOENT' || e.code === 'EACCES')) {
          triedFallback = true; bin = YTDLP_FALLBACK; return launch();
        }
        reject(e);
      });
      proc.on('close', (code) => {
        if (code === 0 && out.trim()) {
          try { resolve(JSON.parse(out)); }
          catch (e) { reject(new Error('yt-dlp JSON parse: ' + e.message)); }
        } else {
          reject(new Error(err.trim().split('\n').pop() || ('yt-dlp exit ' + code)));
        }
      });
    };
    launch();
  });
}

// Invidious インスタンス
// 先頭が優先インスタンス（実測OK）。raceInv() は先頭を必ず含めてレースする。
// 定期確認(2026-07): yt.omada.cafe のみ安定稼働、他は停止/CF/429。
const INV_INSTANCES = [
  'https://yt.omada.cafe',           // 実測OK（唯一安定）
  'https://invidious.darkness.services', // 429（レート制限あり・生存確認）
  'https://invidious.projectsegfau.lt',  // 復活を見込んで維持
  'https://inv.nadeko.net',             // エンドポイント制限付きだが試行
  'https://yewtu.be',                   // CF下だが一部環境で疎通
];

// 複数Promiseのうち最初に truthy を返したものを採用。全滅なら null。
// （1つでも成功すれば即返すので、遅いインスタンスを待たない）
function firstTruthy(promises) {
  return new Promise((resolve) => {
    let remaining = promises.length;
    if (!remaining) return resolve(null);
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => { if (v) resolve(v); else if (--remaining === 0) resolve(null); },
        ()  => { if (--remaining === 0) resolve(null); }
      );
    }
  });
}

// sennin-tube-plus 方式ベース: 先頭(yt.omada.cafe)を必ず含め、残りからランダムに3つ選んでレース。
// 先頭を固定することで「全部ハズレ」になる確率をゼロにする。
function raceInv(fn) {
  const priority = INV_INSTANCES[0];
  const rest = INV_INSTANCES.slice(1).sort(() => Math.random() - 0.5).slice(0, 3);
  return firstTruthy([priority, ...rest].map(h => fn(h)));
}

// 1インスタンスを解決: API取得のみ。ブラウザが直接インスタンスURLを叩くのでサーバ側probe不要。
// sennin-tube-plus と同方式: formatStreams の url をそのままブラウザへ渡す。
async function tryInvidiousInstance(host, vid) {
  try {
    const { statusCode, body } = await request(
      `${host}/api/v1/videos/${vid}?fields=title,author,authorId,viewCount,likeCount,published,description,formatStreams,adaptiveFormats,recommendedVideos`,
      { headers: { 'user-agent': UA }, headersTimeout: 8000, bodyTimeout: 12000 }
    );
    const chunks = []; for await (const c of body) chunks.push(c);
    if (statusCode !== 200) { console.warn('[ytinfo]', host, 'status', statusCode); return null; }
    let d;
    try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch { console.warn('[ytinfo]', host, 'non-JSON'); return null; }
    if (d.error) { console.warn('[ytinfo]', host, 'error:', d.error.slice?.(0,60)); return null; }
    // formatStreams（映像+音声muxed）を優先、なければ adaptiveFormats の映像トラックで代替
    // （sennin-tube-plus と同方式）
    let fs = (d.formatStreams || []).filter(s => s.url);
    let audioToken = null;
    if (!fs.length) {
      // adaptiveFormats: 映像+音声を個別取得 → ffmpegでリアルタイムmux
      const af = d.adaptiveFormats || [];
      const videoTracks = af.filter(s => s.url && s.itag && s.type?.startsWith('video/'));
      const audioTracks = af.filter(s => s.url && s.itag && s.type?.startsWith('audio/'));
      if (videoTracks.length) {
        // mp4を優先・品質降順でソート（例: 720p→480p→360p→144p）
        videoTracks.sort((a, b) => {
          const am = a.type?.includes('mp4') ? 1 : 0, bm = b.type?.includes('mp4') ? 1 : 0;
          if (am !== bm) return bm - am;
          return (parseInt(b.qualityLabel) || 0) - (parseInt(a.qualityLabel) || 0);
        });
        // m4a（itag 140）が最高品質の音声
        const audioTrack = audioTracks.find(s => s.type?.includes('mp4')) || audioTracks[0];
        if (audioTrack) {
          audioToken = seal(`${host}/latest_version?id=${vid}&itag=${audioTrack.itag}&local=true`);
          console.log('[ytinfo] adaptive mux: videoItag=', videoTracks[0].itag, 'audioItag=', audioTrack.itag);
        }
        fs = videoTracks;
      }
    }
    if (!fs.length) { console.warn('[ytinfo]', host, 'no streams'); return null; }
    const streams = fs.map(s => ({
      label: s.qualityLabel || s.quality || '?',
      // latest_version?local=true → Invidious自身がgooglevideo.comをfetchするのでIP署名の問題を回避
      token: seal(s.itag ? `${host}/latest_version?id=${vid}&itag=${s.itag}&local=true` : s.url),
      audioToken,  // muxed formatStreams時はnull、adaptive時は音声URL token
      container: s.container || 'mp4',
    }));
    console.log('[ytinfo] invidious OK via', host, 'streams=', streams.length);
    return {
      title: d.title || '', author: d.author || '', authorId: d.authorId || '',
      viewCount: d.viewCount || 0, likeCount: d.likeCount || 0,
      published: d.published || 0,
      description: (d.description || '').slice(0, 2000), streams,
      recommended: (d.recommendedVideos || []).slice(0, 15).map(r => ({
        videoId: r.videoId, title: r.title || '', author: r.author || '',
        lengthSeconds: r.lengthSeconds || 0, viewCount: r.viewCount || 0,
        thumbToken: sealImg(`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`),
      })),
    };
  } catch { return null; }
}

// sennin-tube-plus 方式: シャッフルして上位4インスタンスをレース
async function fetchInvidiousInfo(vid) {
  return raceInv(h => tryInvidiousInstance(h, vid));
}

// yt-dlp の JSON から muxed (映像＋音声一体) ストリームを抽出して共通形式に整形
function buildInfoFromYtDlp(data) {
  const fmts = (data.formats || []).filter(f =>
    f.url && (f.protocol === 'https' || f.protocol === 'http') &&
    f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
  );
  fmts.sort((a, b) => {
    const am = a.ext === 'mp4' ? 1 : 0, bm = b.ext === 'mp4' ? 1 : 0;
    if (am !== bm) return bm - am;
    return (a.height || 0) - (b.height || 0);
  });
  const streams = fmts.map(f => ({
    label: f.height ? f.height + 'p' : (f.format_note || '?'),
    token: seal(f.url),
    container: f.ext || 'mp4',
  }));
  return {
    title: data.title || '', author: data.uploader || data.channel || '',
    authorId: data.channel_id || '', viewCount: data.view_count || 0,
    description: (data.description || '').slice(0, 800), streams,
  };
}

// Invidiousを短時間先行させ、遅い時だけyt-dlpを起動するヘッジ方式。
// 暗号化トークンとサーバー中継はどちらの経路でも共通。
async function resolveYtInfo(vid) {
  const valid = value => value?.streams?.length ? value : null;
  const invPromise = fetchInvidiousInfo(vid).then(valid).catch(() => null);
  const fastInv = await Promise.race([
    invPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 700)),
  ]);
  if (fastInv) {
    console.log('[ytinfo] fast Invidious path streams=', fastInv.streams.length);
    return fastInv;
  }

  const dlpPromise = runYtDlp(vid)
    .then(buildInfoFromYtDlp).then(valid)
    .catch(e => { console.warn('[ytinfo] yt-dlp failed:', e.message); return null; });
  const info = await firstTruthy([invPromise, dlpPromise]);
  if (!info) console.error('[ytinfo] no streams for', vid);
  return info;
}

function decompress(buf, enc) {
  try {
    if (enc === 'gzip')    return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br')      return zlib.brotliDecompressSync(buf);
  } catch { /* fallthrough */ }
  return buf;
}

// YouTube has used multiple nested renderers for Shorts. Walk the full response
// so a layout change does not silently break discovery.
function collectShortVideos(node, videos, seen) {
  if (!node || typeof node !== 'object' || videos.length >= 24) return;
  const reel = node.reelItemRenderer;
  const lockup = node.shortsLockupViewModel;
  const regular = node.videoRenderer;
  const videoId = reel?.videoId
    || lockup?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
    || lockup?.onTap?.innertubeCommand?.watchEndpoint?.videoId
    || (typeof lockup?.entityId === 'string' ? lockup.entityId.match(/([A-Za-z0-9_-]{11})$/)?.[1] : '')
    || regular?.videoId;
  if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) && !seen.has(videoId)) {
    seen.add(videoId);
    videos.push({
      videoId,
      title: reel?.headline?.simpleText || reel?.headline?.runs?.[0]?.text
        || lockup?.overlayMetadata?.primaryText?.content
        || regular?.title?.runs?.[0]?.text || regular?.title?.simpleText || '',
      author: reel?.channelName?.simpleText
        || lockup?.overlayMetadata?.secondaryText?.content
        || regular?.ownerText?.runs?.[0]?.text || '',
      thumbToken: sealImg(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
      lengthSeconds: 0,
      viewCount: 0,
    });
  }
  for (const value of Object.values(node)) collectShortVideos(value, videos, seen);
}

const server = http.createServer(async (req, res) => {
  // ヘルスチェック用（Replitデプロイのヘルスチェックが500で落ちないよう最優先）
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  try {
  const url = req.url;

  // ─── Google OAuth2 ログインフロー ─────────────────────────────────────────
  // /auth/google → Google認証画面へリダイレクト
  if (url === '/auth/google') {
    if (!GOOGLE_CLIENT_ID) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2>Google OAuth が未設定です（管理者に連絡してください）</h2>');
    }
    const base = getOAuthBase(req);
    console.log('[oauth] host:', req.headers['host'], '→ redirect_uri:', base + '/auth/callback');
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: base + '/auth/callback',
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/classroom.courses.readonly',
      access_type: 'online',
      prompt: 'consent',
      state,
    });
    res.writeHead(302, {
      location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
      'set-cookie': `kp_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    });
    return res.end();
  }

  // /auth/callback → Google認証後のコールバック
  if (url.startsWith('/auth/callback')) {
    const qs = new URL(url, 'http://x').searchParams;
    const code  = qs.get('code');
    const state = qs.get('state');
    const cookieHeader = req.headers['cookie'] || '';
    const stateM = cookieHeader.match(/(?:^|;\s*)kp_oauth_state=([^;]+)/);
    const savedState = stateM ? decodeURIComponent(stateM[1]) : '';

    if (!code || !state || state !== savedState) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2>認証エラー: stateが一致しません。<a href="/auth/google">もう一度ログイン</a></h2>');
    }

    const base = getOAuthBase(req);
    let tokens;
    try {
      const tr = await request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: base + '/auth/callback',
          grant_type: 'authorization_code',
        }).toString(),
      });
      const buf = [];
      for await (const chunk of tr.body) buf.push(chunk);
      tokens = JSON.parse(Buffer.concat(buf).toString());
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2>Googleとの通信に失敗しました。<a href="/auth/google">もう一度</a></h2>');
    }

    if (!tokens.access_token) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2>Googleログイン失敗。<a href="/auth/google">もう一度</a></h2>');
    }

    // ユーザー情報取得
    let userInfo;
    try {
      const ur = await request('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': 'Bearer ' + tokens.access_token },
      });
      const buf2 = [];
      for await (const chunk of ur.body) buf2.push(chunk);
      userInfo = JSON.parse(Buffer.concat(buf2).toString());
    } catch {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2>ユーザー情報取得失敗。<a href="/auth/google">もう一度</a></h2>');
    }

    // Classroom参加チェック
    const { isMember, isTeacher } = await checkClassroomMembership(tokens.access_token);
    // isMember === null: Classroom API自体の通信失敗（メンバー外とは断定できない）
    if (isMember === null) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>通信エラー</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#e2e8f0;margin:0}
.card{background:#1e293b;border-radius:16px;padding:2rem 2.5rem;text-align:center;max-width:420px}
h2{color:#fbbf24;margin-bottom:1rem}p{color:#94a3b8;margin-bottom:1.5rem;line-height:1.6}
.btn{display:inline-block;background:#3b82f6;color:#fff;padding:.75rem 2rem;border-radius:10px;text-decoration:none;font-weight:700;margin-top:.5rem}
small{color:#64748b;font-size:.8rem}</style></head>
<body><div class="card">
<h2>⚠️ 一時的な通信エラー</h2>
<p>Google Classroomとの通信に失敗しました。<br>もう一度ログインを試してください。</p>
<p><small>${userInfo.email || ''}</small></p>
<a href="/auth/google" class="btn">もう一度ログイン</a>
</div></body></html>`);
    }
    if (!isMember) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>アクセス拒否</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#e2e8f0;margin:0}
.card{background:#1e293b;border-radius:16px;padding:2rem 2.5rem;text-align:center;max-width:400px}
h2{color:#f87171;margin-bottom:1rem}p{color:#94a3b8;margin-bottom:1.5rem}
a{color:#60a5fa;text-decoration:none}</style></head>
<body><div class="card">
<h2>🚫 アクセスできません</h2>
<p>クラスルームに参加していないため、このサービスは使えません。</p>
<p style="font-size:0.85rem;color:#64748b">${userInfo.email || ''}</p>
<a href="/auth/google">別のアカウントでログイン</a>
</div></body></html>`);
    }

    // セッション発行（7日間有効）
    const sessionToken = createHmac('sha256', process.env.PROXY_SECRET)
      .update(userInfo.sub + Date.now())
      .digest('hex') + Math.random().toString(36).slice(2);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await pool.query(
      `INSERT INTO auth_sessions (token, google_id, email, name, is_teacher, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token) DO UPDATE SET expires_at=$6, is_teacher=$5`,
      [sessionToken, userInfo.sub, userInfo.email || '', userInfo.name || '', isTeacher, expiresAt]
    );

    const cookieExpires = expiresAt.toUTCString();
    res.writeHead(302, {
      location: '/',
      'set-cookie': [
        `kp_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Expires=${cookieExpires}`,
        `kp_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
      ],
    });
    return res.end();
  }

  // /auth/logout
  if (url === '/auth/logout') {
    const cookieHeader = req.headers['cookie'] || '';
    const m = cookieHeader.match(/(?:^|;\s*)kp_session=([^;]+)/);
    if (m) {
      const tok = decodeURIComponent(m[1]);
      pool.query('DELETE FROM auth_sessions WHERE token=$1', [tok]).catch(() => {});
    }
    res.writeHead(302, {
      location: '/auth/login',
      'set-cookie': 'kp_session=; Path=/; HttpOnly; Max-Age=0',
    });
    return res.end();
  }

  // /auth/login → ログインページ
  if (url === '/auth/login') {
    const hasOAuth = !!GOOGLE_CLIENT_ID;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>カピバラの学習サイト — ログイン</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:100vh;background:#0f172a;color:#e2e8f0;margin:0;padding:1rem}
.card{background:#1e293b;border-radius:20px;padding:2.5rem 2rem;text-align:center;
  max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.logo{font-size:3rem;margin-bottom:.5rem}
h1{font-size:1.4rem;margin:0 0 .5rem;color:#f1f5f9}
p{color:#94a3b8;font-size:.9rem;margin:0 0 2rem}
.btn{display:flex;align-items:center;justify-content:center;gap:.7rem;
  width:100%;padding:.85rem 1.5rem;border:none;border-radius:12px;
  font-size:1rem;font-weight:600;cursor:pointer;text-decoration:none;
  background:#fff;color:#1e293b;transition:opacity .15s}
.btn:hover{opacity:.9}
.btn svg{width:20px;height:20px;flex-shrink:0}
.note{margin-top:1.5rem;font-size:.78rem;color:#64748b}
</style></head>
<body><div class="card">
<div class="logo">🦫</div>
<h1>カピバラの学習サイト</h1>
<p>Googleアカウントでログインしてください</p>
${hasOAuth ? `<a href="/auth/google" class="btn">
<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.8 2.5 30.3 0 24 0 14.8 0 6.9 5.4 3 13.3l7.8 6C12.7 13 17.9 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-9.9 6.9-17z"/><path fill="#FBBC05" d="M10.8 28.7A14.8 14.8 0 0 1 9.5 24c0-1.7.3-3.3.8-4.7L2.5 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.5 10.7l8.3-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.2-8.4 2.2-6.1 0-11.3-4.1-13.2-9.7l-7.8 6C6.9 42.6 14.8 48 24 48z"/></svg>
Googleでログイン
</a>` : `<p style="color:#f87171">⚠️ OAuth未設定（管理者に連絡）</p>`}
<p class="note">クラスルームに参加済みのGoogleアカウントのみ使えます</p>
</div></body></html>`);
  }

  // ホーム — 認証ガードの前で処理し常に200を返す（Replitヘルスチェック対応）
  if (url === '/' || url === '/index.html') {
    const sess = await getAuthSession(req);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (!sess) {
      return res.end('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/auth/login"><meta charset="utf-8"><title>カピバラの学習サイト</title></head><body></body></html>');
    }
    return res.end(HOME_HTML);
  }

  // ─── 認証ガード: 静的リソース以外はセッション必須 ──────────────────────────
  const isPublicPath = AUTH_BYPASS.some(p => url.startsWith(p)) ||
    url === '/favicon.ico' || url.startsWith('/apple-touch-icon');
  if (!isPublicPath) {
    const session = await getAuthSession(req);
    if (!session) {
      // APIはJSONで返す
      if (url.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      res.writeHead(302, { location: '/auth/login' });
      return res.end();
    }
  }

  // /api/me — ログイン中ユーザー情報（教師フラグ含む）
  if (url === '/api/me') {
    const session = await getAuthSession(req);
    if (!session) { res.writeHead(401, {'content-type':'application/json'}); return res.end('{"error":"unauthorized"}'); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ email: session.email, name: session.name, isTeacher: !!session.is_teacher }));
  }

  // PWA / アイコン
  if (url === '/manifest.webmanifest' || url === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
    return res.end(MANIFEST);
  }
  // Minecraft Eaglercraft（日本語版、自己配信）
  if (url === '/neon' || url === '/neon-survivor') {
    const neonPath = path.join(__dir, 'assets', 'neon.html');
    try {
      const html = fs.readFileSync(neonPath, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return res.end(html);
    } catch { res.writeHead(404); return res.end('not found'); }
  }

  if (url === '/mc' || url === '/minecraft') {
    res.writeHead(302, { location: '/mc/' });
    return res.end();
  }
  if (url.startsWith('/mc/')) {
    const MC_DIR = path.join(__dir, 'mc_game');
    const rawFile = decodeURIComponent(url.slice('/mc/'.length).split('?')[0]) || 'index.html';
    if (rawFile.endsWith('.map')) { res.writeHead(404); return res.end('not found'); }
    const filePath = path.resolve(MC_DIR, rawFile);
    if (!filePath.startsWith(MC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    let stat;
    try { stat = fs.statSync(filePath); } catch { res.writeHead(404); return res.end('not found'); }
    if (!stat.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(rawFile).toLowerCase();
    const mcMime = {
      '.html':'text/html; charset=utf-8', '.js':'application/javascript',
      '.epk':'application/octet-stream', '.ico':'image/x-icon',
      '.png':'image/png', '.jpg':'image/jpeg', '.json':'application/json',
    };
    const ct = mcMime[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';
    const cacheVal = isHtml ? 'no-cache' : 'public, max-age=86400';
    const acceptEnc = req.headers['accept-encoding'] || '';
    const hdrs = { 'content-type': ct, 'cache-control': cacheVal };
    // 事前圧縮済み .gz ファイルがあればそれを直接配信（CPU負荷ゼロ）
    const preGzPath = filePath + '.gz';
    if (acceptEnc.includes('gzip') && fs.existsSync(preGzPath)) {
      hdrs['content-encoding'] = 'gzip';
      res.writeHead(200, hdrs);
      fs.createReadStream(preGzPath).pipe(res);
    } else if (acceptEnc.includes('gzip') && ['.js','.html','.json'].includes(ext)) {
      hdrs['content-encoding'] = 'gzip';
      res.writeHead(200, hdrs);
      fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 4 })).pipe(res);
    } else {
      res.writeHead(200, hdrs);
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // カピバラクエスト（直接配信: プロキシ経由なし）
  if (url === '/game') {
    const entry = ASSET_CACHE.get('game.html');
    if (!entry) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(entry.data);
  }

  // YouTube 軽量プレイヤーページ (/ytw?v=VIDEO_ID)
  // カスタム動画プレイヤー（Invidious経由でbot検出回避）
  if (url.startsWith('/ytw')) {
    const entry = ASSET_CACHE.get('ytw.html');
    if (!entry) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(entry.data);
  }

  // ── 画像プロキシ /img/<token> ──────────────────────────────────────────
  // サムネイル等の画像URLをAES-256-GCMトークンで隠蔽し、サーバー経由で配信。
  // ブラウザには元URLが一切露出しない。
  if (url.startsWith('/img/')) {
    const token = url.slice('/img/'.length).split('?')[0];
    let imgUrl;
    try { imgUrl = unsealImg(token); } catch { res.writeHead(400); return res.end('invalid img token'); }
    if (!/^https?:\/\//i.test(imgUrl)) { res.writeHead(400); return res.end('invalid url'); }
    try {
      const { statusCode, headers: upH, body: upB } = await request(imgUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; KapibaraProxy/2)', accept: 'image/*,*/*' },
        headersTimeout: 6000, bodyTimeout: 15000,
      });
      const ct = upH['content-type'] || 'image/jpeg';
      res.writeHead(statusCode === 200 ? 200 : 502, {
        'content-type': ct,
        'cache-control': 'public, max-age=86400',
        'x-powered-by': 'KapibaraProxy/AES256GCM',
      });
      for await (const chunk of upB) res.write(chunk);
      return res.end();
    } catch (e) {
      res.writeHead(502); return res.end('img fetch error');
    }
  }

  // ── サムネイル同一オリジン配信 /thumb/<id> ─────────────────────────────
  // ytimg のサムネを id 指定でサーバー経由配信。ブラウザは i.ytimg.com に直接触れない
  // （ウェブフィルタが ytimg / youtube ドメインを遮断しても影響を受けない）。
  if (url.startsWith('/thumb/')) {
    const id = url.slice('/thumb/'.length).split('?')[0].replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) { res.writeHead(400); return res.end('bad id'); }
    const imgUrl = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    try {
      const { statusCode, headers: upH, body: upB } = await request(imgUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; KapibaraProxy/2)', accept: 'image/*,*/*' },
        headersTimeout: 6000, bodyTimeout: 15000,
      });
      res.writeHead(statusCode === 200 ? 200 : 502, {
        'content-type': upH['content-type'] || 'image/jpeg',
        'cache-control': 'public, max-age=86400',
      });
      for await (const chunk of upB) res.write(chunk);
      return res.end();
    } catch { res.writeHead(502); return res.end('thumb error'); }
  }

  // ── 高評価/低評価 同一オリジン中継 /api/ryd?v=<id> ───────────────────────
  // returnyoutubedislikeapi.com をサーバー経由で叩く。ブラウザが外部ドメインに
  // 直接リクエストしないのでウェブフィルタに引っかからない。失敗時は空JSON。
  if (url.startsWith('/api/ryd')) {
    const v = (new URL(url, 'http://x').searchParams.get('v') || '').replace(/[^A-Za-z0-9_-]/g, '');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
    if (!v) return res.end('{}');
    try {
      const r = await fetch('https://returnyoutubedislikeapi.com/votes?videoId=' + encodeURIComponent(v), {
        headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000),
      });
      const txt = await r.text();
      return res.end(r.ok && txt ? txt : '{}');
    } catch { return res.end('{}'); }
  }

  // ── 汎用URLプロキシ /proxy/<token> ──────────────────────────────────────
  // 任意URLをAES-256-GCMトークンで保護し、サーバー経由でコンテンツを中継する。
  // 元URLはブラウザに送信されず、サーバー鍵なしに復元不能。
  if (url.startsWith('/proxy/')) {
    const token = url.slice('/proxy/'.length).split('?')[0];
    let proxyUrl;
    try { proxyUrl = unsealProxy(token); } catch { res.writeHead(400); return res.end('invalid proxy token'); }
    if (!/^https?:\/\//i.test(proxyUrl)) { res.writeHead(400); return res.end('invalid url'); }
    try {
      const { statusCode, headers: upH, body: upB } = await request(proxyUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KapibaraProxy/2)',
          accept: '*/*',
          referer: new URL(proxyUrl).origin + '/',
        },
        headersTimeout: 10000, bodyTimeout: 30000,
      });
      const ct = upH['content-type'] || 'application/octet-stream';
      res.writeHead(statusCode, {
        'content-type': ct,
        'content-length': upH['content-length'] || '',
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
        'x-powered-by': 'KapibaraProxy/AES256GCM',
      });
      for await (const chunk of upB) res.write(chunk);
      return res.end();
    } catch (e) {
      res.writeHead(502); return res.end('proxy fetch error: ' + e.message);
    }
  }

  // ── /__sealimg: 画像URLトークン発行 ─────────────────────────────────────
  if (url.startsWith('/__sealimg?')) {
    const u = new URL(url, 'http://x').searchParams.get('u');
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' });
    if (!u || !/^https?:\/\//i.test(u)) return res.end('');
    try { return res.end(sealImg(u)); } catch { return res.end(''); }
  }

  // ── /__sealproxy: プロキシURLトークン発行 ───────────────────────────────
  if (url.startsWith('/__sealproxy?')) {
    const u = new URL(url, 'http://x').searchParams.get('u');
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    if (!u || !/^https?:\/\//i.test(u)) return res.end('');
    try { return res.end(sealProxy(u)); } catch { return res.end(''); }
  }

  // HLS プレイリスト（/m/<token>/p?at=<audioToken>）
  if (url.match(/^\/m\/[^/]+\/p(?:\.m3u8)?(?:\?.*)?$/)) {
    const urlObj = new URL(url, 'http://x');
    const token = urlObj.pathname.split('/')[2];
    const atParam = urlObj.searchParams.get('at');
    let streamUrl, audioUrl = null;
    try { streamUrl = unseal(token); } catch { res.writeHead(400); return res.end('invalid token'); }
    if (atParam) { try { audioUrl = unseal(atParam); } catch {} }
    let session;
    try { session = await ensureHlsSession(token, streamUrl, audioUrl, atParam || null); } catch (e) {
      console.error('[hls] session start error', e.message);
      res.writeHead(502); return res.end('hls error');
    }
    const playlistPath = path.join(session.dir, 'p.m3u8');
    const ok = await hlsWaitFile(playlistPath, 20000);
    if (!ok) { res.writeHead(504); return res.end('hls timeout'); }
    try {
      const raw = fs.readFileSync(playlistPath, 'utf8');
      // セグメントのファイル名（例: 0.ts）をサーバー経由URLに書き換え
      const rewritten = raw.replace(/^(\d+\.ts)$/gm, `/m/${token}/$1`);
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      return res.end(rewritten);
    } catch (e) {
      console.error('[hls] playlist read error', e.message);
      res.writeHead(500); return res.end('playlist error');
    }
  }

  // HLS セグメント（/m/<token>/<n>.ts）
  if (url.match(/^\/m\/[^/]+\/\d+\.ts$/)) {
    const parts = url.split('/');
    const token = parts[2];
    const seg = parts[3];
    try { unseal(token); } catch { res.writeHead(400); return res.end('invalid token'); }
    const session = hlsSessions.get(token);
    if (!session) { res.writeHead(404); return res.end('no session'); }
    const segPath = path.join(session.dir, seg);
    const ok = await hlsWaitFile(segPath, 30000);
    if (!ok) {
      if (session.done) { res.writeHead(410); return res.end('segment not found'); }
      res.writeHead(504); return res.end('segment timeout');
    }
    try {
      const data = fs.readFileSync(segPath);
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      return res.end(data);
    } catch (e) {
      console.error('[hls] segment read error', e.message);
      res.writeHead(500); return res.end('segment error');
    }
  }

  // 動画ストリーム プロキシ（Invidiousから取得したURLを封印→復号してパイプ）
  if (url.startsWith('/s/')) {
    const token = url.slice('/s/'.length).split('?')[0];
    let streamUrl;
    try { streamUrl = unseal(token); } catch { res.writeHead(400); return res.end('invalid token'); }
    if (!streamUrl) { res.writeHead(400); return res.end('invalid token'); }
    // 全ストリームをサーバー側でプロキシして同一オリジンで配信する。
    //  - yt-dlp由来のgooglevideo URL: 自サーバーIP署名なのでサーバー経由が必須。
    //  - Invidiousのlatest_version?local=true URL: Invidious自身のcompanionが
    //    googlevideoをproxyするため、リダイレクト先(=/companion/videoplayback)も同一インスタンス内。
    //    サーバーfetchでも403にならず、Range/206に対応する。
    // クロスオリジン302リダイレクト方式より確実（Range・シーク対応、単一オリジン）。
    // 重要1: latest_version は /companion/latest_version → /companion/videoplayback へ
    //   2段リダイレクトする。undici の request() は maxRedirects を渡してもリダイレクトを
    //   追わず 302(本文空) を返してしまうため、リダイレクト追従する global fetch を使う。
    // 重要2: googlevideo/companion は Range ヘッダが無いと空の text/html を返すことがあるため、
    //   クライアントがRangeを送らない場合も必ず bytes=0- を付与する。
    const ac = new AbortController();
    // クライアントが切断/シークで接続を閉じたら上流fetchも中断する。
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const up = await fetch(streamUrl, {
        headers: { range: req.headers['range'] || 'bytes=0-', 'user-agent': UA },
        signal: ac.signal,
      });
      // 上流が403の場合 → local=true を外してリトライ（YouTubeのCDN直リダイレクトを試みる）
      if (up.status === 403 && streamUrl.includes('local=true')) {
        try { await up.body?.cancel(); } catch {}
        console.warn('[ytstream] local=true got 403, retrying without local=true');
        const retryUrl = streamUrl.replace(/[&?]local=true/g, '');
        const up2 = await fetch(retryUrl, {
          headers: { range: req.headers['range'] || 'bytes=0-', 'user-agent': UA, 'referer': 'https://www.youtube.com/' },
          signal: ac.signal,
          redirect: 'follow',
        });
        if (up2.status !== 200 && up2.status !== 206) {
          try { await up2.body?.cancel(); } catch {}
          console.error('[ytstream] retry also failed status', up2.status);
          res.writeHead(502); return res.end('upstream error');
        }
        const fwd2 = { 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'content-type': 'application/octet-stream' };
        for (const h of ['content-length','content-range']) { const v = up2.headers.get(h); if (v) fwd2[h] = v; }
        res.writeHead(up2.status, fwd2);
        if (!up2.body) { res.end(); return; }
        const src2 = Readable.fromWeb(up2.body);
        src2.on('error', () => { try { res.destroy(); } catch {} });
        src2.pipe(res);
        return;
      }
      // 上流が2xx以外(403/416/5xx等)ならエラー本文を動画として流さず502で明示的に失敗させる。
      // → ブラウザ側の error ハンドラが次stream/fresh再取得のフォールバックに入れる。
      if (up.status !== 200 && up.status !== 206) {
        try { await up.body?.cancel(); } catch {}
        console.error('[ytstream] upstream status', up.status);
        res.writeHead(502); return res.end('upstream error');
      }
      // Content-Type は application/octet-stream に固定する。
      // ウェブフィルタ(ISGC等)がSSLインスペクションでContent-Type: video/mp4を
      // 検知してブロックするケースがあるため、汎用バイナリとして配信する。
      // ブラウザは先頭バイト(moov atom)からコンテナ形式を自動判別して再生できる。
      const fwd = { 'accept-ranges': 'bytes', 'cache-control': 'no-store',
                    'content-type': 'application/octet-stream' };
      for (const h of ['content-length','content-range']) {
        const v = up.headers.get(h);
        if (v) fwd[h] = v;
      }
      res.writeHead(up.status, fwd);
      if (!up.body) { res.end(); return; }
      const src = Readable.fromWeb(up.body);
      // 中断(AbortError)や上流切断のエラーはクラッシュさせず接続破棄で握りつぶす。
      src.on('error', () => { try { res.destroy(); } catch {} });
      src.pipe(res);
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[ytstream]', e.message);
      if (!res.headersSent) { res.writeHead(502); res.end('stream error'); }
    }
    return;
  }

  // YouTube 検索ページ
  if (url === '/yt' || url === '/y') {
    const entry = ASSET_CACHE.get('yt.html');
    if (!entry) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(entry.data);
  }

  // YouTube Shorts API (Invidious 経由)
  if (url.startsWith('/api/ytshorts')) {
    res.setHeader('access-control-allow-origin', '*');
    const q = new URL(url, 'http://x').searchParams.get('q') || '';
    const cacheKey = q.trim().toLocaleLowerCase('ja-JP').slice(0, 120) || '__default__';
    const cached = YTSHORTS_CACHE.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60, stale-while-revalidate=120',
        'x-kapibara-cache': 'HIT',
      });
      return res.end(cached.json);
    }
    try {
      // Shorts検索: YouTubeの shorts フィルタ(EgIQAQ==はショートのsp値: sp=EgQKAhAB)
      const spShort = 'EgQKAhAB%3D%3D'; // type=short filter
      const searchQ = q || 'shorts';
      const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQ)}&sp=${spShort}`;
      const { statusCode, body } = await request(ytUrl, {
        method: 'GET',
        headers: {
          'user-agent': UA,
          'accept-language': 'ja,en;q=0.9',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate',
          'cookie': 'CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjgaAmphIAE',
        },
        headersTimeout: 10000,
        bodyTimeout: 15000,
      });
      const rawChunks = []; for await (const c of body) rawChunks.push(c);
      const html = decompress(Buffer.concat(rawChunks), 'gzip').toString('utf-8');
      const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*(?:var |<\/script>)/s);
      if (!match) throw new Error('ytInitialData not found');
      const ytData = JSON.parse(match[1]);
      const videos = [];
      collectShortVideos(ytData, videos, new Set());
      if (!videos.length) throw new Error('Shorts data not found');
      const json = JSON.stringify(videos);
      if (YTSHORTS_CACHE.size >= YTSEARCH_CACHE_MAX) {
        YTSHORTS_CACHE.delete(YTSHORTS_CACHE.keys().next().value);
      }
      YTSHORTS_CACHE.set(cacheKey, { json, expires: Date.now() + 2 * 60 * 1000 });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60, stale-while-revalidate=120',
        'x-kapibara-cache': 'MISS',
      });
      return res.end(json);
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // YouTube 検索 API (Invidious 経由)
  if (url.startsWith('/api/ytsearch?')) {
    res.setHeader('access-control-allow-origin', '*');
    const q = new URL(url, 'http://x').searchParams.get('q');
    if (!q) { res.writeHead(400); return res.end('{"error":"missing q"}'); }
    const searchKey = q.trim().toLocaleLowerCase('ja-JP').slice(0, 120);
    const searchHit = YTSEARCH_CACHE.get(searchKey);
    if (searchHit && searchHit.expires > Date.now()) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60, stale-while-revalidate=120',
        'x-kapibara-cache': 'HIT',
      });
      return res.end(searchHit.json);
    }

    // YouTube 検索結果ページから ytInitialData を解析
    try {
      const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D`;
      const { statusCode, body } = await request(ytUrl, {
        method: 'GET',
        headers: {
          'user-agent': UA,
          'accept-language': 'ja,en;q=0.9',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate',
          'cookie': 'CONSENT=YES+; SOCS=CAESEwgDEgk0ODE3Nzk3MjgaAmphIAE',
        },
        headersTimeout: 10000,
        bodyTimeout: 15000,
      });
      const rawChunks = []; for await (const c of body) rawChunks.push(c);
      const html = decompress(Buffer.concat(rawChunks), 'gzip').toString('utf-8');

      // ytInitialData = {...}; を抽出
      const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*(?:var |<\/script>)/s);
      if (!match) throw new Error('ytInitialData not found');
      const ytData = JSON.parse(match[1]);

      // 動画リストを取り出す
      const section = ytData?.contents
        ?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents ?? [];
      const videos = [];
      for (const s of section) {
        const items = s?.itemSectionRenderer?.contents ?? [];
        for (const item of items) {
          const v = item?.videoRenderer;
          if (!v?.videoId) continue;
          const durText = v.lengthText?.simpleText ?? '0:00';
          const durParts = durText.split(':').map(Number);
          const secs = durParts.length === 3
            ? durParts[0]*3600 + durParts[1]*60 + durParts[2]
            : durParts.length === 2 ? durParts[0]*60 + durParts[1] : 0;
          const viewText = v.viewCountText?.simpleText ?? '';
          const viewNum = parseInt(viewText.replace(/[^0-9]/g, '')) || 0;
          const vid2 = v.videoId;
          videos.push({
            videoId: vid2,
            title: v.title?.runs?.[0]?.text ?? '',
            author: v.ownerText?.runs?.[0]?.text ?? '',
            lengthSeconds: secs,
            viewCount: viewNum,
            thumbToken: sealImg(`https://i.ytimg.com/vi/${vid2}/mqdefault.jpg`),
          });
          if (videos.length >= 20) break;
        }
        if (videos.length >= 20) break;
      }

      const searchJson = JSON.stringify(videos);
      if (YTSEARCH_CACHE.size >= YTSEARCH_CACHE_MAX) {
        YTSEARCH_CACHE.delete(YTSEARCH_CACHE.keys().next().value);
      }
      YTSEARCH_CACHE.set(searchKey, { json: searchJson, expires: Date.now() + 2 * 60 * 1000 });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, max-age=60, stale-while-revalidate=120',
        'x-kapibara-cache': 'MISS',
      });
      return res.end(searchJson);
    } catch (e) {
      console.error('[ytsearch] error:', e.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '検索に失敗しました: ' + e.message }));
    }
  }

  // 動画情報 API (Invidious経由、stream URLを封印して返す)
  if (url.startsWith('/api/ytinfo')) {
    res.setHeader('access-control-allow-origin', '*');
    const vid = new URL(url, 'http://x').searchParams.get('v');
    if (!vid || !/^[A-Za-z0-9_-]{11}$/.test(vid)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '無効な動画IDです' }));
    }
    // キャッシュ確認（URLはyt-dlpの署名で数時間有効）。fresh=1 で再抽出（URL失効リカバリ用）
    const wantFresh = new URL(url, 'http://x').searchParams.get('fresh') === '1';
    if (wantFresh) {
      YTINFO_CACHE.delete(vid);
    } else {
      const cached = YTINFO_CACHE.get(vid);
      if (cached && cached.expires > Date.now()) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(cached.json);
      }
    }

    // 動画情報の取得（同一動画の重複起動を防ぐ）
    // 戦略: まず Invidious（インスタンス自身の正常IPでYouTubeを取得→bot検出回避）。
    //       失敗したら yt-dlp（自IP署名URL）にフォールバック。
    //       本番のデータセンタIPは YouTube に bot 判定されるため Invidious が主役になる。
    let info;
    try {
      let p = YTINFO_INFLIGHT.get(vid);
      if (!p) { p = resolveYtInfo(vid); YTINFO_INFLIGHT.set(vid, p); }
      try { info = await p; } finally { YTINFO_INFLIGHT.delete(vid); }
    } catch (e) {
      console.error('[ytinfo] resolve error:', e.message);
      info = null;
    }

    if (!info || !info.streams || !info.streams.length) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '動画情報の取得に失敗しました。別の動画をお試しください。' }));
    }

    const payload = JSON.stringify(info);
    // 署名URLの有効期間は概ね6時間。安全側で3時間キャッシュ（上限付き）。
    cacheYtInfo(vid, payload, 3 * 3600 * 1000);

    // HLS pre-warm: 動画情報取得と同時にffmpegを起動しセグメントを事前生成
    // → ユーザーが再生ボタンを押す頃には最初のセグメントが準備済みになる
    if (FFMPEG_BIN && info.streams && info.streams[0]) {
      try {
        const s0 = info.streams[0];
        const tok = s0.token;
        const sUrl = unseal(tok);
        const aUrl = s0.audioToken ? unseal(s0.audioToken) : null;
        ensureHlsSession(tok, sUrl, aUrl).catch(() => {});
      } catch {}
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(payload);
  }

  // コメント API (Invidious経由)
  if (url.startsWith('/api/ytcomments')) {
    res.setHeader('access-control-allow-origin', '*');
    const params = new URL(url, 'http://x').searchParams;
    const vid = params.get('v');
    const continuation = params.get('continuation') || '';
    if (!vid || !/^[A-Za-z0-9_-]{11}$/.test(vid)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":"invalid id"}');
    }
    try {
      const data = await raceInv(async h => {
        try {
          const qs = continuation ? `?continuation=${encodeURIComponent(continuation)}` : '';
          const { statusCode, body: b2 } = await request(
            `${h}/api/v1/comments/${vid}${qs}`,
            { headers: { 'user-agent': UA }, headersTimeout: 8000, bodyTimeout: 12000 }
          );
          const chunks = []; for await (const c of b2) chunks.push(c);
          if (statusCode !== 200) return null;
          let d; try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
          if (!d || !Array.isArray(d.comments)) return null;
          return d;
        } catch { return null; }
      });
      if (!data) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end('{"error":"コメントの取得に失敗しました"}');
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120' });
      return res.end(JSON.stringify({
        comments: (data.comments || []).slice(0, 30).map(c => ({
          author: c.author || '',
          authorIcon: (() => {
            const u = (c.authorThumbnails || []).slice(-1)[0]?.url || '';
            try { return u && /^https?:\/\//i.test(u) ? '/img/' + sealImg(u) : ''; } catch { return ''; }
          })(),
          text: c.content || (c.contentHtml || '').replace(/<[^>]+>/g, '') || '',
          likes: c.likeCount || 0,
          published: c.publishedText || '',
          isPinned: !!c.isPinned,
          isHearted: !!c.creatorHeart,
        })),
        continuation: data.continuation || null,
      }));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // トレンド API (Invidious経由、region=JP)
  if (url === '/api/yttrending' || url.startsWith('/api/yttrending?')) {
    res.setHeader('access-control-allow-origin', '*');
    const region = new URL(url, 'http://x').searchParams.get('region') || 'JP';
    try {
      const data = await raceInv(async h => {
        try {
          const { statusCode, body: b2 } = await request(
            `${h}/api/v1/trending?region=${region}&type=default`,
            { headers: { 'user-agent': UA }, headersTimeout: 8000, bodyTimeout: 12000 }
          );
          const chunks = []; for await (const c of b2) chunks.push(c);
          if (statusCode !== 200) return null;
          let d; try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
          if (!Array.isArray(d) || !d.length) return null;
          return d;
        } catch { return null; }
      });
      if (!data) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end('{"error":"トレンドの取得に失敗しました"}');
      }
      const videos = data.slice(0, 20).map(v => ({
        videoId: v.videoId, title: v.title || '', author: v.author || '',
        lengthSeconds: v.lengthSeconds || 0, viewCount: v.viewCount || 0,
        thumbToken: sealImg(`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`),
      }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' });
      return res.end(JSON.stringify(videos));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 検索サジェスト API (Invidious経由)
  if (url.startsWith('/api/ytsuggest')) {
    res.setHeader('access-control-allow-origin', '*');
    const q = new URL(url, 'http://x').searchParams.get('q') || '';
    if (!q) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    try {
      const data = await raceInv(async h => {
        try {
          const { statusCode, body: b2 } = await request(
            `${h}/api/v1/search/suggestions?q=${encodeURIComponent(q)}`,
            { headers: { 'user-agent': UA }, headersTimeout: 4000, bodyTimeout: 6000 }
          );
          const chunks = []; for await (const c of b2) chunks.push(c);
          if (statusCode !== 200) return null;
          let d; try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
          if (!d?.suggestions?.length) return null;
          return d.suggestions;
        } catch { return null; }
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
      return res.end(JSON.stringify(data || []));
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('[]');
    }
  }

  // AI API (Groq)
  // /editor — CodeStudio IDEページ（認証済みユーザーのみ）
  if (url === '/editor') {
    const html = fs.readFileSync(path.join(__dir, 'assets/editor.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // /api/languages — CodeStudio用ランタイム一覧
  if (url === '/api/languages') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
    return res.end(JSON.stringify(getCodeLanguages()));
  }

  if (url === '/api/ai' && req.method === 'POST') {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'AIコーナーはまだ準備中です（APIキー未設定）' }));
    }
    let body;
    try {
      const chunks = []; let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', c => { size += c.length; if (size > 32768) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
        req.on('end', () => resolve());
        req.on('error', reject);
      });
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '不正なリクエスト' }));
    }
    const messages = Array.isArray(body?.messages) ? body.messages.slice(-20) : [];
    if (!messages.length) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'messagesが空です' }));
    }
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${GROQ_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'あなたはカピバラproxyのAIアシスタント「カピバラAI」です。親切で丁寧な日本語で答えてください。勉強の質問や雑談なんでもOKです。' },
            ...messages,
          ],
          max_tokens: 1024,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!groqRes.ok) {
        const errText = await groqRes.text().catch(() => '');
        console.error('[ai] groq error', groqRes.status, errText.slice(0, 200));
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'AI応答の取得に失敗しました (status ' + groqRes.status + ')' }));
      }
      const data = await groqRes.json();
      const reply = data?.choices?.[0]?.message?.content || '';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ reply }));
    } catch (e) {
      console.error('[ai] fetch error:', e.message);
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'AI応答の取得に失敗しました: ' + e.message }));
    }
  }

  // ランキング API
  if (url === '/api/ranking') {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET') {
      try {
        const r = await pool.query(
          'SELECT name, level, gold, kill_count FROM rankings ORDER BY level DESC, kill_count DESC, created_at ASC LIMIT 20'
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(r.rows));
      } catch (e) {
        res.writeHead(500); return res.end('[]');
      }
    }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const name = String(data.name ?? 'なぞのカピ').trim().slice(0, 20) || 'なぞのカピ';
        const level = Math.min(Math.max(parseInt(data.level) || 1, 1), 9999);
        const gold  = Math.max(parseInt(data.gold) || 0, 0);
        const kc    = Math.max(parseInt(data.kill_count) || 0, 0);
        await pool.query(
          'INSERT INTO rankings (name, level, gold, kill_count) VALUES ($1,$2,$3,$4)',
          [name, level, gold, kc]
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      } catch (e) {
        if (e.code === '23505') {
          res.writeHead(409, { 'content-type': 'application/json' });
          return res.end('{"ok":false,"error":"duplicate"}');
        }
        res.writeHead(400); return res.end('{"ok":false}');
      }
    }
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const name = String(data.name ?? '').trim().slice(0, 20);
        if (!name) { res.writeHead(400); return res.end('{"ok":false}'); }
        const level = Math.min(Math.max(parseInt(data.level) || 1, 1), 9999);
        const gold  = Math.max(parseInt(data.gold) || 0, 0);
        const kc    = Math.max(parseInt(data.kill_count) || 0, 0);
        const r = await pool.query(
          'UPDATE rankings SET level=$2, gold=$3, kill_count=$4 WHERE name=$1',
          [name, level, gold, kc]
        );
        if (r.rowCount === 0) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end('{"ok":false,"error":"not found"}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400); return res.end('{"ok":false}');
      }
    }
    res.writeHead(405); return res.end();
  }

  // ランキング管理API（管理者専用リセット）
  if (url === '/api/ranking/reset' && req.method === 'POST') {
    if (req.headers['x-admin-action'] !== 'ranking-reset') {
      res.writeHead(403); return res.end('forbidden');
    }
    try {
      await pool.query('DELETE FROM rankings');
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(500); return res.end('{"ok":false}');
    }
  }

  // プレイヤー遠隔指令 API
  if (url === '/api/playercmd' || url.startsWith('/api/playercmd?')) {
    // GET：対象プレイヤーの端末が ポーリングして 自分宛ての指令を取得（CORS 許可）
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, x-admin-action');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.writeHead(204); return res.end();
    }
    if (req.method === 'GET') {
      res.setHeader('access-control-allow-origin', '*');
      const name = String(new URL(url, 'http://x').searchParams.get('name') || '').trim().slice(0, 20);
      if (!name) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"id":0}'); }
      try {
        const r = await pool.query('SELECT cmd FROM player_commands WHERE name=$1', [name]);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(r.rows[0] ? r.rows[0].cmd : { id: 0 }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"id":0}');
      }
    }
    // POST：管理者のみ（ヘッダー認証、CORS なし）
    if (req.method === 'POST') {
      if (req.headers['x-admin-action'] !== 'player-cmd') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"forbidden"}');
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const name = String(body.name || '').trim().slice(0, 20);
        if (!name) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"noname"}'); }
        if (body.action === 'clear') {
          await pool.query('DELETE FROM player_commands WHERE name=$1', [name]);
          res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
        }
        // ランキングに 存在する名前か 確認（誤入力を 防ぐ）
        const exists = await pool.query('SELECT 1 FROM rankings WHERE name=$1 LIMIT 1', [name]);
        if (exists.rowCount === 0) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"ok":false,"error":"not found"}');
        }
        const cmd = { id: Date.now() };
        if (body.level !== undefined && body.level !== null && body.level !== '') {
          const lv = parseInt(body.level);
          if (Number.isFinite(lv)) cmd.level = Math.min(Math.max(lv, 1), 999);
        }
        if (body.stage !== undefined && body.stage !== null && body.stage !== '') {
          const st = parseInt(body.stage);
          if (Number.isFinite(st)) cmd.stage = Math.min(Math.max(st, 1), 45);
        }
        if (body.skin !== undefined && ['default','nagaimo','mage'].includes(body.skin)) {
          cmd.skin = body.skin;
        }
        if (cmd.level === undefined && cmd.stage === undefined && cmd.skin === undefined) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"ok":false,"error":"empty"}');
        }
        await pool.query(
          `INSERT INTO player_commands (name, cmd, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (name) DO UPDATE SET cmd=$2, updated_at=NOW()`,
          [name, JSON.stringify(cmd)]
        );
        // レベル指定があれば ランキングも その場で 強制更新（プレイヤーが オフラインでも 即反映）
        if (cmd.level !== undefined) {
          await pool.query('UPDATE rankings SET level=$2 WHERE name=$1', [name, cmd.level]);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, cmd }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false}');
      }
    }
    res.writeHead(405); return res.end();
  }

  // イベント API（期間限定ステージ / 経験値イベント）
  if (url === '/api/event') {
    // 公開：現在の イベント状態を 取得（全端末が ポーリング）。GET のみ CORS 許可。
    if (req.method === 'GET') {
      res.setHeader('access-control-allow-origin', '*');
      const state = await readEventState();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state));
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    // 管理者：イベントの 開始 / 停止（CORS を 付けない＝同一オリジン[管理者パネル]のみ）
    if (req.method === 'POST') {
      if (req.headers['x-admin-action'] !== 'event-write') {
        res.writeHead(403); return res.end('{"ok":false,"error":"forbidden"}');
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const state = await readEventState();
        const now = Date.now();
        const clampStat = (v, def) => {
          const n = parseInt(v);
          return (Number.isFinite(n) && n >= 0) ? Math.min(n, 9999999) : def;
        };
        const clampMin = (v, def) => {
          const n = parseInt(v);
          return (Number.isFinite(n) && n > 0) ? Math.min(n, 100000) : def;
        };
        if (body.action === 'setStage') {
          const e = body.enemy || {}, b = body.boss || {};
          const minutes = clampMin(body.minutes, 60);
          state.stage = {
            active: true,
            name: String(body.name || '').trim().slice(0, 30),
            bossName: String(body.bossName || '').trim().slice(0, 30),
            enemy: {
              hp: clampStat(e.hp, 100), atk: clampStat(e.atk, 20), def: clampStat(e.def, 10),
              exp: clampStat(e.exp, 50), gold: clampStat(e.gold, 30),
            },
            boss: {
              hp: clampStat(b.hp, 800), atk: clampStat(b.atk, 45), def: clampStat(b.def, 20),
              exp: clampStat(b.exp, 500), gold: clampStat(b.gold, 300),
            },
            until: now + minutes * 60000,
          };
        } else if (body.action === 'stopStage') {
          state.stage = { active: false };
        } else if (body.action === 'setXp') {
          const allowed = [2, 4, 8, 10, 20];
          const mult = allowed.includes(parseInt(body.mult)) ? parseInt(body.mult) : 2;
          const minutes = clampMin(body.minutes, 60);
          state.xp = { mult, until: now + minutes * 60000 };
        } else if (body.action === 'stopXp') {
          state.xp = { mult: 1, until: 0 };
        } else {
          res.writeHead(400); return res.end('{"ok":false,"error":"bad action"}');
        }
        await writeEventState(state);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, state: normalizeEventState(state) }));
      } catch (e) {
        res.writeHead(400); return res.end('{"ok":false}');
      }
    }
    res.writeHead(405); return res.end();
  }

  if (url === '/favicon.ico') return serveAsset(res, 'favicon.ico');
  if (url === '/apple-touch-icon.png' || url === '/apple-touch-icon-precomposed.png')
    return serveAsset(res, 'apple-touch-icon.png');
  if (url.startsWith('/assets/')) return serveAsset(res, url.slice('/assets/'.length));

  // Monaco Editor ローカル配信（CDN不要）
  if (url.startsWith('/monaco-min/')) {
    let rel = url.slice('/monaco-min/'.length).split('?')[0];
    if (!rel || rel.includes('..') || rel.startsWith('/')) { res.writeHead(400); return res.end(); }
    // バージョンをまたぐ安定エイリアス: vs/workerMain.js → 実際の workers-*.js
    if (rel === 'vs/workerMain.js') {
      try {
        const vsDir = path.join(__dir, 'node_modules', 'monaco-editor', 'min', 'vs');
        const w = fs.readdirSync(vsDir).find(f => /^workers-[^.]+\.js$/.test(f));
        if (w) rel = 'vs/' + w;
      } catch {}
    }
    const monacoPath = path.join(__dir, 'node_modules', 'monaco-editor', 'min', rel);
    const ext = path.extname(monacoPath).toLowerCase();
    const ctTypes = { '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2', '.png':'image/png' };
    if (!ctTypes[ext]) { res.writeHead(404); return res.end(); }
    try {
      const data = fs.readFileSync(monacoPath);
      res.writeHead(200, { 'content-type': ctTypes[ext], 'cache-control': 'public, max-age=604800, immutable' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end(); }
  }

  // クライアント傍受スクリプト
  if (url === '/__proxy__/client.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    });
    return res.end(CLIENT_SCRIPT);
  }
  // 封印エンドポイント。元URLをアクセスログやアドレスバーへ出さないためPOSTのみ。
  if (url === '/__seal' && req.method === 'POST') {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) { res.writeHead(413); return res.end(''); }
      chunks.push(c);
    }
    let spec;
    try { spec = JSON.parse(Buffer.concat(chunks).toString()); } catch { spec = {}; }
    let u = typeof spec.value === 'string' ? spec.value.trim() : '';
    if (u && !/^https?:\/\//i.test(u)) {
      if (spec.base) {
        try { u = new URL(u, unseal(spec.base)).href; } catch { u = ''; }
      } else {
        u = 'https://' + u;
      }
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    if (!u || !/^https?:\/\//i.test(u)) return res.end('');
    try { return res.end(seal(u)); } catch { return res.end(''); }
  }

  // ── /__seal/batch: 複数URLを一括封印（クライアントの同期XHR直列を解消）─
  if (url === '/__seal/batch' && req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    let specs;
    try { specs = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); return res.end('{}'); }
    if (!Array.isArray(specs)) { res.writeHead(400); return res.end('{}'); }
    const out = {};
    for (const spec of specs.slice(0, 200)) {
      if (!spec || typeof spec.key !== 'string' || typeof spec.value !== 'string') continue;
      let u = spec.value;
      if (!/^https?:\/\//i.test(u) && spec.base) {
        try { u = new URL(u, unseal(spec.base)).href; } catch { u = ''; }
      }
      if (/^https?:\/\//i.test(u)) {
        try { out[spec.key] = seal(u); } catch { out[spec.key] = null; }
      } else out[spec.key] = null;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify(out));
  }

  // 旧式の生URLクエリは元URL露出防止のため廃止。
  if (url.startsWith('/go?')) {
    res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('This URL format is no longer supported.');
  }

  // プロキシ本体
  if (url.startsWith(PREFIX)) {
    return handleProxy(req, res);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found.');
  } catch (e) {
    console.error('[handler]', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    }
  }
});

// HTTP keep-alive チューニング
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;

// ポートを即時バインド（ヘルスチェック対応: listenを最前方に移動）
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🦫 カピバラproxy 起動: http://0.0.0.0:${PORT}\n`);
});

// リアルなブラウザヘッダを構築（bot判定回避）
function buildFwdHeaders(req, targetUrl, accCookies) {
  const fwd = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'host' || lk === 'referer' || lk === 'origin' ||
        lk === 'cookie' || lk === 'accept-encoding' ||
        lk.startsWith('sec-fetch-') || lk.startsWith('sec-ch-') || lk === 'dnt') continue;
    fwd[k] = v;
  }
  const ua = req.headers['user-agent'] || UA;
  fwd['host']            = targetUrl.host;
  fwd['user-agent']      = ua;
  fwd['accept-encoding'] = safeAcceptEncoding(req.headers['accept-encoding']);
  if (!fwd['accept'])          fwd['accept']          = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  if (!fwd['accept-language']) fwd['accept-language'] = 'ja,en-US;q=0.9,en;q=0.8';

  // sec-fetch-* — Chromeと同じ値を注入（多くのCloudflare/CDNが検査する）
  fwd['sec-fetch-dest'] = 'document';
  fwd['sec-fetch-mode'] = 'navigate';
  fwd['sec-fetch-site'] = 'none';
  fwd['sec-fetch-user'] = '?1';
  fwd['upgrade-insecure-requests'] = '1';
  // sec-ch-ua（Chrome 124相当）
  if (/Chrome\/(\d+)/.test(ua)) {
    const ver = RegExp.$1 || '124';
    fwd['sec-ch-ua']          = `"Chromium";v="${ver}", "Google Chrome";v="${ver}", "Not-A.Brand";v="99"`;
    fwd['sec-ch-ua-mobile']   = '?0';
    fwd['sec-ch-ua-platform'] = '"Windows"';
  }

  const ro = deriveRefererOrigin(req.headers, targetUrl);
  if (ro.referer) fwd['referer'] = ro.referer;
  if (ro.origin)  fwd['origin']  = ro.origin;

  // クッキー: クライアント由来 + サーバー側リダイレクト追跡で積算したもの
  const clientCk = upstreamCookie(req.headers['cookie'], targetUrl.host) || '';
  const accCk    = Object.entries(accCookies)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`).join('; ');
  const ck = [clientCk, accCk].filter(Boolean).join('; ');
  if (ck) fwd['cookie'] = ck;

  return fwd;
}

// set-cookie ヘッダをパースして Map に蓄積
function accumulateCookies(setCookie, acc) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const s of list) {
    const pair = s.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    acc[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

async function handleProxy(req, res) {
  let target = req.url.slice(PREFIX.length);
  if (!target) { res.writeHead(400); return res.end('no target'); }

  try { target = decodeProxyUrl(target); } catch { res.writeHead(400); return res.end('bad url'); }
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let targetUrl;
  try { targetUrl = new URL(target); } catch { res.writeHead(400); return res.end('bad url'); }

  // SSRF対策: 内部アドレス宛を拒否
  try { await assertPublicHost(targetUrl.hostname); }
  catch { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Blocked: internal address not allowed'); }

  const method = req.method || 'GET';

  // リクエストボディ収集（POST等）
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413); return res.end('payload too large'); }
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  }

  // サーバー側リダイレクト追跡（最大15ホップ）
  // クッキーをホップをまたいで蓄積し、ログインセッション等を維持する
  const MAX_HOPS = 15;
  const accCookies = {}; // ホップ間で蓄積するクッキー
  let upstream, finalUrl = targetUrl, lastStatus = 0;
  let hopMethod = method;
  let hopBody = body;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const fwdHeaders = buildFwdHeaders(req, finalUrl, accCookies);

    try {
      upstream = await request(finalUrl.href, {
        method: hopMethod,
        headers: fwdHeaders,
        body: hopBody,
        bodyTimeout:   60_000,
        headersTimeout: 20_000,
        maxRedirections: 0, // 自前で追跡する
      });
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Upstream request failed');
    }

    lastStatus = upstream.statusCode;
    const h = upstream.headers;

    if (lastStatus >= 300 && lastStatus < 400) {
      const rawLoc = Array.isArray(h.location) ? h.location[0] : h.location;
      // Locationなし → ボディを流す
      if (!rawLoc) break;

      // クッキーを蓄積
      accumulateCookies(h['set-cookie'], accCookies);
      upstream.body.resume(); // ボディを捨ててコネクション解放

      let nextUrl;
      try { nextUrl = new URL(rawLoc, finalUrl.href); }
      catch { break; } // URL解決失敗 → そのまま流す

      // SSRF対策（リダイレクト先も確認）
      try { await assertPublicHost(nextUrl.hostname); }
      catch { upstream.body.resume(); res.writeHead(403, {'content-type':'text/plain'}); return res.end('Blocked: redirect to internal address'); }

      // 303/307/308 以外は POST→GET に従う
      if (lastStatus === 301 || lastStatus === 302 || lastStatus === 303) {
        hopMethod = 'GET'; hopBody = undefined;
      }
      finalUrl = nextUrl;

      if (hop === MAX_HOPS) {
        // ホップ上限 → クライアントにリダイレクト
        const redirHeaders = { location: encodeProxyUrl(finalUrl.href) };
        const sc = Object.entries(accCookies).map(([k,v])=>`${k}=${v}; Path=/`);
        if (sc.length) redirHeaders['set-cookie'] = namespaceSetCookies(sc, finalUrl.host);
        res.writeHead(302, redirHeaders);
        return res.end();
      }
      continue; // 次のホップへ
    }

    break; // 非リダイレクト → ボディ処理へ
  }

  const status = lastStatus;
  const h = upstream.headers;
  const ctype = (h['content-type'] || '').toLowerCase();
  const enc   = Array.isArray(h['content-encoding']) ? h['content-encoding'][0] : h['content-encoding'];
  const isHtml = ctype.includes('text/html');
  const isCss  = ctype.includes('text/css');
  const rewriteBody = isHtml || isCss;

  // レスポンスヘッダ構築
  const outHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (HOP_BY_HOP.has(k.toLowerCase()) || URL_LEAK_HEADERS.has(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  // リダイレクト追跡中に蓄積したクッキー + 最終ホップのクッキーをまとめて返す
  const mergedSc = [...(Array.isArray(h['set-cookie']) ? h['set-cookie'] : h['set-cookie'] ? [h['set-cookie']] : [])];
  if (mergedSc.length) outHeaders['set-cookie'] = namespaceSetCookies(mergedSc, finalUrl.host);
  outHeaders['access-control-allow-origin'] = '*';

  // キャッシュキー: GETかつ最終URLで
  const cacheKey = hopMethod === 'GET' ? finalUrl.href : null;

  if (rewriteBody) {
    if (cacheKey && status === 200) {
      const ttl = isHtml ? CACHE_TTL_HTML : CACHE_TTL_CSS;
      const hit = cacheGet(cacheKey, ttl);
      if (hit) {
        upstream.body.resume();
        return sendBody(req, res, hit.status, hit.headers, hit.body);
      }
    }

    const chunks = [];
    for await (const c of upstream.body) chunks.push(c);
    let buf = Buffer.concat(chunks);
    buf = decompress(buf, enc);
    let text = decodeBody(buf, h['content-type']);
    text = isHtml ? rewriteHtml(text, finalUrl.href) : rewriteCss(text, finalUrl.href);
    const outBuf = Buffer.from(text, 'utf-8');
    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    outHeaders['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';

    if (cacheKey && status === 200) {
      const { 'set-cookie': _sc, ...cacheable } = outHeaders;
      cacheSet(cacheKey, { status, headers: cacheable, body: outBuf });
    }
    return sendBody(req, res, status, outHeaders, outBuf);
  }

  const isJs = ctype.includes('javascript');
  // JS/JSON/フォント/SVG等: ISGCの大容量バイナリ判定を回避するため未圧縮なら自動gzip + キャッシュ
  const isCompressible = !enc && (
    isJs || ctype.includes('json') ||
    ctype.includes('text/') || ctype.includes('font/') ||
    ctype.includes('application/x-font') || ctype.includes('application/font') ||
    ctype.includes('image/svg')
  );
  const clientAcceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');

  if (isCompressible && clientAcceptsGzip) {
    // JSキャッシュヒット確認（gzip済みバッファをそのまま返す）
    if (isJs && cacheKey && status === 200) {
      const hit = cacheGet(cacheKey, CACHE_TTL_JS);
      if (hit) {
        upstream.body.resume();
        return sendBody(req, res, hit.status, hit.headers, hit.body);
      }
    }
    const rawChunks = [];
    for await (const c of upstream.body) rawChunks.push(c);
    const rawBuf = Buffer.concat(rawChunks);
    if (rawBuf.length > 1024) {
      try {
        const compressed = await gzipCompress(rawBuf, { level: 4 });
        delete outHeaders['content-length'];
        outHeaders['content-encoding'] = 'gzip';
        outHeaders['content-length'] = compressed.length;
        // JSはキャッシュ（最大4MB以下）
        if (isJs && cacheKey && status === 200 && compressed.length < 4 * 1024 * 1024) {
          const { 'set-cookie': _sc, ...cacheable } = outHeaders;
          cacheSet(cacheKey, { status, headers: cacheable, body: compressed });
        }
        res.writeHead(status, outHeaders);
        return res.end(compressed);
      } catch {
        res.writeHead(status, outHeaders);
        return res.end(rawBuf);
      }
    }
    res.writeHead(status, outHeaders);
    return res.end(rawBuf);
  }

  // 画像/動画/バイナリ等: そのままストリーム
  if (enc) outHeaders['content-encoding'] = enc;
  res.writeHead(status, outHeaders);
  upstream.body.pipe(res);
}

// === PvP オンライン対戦 ルーム管理 ===
const pvpWss = new WebSocketServer({ noServer: true });
const pvpRooms = new Map(); // code → { code, host, guest }

function makePvpCode(){
  for(let i=0;i<200;i++){
    const c=Math.random().toString(36).slice(2,6).toUpperCase();
    if(!pvpRooms.has(c)) return c;
  }
  return null;
}
function pvpSendMsg(ws,obj){
  if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function pvpRoomOf(ws){
  for(const r of pvpRooms.values()) if(r.host===ws||r.guest===ws) return r;
  return null;
}
function pvpHandleDisconnect(ws){
  const r=pvpRoomOf(ws);
  if(!r) return;
  const other=r.host===ws?r.guest:r.host;
  pvpSendMsg(other,{type:'OPPONENT_LEFT'});
  pvpRooms.delete(r.code);
}
pvpWss.on('connection', ws=>{
  ws.on('message', raw=>{
    let msg; try{ msg=JSON.parse(raw.toString()); }catch{ return; }
    switch(msg.type){
      case 'CREATE_ROOM': {
        const old=pvpRoomOf(ws); if(old) pvpRooms.delete(old.code);
        const code=makePvpCode();
        if(!code){ pvpSendMsg(ws,{type:'ERROR',text:'部屋を作れませんでした'}); return; }
        pvpRooms.set(code,{code,host:ws,guest:null});
        pvpSendMsg(ws,{type:'ROOM_CREATED',code});
        break;
      }
      case 'JOIN_ROOM': {
        const code=(msg.code||'').toUpperCase().trim();
        const r=pvpRooms.get(code);
        if(!r){ pvpSendMsg(ws,{type:'ERROR',text:'その部屋は みつかりません'}); return; }
        if(r.guest){ pvpSendMsg(ws,{type:'ERROR',text:'その部屋は 満員です'}); return; }
        if(r.host===ws){ pvpSendMsg(ws,{type:'ERROR',text:'自分の部屋には 入れません'}); return; }
        r.guest=ws;
        pvpSendMsg(r.host, {type:'MATCH_START',role:'host'});
        pvpSendMsg(r.guest,{type:'MATCH_START',role:'guest'});
        break;
      }
      case 'RELAY': {
        const r=pvpRoomOf(ws); if(!r) return;
        const other=r.host===ws?r.guest:r.host;
        pvpSendMsg(other,{type:'RELAY',payload:msg.payload});
        break;
      }
    }
  });
  ws.on('close',()=>pvpHandleDisconnect(ws));
  ws.on('error',()=>pvpHandleDisconnect(ws));
});

// --- CodeStudio コード実行 WebSocket ------------------------------------
const CODE_LANGS = {
  python:     { label:'Python 3',          exts:['.py','.pyw'],        need:[['python3','python']], cmds:(e,s,w)=>[[e[0],'-u',s]] },
  javascript: { label:'JavaScript (Node)', exts:['.js','.mjs','.cjs'], need:[['node']],            cmds:(e,s,w)=>[[e[0],s]] },
  typescript: { label:'TypeScript (Deno)', exts:['.ts'],               need:[['deno']],            cmds:(e,s,w)=>[[e[0],'run','--quiet','--allow-all',s]] },
  c:          { label:'C (gcc)',           exts:['.c'],                need:[['gcc','clang']],     cmds:(e,s,w)=>[[e[0],s,'-O2','-o',path.join(w,'prog')],[path.join(w,'prog')]] },
  cpp:        { label:'C++ (g++)',         exts:['.cpp','.cc','.cxx'], need:[['g++','clang++']],   cmds:(e,s,w)=>[[e[0],s,'-O2','-std=c++17','-o',path.join(w,'prog')],[path.join(w,'prog')]] },
  java:       { label:'Java',             exts:['.java'],             need:[['javac'],['java']],  cmds:(e,s,w)=>[[e[0],'-d',w,s],[e[1],'-cp',w,path.basename(s,'.java')]] },
  ruby:       { label:'Ruby',             exts:['.rb'],               need:[['ruby']],            cmds:(e,s,w)=>[[e[0],s]] },
  go:         { label:'Go',              exts:['.go'],               need:[['go']],              cmds:(e,s,w)=>[[e[0],'run',s]] },
  rust:       { label:'Rust',            exts:['.rs'],               need:[['rustc']],           cmds:(e,s,w)=>[[e[0],'-O',s,'-o',path.join(w,'prog')],[path.join(w,'prog')]] },
  shell:      { label:'Shell (bash)',     exts:['.sh'],               need:[['bash']],            cmds:(e,s,w)=>[[e[0],s]] },
};

function findRuntime(candidates) {
  for (const name of candidates) {
    try { const p = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim(); if (p) return p; }
    catch {}
  }
  return null;
}

function getCodeLanguages() {
  return Object.entries(CODE_LANGS).map(([id, spec]) => ({
    id, label: spec.label, exts: spec.exts,
    available: spec.need.every(group => !!findRuntime(group)),
  }));
}

const runWss = new WebSocketServer({ noServer: true });
const MAX_RUN_SECONDS = 120;
const MAX_OUT_BYTES = 2 * 1024 * 1024;

runWss.on('connection', (ws) => {
  let proc = null, killTimer = null, workdir = null;

  function wsSend(obj) {
    if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(obj)); } catch {}
  }
  function cleanup() {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (proc) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      proc = null;
    }
    if (workdir) { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {} workdir = null; }
  }

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'run') {
      cleanup();
      const spec = CODE_LANGS[msg.language];
      if (!spec) { wsSend({ type: 'error', message: '未対応の言語: ' + msg.language }); return; }
      const exes = spec.need.map(g => findRuntime(g));
      if (exes.some(e => !e)) { wsSend({ type: 'error', message: spec.label + ' のランタイムがサーバーにありません' }); return; }

      // 一時ディレクトリにファイルを書き出す
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpcode_'));
      const files = msg.files || [], entry = msg.entry || '';
      for (const f of files) {
        if (!f.path || !/^[a-zA-Z0-9._\-/]+$/.test(f.path)) continue;
        const fp = path.join(workdir, f.path.replace(/^\/+/, ''));
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, f.content || '', 'utf8');
      }
      const srcPath = path.join(workdir, entry);
      if (!fs.existsSync(srcPath)) { wsSend({ type: 'error', message: 'エントリファイルなし: ' + entry }); cleanup(); return; }

      const commands = spec.cmds(exes, srcPath, workdir);
      // コンパイルステップ（最後以外）
      for (const cmd of commands.slice(0, -1)) {
        wsSend({ type: 'system', message: 'コンパイル中...' });
        const r = spawnSync(cmd[0], cmd.slice(1), { cwd: workdir, encoding: 'utf8', timeout: 60000 });
        if (r.stdout) wsSend({ type: 'stdout', data: r.stdout });
        if (r.stderr) wsSend({ type: 'stderr', data: r.stderr });
        if (r.status !== 0) { wsSend({ type: 'exit', code: r.status ?? 1 }); cleanup(); return; }
      }

      const runCmd = commands[commands.length - 1];
      let outBytes = 0;
      proc = spawn(runCmd[0], runCmd.slice(1), {
        cwd: workdir, stdio: ['pipe','pipe','pipe'], detached: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', NODE_OPTIONS: '' },
      });
      wsSend({ type: 'start', command: path.basename(runCmd[0]) + ' ' + path.basename(entry) });
      killTimer = setTimeout(() => {
        wsSend({ type: 'system', message: `実行時間 ${MAX_RUN_SECONDS}秒超過のため停止` });
        cleanup();
      }, MAX_RUN_SECONDS * 1000);
      proc.stdout.on('data', (d) => {
        outBytes += d.length; wsSend({ type: 'stdout', data: d.toString('utf8') });
        if (outBytes > MAX_OUT_BYTES) { wsSend({ type: 'system', message: '出力サイズ上限超過' }); cleanup(); }
      });
      proc.stderr.on('data', (d) => { outBytes += d.length; wsSend({ type: 'stderr', data: d.toString('utf8') }); });
      proc.on('exit', (code) => { wsSend({ type: 'exit', code: code ?? -1 }); cleanup(); });
      proc.on('error', (e) => { wsSend({ type: 'error', message: e.message }); cleanup(); });

    } else if (msg.type === 'stdin') {
      if (proc && !proc.killed) try { proc.stdin.write(msg.data || ''); } catch {}
    } else if (msg.type === 'kill') {
      wsSend({ type: 'system', message: 'ユーザーにより停止' }); cleanup();
    }
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// --- WebSocket プロキシ -------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  if(req.url==='/ws/battle'){
    pvpWss.handleUpgrade(req,socket,head,ws=>pvpWss.emit('connection',ws,req));
    return;
  }
  // CodeStudio コード実行WebSocket（認証必須）
  if (req.url === '/ws/run') {
    const sess = await getAuthSession(req);
    if (!sess) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    runWss.handleUpgrade(req, socket, head, (ws) => runWss.emit('connection', ws, req));
    return;
  }
  if (!req.url.startsWith(PREFIX)) { socket.destroy(); return; }
  let original;
  try { original = decodeProxyUrl(req.url.slice(PREFIX.length)); }
  catch { socket.destroy(); return; }

  let u;
  try { u = new URL(original); } catch { socket.destroy(); return; }
  if (u.protocol === 'http:')  u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';

  try { await assertPublicHost(u.hostname); }
  catch { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (client) => {
    const headers = {};
    const uc = upstreamCookie(req.headers['cookie'], u.host);
    if (uc) headers['cookie'] = uc;
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    headers['origin'] = u.origin.replace(/^ws/, 'http');

    const upstream = new WebSocket(u.href, {
      headers,
      handshakeTimeout: 15_000,
      rejectUnauthorized: false,
    });

    const queue = [];
    client.on('message', (d, bin) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(d, { binary: bin }) : queue.push([d, bin]));
    upstream.on('open', () => { for (const [d, b] of queue) upstream.send(d, { binary: b }); queue.length = 0; });
    upstream.on('message', (d, bin) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: bin }); });

    const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    client.on('close', closeBoth); upstream.on('close', closeBoth);
    client.on('error', closeBoth); upstream.on('error', closeBoth);
  });
});
