/* 卷灵 GhostPaper · 主逻辑（v1） */
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
  function ac() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } return AC; }
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
  async function bridgeHealth() {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(BRIDGE + '/health', { signal: ctl.signal });
      clearTimeout(to); bridgeOn = r.ok;
    } catch (e) { bridgeOn = false; }
    $('#bridgeDot').className = 'dot ' + (bridgeOn ? 'on' : 'off');
    $('#bridgeDot').title = bridgeOn ? '本地桥在线：数据直存' : '本地桥离线：数据暂存本机';
    $('#netTxt').textContent = bridgeOn ? '本地桥在线 · 数据直存' : '本地桥离线 · 数据暂存本机，赛后自动补传';
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
  }

  /* ---------- 路由 ---------- */
  const screens = ['library', 'brief', 'race', 'result'];
  function go(name) {
    location.hash = '#/' + name;
  }
  function route() {
    let h = (location.hash || '#/library').replace('#/', '');
    if (h === 'race' && !S.running) h = 'library';          // 没有在赛 → 回卷库
    if (h === 'brief' && !S.paper) h = 'library';           // 没选卷 → 回卷库
    if (h === 'result') {                                    // 结算永远展示最近一场
      ensureLastResult().then(s => { if (s) renderResult(s); else go('library'); });
    }
    screens.forEach(s => $('#s-' + s).classList.toggle('on', s === h));
    $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.s === 's-' + h));
    if (h === 'library') renderLibrary();
  }
  /* 最近一场结果：现场 → localStorage → 桥（磁盘） */
  async function ensureLastResult() {
    if (S.lastResult) return S.lastResult;
    S.lastResult = lsGet('gp_last', null);
    if (S.lastResult) return S.lastResult;
    if (bridgeOn) {
      try {
        const r = await fetch(BRIDGE + '/latest');
        if (r.ok) { S.lastResult = await r.json(); lsSet('gp_last', S.lastResult); }
      } catch (e) { }
    }
    return S.lastResult;
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
            const h = hist[s.paper_id] || { wins: 0, losses: 0, best: null };
            if (s.win) h.wins++; else h.losses++;
            const diff = s.ghost - s.you;
            if (h.best == null || diff > h.best) h.best = diff;
            hist[s.paper_id] = h;
          });
          lsSet(LS.history, hist);
          return hist;
        }
      } catch (e) { }
    }
    return history();
  }
  async function renderLibrary() {
    const hist = await loadHistory();
    const list = $('#paperList'); list.innerHTML = '';
    (window.PAPERS_DATA || []).forEach(p => {
      const h = hist[p.id];
      const mins = Math.round(p.questions.reduce((s, q) => s + q.pred_sec, 0) / 60);
      const card = document.createElement('div');
      card.className = 'pcard';
      card.innerHTML =
        `<div class="row1"><span class="tag red">${subjName(p.subject)}</span><span class="tag">${p.grade || ''}</span></div>
         <h3>${p.title}</h3>
         <div class="meta"><span><b class="num">${p.questions.length}</b> 题</span><span>预测 <b class="num">${mins} 分钟</b></span></div>
         <div class="rec"><span>${h ? `战绩 ${h.wins} 胜 ${h.losses} 负` : '尚未挑战'}</span><span class="win">${h && h.best != null ? '最佳：' + (h.best >= 0 ? '领先' : '落后') + ' ' + fmt(Math.abs(h.best)) : '开赛 →'}</span></div>`;
      card.onclick = () => { S.paper = p; renderBrief(p); go('brief'); };
      list.appendChild(card);
    });
    const add = document.createElement('div');
    add.className = 'pcard new';
    add.textContent = '＋ 拍新卷（在聊天里发给 agent）';
    list.appendChild(add);
  }
  function subjName(s) {
    return { math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学', biology: '生物', history: '历史', geography: '地理', politics: '政治' }[s] || s;
  }

  /* ---------- 赛前 ---------- */
  let level = 1.0;
  function renderBrief(p) {
    $('#briefTitle').textContent = p.title;
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
    startWall: 0, pauseStart: 0, pausedAccum: 0, pausing: false,
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

  $('#btnStart').onclick = () => {
    if (!S.paper) return;
    if (S.running && !S.finishT && !confirm('有正在进行的比赛，重开将放弃它。确定重开？')) return;
    ac(); if (AC && AC.state === 'suspended') AC.resume(); // 借开卷手势解锁音频
    startRace(S.paper, level);
  };

  function startRace(paper, lv) {
    const qs = paper.questions;
    S.paper = paper; S.level = lv;
    S.seed = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''), 10);
    S.ghost = Ghost.build(paper, lv, S.seed);
    S.order = qs.map(q => q.n); S.pointer = 0; S.skipped = []; S.done = {};
    S.events = []; S.pausedAccum = 0; S.pausing = false; S.finishT = null;
    S.glimpseRng = (function (a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(S.seed ^ 0x9e3779b9);
    S.lastGlimpseShown = 0; S.lastGlimpse = -1;
    // 倒计时
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
        setTimeout(() => { cd.classList.remove('on'); }, 650);
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
    $('#elapsed').textContent = fmt(t);
    $('#ghostEta').textContent = fmt(S.ghost.submit);
    const n = S.paper.questions.length;
    // 你
    const yourDone = Object.keys(S.done).length;
    const cq = currentQ();
    const yourPos = (yourDone + (cq ? 0.5 : 0)) / n;
    $('#mkYou').style.left = (yourPos * 100) + '%';
    // 幽灵（余光模式：只在 glimpse 时刻刷新显示）
    const gpos = Ghost.positionAt(S.ghost, n, t);
    if (force || t >= S.glimpseAt) {
      S.lastGlimpse = t;
      S.glimpseAt = t + 25 + S.glimpseRng() * 65;
      const dispDone = gpos.done;
      const dispQ = dispDone < n ? (S.ghost.doneList[dispDone] ? S.ghost.doneList[dispDone].q : n) : n;
      $('#mkGhost').style.left = ((dispDone + gpos.frac) / n * 100) + '%';
      $('#mkGhostQ').textContent = gpos.submitted ? '✓' : dispQ;
      // 翻页声：上一瞥到这一瞥之间的 flip 事件
      const flips = S.ghost.events.filter(e => e.ev === 'flip' && e.t > S.lastGlimpseShown && e.t <= t).length;
      if (flips > 0) sndFlip();
      S.lastGlimpseShown = t;
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
    $('#pauseOv').classList.add('on');
    $('#pauseWhy').textContent = auto ? '屏幕离开，已自动暂停' : '幽灵也停下了';
  }
  $('#btnResume').onclick = () => {
    if (!S.pausing) return;
    S.pausedAccum += Date.now() - S.pauseStart;
    S.pausing = false;
    pushEv('resume');
    $('#pauseOv').classList.remove('on');
    wakeLock(true);
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
  function buildSession() {
    const t = S.finishT;
    const per = [];
    let prevT = 0;
    for (const e of S.events) {
      if (e.ev === 'done') {
        const q = S.paper.questions.find(x => x.n === e.q);
        per.push({ n: e.q, pred_sec: Math.round(q.pred_sec * S.level), actual_sec: Math.round(e.t - prevT) });
        prevT = e.t;
      }
    }
    return {
      id: 's_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
      paper_id: S.paper.id, level: S.level, seed: S.seed,
      started_at: new Date(S.startWall).toISOString(),
      events: S.events,
      ghost: { submit: +S.ghost.submit.toFixed(1), writeEnd: +S.ghost.writeEnd.toFixed(1), seedUsed: S.ghost.seedUsed, notes: Ghost.replayNotes(S.ghost) },
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
    // 幽灵回放（取自存档，不依赖现场）
    const notes = (sess.ghost && sess.ghost.notes) || [];
    $('#rReplay').textContent = notes.length ? notes.join('；') + '。' : '幽灵本场顺风顺水，没有卡壳。';
    // 你的本场回放
    const mine = myNotes(sess);
    $('#rMyReplay').textContent = mine.length ? mine.join('；') + '。' : '你本场节奏平稳，没有死磕。';
  }
  $('#btnAgain').onclick = () => { renderBrief(S.paper); go('brief'); };
  $('#btnBack').onclick = () => go('library');

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
    // 校验 seedUsed 一致（引擎确定性）
    S.startWall = a.startWall; S.pausedAccum = a.pausedAccum;
    S.pausing = true; S.pauseStart = Date.now(); // 一律以暂停态恢复
    S.events = a.events; S.pointer = a.pointer; S.order = a.order;
    S.skipped = a.skipped; S.done = a.done;
    S.glimpseRng = (function (x) { return function () { x |= 0; x = x + 0x6D2B79F5 | 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(S.seed ^ 0x9e3779b9);
    S.lastGlimpseShown = 0; S.lastGlimpse = -1; S.glimpseAt = 0;
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

  /* 你的本场回放：与幽灵同一套规则，从真实事件流推导 */
  function myNotes(sess) {
    const out = [];
    sess.result.per_q.forEach(r => {
      if (r.actual_sec > r.pred_sec * 2.5) out.push(`第 ${r.n} 题死磕 ${fmt(r.actual_sec)}`);
    });
    (sess.events || []).forEach(e => {
      if (e.ev === 'skip') out.push(`第 ${e.q} 题跳过，回头补做`);
    });
    const evs = sess.events || [];
    for (let i = 0; i < evs.length; i++) {
      if (evs[i].ev === 'pause' || evs[i].ev === 'auto_pause') {
        const r = evs.slice(i + 1).find(x => x.ev === 'resume');
        if (r) {
          const sec = (new Date(r.wall) - new Date(evs[i].wall)) / 1000;
          if (sec > 60) out.push(`暂停了 ${Math.round(sec / 60)} 分钟`);
        }
      }
    }
    return out;
  }

  /* ---------- 调试把手（agent 用） ---------- */
  window.GP = {
    S, Ghost,
    warp(sec) { S.startWall -= sec * 1000; updateRaceUI(true); }, // 测试：快进到 sec 秒后
    state() { return { t: raceT(), pointer: S.pointer, done: Object.keys(S.done).length, ghost: S.ghost && S.ghost.submit }; }
  };

  /* ---------- 启动 ---------- */
  addEventListener('hashchange', route);
  bridgeHealth().then(flushPending);
  setInterval(() => bridgeHealth().then(flushPending), 15000);
  if (!tryRestore()) route();
})();
