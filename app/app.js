/* 卷灵 GhostPace · 主逻辑（v1） */
'use strict';
(function () {
  const BRIDGE = 'http://127.0.0.1:8756';
  const LS = { history: 'gp_history', active: 'gp_active', pending: 'gp_pending' };
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtSigned = s => (s >= 0 ? '领先 ' : '落后 ') + '≈ ' + fmt(Math.abs(s));
  const nowISO = () => new Date().toISOString();

  /* ---------- 音效（WebAudio，无资产文件） ---------- */
  let AC = null;
  function ac() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
    if (AC && (AC.state === 'suspended' || AC.state === 'interrupted')) AC.resume(); // iOS 打断会挂起，借手势恢复（interrupted 是 Safari 专有态）
    return AC;
  }
  function sndClick() {
    const c = ac(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = 980;
    g.gain.setValueAtTime(0.12, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.09);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.1);
  }
  function sndFlip() {
    const c = ac(); if (!c) return;
    const len = c.sampleRate * 0.14, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.8;
    const g = c.createGain(); g.gain.value = 0.16;
    src.connect(f).connect(g).connect(c.destination); src.start();
  }

  /* ---------- 存储 ---------- */
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function history() { return lsGet(LS.history, {}); }

  /* ---------- 本地桥 ---------- */
  let bridgeOn = false;
  function renderNetline() {
    const pendN = lsGet(LS.pending, []).length;
    $('#netTxt').textContent = bridgeOn
      ? (pendN ? `本地桥在线 · ${pendN} 场补传中…` : '本地桥在线 · 数据直存')
      : (pendN ? `本地桥离线 · ${pendN} 场待补传，桥恢复后自动上传` : '本地桥离线 · 数据暂存本机，赛后自动补传');
  }
  async function bridgeHealth() {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(BRIDGE + '/health', { signal: ctl.signal });
      clearTimeout(to); bridgeOn = r.ok;
    } catch (e) { bridgeOn = false; }
    $('#bridgeDot').className = 'dot ' + (bridgeOn ? 'on' : 'off');
    $('#bridgeDot').title = bridgeOn ? '本地桥在线：数据直存' : '本地桥离线：数据暂存本机';
    renderNetline();
  }
  async function saveSession(sess) {
    // 本地兜底
    const pend = lsGet(LS.pending, []);
    pend.push(sess); lsSet(LS.pending, pend);
    flushPending();
  }
  async function flushPending() {
    if (!bridgeOn) return;
    const pend = lsGet(LS.pending, []);
    if (!pend.length) return;
    const left = [];
    for (const s of pend) {
      try {
        const r = await fetch(BRIDGE + '/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relpath: 'sessions/' + s.id + '.json', data: s })
        });
        if (!r.ok) left.push(s);
      } catch (e) { left.push(s); }
    }
    lsSet(LS.pending, left);
    renderNetline();
  }

  /* ---------- 路由 ---------- */
  const screens = ['library', 'brief', 'race', 'result'];
  function go(name) {
    location.hash = '#/' + name;
  }
  // 底栏快速通道：手指按下即切屏，不等 click（WKWebView 的 <a> 点击要过手势判定，感知慢半拍）
  $$('#nav a').forEach(a => {
    a.addEventListener('pointerdown', e => {
      if (a.classList.contains('off')) return;
      e.preventDefault();
      const target = a.getAttribute('href');
      if (location.hash !== target) location.hash = target;
    });
  });
  function route() {
    let h = (location.hash || '#/library').replace('#/', '');
    // 深链：#/brief/<卷子id> 直达该卷赛前页（建卷 agent 给的入口链接）
    const deep = h.match(/^brief\/(.+)$/);
    if (deep) {
      const p = paperById(decodeURIComponent(deep[1]));
      if (p) { S.paper = p; h = 'brief'; } else h = 'library';
    }
    if (h === 'race' && !S.running && !S.starting) h = 'library'; // 没有在赛 → 回卷库（倒计时中 starting=true 不算误弹）
    if (h === 'brief' && !S.paper) h = 'library';           // 没选卷 → 回卷库
    if (h === 'result') {                                    // 结算永远展示最近一场
      ensureLastResult().then(s => { if (s) renderResult(s); else go('library'); });
    }
    if (h === 'brief' && S.paper) renderBrief(S.paper);      // 底栏直达赛前也能渲染当前卷（已赛卷的重赛入口）
    screens.forEach(s => $('#s-' + s).classList.toggle('on', s === h));
    if (h === 'brief') placeRestartRow();                    // 可见后才能量出是否超屏
    // 底栏：当前页高亮；不可用的暗掉并禁点
    const canBrief = !!S.paper, canRace = S.running || S.starting, canResult = !!(S.lastResult || lsGet('gp_last', null));
    $$('#nav a').forEach(a => {
      const s = a.dataset.s;
      a.classList.toggle('on', s === 's-' + h);
      a.classList.toggle('off', (s === 's-brief' && !canBrief) || (s === 's-race' && !canRace) || (s === 's-result' && !canResult));
    });
    if (h === 'library') renderLibrary();
  }
  /* 最近一场结果：现场 → 桥（磁盘，在线时权威） → localStorage（离线兜底） */
  async function ensureLastResult() {
    if (S.lastResult) return S.lastResult;
    if (bridgeOn) {
      try {
        const r = await fetch(BRIDGE + '/latest');
        if (r.ok) {
          const s = await r.json();
          if (s) { S.lastResult = s; lsSet('gp_last', s); return s; }
        }
      } catch (e) { }
    }
    S.lastResult = lsGet('gp_last', null);
    return S.lastResult;
  }

  // 已赛卷子：按卷取最新一场进结算；看过的结果按卷缓存，桥离线也能回看
  async function showPaperResult(p) {
    S.paper = p;
    try {
      const r = await fetch(BRIDGE + '/session?paper=' + encodeURIComponent(p.id));
      const s = r.ok ? await r.json() : null;
      if (s && s.result) {
        S.lastResult = s; lsSet('gp_last', s);
        const rc = lsGet('gp_results', {}); rc[p.id] = s; lsSet('gp_results', rc);
        renderResult(s); go('result'); return;
      }
    } catch (e) { }
    const cached = lsGet('gp_results', {})[p.id];
    if (cached && cached.result) { S.lastResult = cached; renderResult(cached); go('result'); return; }
    renderBrief(p); go('brief');
  }

  /* ---------- 卷库 ---------- */
  function paperById(id) { return (window.PAPERS_DATA || []).find(p => p.id === id); }
  /* 战绩合并：桥在线时以磁盘 sessions 为正主（跨入口一致），否则用本地缓存 */
  async function loadHistory() {
    if (bridgeOn) {
      try {
        const r = await fetch(BRIDGE + '/list');
        if (r.ok) {
          const rows = await r.json();
          const hist = {};
          rows.forEach(s => {
            const h = hist[s.paper_id] || { wins: 0, losses: 0, best: null, last: null, lastId: '', lastDay: '' };
            if (s.win) h.wins++; else h.losses++;
            const diff = s.ghost - s.you;
            if (h.best == null || diff > h.best) h.best = diff;
            // 完成日期取 session id 里的保存时刻（started_at 可能是中断恢复前的旧时间）
            const day = s.id && s.id.length >= 10 ? s.id.slice(2, 6) + '-' + s.id.slice(6, 8) + '-' + s.id.slice(8, 10) : (s.started_at || '').slice(0, 10);
            if ((s.id || '') >= (h.lastId || '')) { h.lastId = s.id || ''; h.last = diff; h.lastDay = day; }
            hist[s.paper_id] = h;
          });
          lsSet(LS.history, hist);
          return hist;
        }
      } catch (e) { }
    }
    return history();
  }
  function drawLibrary(hist) {
    const list = $('#paperList'); list.innerHTML = '';
    const papers = (window.PAPERS_DATA || []).slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id.localeCompare(a.id));
    papers.forEach(p => {
      const h = hist[p.id];
      const raced = h && h.last != null;
      const mins = Math.round(p.questions.reduce((s, q) => s + q.pred_sec, 0) / 60);
      const card = document.createElement('div');
      card.className = 'pcard' + (raced ? ' done' : '');
      card.innerHTML =
        `<div class="row1"><span><span class="tag red">${subjName(p.subject)}</span> <span class="tag">${p.grade || ''}</span></span>${raced ? `<span class="seal ${h.last >= 0 ? 'w' : 'l'}">${h.last >= 0 ? '胜' : '负'}</span>` : ''}</div>
         <h3>${p.title}</h3>
         <div class="meta"><span><b class="num">${p.questions.length}</b> 题</span><span>预测 <b class="num">${mins} 分钟</b></span></div>
         <div class="rec"><span>${(() => {
           if (!h || h.last == null) return (h && (h.wins + h.losses) > 0) ? '已完赛' : '尚未挑战';
           return `已完赛 · ${h.last >= 0 ? '赢' : '输'} ${fmt(Math.abs(h.last))}`;
         })()}</span><span>${h && h.lastDay ? h.lastDay.slice(5).replace('-', '/') : '开赛 →'}</span></div>`;
      card.onclick = () => { S.paper = p; raced ? showPaperResult(p) : (renderBrief(p), go('brief')); };
      list.appendChild(card);
    });
    const add = document.createElement('div');
    add.className = 'pcard new';
    add.textContent = '＋ 拍新卷（在聊天里发给 agent）';
    list.appendChild(add);
  }
  // 先按本地缓存秒渲，再等桥返回后刷新——切到卷库零等待；数据没变就不二次渲染（防闪）
  let lastHistJSON = '';
  async function renderLibrary() {
    const cached = history();
    lastHistJSON = JSON.stringify(cached);
    drawLibrary(cached);
    const fresh = await loadHistory();
    if (JSON.stringify(fresh) !== lastHistJSON) drawLibrary(fresh);
  }
  function subjName(s) {
    return { math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学', biology: '生物', history: '历史', geography: '地理', politics: '政治' }[s] || s;
  }

  /* ---------- 赛前 ---------- */
  let level = 1.0;
  function renderBrief(p) {
    $('#restartRow').style.display = 'none'; // 进赛前一律收起确认排
    placeRestartRow();
    $('#briefTitle').textContent = p.title;
    // 已赛提示：让用户知道这是重赛
    const bh = $('#briefHist');
    const ph = lsGet(LS.history, {})[p.id];
    if (ph && ph.last != null) {
      bh.textContent = `此卷已完赛 · 上次 ${ph.last >= 0 ? '赢' : '输'} ${fmt(Math.abs(ph.last))}${ph.lastDay ? ' · ' + ph.lastDay.slice(5).replace('-', '/') : ''}`;
      bh.style.display = '';
    } else bh.style.display = 'none';
    $('#briefTag').textContent = subjName(p.subject) + (p.grade ? ' · ' + p.grade : '');
    const tot = p.questions.reduce((s, q) => s + q.pred_sec, 0);
    $('#bStatN').textContent = p.questions.length;
    $('#bStatT').textContent = fmt(tot * level);
    $('#bStatAvg').textContent = fmt(tot * level / p.questions.length);
    const bars = $('#qbars'); bars.innerHTML = '';
    const mx = Math.max(...p.questions.map(q => q.pred_sec));
    p.questions.forEach(q => {
      const i = document.createElement('i');
      i.style.height = Math.max(12, q.pred_sec / mx * 100) + '%';
      if (q.difficulty === 'hard') i.className = 'hard';
      if (q.pred_sec > 150) i.classList.add('big');
      i.title = `第${q.n}题 ${fmt(q.pred_sec)}`;
      bars.appendChild(i);
    });
  }
  $$('.level').forEach(b => b.onclick = () => {
    $$('.level').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); level = parseFloat(b.dataset.lv);
    if (S.paper) renderBrief(S.paper);
  });

  /* ---------- 比赛状态 ---------- */
  const S = {
    paper: null, ghost: null, seed: 0,
    startWall: 0, pauseStart: 0, pausedAccum: 0, pausing: false, starting: false,
    events: [], pointer: 0, order: [], skipped: [],
    glimpseAt: 0, lastGlimpse: -1, glimpseRng: null,
    timer: null, running: false, done: {}, finishT: null
  };
  function raceT() {
    if (!S.running && !S.pausing) return 0;
    const now = Date.now();
    const pausedPart = S.pausedAccum + (S.pausing ? now - S.pauseStart : 0);
    return (now - S.startWall - pausedPart) / 1000;
  }
  function pushEv(ev, q) {
    S.events.push({ t: +raceT().toFixed(1), ev, q, wall: nowISO() });
    persistActive();
  }

  // 确认排位置按"内容是否超屏"自动判断：超屏→开卷键下方（底部不在拇指区）；未超屏→上方（避免贴着底栏误触）
  function placeRestartRow() {
    const row = $('#restartRow'), btn = $('#btnStart'), brief = $('#s-brief');
    if (!brief.classList.contains('on')) return;
    const was = row.style.display; row.style.display = 'none';
    const overflow = brief.scrollHeight > brief.clientHeight + 2;
    row.style.display = was;
    if (overflow) btn.after(row); else btn.before(row);
  }
  addEventListener('resize', placeRestartRow);
  $('#btnStart').onclick = () => {
    if (!S.paper) return;
    // 比赛中重开：分离确认（WKWebView 没有 confirm 面板；同键二次确认会被连点误触）
    if (S.running && !S.finishT) { placeRestartRow(); $('#restartRow').style.display = 'flex'; return; }
    ac(); if (AC && AC.state === 'suspended') AC.resume(); // 借开卷手势解锁音频
    startRace(S.paper, level);
  };
  $('#btnRestartNo').onclick = () => { $('#restartRow').style.display = 'none'; };
  $('#btnRestartYes').onclick = () => {
    $('#restartRow').style.display = 'none';
    ac(); if (AC && AC.state === 'suspended') AC.resume();
    startRace(S.paper, level);
  };

  function startRace(paper, lv) {
    const qs = paper.questions;
    S.paper = paper; S.level = lv;
    S.seed = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
    S.ghost = Ghost.build(paper, lv, S.seed);
    $('#ghostEta').textContent = fmt(S.ghost.predTotal); // 未见其影之前的初始估计=计划总量
    S.order = qs.map(q => q.n); S.pointer = 0; S.skipped = []; S.done = {};
    S.events = []; S.pausedAccum = 0; S.pausing = false; S.finishT = null;
    S.glimpseRng = (function (a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(S.seed ^ 0x9e3779b9);
    S.lastGlimpseShown = 0; S.lastGlimpse = -1; S.ghostSubmitShown = false;
    // 倒计时
    S.starting = true;
    go('race');
    const cd = $('#countdown'); cd.classList.add('on');
    let n = 3;
    cd.textContent = n;
    const cdi = setInterval(() => {
      n--;
      if (n > 0) { cd.textContent = n; sndClick(); }
      else {
        clearInterval(cdi);
        cd.textContent = '开卷'; sndFlip();
        setTimeout(() => { cd.classList.remove('on'); }, 450);
        S.starting = false;
        S.startWall = Date.now(); S.running = true;
        pushEv('start');
        S.glimpseAt = 20 + S.glimpseRng() * 40; // 第一瞥稍早
        S.timer = setInterval(tick, 250);
        wakeLock(true);
        buildTrack(); updateRaceUI(true);
      }
    }, 750);
  }

  /* wakeLock */
  let wl = null;
  async function wakeLock(on) {
    try {
      if (on && 'wakeLock' in navigator) wl = await navigator.wakeLock.request('screen');
      else if (wl) { await wl.release(); wl = null; }
    } catch (e) { }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (S.running && !S.pausing) wakeLock(true); bridgeHealth().then(flushPending); }
    else if (S.running && !S.pausing && !S.finishT) doPause(true);
  });

  /* ---------- 赛道 UI ---------- */
  function buildTrack() {
    const tk = $('#ticks'); tk.innerHTML = '';
    const n = S.paper.questions.length;
    let prevType = S.paper.questions[0].type;
    S.paper.questions.forEach((q, i) => {
      const el = document.createElement('i');
      if (q.type !== prevType) { el.className = 'sec'; prevType = q.type; }
      tk.appendChild(el);
    });
  }
  function currentQ() {
    if (S.pointer < S.order.length) return S.order[S.pointer];
    return S.skipped.length ? S.skipped[0] : null;
  }
  function updateRaceUI(force) {
    const t = raceT();
    const n = S.paper.questions.length;
    const gpos = Ghost.positionAt(S.ghost, n, t);
    $('#elapsed').textContent = fmt(t);
    // 你
    const yourDone = Object.keys(S.done).length;
    const cq = currentQ();
    const yourPos = (yourDone + (cq ? 0.5 : 0)) / n;
    $('#mkYou').style.left = (yourPos * 100) + '%';
    // 幽灵（余光模式：只在 glimpse 时刻刷新显示；但交卷是考场公开事件，立即揭示）
    const justSubmitted = gpos.submitted && !S.ghostSubmitShown;
    if (force || justSubmitted || t >= S.glimpseAt) {
      S.lastGlimpse = t;
      S.glimpseAt = t + 25 + S.glimpseRng() * 65;
      if (gpos.submitted) S.ghostSubmitShown = true;
      const dispDone = gpos.done;
      const dispQ = dispDone < n ? (S.ghost.doneList[dispDone] ? S.ghost.doneList[dispDone].q : n) : n;
      // 幽灵预计完卷：只在"瞥见"时按所见进度外推（没见过就凭计划总量）——估计必须基于你看见的东西
      {
        const predOf = {}; S.paper.questions.forEach(q => predOf[q.n] = q.pred_sec * S.level);
        let predDone = 0;
        for (let i = 0; i < dispDone; i++) predDone += predOf[S.ghost.doneList[i].q] || 0;
        const predTotal = S.ghost.predTotal;
        const pace = (t + predTotal / 3) / (predDone + predTotal / 3); // 收缩：样本少时外推保守
        $('#ghostEta').textContent = fmt(t + (predTotal - predDone) * pace);
      }
      $('#mkGhost').style.left = ((dispDone + gpos.frac) / n * 100) + '%';
      $('#mkGhostQ').textContent = gpos.submitted ? '✓' : dispQ;
      // 状态行
      if (gpos.submitted) {
        $('#glimpseTxt').innerHTML = '幽灵 <b>已交卷</b>';
      } else {
        $('#glimpseTxt').innerHTML = `余光一瞥 · 幽灵在 <b>第 ${dispQ} 题附近</b>`;
      }
      $('#glimpseAge').textContent = '刚刚瞥见';
      // 领先/落后：你已完成 yourDone 题，对照幽灵完成第 yourDone 题的时刻
      const leadSec = Ghost.timeOfDone(S.ghost, yourDone) - t;
      const bl = $('#behind');
      bl.textContent = fmtSigned(leadSec);
      bl.className = Math.abs(leadSec) < 20 ? 'behind even' : (leadSec >= 0 ? 'behind ahead' : 'behind');
    } else if (S.lastGlimpse >= 0) {
      $('#glimpseAge').textContent = Math.round(t - S.lastGlimpse) + ' 秒前瞥见';
    }
    // 当前题信息
    if (cq) {
      const q = S.paper.questions.find(x => x.n === cq);
      const lastT = S.events.length ? S.events[S.events.length - 1].t : 0;
      const over = (t - lastT) > 2.5 * q.pred_sec * S.level;
      $('#qno').innerHTML = `${cq}<small> / ${n}</small>`;
      $('#qtype').innerHTML = `${typeName(q.type)} · 预估 <b class="num">${fmt(q.pred_sec * S.level)}</b>${q.difficulty === 'hard' ? ' · 难点' : ''}${over ? ' · <b style="color:var(--red-hi)">已超预估，考虑跳题</b>' : ''}`;
      const nq = nextAfter(cq);
      const catchup = S.pointer >= S.order.length;
      $('#btnDoneSub').textContent = (catchup ? `补做中 · 还剩 ${S.skipped.length} 题 · ` : '') +
        (nq ? `下一题：第${nq}题 · ${typeName(S.paper.questions.find(x => x.n === nq).type)}` : '这是最后一题');
    }
  }
  function nextAfter(cq) {
    const rest = S.order.slice(S.pointer + 1).concat(S.skipped.filter(x => x !== cq));
    return rest.length ? rest[0] : null;
  }
  function typeName(t) { return { choice: '选择', fill: '填空', solve: '解答', reading: '阅读', cloze: '完形', writing: '作文' }[t] || '题目'; }

  function tick() {
    if (!S.running || S.pausing) return;
    updateRaceUI(false);
  }

  /* ---------- 按钮 ---------- */
  $('#btnDone').onclick = () => {
    if (!S.running || S.pausing) return;
    const cq = currentQ();
    if (!cq) return;
    ac(); sndClick();
    pushEv('done', cq);
    S.done[cq] = raceT();
    if (S.pointer < S.order.length && S.order[S.pointer] === cq) S.pointer++;
    else S.skipped = S.skipped.filter(x => x !== cq);
    const btn = $('#btnDone');
    btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 180);
    if (!currentQ()) { doFinish(); return; }
    updateRaceUI(true);
  };
  $('#btnSkip').onclick = () => {
    if (!S.running || S.pausing) return;
    const cq = currentQ();
    if (!cq || S.pointer >= S.order.length) return;
    pushEv('skip', cq);
    S.skipped.push(cq); S.pointer++;
    updateRaceUI(true);
  };
  $('#btnPause').onclick = () => doPause(false);
  function doPause(auto) {
    if (!S.running || S.pausing) return;
    S.pausing = true; S.pauseStart = Date.now();
    pushEv(auto ? 'auto_pause' : 'pause');
    $('#abortBar').style.display = 'none'; $('#btnAbort').style.display = ''; // 每次进暂停重置确认条
    $('#pauseOv').classList.add('on');
    $('#pauseWhy').textContent = auto ? '屏幕离开，已自动暂停' : '幽灵也停下了';
  }
  $('#btnResume').onclick = () => {
    if (!S.pausing) return;
    ac();
    $('#abortBar').style.display = 'none'; $('#btnAbort').style.display = ''; // 继续=天然取消放弃
    S.pausedAccum += Date.now() - S.pauseStart;
    S.pausing = false;
    pushEv('resume');
    $('#pauseOv').classList.remove('on');
    wakeLock(true);
  };
  // 放弃比赛：确认条出现在遮罩顶部（远离下方按钮区，连点误触不到）
  $('#btnAbort').onclick = () => { $('#btnAbort').style.display = 'none'; $('#abortBar').style.display = 'block'; };
  $('#btnAbortYes').onclick = () => {
    S.running = false; S.pausing = false; S.starting = false; S.finishT = null;
    localStorage.removeItem(LS.active);
    $('#abortBar').style.display = 'none'; $('#btnAbort').style.display = '';
    $('#pauseOv').classList.remove('on');
    clearInterval(S.timer);
    go('library');
  };

  /* ---------- 结束与结算 ---------- */
  function doFinish() {
    pushEv('finish');
    S.finishT = raceT();
    S.running = false;
    clearInterval(S.timer);
    wakeLock(false);
    const sess = buildSession();
    S.lastResult = sess; lsSet('gp_last', sess);
    const rc = lsGet('gp_results', {}); rc[sess.paper_id] = sess; lsSet('gp_results', rc);
    saveSession(sess);
    // 战绩
    const h = history();
    const rec = h[S.paper.id] || { wins: 0, losses: 0, best: null };
    if (sess.result.win) rec.wins++; else rec.losses++;
    const diff = sess.result.ghost_submit_sec - sess.result.your_total_sec;
    if (rec.best == null || diff > rec.best) rec.best = diff;
    h[S.paper.id] = rec; lsSet(LS.history, h);
    localStorage.removeItem(LS.active);
    renderResult(sess);
    go('result');
  }
  /* 逐题用时 = 该题作为"当前题"的区间累加（跳题前后的两段都归它，不污染下一题） */
  function attributeTimes(events, order) {
    const acc = {};
    let cur = order[0], ptr = 0, skipped = [], lastT = 0;
    for (const e of events) {
      if (cur != null && e.t > lastT) acc[cur] = (acc[cur] || 0) + (e.t - lastT);
      lastT = e.t;
      if (e.ev === 'done') {
        if (ptr < order.length && order[ptr] === e.q) ptr++;
        else skipped = skipped.filter(x => x !== e.q);
        cur = ptr < order.length ? order[ptr] : (skipped[0] ?? null);
      } else if (e.ev === 'skip') {
        skipped.push(e.q); ptr++;
        cur = ptr < order.length ? order[ptr] : (skipped[0] ?? null);
      }
    }
    return acc;
  }
  function buildSession() {
    const t = S.finishT;
    const acc = attributeTimes(S.events, S.order);
    const per = [];
    for (const e of S.events) {
      if (e.ev === 'done') {
        const q = S.paper.questions.find(x => x.n === e.q);
        per.push({ n: e.q, pred_sec: Math.round(q.pred_sec * S.level), actual_sec: Math.round(acc[e.q] || 0) });
      }
    }
    return {
      id: 's_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
      paper_id: S.paper.id, level: S.level, seed: S.seed,
      started_at: new Date(S.startWall).toISOString(),
      events: S.events,
      ghost: { submit: +S.ghost.submit.toFixed(1), writeEnd: +S.ghost.writeEnd.toFixed(1), seedUsed: S.ghost.seedUsed, notes: Ghost.replayNotes(S.ghost), doneList: S.ghost.doneList },
      result: {
        your_total_sec: Math.round(t),
        ghost_submit_sec: Math.round(S.ghost.submit),
        win: t < S.ghost.submit,
        per_q: per
      }
    };
  }
  function renderResult(sess) {
    const win = sess.result.win;
    const diff = sess.result.ghost_submit_sec - sess.result.your_total_sec;
    const paper = paperById(sess.paper_id);
    const lvName = { '0.85': '轻松', '1': '标准', '1.15': '挑战' }[String(sess.level)] || '标准';
    $('#rSeal').textContent = win ? '胜' : '负';
    $('#rSeal').style.borderColor = win ? 'var(--red)' : 'var(--dim)';
    $('#rSeal').style.color = win ? 'var(--red)' : 'var(--dim)';
    $('#rHead').textContent = (win ? '赢 ' : '输 ') + fmt(Math.abs(diff));
    $('#rSub').textContent = `${paper ? paper.title : sess.paper_id} · 幽灵${lvName}档`;
    $('#rYou').textContent = fmt(sess.result.your_total_sec);
    $('#rGhost').textContent = fmt(sess.result.ghost_submit_sec);
    renderRaceChart(sess);
    // 逐题
    const wrap = $('#rRows'); wrap.innerHTML = '';
    const mx = Math.max(...sess.result.per_q.map(r => Math.max(r.pred_sec, r.actual_sec)));
    sess.result.per_q.forEach(r => {
      const row = document.createElement('div');
      row.className = 'qr';
      const slow = r.actual_sec > r.pred_sec * 1.4;
      row.innerHTML = `<span class="n num">${r.n}</span>
        <div class="bars">
          <div class="bar pred" style="width:${r.pred_sec / mx * 100}%"></div>
          <div class="bar act${slow ? ' slow' : ''}" style="width:${r.actual_sec / mx * 100}%"></div>
        </div>
        <span class="t num">${fmt(r.pred_sec)} / ${fmt(r.actual_sec)}</span>`;
      wrap.appendChild(row);
    });
  }
  $('#btnAgain').onclick = () => { renderBrief(S.paper); go('brief'); };
  $('#btnBack').onclick = () => go('library');

  /* 比赛过程折线：你 vs 幽灵的累计完成题数（幽灵按 seed 重放整局） */
  function renderRaceChart(sess) {
    const box = $('#rChart'); if (!box) return;
    const n = sess.result.per_q.length;
    const youT = sess.result.your_total_sec, ghT = sess.result.ghost_submit_sec;
    const T = Math.max(youT, ghT, 1);
    const you = [[0, 0]]; let c = 0;
    (sess.events || []).forEach(e => { if (e.ev === 'done') { c++; you.push([e.t, c]); } });
    you.push([youT, n]);
    const ghost = [[0, 0]];
    const stored = sess.ghost && sess.ghost.doneList;
    if (stored && stored.length) {
      stored.forEach((d, i) => ghost.push([d.t, i + 1]));  // 精确回放当场时间线
    } else {
      const paper = paperById(sess.paper_id);
      if (paper && sess.ghost && sess.ghost.seedUsed != null) {
        const g = Ghost.build(paper, sess.level, sess.ghost.seedUsed); // 旧session按seed重放（参数改版后形状近似）
        g.doneList.forEach((d, i) => ghost.push([d.t, i + 1]));
      }
    }
    ghost.push([ghT, n]);
    const W = 340, H = 132, pl = 8, pr = 8, pt = 8, pb = 18;
    const X = t => pl + (t / T) * (W - pl - pr);
    const Y = k => pt + (1 - k / n) * (H - pt - pb);
    const path = pts => {  // 中点二次贝塞尔：平滑且单调不超调
      let d = `M ${X(pts[0][0]).toFixed(1)} ${Y(pts[0][1]).toFixed(1)}`;
      for (let i = 1; i < pts.length - 1; i++)
        d += ` Q ${X(pts[i][0]).toFixed(1)} ${Y(pts[i][1]).toFixed(1)} ${((X(pts[i][0]) + X(pts[i + 1][0])) / 2).toFixed(1)} ${((Y(pts[i][1]) + Y(pts[i + 1][1])) / 2).toFixed(1)}`;
      d += ` L ${X(pts[pts.length - 1][0]).toFixed(1)} ${Y(pts[pts.length - 1][1]).toFixed(1)}`;
      return d;
    };
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">
      <line x1="${pl}" y1="${Y(0)}" x2="${W - pr}" y2="${Y(0)}" stroke="#33291d"/>
      <text x="${pl}" y="${H - 5}" fill="#5d5546" font-size="8">0</text>
      <text x="${W - pr}" y="${H - 5}" fill="#5d5546" font-size="8" text-anchor="end">${fmt(T)}</text>
      <path d="${path(ghost)}" fill="none" stroke="#8ad8c6" stroke-width="2" opacity=".8"/>
      <path d="${path(you)}" fill="none" stroke="#c8a24a" stroke-width="2"/>
      <circle cx="${X(ghT)}" cy="${Y(n)}" r="3" fill="#8ad8c6"/>
      <circle cx="${X(youT)}" cy="${Y(n)}" r="3" fill="#c8a24a"/>
    </svg>`;
  }

  /* ---------- 中断恢复 ---------- */
  function persistActive() {
    if (!S.running && !S.pausing) return;
    lsSet(LS.active, {
      paper_id: S.paper.id, level: S.level, seed: S.seed,
      startWall: S.startWall, pausedAccum: S.pausedAccum, pausing: S.pausing,
      pauseStart: S.pauseStart, events: S.events, pointer: S.pointer,
      order: S.order, skipped: S.skipped, done: S.done
    });
  }
  function tryRestore() {
    const a = lsGet(LS.active, null);
    if (!a || !a.paper_id) return false;
    const p = paperById(a.paper_id);
    if (!p) { localStorage.removeItem(LS.active); return false; }
    S.paper = p; S.level = a.level; S.seed = a.seed;
    S.ghost = Ghost.build(p, a.level, a.seed);
    $('#ghostEta').textContent = fmt(S.ghost.predTotal); // 恢复时先给计划总量，下一瞥再校准
    // 校验 seedUsed 一致（引擎确定性）
    S.startWall = a.startWall; S.pausedAccum = a.pausedAccum;
    S.pausing = true; S.pauseStart = Date.now(); // 一律以暂停态恢复
    S.events = a.events; S.pointer = a.pointer; S.order = a.order;
    S.skipped = a.skipped; S.done = a.done;
    S.glimpseRng = (function (x) { return function () { x |= 0; x = x + 0x6D2B79F5 | 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(S.seed ^ 0x9e3779b9);
    S.lastGlimpseShown = 0; S.lastGlimpse = -1; S.glimpseAt = 0; S.ghostSubmitShown = false;
    S.running = true;
    // 死时间兜底：无论页面被冻结/杀掉多久，恢复后时钟对齐到最后一个事件的时刻
    const lastT = S.events.length ? S.events[S.events.length - 1].t : 0;
    S.pausedAccum = Date.now() - S.startWall - lastT * 1000;
    go('race'); buildTrack();
    $('#pauseOv').classList.add('on');
    $('#pauseWhy').textContent = '页面重开，已从断点恢复（已暂停）';
    S.timer = setInterval(tick, 250);
    updateRaceUI(true);
    return true;
  }

  /* 倒计时遮罩：点按可关（防冻结卡住） */
  $('#countdown').onclick = () => $('#countdown').classList.remove('on');

  /* ---------- 结算图导出（canvas 手绘，无外部依赖） ---------- */
  $('#btnShot').onclick = () => {
    if (!S.lastResult) return;
    ac();
    $('#shotImg').src = renderShot(S.lastResult);
    $('#shotOv').classList.add('on');
  };
  $('#shotOv').onclick = () => $('#shotOv').classList.remove('on');

  function renderShot(sess) {
    const W = 750, pad = 44, rowH = 56;
    const rows = sess.result.per_q;
    const H = 342 + 180 + rows.length * rowH + 80;
    const SC = 2; // 2 倍像素渲染，导出更清晰（布局坐标不变）
    const cv = document.createElement('canvas'); cv.width = W * SC; cv.height = H * SC;
    const x = cv.getContext('2d');
    x.scale(SC, SC);
    const RED = '#e0563c', DIM = '#8d8474', INK = '#d9d2c2', FAINT = '#5d5546', GHOST = '#8ad8c6', GOLD = '#c8a24a';
    const mono = 'ui-monospace,Menlo,monospace', serif = '"PingFang SC",sans-serif';
    x.fillStyle = '#16120d'; x.fillRect(0, 0, W, H);
    const g = x.createRadialGradient(W * .75, -60, 0, W * .75, -60, W);
    g.addColorStop(0, 'rgba(200,162,74,.10)'); g.addColorStop(1, 'rgba(200,162,74,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    function rr(px, py, w, h, r) {
      x.beginPath(); x.moveTo(px + r, py);
      x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r);
      x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath();
    }
    let y = pad;
    x.textBaseline = 'middle'; x.textAlign = 'left';
    x.fillStyle = FAINT; x.font = '18px ' + mono;
    x.fillText('卷灵 GHOSTPACE', pad, y);
    y += 56;
    const win = sess.result.win;
    x.save(); x.translate(pad + 46, y + 46); x.rotate(-0.13);
    x.strokeStyle = win ? RED : DIM; x.lineWidth = 5; rr(-44, -44, 88, 88, 10); x.stroke();
    x.fillStyle = win ? RED : DIM; x.font = '700 46px ' + serif; x.textAlign = 'center';
    x.fillText(win ? '胜' : '负', 0, 2); x.restore(); x.textAlign = 'left';
    const diff = Math.abs(sess.result.ghost_submit_sec - sess.result.your_total_sec);
    x.fillStyle = INK; x.font = '700 40px ' + serif;
    x.fillText((win ? '赢 ' : '输 ') + fmt(diff), pad + 128, y + 26);
    const paper = paperById(sess.paper_id);
    const lvName = { '0.85': '轻松', '1': '标准', '1.15': '挑战' }[String(sess.level)] || '标准';
    x.fillStyle = DIM; x.font = '19px ' + serif;
    x.fillText(`${paper ? paper.title : sess.paper_id} · ${lvName}档 · ${(sess.started_at || '').slice(0, 10)}`, pad + 128, y + 70);
    y += 116;
    const bw = (W - pad * 2 - 16) / 2;
    [[pad, '你', sess.result.your_total_sec, RED], [pad + bw + 16, '幽灵', sess.result.ghost_submit_sec, GHOST]].forEach(b => {
      x.fillStyle = '#211b14'; rr(b[0], y, bw, 100, 14); x.fill();
      x.strokeStyle = b[3] + '66'; x.lineWidth = 1.5; rr(b[0], y, bw, 100, 14); x.stroke();
      x.fillStyle = DIM; x.font = '16px ' + serif; x.textAlign = 'center';
      x.fillText(b[1], b[0] + bw / 2, y + 26);
      x.fillStyle = INK; x.font = '34px ' + mono;
      x.fillText(fmt(b[2]), b[0] + bw / 2, y + 66);
    });
    x.textAlign = 'left';
    y += 132;
    // 比赛过程折线（与结算屏同款：金=你 青=幽灵，幽灵优先用存储时间线）
    {
      const n = rows.length;
      const youT = sess.result.your_total_sec, ghT = sess.result.ghost_submit_sec;
      const T = Math.max(youT, ghT, 1);
      const you = [[0, 0]]; let c = 0;
      (sess.events || []).forEach(e => { if (e.ev === 'done') { c++; you.push([e.t, c]); } });
      you.push([youT, n]);
      const ghost = [[0, 0]];
      const dl = sess.ghost && sess.ghost.doneList;
      if (dl && dl.length) dl.forEach((d, i) => ghost.push([d.t, i + 1]));
      else {
        const pp = paperById(sess.paper_id);
        if (pp && sess.ghost && sess.ghost.seedUsed != null)
          Ghost.build(pp, sess.level, sess.ghost.seedUsed).doneList.forEach((d, i) => ghost.push([d.t, i + 1]));
      }
      ghost.push([ghT, n]);
      x.fillStyle = FAINT; x.font = '15px ' + serif;
      x.fillText('比赛过程 · 金=你 青=幽灵', pad, y + 4);
      const cy0 = y + 20, ch = 116, cw = W - pad * 2;
      const X = t => pad + (t / T) * cw;
      const Y = k => cy0 + (1 - k / n) * ch;
      const line = (pts, color, w) => {
        x.strokeStyle = color; x.lineWidth = w; x.beginPath();
        x.moveTo(X(pts[0][0]), Y(pts[0][1]));
        for (let i = 1; i < pts.length - 1; i++)
          x.quadraticCurveTo(X(pts[i][0]), Y(pts[i][1]), (X(pts[i][0]) + X(pts[i + 1][0])) / 2, (Y(pts[i][1]) + Y(pts[i + 1][1])) / 2);
        x.lineTo(X(pts[pts.length - 1][0]), Y(pts[pts.length - 1][1]));
        x.stroke();
      };
      x.strokeStyle = '#33291d'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(pad, Y(0)); x.lineTo(pad + cw, Y(0)); x.stroke();
      line(ghost, GHOST, 2); line(you, GOLD, 2.5);
      [[X(ghT), GHOST], [X(youT), GOLD]].forEach(d => { x.fillStyle = d[1]; x.beginPath(); x.arc(d[0], Y(n), 4, 0, 7); x.fill(); });
      x.fillStyle = FAINT; x.font = '13px ' + mono;
      x.fillText('0', pad, cy0 + ch + 14);
      x.textAlign = 'right'; x.fillText(fmt(T), pad + cw, cy0 + ch + 14); x.textAlign = 'left';
      y += 180;
    }
    x.fillStyle = FAINT; x.font = '15px ' + serif;
    x.fillText('逐题 · 灰=预测 金=实际 红=超时', pad, y);
    y += 30;
    const mx = Math.max(...rows.map(r => Math.max(r.pred_sec, r.actual_sec)));
    // 时间栏宽度按最长文本实测量出，条区动态度让——双位数分钟不再被条尾遮字
    x.font = '15px ' + mono;
    const tColW = Math.max(...rows.map(r => x.measureText(fmt(r.pred_sec) + ' / ' + fmt(r.actual_sec)).width));
    const barMaxW = W - pad * 2 - 60 - tColW;
    rows.forEach(r => {
      x.fillStyle = DIM; x.font = '16px ' + mono;
      x.fillText(String(r.n), pad, y + 16);
      x.fillStyle = '#3a3123'; rr(pad + 44, y + 4, Math.max(2, r.pred_sec / mx * barMaxW), 7, 3); x.fill();
      x.fillStyle = r.actual_sec > r.pred_sec * 1.4 ? RED : GOLD;
      rr(pad + 44, y + 17, Math.max(2, r.actual_sec / mx * barMaxW), 7, 3); x.fill();
      x.fillStyle = FAINT; x.font = '15px ' + mono; x.textAlign = 'right';
      x.fillText(fmt(r.pred_sec) + ' / ' + fmt(r.actual_sec), W - pad, y + 16);
      x.textAlign = 'left';
      y += rowH;
    });
    y += 20;
    x.fillStyle = FAINT; x.font = '15px ' + serif; x.textAlign = 'center';
    x.fillText('卷灵 · 与幽灵赛跑', W / 2, y);
    return cv.toDataURL('image/png');
  }

  /* ---------- 调试把手（agent 用） ---------- */
  window.GP = {
    S, Ghost,
    warp(sec) { S.startWall -= sec * 1000; updateRaceUI(true); }, // 测试：快进到 sec 秒后
    state() { return { t: raceT(), pointer: S.pointer, done: Object.keys(S.done).length, ghost: S.ghost && S.ghost.submit }; }
  };

  /* ---------- 启动 ---------- */
  addEventListener('hashchange', route);
  addEventListener('pointerdown', () => ac(), true); // 兜底：任何真实点击都尝试唤醒音频（iOS 只认手势）
  bridgeHealth().then(flushPending);
  setInterval(() => bridgeHealth().then(flushPending), 15000);
  if (!tryRestore()) route();
})();
