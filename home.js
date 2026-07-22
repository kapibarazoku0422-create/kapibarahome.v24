/*!
 * カピバラproxy — ホームページ
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. See LICENSE. Watermark: KPBR-9f3a2c7e
 */

const QUICK_URLS = [
  { label: 'Google',      url: 'https://www.google.com' },
  { label: 'Wikipedia',   url: 'https://www.wikipedia.org' },
  { label: 'Hacker News', url: 'https://news.ycombinator.com' },
  { label: 'example.com', url: 'https://example.com' },
];

export function makeHomePage(encodeProxyUrl) {
  const quickLinks = QUICK_URLS.map(({ label, url }) =>
    `<a href="${encodeProxyUrl(url)}">${label}</a>`
  ).join('\n    ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🦫 カピバラの学習サイト</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0f172a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="カピバラの学習サイト">
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
       font-family:system-ui,'Segoe UI',sans-serif;
       background:radial-gradient(circle at 30% 20%,#1e293b,#0f172a 60%,#020617);color:#e2e8f0}
  .logo{margin-bottom:12px;border-radius:24px;background:#f8fafc;padding:6px;
        box-shadow:0 8px 30px rgba(0,0,0,.35)}
  h1{margin:0 0 4px;font-size:34px;font-weight:800;letter-spacing:-1px}
  p.sub{margin:0 0 32px;color:#94a3b8}
  form{display:flex;width:min(640px,90vw);gap:8px}
  input{flex:1;padding:16px 20px;border:1px solid #334155;border-radius:12px;background:#1e293b;
        color:#f1f5f9;font-size:16px;outline:none;transition:.2s}
  input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.25)}
  button{padding:0 28px;border:0;border-radius:12px;cursor:pointer;font-size:16px;font-weight:700;
         background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff}
  button:hover{filter:brightness(1.1)}
  .quick{margin-top:24px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .quick a{padding:8px 16px;border-radius:999px;background:#1e293b;border:1px solid #334155;
           color:#cbd5e1;text-decoration:none;font-size:14px}
  .quick a:hover{border-color:#38bdf8;color:#fff}
  .game-link{display:flex;align-items:center;gap:12px;margin-top:10px;
             padding:14px 22px;border-radius:14px;background:#1e293b;
             border:1px solid #334155;text-decoration:none;color:#e2e8f0;
             transition:.2s;max-width:min(640px,90vw);width:100%}
  .game-link:first-of-type{margin-top:28px}
  .game-link:hover{border-color:#ffd34e;background:#1e3050;color:#fff}
  .game-link .game-icon{font-size:28px;line-height:1}
  .game-link .game-text{display:flex;flex-direction:column;gap:2px}
  .game-link .game-title{font-size:15px;font-weight:700;color:#ffd34e}
  .game-link .game-desc{font-size:12px;color:#94a3b8}
  .yt-badge-inline{font-size:10px;padding:2px 7px;border-radius:99px;
                   background:#1a1a2e;border:1px solid #ef4444;color:#fca5a5;margin-left:6px;vertical-align:middle}
  footer{margin-top:40px;color:#475569;font-size:13px}

  /* AIコーナー */
  .ai-wrap{margin-top:16px;width:min(640px,90vw)}
  .ai-card{background:#1e293b;border:1px solid #334155;border-radius:16px;overflow:hidden}
  .ai-head{display:flex;align-items:center;gap:10px;padding:16px 20px;
           border:0;border-bottom:1px solid #334155;cursor:pointer;user-select:none;
           width:100%;background:transparent;color:inherit;text-align:left;font:inherit;touch-action:manipulation}
  .ai-head-title{font-weight:700;font-size:15px}
  .ai-head-desc{font-size:12px;color:#64748b;margin-left:auto}
  .ai-body{padding:16px 20px;display:none}
  .ai-body.open{display:flex;flex-direction:column;gap:12px}
  .ai-msgs{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;padding-right:2px}
  .ai-msg{padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
  .ai-msg.user{background:#0c2340;border:1px solid #1e40af;color:#bfdbfe;align-self:flex-end;max-width:85%}
  .ai-msg.ai{background:#0f172a;border:1px solid #1e3a2a;color:#bbf7d0;align-self:flex-start;max-width:95%}
  .ai-msg.err{background:#200;border:1px solid #7f1d1d;color:#fca5a5;font-size:13px;align-self:flex-start;max-width:95%}
  .ai-input-row{display:flex;gap:8px;align-items:flex-end}
  .ai-textarea{flex:1;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#e2e8f0;
               font-size:14px;font-family:inherit;padding:10px 14px;outline:none;resize:none;
               line-height:1.5;max-height:120px;transition:.2s}
  .ai-textarea:focus{border-color:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.18)}
  .ai-send{padding:10px 18px;border:0;border-radius:10px;cursor:pointer;font-size:13px;font-weight:700;
           background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;white-space:nowrap;flex-shrink:0}
  .ai-send:disabled{opacity:.45;cursor:default}
  .ai-send:not(:disabled):hover{filter:brightness(1.1)}
  .ai-model{font-size:11px;color:#475569;text-align:right}

  /* コードエディタ */
  .ed-wrap{margin-top:16px;width:min(640px,90vw)}
  .ed-card{display:flex;align-items:center;gap:10px;padding:16px 20px;
           background:#1e293b;border:1px solid #334155;border-radius:16px;
           cursor:pointer;user-select:none;text-decoration:none;color:inherit;
           transition:border-color .15s,background .15s}
  .ed-card:hover{border-color:#4f8cff;background:#1a2844}
  .ed-badge{font-size:11px;padding:2px 7px;border-radius:99px;background:#0a1a3a;
            border:1px solid #1e3a6e;color:#60a5fa;margin-left:4px;vertical-align:middle}
  .ed-head-title{font-weight:700;font-size:15px}
  .ed-head-desc{font-size:12px;color:#64748b;margin-left:auto}

</style>
</head>
<body>
  <img class="logo" src="/assets/icon-192.png" alt="capybara" width="120" height="120">
  <h1>カピバラの学習サイト</h1>
  <p class="sub">のんびり最強。URLを入れるとプロキシ経由で表示します</p>
  <form id="goForm">
    <input id="goInput" autofocus placeholder="example.com または https://..." autocomplete="off">
    <button type="submit">Go</button>
  </form>
  <div class="quick">
    ${quickLinks}
  </div>
  <a class="game-link" href="/game" target="_blank">
    <span class="game-icon">🦫</span>
    <span class="game-text">
      <span class="game-title">カピバラクエスト 〜キメ顔の勇者〜</span>
      <span class="game-desc">ブラウザで遊べる本格RPG・プロキシ不使用</span>
    </span>
    <span style="margin-left:auto;color:#475569;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="https://threed-cotb.onrender.com/" target="_blank" rel="noopener" style="border-color:#b8873b">
    <span class="game-icon">🕶️</span>
    <span class="game-text">
      <span class="game-title" style="color:#f5c56b">カピバラ帝国記 — 長芋戦役</span>
      <span class="game-desc">グラサンカピバラが帝国を築き、長芋族と戦う本格3DアクションRPG</span>
    </span>
    <span style="margin-left:auto;color:#b8873b;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="https://kapibara-board.onrender.com/" target="_blank" rel="noopener" style="border-color:#38bdf8">
    <span class="game-icon">💬</span>
    <span class="game-text">
      <span class="game-title" style="color:#7dd3fc">Kapibara Board</span>
      <span class="game-desc">好きな話をのんびり楽しめるコミュニティ掲示板</span>
    </span>
    <span style="margin-left:auto;color:#38bdf8;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="https://tawadhifens.onrender.com/" target="_blank" rel="noopener" style="border-color:#5b3b83">
    <span class="game-icon">🏰</span>
    <span class="game-text">
      <span class="game-title" style="color:#c4a7ff">絵文字タワーディフェンス</span>
      <span class="game-desc">絵文字のタワーで敵を迎え撃つタワーディフェンス</span>
    </span>
    <span style="margin-left:auto;color:#475569;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="https://neon-rift-tk7u.onrender.com/" target="_blank" rel="noopener" style="border-color:#ff2fb3">
    <span class="game-icon">🚀</span>
    <span class="game-text">
      <span class="game-title" style="color:#5eefff">NEON <span style="color:#ff2fb3">RIFT</span></span>
      <span class="game-desc">3Dで障害物を避けながら進む軽量ランゲーム</span>
    </span>
    <span style="margin-left:auto;color:#ff2fb3;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="/yt" style="border-color:#2d1a1a">
    <span class="game-icon">▶️</span>
    <span class="game-text">
      <span class="game-title" style="color:#f87171">YouTube<span class="yt-badge-inline">proxy経由</span></span>
      <span class="game-desc">キーワード検索・proxy経由で再生</span>
    </span>
    <span style="margin-left:auto;color:#475569;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="/mc" target="_blank" style="border-color:#3a5c2a">
    <span class="game-icon">⛏️</span>
    <span class="game-text">
      <span class="game-title" style="color:#7ec850">Minecraft 1.8<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:#1a2e1a;border:1px solid #5d8a3c;color:#a8d87a;margin-left:6px;vertical-align:middle">Eaglercraft</span></span>
      <span class="game-desc">ブラウザで遊べるMinecraft 1.8・シングル&マルチ対応</span>
    </span>
    <span style="margin-left:auto;color:#475569;font-size:18px">▶</span>
  </a>
  <a class="game-link" href="/neon" target="_blank" style="border-color:#1a1a3a">
    <span class="game-icon">⚡</span>
    <span class="game-text">
      <span class="game-title" style="color:#4df3ff">NEON SURVIVOR<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:#0a0a2a;border:1px solid #2a2a6a;color:#7070ff;margin-left:6px;vertical-align:middle">ローグライト</span></span>
      <span class="game-desc">攻撃は全自動、キミは動くだけ。武器進化×永久強化のサバイバー</span>
    </span>
    <span style="margin-left:auto;color:#475569;font-size:18px">▶</span>
  </a>

  <!-- AIコーナー -->
  <div class="ai-wrap">
    <div class="ai-card">
      <button class="ai-head" id="aiHead" type="button" aria-expanded="false" aria-controls="aiBody">
        <span style="font-size:22px">🤖</span>
        <span class="ai-head-title">AIコーナー <span style="font-size:11px;padding:2px 7px;border-radius:99px;background:#0a2a1a;border:1px solid #166534;color:#4ade80;margin-left:4px;vertical-align:middle">Groq</span></span>
        <span class="ai-head-desc">クリックで開く</span>
      </button>
      <div class="ai-body" id="aiBody">
        <div class="ai-msgs" id="aiMsgs">
          <div class="ai-msg ai">🦫 なんでも聞いてね！勉強のこと、なんでもOKだよ</div>
        </div>
        <div class="ai-input-row">
          <textarea class="ai-textarea" id="aiInput" rows="1" placeholder="メッセージを入力…" autocomplete="off"></textarea>
          <button class="ai-send" id="aiSend">送信</button>
        </div>
        <div class="ai-model">llama-3.3-70b-versatile · Groq</div>
      </div>
    </div>
  </div>

  <!-- コードエディタ -->
  <div class="ed-wrap">
    <a class="ed-card" href="/editor" target="_blank" rel="noopener">
      <span style="font-size:22px">⚡</span>
      <span class="ed-head-title">コードエディタ<span class="ed-badge">CodeStudio</span></span>
      <span class="ed-head-desc">クリックで開く →</span>
    </a>
  </div>

  <div class="ed-wrap">
    <a class="ed-card" href="/tool" style="border-color:#0e7490;background:linear-gradient(135deg,#172554,#0f172a)">
      <span style="font-size:22px">🧰</span>
      <span class="ed-head-title" style="color:#67e8f9">ミニツール<span class="ed-badge" style="border-color:#0891b2;color:#67e8f9">10 TOOLS</span></span>
      <span class="ed-head-desc">便利ツールを開く →</span>
    </a>
  </div>

  <footer>streaming · gzip/br · HTML/CSS rewrite · dynamic intercept</footer>
<script>
/* ── AIコーナー ─────────────────────────────── */
(function(){
  var aiHead  = document.getElementById('aiHead');
  var aiBody  = document.getElementById('aiBody');
  var aiMsgs  = document.getElementById('aiMsgs');
  var aiInput = document.getElementById('aiInput');
  var aiSend  = document.getElementById('aiSend');
  var aiHistory = []; // {role:'user'|'assistant', content:'...'}

  aiHead.addEventListener('click', function() {
    var open = aiBody.classList.toggle('open');
    aiHead.setAttribute('aria-expanded', open ? 'true' : 'false');
    aiHead.querySelector('.ai-head-desc').textContent = open ? 'クリックで閉じる' : 'クリックで開く';
    if (open) aiInput.focus();
  });

  // textareaの自動高さ調整
  aiInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Enterで送信（Shift+Enterは改行）
  aiInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });

  aiSend.addEventListener('click', sendMsg);

  function addMsg(role, text) {
    var div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    div.textContent = text;
    aiMsgs.appendChild(div);
    aiMsgs.scrollTop = aiMsgs.scrollHeight;
    return div;
  }

  function sendMsg() {
    var msg = aiInput.value.trim();
    if (!msg || aiSend.disabled) return;
    aiInput.value = ''; aiInput.style.height = 'auto';
    addMsg('user', msg);
    aiHistory.push({role:'user', content:msg});
    aiSend.disabled = true;
    var loadingDiv = addMsg('ai', '…');
    fetch('/api/ai', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({messages: aiHistory.slice(-20)}),
    })
      .then(function(r){ return r.json(); })
      .then(function(d) {
        loadingDiv.remove();
        if (d.error) {
          addMsg('err', '⚠ ' + d.error);
        } else {
          var reply = d.reply || '（返答なし）';
          aiHistory.push({role:'assistant', content:reply});
          addMsg('ai', reply);
        }
      })
      .catch(function(e) {
        loadingDiv.remove();
        addMsg('err', '⚠ 通信エラー: ' + e.message);
      })
      .finally(function() { aiSend.disabled = false; aiInput.focus(); });
  }
})();

/* ── ホームページURLフォーム ───────────────── */
(function(){
  // --- YouTube URL → 専用プレイヤー/検索 ---
  function tryYouTube(url) {
    try {
      var u = new URL(url);
      var host = u.hostname.replace(/^(www\.|m\.)/, '');
      if (host === 'youtu.be') {
        var id = u.pathname.slice(1).split(/[/?#]/)[0];
        if (id) { location.href = '/ytw?v=' + btoa(id); return true; }
      }
      if (host === 'youtube.com') {
        var sm = u.pathname.match(/^\\/shorts\\/([A-Za-z0-9_-]{11})/);
        if (sm) { location.href = '/ytw?v=' + btoa(sm[1]); return true; }
        if (u.pathname === '/watch') {
          var v = u.searchParams.get('v');
          if (v) { location.href = '/ytw?v=' + btoa(v); return true; }
        }
        var sq = u.searchParams.get('search_query') || u.searchParams.get('q');
        if (u.pathname === '/results' && sq) { location.href = '/yt?q=' + encodeURIComponent(sq); return true; }
        location.href = '/yt'; return true;
      }
    } catch(e) {}
    return false;
  }

  // --- ホームページURLフォーム ---
  document.getElementById('goForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var val = document.getElementById('goInput').value.trim();
    if (!val) return;
    if (val.indexOf('http://') !== 0 && val.indexOf('https://') !== 0) val = 'https://' + val;
    if (tryYouTube(val)) return;
    fetch('/__seal', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({value:val})
    })
      .then(function(r){return r.text();})
      .then(function(token){
        if (!token) throw new Error('URLを保護できませんでした');
        location.href = '/p/' + token;
      })
      .catch(function(){ alert('URLを開けませんでした。もう一度お試しください。'); });
  });

})();
</script>
</body>
</html>`;
}
