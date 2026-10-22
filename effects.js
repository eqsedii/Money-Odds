/* Money Odds — lightweight visual effects (no libraries).
   Celebrate.show({emoji,title,sub}) = confetti blast + celebration card.
   Also: scroll-reveal for cards, hover lift, animated confidence bars, CTA shimmer.
   Respects "reduce motion" settings. */
(function(){
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- styles ----------
  var css = `
  .fx-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(5,8,12,.72);backdrop-filter:blur(3px);animation:fxFade .25s ease both;padding:20px;}
  .fx-overlay.out{animation:fxFadeOut .35s ease both;}
  .fx-card{position:relative;z-index:2;max-width:360px;width:100%;text-align:center;padding:34px 26px 26px;border-radius:22px;background:linear-gradient(160deg,#162030,#0F1620);border:1px solid rgba(245,166,35,.45);box-shadow:0 0 0 1px rgba(255,255,255,.04),0 20px 70px rgba(0,0,0,.6),0 0 60px rgba(245,166,35,.25);animation:fxPop .55s cubic-bezier(.2,1.4,.4,1) both;}
  .fx-emoji{font-size:64px;line-height:1;display:inline-block;animation:fxBounce 1s ease .3s both;}
  .fx-title{font-family:'Space Grotesk',sans-serif;font-size:24px;font-weight:700;margin:14px 0 6px;color:#F5A623;}
  .fx-sub{font-size:14.5px;color:#C9CEDA;line-height:1.5;}
  .fx-btn{margin-top:20px;padding:11px 26px;border:none;border-radius:10px;background:#F5A623;color:#1A1204;font-weight:700;font-size:14px;cursor:pointer;}
  .fx-canvas{position:fixed;inset:0;z-index:99998;pointer-events:none;width:100%;height:100%;}
  @keyframes fxFade{from{opacity:0}to{opacity:1}}
  @keyframes fxFadeOut{to{opacity:0}}
  @keyframes fxPop{0%{transform:scale(.6) translateY(30px);opacity:0}100%{transform:none;opacity:1}}
  @keyframes fxBounce{0%{transform:scale(0) rotate(-30deg)}60%{transform:scale(1.25) rotate(8deg)}100%{transform:scale(1) rotate(0)}}
  /* scroll reveal */
  .fx-pre{opacity:0;transform:translateY(18px);}
  .fx-in{transition:opacity .5s ease,transform .5s cubic-bezier(.2,.8,.3,1);}
  /* hover lift + glow */
  .card,.multi-card,.plan-card{transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease;}
  @media (hover:hover){.card:hover,.plan-card:hover{transform:translateY(-3px);box-shadow:0 10px 30px rgba(0,0,0,.35),0 0 24px rgba(45,225,232,.12);}}
  /* confidence bars fill in */
  .conf-fill{transform-origin:left;animation:fxFill .9s cubic-bezier(.2,.8,.3,1) both;}
  @keyframes fxFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  /* shimmer sweep on primary buttons */
  .nav-cta,.pay-btn,.btn-gold{position:relative;overflow:hidden;}
  .nav-cta::after,.pay-btn::after{content:'';position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-20deg);animation:fxShine 3.6s ease-in-out infinite;}
  @keyframes fxShine{0%,60%{left:-60%}100%{left:130%}}
  /* locked pick gentle pulse */
  .pick-value[style*="text-dim"]{animation:fxLock 2.4s ease-in-out infinite;}
  @keyframes fxLock{0%,100%{opacity:.75}50%{opacity:1}}
  @media (prefers-reduced-motion: reduce){.nav-cta::after,.pay-btn::after,.conf-fill,.pick-value{animation:none!important}.fx-pre{opacity:1;transform:none}}
  `;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---------- confetti ----------
  var COLORS = ['#F5A623','#2DE1E8','#3DD68C','#C084FC','#E8536B','#FFFFFF'];
  function confetti(duration){
    if(reduce) return;
    var c = document.createElement('canvas'); c.className = 'fx-canvas'; document.body.appendChild(c);
    var ctx = c.getContext('2d'), W = c.width = innerWidth, H = c.height = innerHeight, dpr = 1;
    var P = [], n = Math.min(220, Math.round(W / 4));
    function burst(x, y, count, spread){
      for(var i=0;i<count;i++){
        var a = -Math.PI/2 + (Math.random()-.5)*spread, v = 7 + Math.random()*10;
        P.push({x:x,y:y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,w:6+Math.random()*7,h:4+Math.random()*6,
          r:Math.random()*6,vr:(Math.random()-.5)*.35,c:COLORS[(Math.random()*COLORS.length)|0],life:0,round:Math.random()<.3});
      }
    }
    burst(W*.2, H*.85, n/2, 1.3); burst(W*.8, H*.85, n/2, 1.3);
    setTimeout(function(){ burst(W*.5, H*.7, n/2, 2.2); }, 350);
    var t0 = performance.now(), raf;
    (function frame(t){
      ctx.clearRect(0,0,W,H);
      for(var i=P.length-1;i>=0;i--){
        var p = P[i]; p.life++; p.vy += .28; p.vx *= .992; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        if(p.y > H + 30){ P.splice(i,1); continue; }
        ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.globalAlpha = Math.max(0, 1 - p.life/220);
        if(p.round){ ctx.beginPath(); ctx.arc(0,0,p.w/2.2,0,6.3); ctx.fill(); } else ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);
        ctx.restore();
      }
      if(P.length && t - t0 < (duration||4500)) raf = requestAnimationFrame(frame);
      else { cancelAnimationFrame(raf); c.remove(); }
    })(t0);
  }

  // ---------- celebration card ----------
  var Celebrate = {
    show: function(o){
      o = o || {};
      var ov = document.createElement('div'); ov.className = 'fx-overlay';
      ov.innerHTML = '<div class="fx-card"><div class="fx-emoji">'+(o.emoji||'🎉')+'</div>'
        + '<div class="fx-title"></div><div class="fx-sub"></div><button class="fx-btn">'+(o.button||'Awesome!')+'</button></div>';
      ov.querySelector('.fx-title').textContent = o.title || 'Success!';
      ov.querySelector('.fx-sub').textContent = o.sub || '';
      document.body.appendChild(ov);
      confetti(4500);
      try { if(navigator.vibrate) navigator.vibrate([40,30,80]); } catch(e){}
      var done = false;
      function close(){ if(done) return; done = true; ov.classList.add('out'); setTimeout(function(){ ov.remove(); }, 350); }
      ov.addEventListener('click', close);
      setTimeout(close, o.duration || 4200);
      return { close: close };
    },
    confetti: confetti
  };
  window.Celebrate = Celebrate;

  // ---------- scroll reveal ----------
  if('IntersectionObserver' in window && !reduce){
    var SEL = '.card,.multi-card,.plan-card,.leg-row,.date-group-head,.about-card,.value-card';
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.remove('fx-pre'); io.unobserve(e.target); } });
    }, {rootMargin:'0px 0px -6% 0px', threshold:.05});
    function watch(root){
      (root.querySelectorAll ? root.querySelectorAll(SEL) : []).forEach(function(el){
        if(el.__fx) return; el.__fx = 1;
        var r = el.getBoundingClientRect();
        if(r.top < innerHeight && r.bottom > 0) return;       // already on screen: leave alone
        el.classList.add('fx-pre','fx-in'); io.observe(el);
        setTimeout(function(){ el.classList.remove('fx-pre'); }, 6000); // safety: never stay hidden
      });
    }
    function start(){
      watch(document);
      new MutationObserver(function(ms){ ms.forEach(function(m){ m.addedNodes.forEach(function(n){ if(n.nodeType===1){ if(n.matches && n.matches(SEL)) watch({querySelectorAll:function(){return [n];}}); watch(n); } }); }); })
        .observe(document.body, {childList:true, subtree:true});
    }
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})();

