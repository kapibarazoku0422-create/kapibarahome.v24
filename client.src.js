/*!
 * カピバラproxy — client interceptor (browser side)
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. See LICENSE. Watermark: KPBR-9f3a2c7e
 */
(function(){
  var PREFIX='/p/';
  var me=document.currentScript;
  var BASE=(me&&me.getAttribute('data-base'))||location.href;

  // ----- シールキャッシュ + 非同期バッチキュー ----------------------------
  var sealCache=new Map();          // url → token | null
  var batchQueue=new Map();         // url → [resolve, ...]
  var batchTimer=null;

  function flushBatch(){
    if(!batchQueue.size) return;
    var urls=Array.from(batchQueue.keys());
    var snap=new Map(batchQueue);
    batchQueue.clear(); batchTimer=null;
    var xhr=new XMLHttpRequest();
    xhr.open('POST','/__seal/batch',true);
    xhr.setRequestHeader('content-type','application/json');
    xhr.onload=function(){
      var result={};
      try{ result=JSON.parse(xhr.responseText); }catch(e){}
      urls.forEach(function(u){
        var tok=result[u]||null;
        sealCache.set(u,tok);
        var cbs=snap.get(u); if(cbs) cbs.forEach(function(fn){ fn(tok); });
      });
    };
    xhr.onerror=function(){
      urls.forEach(function(u){
        sealCache.set(u,null);
        var cbs=snap.get(u); if(cbs) cbs.forEach(function(fn){ fn(null); });
      });
    };
    xhr.send(JSON.stringify(urls));
  }

  // 非同期シール（fetch/location等の非ブロッキング系で使う）
  function sealAsync(abs){
    return new Promise(function(resolve){
      var hit=sealCache.get(abs);
      if(hit!==undefined){ resolve(hit); return; }
      var q=batchQueue.get(abs);
      if(q){ q.push(resolve); }
      else{ batchQueue.set(abs,[resolve]); }
      if(!batchTimer) batchTimer=setTimeout(flushBatch,8);
    });
  }

  // 同期シール（XHR.open傍受など同期必須の箇所専用）
  // DOMContentLoadedのpre-sealで多くはキャッシュ済みになるため実際の同期XHRは激減する
  function sealSync(abs){
    var hit=sealCache.get(abs);
    if(hit!==undefined) return hit;
    var token=null;
    try{
      var x=new XMLHttpRequest();
      x.open('GET','/__seal?u='+encodeURIComponent(abs),false);
      x.send();
      if(x.status===200&&x.responseText) token=x.responseText;
    }catch(e){}
    if(sealCache.size>8000) sealCache.clear();
    sealCache.set(abs,token); return token;
  }

  function isProxied(u){
    return u.indexOf(location.origin+PREFIX)===0||u.indexOf(PREFIX)===0;
  }
  function toAbs(u){
    if(u==null) return null; u=''+u;
    if(/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(u)) return null;
    try{ return new URL(u,BASE).href; }catch(e){ return null; }
  }
  function toProxySync(u){
    if(u==null) return u;
    var s=''+u;
    if(isProxied(s)) return s;
    var abs=toAbs(s); if(abs==null) return u;
    var t=sealSync(abs);
    return t? PREFIX+t : u;
  }
  async function toProxyAsync(u){
    if(u==null) return u;
    var s=''+u;
    if(isProxied(s)) return s;
    var abs=toAbs(s); if(abs==null) return u;
    var t=await sealAsync(abs);
    return t? PREFIX+t : u;
  }
  window.__toProxy=toProxySync;

  // ----- Service Worker をブロック（SW はプロキシをバイパスするため）----
  if(navigator.serviceWorker){
    try{
      navigator.serviceWorker.register=function(){
        return Promise.reject(new Error('SW blocked by proxy'));
      };
      if(navigator.serviceWorker.getRegistrations){
        navigator.serviceWorker.getRegistrations().then(function(regs){
          regs.forEach(function(r){ try{r.unregister();}catch(e){} });
        });
      }
    }catch(e){}
  }

  // ----- WebRTC をブロック（実IPがISGCフィルタに漏れる）-----------------
  ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection'].forEach(function(n){
    try{ window[n]=function(){ throw new Error('WebRTC blocked by proxy'); }; }catch(e){}
  });

  // ----- EventSource（SSE）傍受 ------------------------------------------
  var _ES=window.EventSource;
  if(_ES){
    var ESProxy=function(url,init){
      try{ url=toProxySync(url); }catch(e){}
      return new _ES(url,init);
    };
    try{ ESProxy.prototype=_ES.prototype; }catch(e){}
    window.EventSource=ESProxy;
  }

  // ----- fetch（非同期バッチ化）------------------------------------------
  var _fetch=window.fetch;
  if(_fetch){
    window.fetch=function(input,init){
      try{
        if(typeof input==='string'){
          var abs=toAbs(input);
          if(abs&&!isProxied(input)){
            return sealAsync(abs).then(function(t){
              return _fetch.call(window, t? PREFIX+t : input, init);
            });
          }
        } else if(input&&input.url&&!isProxied(input.url)){
          var abs2=toAbs(input.url);
          if(abs2){
            return sealAsync(abs2).then(function(t){
              return _fetch.call(window, t? new Request(PREFIX+t,input) : input, init);
            });
          }
        }
      }catch(e){}
      return _fetch.call(window,input,init);
    };
  }

  // ----- XHR（同期シール = キャッシュ命中で高速）-------------------------
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{
      if((''+u).indexOf('/__seal')===-1&&(''+u).indexOf('/__proxy')===-1){
        u=toProxySync(u);
      }
    }catch(e){}
    return _open.apply(this,[m,u].concat([].slice.call(arguments,2)));
  };

  // ----- WebSocket --------------------------------------------------------
  var _WS=window.WebSocket;
  if(_WS){
    var WSProxy=function(url,protocols){
      try{
        var abs=toAbs(url);
        if(abs&&!isProxied(url)){
          var t=sealSync(abs);
          if(t){
            var scheme=location.protocol==='https:'?'wss:':'ws:';
            url=scheme+'//'+location.host+PREFIX+t;
          }
        }
      }catch(e){}
      return protocols!==undefined?new _WS(url,protocols):new _WS(url);
    };
    WSProxy.prototype=_WS.prototype;
    WSProxy.CONNECTING=_WS.CONNECTING; WSProxy.OPEN=_WS.OPEN;
    WSProxy.CLOSING=_WS.CLOSING; WSProxy.CLOSED=_WS.CLOSED;
    window.WebSocket=WSProxy;
  }

  // ----- sendBeacon -------------------------------------------------------
  if(navigator.sendBeacon){
    var _b=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(u,d){ try{u=toProxySync(u);}catch(e){} return _b(u,d); };
  }

  // ----- window.open（非同期）--------------------------------------------
  var _winOpen=window.open;
  if(_winOpen){
    window.open=function(u,target,features){
      if(u&&typeof u==='string'&&!isProxied(u)){
        var abs=toAbs(u);
        if(abs){
          sealAsync(abs).then(function(t){
            if(t) _winOpen.call(window,PREFIX+t,target,features);
            else  _winOpen.call(window,u,target,features);
          });
          return null;
        }
      }
      return _winOpen.call(window,u,target,features);
    };
  }

  // ----- location.href setter / location.assign / location.replace --------
  try{
    var _locDesc=Object.getOwnPropertyDescriptor(Location.prototype,'href');
    if(_locDesc&&_locDesc.set){
      Object.defineProperty(Location.prototype,'href',{
        get:_locDesc.get,
        set:function(u){
          var self=this;
          try{
            var abs=toAbs(u);
            if(abs&&!isProxied(u)){
              sealAsync(abs).then(function(t){
                _locDesc.set.call(self, t? PREFIX+t : u);
              });
              return;
            }
          }catch(e){}
          return _locDesc.set.call(this,u);
        },
        configurable:true
      });
    }
  }catch(e){}
  try{
    var _la=location.assign.bind(location);
    location.assign=function(u){
      var abs=toAbs(u);
      if(abs&&!isProxied(u)){
        sealAsync(abs).then(function(t){ _la(t? PREFIX+t : u); });
        return;
      }
      return _la(u);
    };
  }catch(e){}
  try{
    var _lr=location.replace.bind(location);
    location.replace=function(u){
      var abs=toAbs(u);
      if(abs&&!isProxied(u)){
        sealAsync(abs).then(function(t){ _lr(t? PREFIX+t : u); });
        return;
      }
      return _lr(u);
    };
  }catch(e){}

  // ----- history API ------------------------------------------------------
  var _ps=history.pushState,_rs=history.replaceState;
  history.pushState=function(s,t,u){
    try{ if(u&&typeof u==='string'&&!isProxied(u)) u=toProxySync(u); }catch(e){}
    return _ps.call(history,s,t,u);
  };
  history.replaceState=function(s,t,u){
    try{ if(u&&typeof u==='string'&&!isProxied(u)) u=toProxySync(u); }catch(e){}
    return _rs.call(history,s,t,u);
  };

  // ----- フォーム submit --------------------------------------------------
  document.addEventListener('submit',function(e){
    var form=e.target;
    if(!form||form.tagName!=='FORM') return;
    var action=form.action||form.getAttribute('action')||'';
    if(action&&!isProxied(action)){
      var abs=toAbs(action);
      if(abs){
        var t=sealSync(abs);
        if(t) form.action=PREFIX+t;
      }
    }
  },true);

  // ----- クリック傍受（<a> href が JS で書き換えられた場合）--------------
  document.addEventListener('click',function(e){
    var el=e.target;
    while(el&&el.tagName!=='A') el=el.parentElement;
    if(!el) return;
    var href=el.getAttribute('href');
    if(!href||isProxied(href)) return;
    if(/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(href)) return;
    try{
      var abs=toAbs(href);
      if(!abs) return;
      e.preventDefault();
      sealAsync(abs).then(function(t){
        location.href=t? PREFIX+t : href;
      });
    }catch(ex){}
  },true);

  // ----- YouTube 専用: yt-navigate イベント傍受 ---------------------------
  document.addEventListener('yt-navigate',function(e){
    try{
      var ep=e.detail&&e.detail.endpoint;
      var url=ep&&(
        (ep.commandMetadata&&ep.commandMetadata.webCommandMetadata&&ep.commandMetadata.webCommandMetadata.url)||
        (ep.urlEndpoint&&ep.urlEndpoint.url)
      );
      if(url&&!isProxied(url)){
        e.stopImmediatePropagation(); e.preventDefault();
        var abs=toAbs(url);
        if(abs) sealAsync(abs).then(function(t){ history.pushState({},'',t? PREFIX+t : abs); });
      }
    }catch(ex){}
  },true);

  // ----- 動的要素の src/href/action/poster 補正（MutationObserver）-------
  var URL_ATTRS=['src','href','action','poster','data-src','data-href','data-url'];
  function fixEl(el){
    if(!el||el.nodeType!==1) return;
    var pending=[];
    URL_ATTRS.forEach(function(a){
      if(el.hasAttribute&&el.hasAttribute(a)){
        var v=el.getAttribute(a);
        if(v&&!isProxied(v)&&!/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(v)){
          var abs=toAbs(v);
          if(abs) pending.push({el:el,attr:a,abs:abs});
        }
      }
    });
    // style 属性
    if(el.hasAttribute&&el.hasAttribute('style')){
      var st=el.getAttribute('style');
      if(st&&st.indexOf('url(')!==-1){
        var fixed=st.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g,function(m,q,u){
          if(isProxied(u)||/^(data:|blob:)/i.test(u)) return m;
          var t=sealSync(u); return t?'url('+q+PREFIX+t+q+')':m;
        });
        if(fixed!==st) el.setAttribute('style',fixed);
      }
    }
    if(!pending.length) return;
    // 非同期バッチで一括シール
    var urls=pending.map(function(p){ return p.abs; });
    Promise.all(urls.map(sealAsync)).then(function(tokens){
      pending.forEach(function(p,i){
        var t=tokens[i];
        if(t) p.el.setAttribute(p.attr,PREFIX+t);
      });
    });
  }
  try{
    var mo=new MutationObserver(function(muts){
      muts.forEach(function(m){
        if(m.type==='attributes') fixEl(m.target);
        m.addedNodes&&m.addedNodes.forEach(function(n){
          fixEl(n);
          if(n.querySelectorAll){
            var sel='[src],[href],[action],[poster],[data-src],[data-href],[data-url]';
            n.querySelectorAll(sel).forEach(fixEl);
          }
        });
      });
    });
    mo.observe(document.documentElement,{
      childList:true,subtree:true,attributes:true,
      attributeFilter:['src','href','action','poster','data-src','data-href','data-url','style']
    });
  }catch(e){}

  // ----- DOMContentLoaded: ページ内の全URLを一括バッチシール（pre-seal）--
  // → ページが表示された時点で主要リンク/リソースがキャッシュ済みになり
  //   以降のXHR.open同期シールがほぼキャッシュ命中になる
  function preSealPage(){
    var seen=new Set();
    function queueUrl(u){
      if(!u||isProxied(u)) return;
      if(/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(u)) return;
      var abs=toAbs(u);
      if(abs&&!sealCache.has(abs)&&!seen.has(abs)){ seen.add(abs); sealAsync(abs); }
    }
    try{
      document.querySelectorAll('[href],[src],[action],[poster]').forEach(function(el){
        ['href','src','action','poster'].forEach(function(a){ queueUrl(el.getAttribute(a)||''); });
      });
      // <style>内の url() は既にサーバー側書き換え済みなのでスキップ
    }catch(e){}
    // タイマーをすぐ起動してバッチ送信
    if(batchQueue.size&&!batchTimer) batchTimer=setTimeout(flushBatch,0);
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',preSealPage);
  } else {
    preSealPage();
  }

})();