/* ===== extras: toast, countdown, count-up, flame, live unlocks ===== */
(function(){
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var st = document.createElement('style');
  st.textContent = `
  .fx-toast-wrap{position:fixed;left:14px;bottom:84px;z-index:9000;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:calc(100vw - 28px);}
  .fx-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(19,26,36,.96);border:1px solid rgba(61,214,140,.4);box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:13px;color:#E8EAED;animation:fxToastIn .45s cubic-bezier(.2,1.2,.4,1) both;}
  .fx-toast.out{animation:fxToastOut .35s ease both;}
  .fx-toast .dot{width:8px;height:8px;border-radius:50%;background:#3DD68C;box-shadow:0 0 10px #3DD68C;animation:fxPulse 1.4s infinite;flex:0 0 8px;}
  .fx-toast small{display:block;color:#8B92A5;font-size:11px;margin-top:1px;}
  @keyframes fxToastIn{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:none}}
  @keyframes fxToastOut{to{opacity:0;transform:translateX(-30px)}}
  @keyframes fxPulse{0%,100%{opacity:1}50%{opacity:.35}}
  .fx-countdown{margin:12px 0;padding:10px 14px;border-radius:10px;background:rgba(232,83,107,.1);border:1px solid rgba(232,83,107,.3);text-align:center;font-size:13.5px;font-weight:600;color:#F2A0AE;letter-spacing:.2px;}
  .fx-countdown b{color:#fff;font-family:'Space Grotesk',sans-serif;font-size:16px;}
  .fx-flame{display:inline-block;animation:fxFlame 1.1s ease-in-out infinite;transform-origin:50% 90%;}
  @keyframes fxFlame{0%,100%{transform:scale(1) rotate(-3deg)}50%{transform:scale(1.18) rotate(4deg)}}
  @media (prefers-reduced-motion: reduce){.fx-flame,.fx-toast .dot{animation:none}}
  `;
  document.head.appendChild(st);

  var FX = window.FX = {};

  FX.toast = function(html, ms){
    var wrap = document.querySelector('.fx-toast-wrap');
    if(!wrap){ wrap = document.createElement('div'); wrap.className = 'fx-toast-wrap'; document.body.appendChild(wrap); }
    var t = document.createElement('div'); t.className = 'fx-toast'; t.innerHTML = '<span class="dot"></span><div>' + html + '</div>';
    wrap.appendChild(t);
    setTimeout(function(){ t.classList.add('out'); setTimeout(function(){ t.remove(); }, 360); }, ms || 5200);
  };

  // number count-up. FX.countUp(el, 87, {suffix:'%'})
  FX.countUp = function(el, to, o){
    o = o || {}; var suf = o.suffix || '', pre = o.prefix || '';
    if(reduce || !isFinite(to)){ el.textContent = pre + to + suf; return; }
    var t0 = performance.now(), d = o.duration || 1100;
    (function f(t){
      var p = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - p, 3);
      el.textContent = pre + Math.round(to * e) + suf;
      if(p < 1) requestAnimationFrame(f);
    })(t0);
  };

  // countdown: any element with data-countdown="<ISO time>"
  function fmt(ms){
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60, p = function(n){ return String(n).padStart(2, '0'); };
    return (d ? d + 'd ' : '') + p(h) + 'h ' + p(m) + 'm ' + p(x) + 's';
  }
  setInterval(function(){
    document.querySelectorAll('[data-countdown]').forEach(function(el){
      var ms = new Date(el.getAttribute('data-countdown')).getTime() - Date.now();
      if(isNaN(ms)) return;
      el.innerHTML = ms > 0 ? '⏱ First kickoff in <b>' + fmt(ms) + '</b>' : '🔴 Matches are underway';
    });
  }, 1000);

  // REAL recent unlocks only (first name, from actual payments). Nothing is shown if there are none.
  FX.liveUnlocks = function(workerBase){
    try { if(sessionStorage.getItem('fxLiveShown')) return; } catch(e){}
    fetch(workerBase + '/recent-unlocks').then(function(r){ return r.json(); }).then(function(d){
      var ev = (d && d.events || []).slice(0, 3);
      if(!ev.length) return;
      try { sessionStorage.setItem('fxLiveShown', '1'); } catch(e){}
      ev.forEach(function(x, i){
        setTimeout(function(){
          var what = x.kind === 'exclusive' ? 'the VIP Golden Slip' : 'full access';
          var ago = x.minutes_ago < 60 ? x.minutes_ago + ' min ago' : Math.round(x.minutes_ago / 60) + ' hr ago';
          var name = String(x.first).replace(/[<>&"]/g, '');
          FX.toast('<b>' + name + '</b> unlocked ' + what + '<small>' + ago + '</small>');
        }, 3500 + i * 9000);
      });
    }).catch(function(){});
  };
})();
