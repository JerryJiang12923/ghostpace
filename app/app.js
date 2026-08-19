/* 卷灵 GhostPace · 主逻辑（v1） */
'use strict';
(function () {
  const BRIDGE = 'http://127.0.0.1:8756';
  const LS = { history: 'gp_history', active: 'gp_active', pending: 'gp_pending', orphan: 'gp_orphan' };
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtSigned = s => (s >= 0 ? '领先 ' : '落后 ') + '≈ ' + fmt(Math.abs(s));
  const nowISO = () => new Date().toISOString();
  const dayLocal = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  /* ---------- 音效（WebAudio，无资产文件） ----------
   * 铁律一：音效异常绝不外泄进游戏逻辑——所有发声整体 try/catch；
   * 铁律二：不许"一次故障永久哑巴"——死 context（closed）立即重建；
   * 僵尸 context（活着但 resume 永不生效，iOS 病灶）按"连续无声"计数弃掉重建；
   * iOS 只认手势：每次真实点按都尝试用静音 buffer 预热解锁。 */
  let AC = null, acRetryAt = 0, acSilent = 0; // acRetryAt：构造失败冷却；acSilent：连续无声计数
  function acDrop() { if (AC) { try { AC.close(); } catch (e) { } } AC = null; acSilent = 0; }
  function ac() {
    try {
      if (AC && AC.state === 'closed') AC = null;    // 死 context：弃掉，下一步重建
      if (!AC && Date.now() >= acRetryAt) {          // 冷却期内不再反复造
        try { AC = new (window.AudioContext || window.webkitAudioContext)(); acSilent = 0; }
        catch (e) { acRetryAt = Date.now() + 5000; return null; }
      }
      if (AC && (AC.state === 'suspended' || AC.state === 'interrupted')) AC.resume().catch(() => { }); // iOS 打断会挂起，借手势恢复（interrupted 是 Safari 专有态）
      return AC;
    } catch (e) { return null; }
  }
  /* 取"能出声"的 context：state 不是 running 就说明这次发声注定无声——
   * 记一次无声；连续 3 次判定为僵尸（resume 始终不生效）→ 弃掉重建，最多 3 次点按内自愈 */
  function acReady() {
    const c = ac();
    if (!c) return null;
    if (c.state !== 'running') {
      if (++acSilent >= 3) acDrop();
      return null;
    }
    acSilent = 0;
    return c;
  }
  /* iOS 解锁：手势里放一段静音 buffer 预热——WebKit 只"记得"手势里发生过的播放，
   * 比单发 resume() 可靠；context 悬浮时调用也无害（排上队，解锁后生效） */
  function acUnlock() {
    try {
      const c = ac(); if (!c) return;
      const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * 0.01)), c.sampleRate);
      const src = c.createBufferSource(); src.buffer = buf;
      src.connect(c.destination); src.start();
    } catch (e) { acDrop(); }
  }
  function sndClick() {
    try {
      const c = acReady(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = 980;
      g.gain.setValueAtTime(0.12, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.09);
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.1);
    } catch (e) { acDrop(); }                         // 发声失败=context 可疑：弃掉重建，且绝不打断调用方（如 btnDone 记事件）
  }
  function sndFlip() {
    try {
      const c = acReady(); if (!c) return;
      const len = Math.max(1, Math.floor(c.sampleRate * 0.14)), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0); // 长度必须取整：浮点直传会炸掉整条发声链
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.8;
      const g = c.createGain(); g.gain.value = 0.16;
      src.connect(f).connect(g).connect(c.destination); src.start();
    } catch (e) { acDrop(); }
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
  /* 按钮快速通道：pointerdown 即触发，不等 click。只用于不滚动的交互区
   * （赛中/暂停遮罩/倒计时）——滚动区的按钮不抢 pointerdown，否则滚动起手会误触。
   * click 兜底留给无 pointer 事件的环境。lastTapAt 是全局的：
   * pointerdown 已触发过的 400ms 内吞掉一切 click 兜底——防止遮罩级按钮（如"继续"）
   * 触发后遮罩消失，系统把该次触摸的 click 派发到下层按钮（如"完成这题"）造成幽灵误触。 */
  let lastTapAt = 0, guardUntil = 0; // guardUntil：恢复/放弃后的防呆窗，吞掉落在下层按钮上的第二击
  function fastTap(el, fn) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (Date.now() < guardUntil) return;      // 防呆窗内：不吃这次触发
      lastTapAt = Date.now(); fn(e);
    });
    el.addEventListener('click', e => { if (Date.now() - lastTapAt > 400) fn(e); });
  }
  function route() {
    let h = (location.hash || '#/library').replace('#/', '');
    // 深链：#/brief/<卷子id> 直达该卷赛前页（建卷 agent 给的入口链接）
    const deep = h.match(/^brief\/(.+)$/);
    if (deep) {
      const p = paperById(decodeURIComponent(deep[1]));
      if (p) { S.browsePaper = p; h = 'brief'; } else h = 'library';
    }
    if (h === 'race' && !S.running && !S.starting) h = 'library'; // 没有在赛 → 回卷库（倒计时中 starting=true 不算误弹）
    if (h === 'brief' && !S.browsePaper) h = 'library';           // 没选卷 → 回卷库
    if (h === 'result') {
      // 结算展示"最近相关的一场"：现场 > 桥最新 > 本地缓存（粘性的——看过某卷旧结算就停在那场）。
      // 先取数渲染再切屏，不闪上一场的残留内容
      ensureLastResult().then(s => {
        if (!s) { go('library'); return; }
        renderResult(s); activate('result');
      });
    } else {
      if (h === 'brief' && S.browsePaper) renderBrief(S.browsePaper);    // 底栏直达赛前也能渲染当前卷（已赛卷的重赛入口）
      activate(h);
    }
    // 底栏：当前页高亮；不可用的暗掉并禁点
    const canBrief = !!S.browsePaper, canRace = S.running || S.starting, canResult = !!(S.lastResult || lsGet('gp_last', null));
    $$('#nav a').forEach(a => {
      const s = a.dataset.s;
      a.classList.toggle('on', s === 's-' + h);
      a.classList.toggle('off', (s === 's-brief' && !canBrief) || (s === 's-race' && !canRace) || (s === 's-result' && !canResult));
    });
  }
  function activate(h) {
    screens.forEach(s => $('#s-' + s).classList.toggle('on', s === h));
    if (h === 'brief') placeRestartRow();                    // 可见后才能量出是否超屏
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
          if (s) { S.lastResult = s; lsSet('gp_last', s); }
        }
      } catch (e) { }
    }
    if (!S.lastResult) S.lastResult = lsGet('gp_last', null);
    // 赛中不覆盖 browsePaper：否则首访结算页会把浏览卷换成旧结果的卷，
    // 此时去赛前页点"开卷"，重开确认会启动错误的卷（正在赛的卷被顶掉）
    if (S.lastResult && !S.running) S.browsePaper = paperById(S.lastResult.paper_id) || S.browsePaper; // "再来一卷"要拿得到卷
    return S.lastResult;
  }

  // 已赛卷子：按卷取最新一场进结算；看过的结果按卷缓存，桥离线也能回看
  async function showPaperResult(p) {
    S.browsePaper = p;
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
            // 完成日期取 session id 里的保存时刻（id 是 UTC 时间戳，还原成 Date 再取本地日——凌晨完赛不再显示昨天；
            // 不用 started_at：中断恢复时它是旧时间）
            const day = s.id && s.id.length >= 14
              ? dayLocal(new Date(Date.UTC(+s.id.slice(2, 6), +s.id.slice(6, 8) - 1, +s.id.slice(8, 10), +s.id.slice(10, 12), +s.id.slice(12, 14))))
              : (s.started_at ? dayLocal(new Date(s.started_at)) : '');
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
      card.onclick = () => { S.browsePaper = p; raced ? showPaperResult(p) : (renderBrief(p), go('brief')); };
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
    renderOrphanBar();
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
      i.title = `${qLabel(p, q.n) ?? `第${q.n}题`} ${fmt(q.pred_sec)}`;
      bars.appendChild(i);
    });
  }
  $$('.level').forEach(b => b.onclick = () => {
    $$('.level').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); level = parseFloat(b.dataset.lv);
    if (S.browsePaper) renderBrief(S.browsePaper);
  });

  /* ---------- 比赛状态 ---------- */
  const S = {
    paper: null, browsePaper: null, ghost: null, seed: 0,
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
    if (!S.browsePaper) return;
    // 比赛中重开：分离确认（WKWebView 没有 confirm 面板；同键二次确认会被连点误触）
    if (S.running && !S.finishT) { placeRestartRow(); $('#restartRow').style.display = 'flex'; return; }
    acUnlock(); // 借开卷手势解锁音频（静音 buffer 预热，比单发 resume 可靠）
    startRace(S.browsePaper, level);
  };
  $('#btnRestartNo').onclick = () => { $('#restartRow').style.display = 'none'; };
  $('#btnRestartYes').onclick = () => {
    $('#restartRow').style.display = 'none';
    acUnlock();
    startRace(S.browsePaper, level);
  };

  function startRace(paper, lv) {
    if (S.starting) return;      // 倒计时中禁止重入（双开会写双 start 事件并泄漏 interval）
    clearInterval(S.timer);      // 赛中重开：杀掉旧 tick，防 interval 泄漏
    const qs = paper.questions;
    S.paper = paper; S.browsePaper = paper; S.level = lv; // 赛卷焊死：浏览操作（卷库点卡等）不再能覆盖   
    S.seed = (Date.now() / 1000) | 0; // 开赛时间戳做种子：同日重赛不再撞同一只幽灵（复盘按 session 存的 seedUsed 回放）
    S.ghost = Ghost.build(paper, lv, S.seed);
    $('#ghostEta').textContent = fmt(S.ghost.predTotal); // 未见其影之前的初始估计=计划总量
    S.order = qs.map(q => q.n); S.pointer = 0; S.skipped = []; S.done = {};
    S.events = []; S.pausedAccum = 0; S.pausing = false; S.finishT = null;
    S.running = false; // 重开时旧 race 的 running 标志要在倒计时前清掉，否则倒计时间切后台会往新 events 里写 auto_pause
    S.glimpseRng = (function (a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(S.seed ^ 0x9e3779b9);
    S.lastGlimpse = -1; S.ghostSubmitShown = false;
    // 倒计时（点按遮罩 = 跳过倒计时立即开卷，也是倒计时卡死时的出口；令牌防迟到 interval 二次触发）
    S.starting = true;
    S.raceGen = (S.raceGen || 0) + 1;
    const gen = S.raceGen;
    go('race');
    const cd = $('#countdown'); cd.classList.add('on');
    let n = 3;
    cd.textContent = n;
    const cdi = setInterval(() => {
      if (gen !== S.raceGen) { clearInterval(cdi); return; }
      n--;
      if (n > 0) { cd.textContent = n; sndClick(); }
      else { clearInterval(cdi); beginRace(); }
    }, 750);
    S.cdTap = () => { if (gen === S.raceGen) { S.raceGen++; clearInterval(cdi); beginRace(); } };
  }

  function beginRace() {
    S.raceGen = (S.raceGen || 0) + 1; // 作废倒计时令牌：正常开跑后 450ms 退场窗内的迟到点按不再二次 beginRace
    const cd = $('#countdown');
    cd.textContent = '开卷';
    setTimeout(() => { cd.classList.remove('on'); }, 450);
    S.starting = false;             // 关键状态先行：音效/遮罩等外围动作出任何错都挡不住开赛
    S.startWall = Date.now(); S.running = true;
    pushEv('start');
    sndFlip();                      // 音效放状态之后（sndFlip 自身也吞异常，双保险）
    S.glimpseAt = 20 + S.glimpseRng() * 40; // 第一瞥稍早
    S.timer = setInterval(tick, 250);
    wakeLock(true);
    buildTrack(); updateRaceUI(true);
    // 倒计时期间切后台的场景：visibilitychange 那一刻还没 running 不会触发自动暂停，
    // 倒计时走完 beginRace 在后台照常启动秒表——开跑即补一个自动暂停，时间不空转
    if (document.visibilityState === 'hidden') doPause(true);
  }

  /* wakeLock —— 意图态 + 串行执行 + 赛中巡检：比赛中绝不灭屏
   * 旧实现的竞态：切后台 release() 还在飞行中就切回来，wakeLock(true) 见
   * released===false 误判"已有锁"直接返回 → release 落定后裸奔熄屏。
   * 现在：所有操作进同一条 promise 链按序收敛，快速 暂停→继续 时释放干脆不发生；
   * tick 里再巡检兜底——锁被系统收回（来电/分屏等）2 秒内自动补回。 */
  let wl = null, wlChain = Promise.resolve(), wlLastTry = 0;
  const wlHeld = () => !!(wl && wl.released === false);
  function wakeLock(on) { wlChain = wlChain.then(() => wlApply(on)).catch(() => { }); }
  async function wlApply(on) {
    if (!('wakeLock' in navigator)) return;
    try {
      if (on) {
        if (wlHeld()) return;                                        // 已有生效锁：不重复 request
        if (wl) { try { await wl.release(); } catch (e) { } wl = null; } // 持过期锁先弃再请
        wl = await navigator.wakeLock.request('screen');
        wlLastTry = Date.now();
      } else if (wl) {
        await wl.release(); wl = null;                               // release 后置 null：旧锁对象已过期，不能再碰
      }
    } catch (e) { wl = null; if (on) wlLastTry = Date.now(); }       // request 失败：清引用，巡检会重试
  }
  function wlEnsure() {  // 赛中巡检：锁一丢就补（节流 2s，防 request 持续失败时刷爆）
    if (S.running && !S.pausing && !S.finishT && !wlHeld() && Date.now() - wlLastTry > 2000) {
      wlLastTry = Date.now();
      wakeLock(true);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // 回到前台：借机唤醒音频（后台会挂起 context；需要手势的平台会在下次点按时自愈）
      acUnlock();
      // 比赛中且未暂停则确保上锁（串行链收敛，与在飞的 release 不再竞态）
      if (S.running && !S.pausing) wakeLock(true);
      bridgeSync();
    } else if (S.running && !S.pausing && !S.finishT) doPause(true);
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
    // 当前题累计投入：attributeTimes 给出过去各段（含跳题前的第一段，暂停期 t 冻结天然不计）+ 本段
    const lastEvT = S.events.length ? S.events[S.events.length - 1].t : 0;
    const accQ = attributeTimes(S.events, S.order);
    const curEl = cq ? (accQ[cq] || 0) + (t - lastEvT) : 0;
    const yourPos = (yourDone + (cq ? 0.5 : 0)) / n;
    $('#mkYou').style.left = (yourPos * 100) + '%';
    // 幽灵（余光模式：只在 glimpse 时刻刷新显示。两个例外都是设计：交卷是考场公开事件立即揭示；
    // 做完/跳过一题时的 force 刷新 = 做完一题自然抬头看一眼考场，不算信息泄漏）
    const justSubmitted = gpos.submitted && !S.ghostSubmitShown;
    if (force || justSubmitted || t >= S.glimpseAt) {
      S.lastGlimpse = t;
      S.glimpseAt = t + 25 + S.glimpseRng() * 65;
      if (gpos.submitted) S.ghostSubmitShown = true;
      const dispDone = gpos.done;
      // 幽灵"真正在做的题"从工作窗口推导：卡壳整段、补做回做段都如实标注，
      // 不再把"下一件完工的事"错当成"正在做的事"（browse/停顿/回改间隙无窗口，退回完工顺序近似）
      const wk = gpos.submitted ? null : Ghost.workAt(S.ghost, t);
      const dispQ = wk ? wk.q : (dispDone < n ? (S.ghost.doneList[dispDone] ? S.ghost.doneList[dispDone].q : n) : n);
      const wkFrac = wk ? Math.min(1, Math.max(0, (t - wk.from) / Math.max(1, wk.to - wk.from))) : 0;
      const predOf = {}; S.paper.questions.forEach(q => predOf[q.n] = q.pred_sec * S.level);
      const predTotal = S.ghost.predTotal;
      // 幽灵预计完卷 = 已过时间(沉没) + 剩余工作量 × 已完工配速。
      // 配速只由已完成的活证明（最后完工时刻÷已完成预测和，收缩向计划配速）——卡壳/在制时间不进配速分子：
      // 局部卡壳 ≠ 全局降速，卡壳的代价以加法体现（卡一秒交卷约推迟一秒），不再乘到全部剩余工作量上暴涨
      if (gpos.submitted) {
        $('#ghostEta').textContent = fmt(S.ghost.submit); // 已交卷：冻结在实际交卷时刻，不再跟着秒表走
      } else if (dispDone >= n) {
        $('#ghostEta').textContent = '收尾检查中'; // 全题写完未交卷：检查期(3–8%)进行中，外推公式在此退化(剩0→显示当前t)，如实提示
      } else {
        let predDone = 0;
        for (let i = 0; i < dispDone; i++) predDone += predOf[S.ghost.doneList[i].q] || 0;
        // 在制题进度：优先真实工作窗口（题号与占比都真），无窗口退回完工插值
        const predWip = wk
          ? (predOf[wk.q] || 0) * wkFrac
          : (S.ghost.doneList[dispDone] ? (predOf[S.ghost.doneList[dispDone].q] || 0) * gpos.frac : 0);
        const tDone = dispDone > 0 ? S.ghost.doneList[dispDone - 1].t : 0; // 最后一题完工时刻（卡壳期间冻结）
        const pace = (tDone + predTotal / 3) / (predDone + predTotal / 3); // 收缩向计划配速1.0：见得少时别太信观测
        $('#ghostEta').textContent = fmt(t + (predTotal - predDone - predWip) * pace);
      }
      // 幽灵标记：优先真实工作窗口（卡壳窗内位置不漂、补做真的往回走），无窗口退回完工插值
      const mkPos = wk ? (wk.q - 1 + wkFrac * 0.85) / n : (dispDone + gpos.frac) / n;
      $('#mkGhost').style.left = (mkPos * 100) + '%';
      $('#mkGhostQ').textContent = gpos.submitted ? '✓' : dispQ;
      // 状态行
      if (gpos.submitted) {
        $('#glimpseTxt').innerHTML = '幽灵 <b>已交卷</b>';
      } else if (dispDone >= n) {
        $('#glimpseTxt').innerHTML = '余光一瞥 · 幽灵 <b>写完了，收卷中</b>';
      } else {
        // 在制时长已超该题预估 2 倍 → 考场里你早注意到 ta 停笔了：如实说"卡住"（正常波动极少越过 2 倍）
        const stuckHint = wk && (t - wk.from) > (predOf[wk.q] || 0) * 2 ? '卡在' : '在';
        const dqLabel = qLabel(S.paper, dispQ); // 无 label 时文案与旧版逐字一致（"第 N 题附近"）
        $('#glimpseTxt').innerHTML = `余光一瞥 · 幽灵${stuckHint} <b>${dqLabel ? dqLabel + ' 附近' : `第 ${dispQ} 题附近`}</b>`;
      }
      $('#glimpseAge').textContent = '刚刚瞥见';
      // 领先/落后：完成数 + 在制题进度折算（已耗时÷(预估×1.3)，钳到 0.9——刻意悲观：永远给"还没写完"
      // 留足余量，同速做题时最多唱衰约 1/3 道题，交题时结算归还；超时折算封顶，但 −t 继续按秒掉，卡题照样显示失血），
      // 在幽灵相邻完工时刻间插值。
      // 注：幽灵时间线赛前已定，这里用的是它的"全量"时刻（含未瞥见段），与 ETA 只按所见外推不同——开卷考试式赛跑，可接受。
      const cqQ = cq ? S.paper.questions.find(x => x.n === cq) : null;
      const frac = cqQ ? Math.min(0.9, Math.max(0, curEl / (cqQ.pred_sec * S.level * 1.3))) : 0;
      const effDone = yourDone + frac;
      const kDone = Math.floor(effDone);
      const gT0 = Ghost.timeOfDone(S.ghost, kDone);
      const gT1 = Ghost.timeOfDone(S.ghost, Math.min(kDone + 1, n));
      const leadSec = (gT0 + (gT1 - gT0) * (effDone - kDone)) - t;
      const bl = $('#behind');
      bl.textContent = (yourDone === 0 && frac < 0.1) ? '蓄势' : fmtSigned(leadSec); // 开卷头一程不报数
      bl.className = Math.abs(leadSec) < 20 ? 'behind even' : (leadSec >= 0 ? 'behind ahead' : 'behind');
    } else if (S.lastGlimpse >= 0) {
      $('#glimpseAge').textContent = Math.round(t - S.lastGlimpse) + ' 秒前瞥见';
    }
    // 当前题信息
    if (cq) {
      const q = S.paper.questions.find(x => x.n === cq);
      const over = curEl > 2.5 * q.pred_sec * S.level; // 按累计投入算（暂停不清零，跳题补做两段合并）
      const nm = q.label ?? cq; // 有卷面显示名就显示名，无则照旧显示内部题号
      $('#qno').classList.toggle('long', String(nm).length >= 4); // 长名降字号防溢出（见 style.css）
      $('#qno').innerHTML = `${nm}<small> / ${n}</small>`;
      $('#qtype').innerHTML = `${typeName(q.type)} · 预估 <b class="num">${fmt(q.pred_sec * S.level)}</b>${q.difficulty === 'hard' ? ' · 难点' : ''}${over ? ' · <b style="color:var(--red-hi)">已超预估，考虑跳题</b>' : ''}`;
      const nq = nextAfter(cq);
      const catchup = S.pointer >= S.order.length;
      $('#btnDoneSub').textContent = (catchup ? `补做中 · 还剩 ${S.skipped.length} 题 · ` : '') +
        (nq ? `下一题：${qLabel(S.paper, nq) ?? `第${nq}题`} · ${typeName(S.paper.questions.find(x => x.n === nq).type)}` : '这是最后一题');
    }
  }
  function nextAfter(cq) {
    const rest = S.order.slice(S.pointer + 1).concat(S.skipped.filter(x => x !== cq));
    return rest.length ? rest[0] : null;
  }
  function typeName(t) { return { choice: '选择', multi: '多选', fill: '填空', solve: '解答', reading: '阅读', cloze: '完形', writing: '作文', other: '其他' }[t] || '题目'; }
  /* 显示名：n 是唯一内部键（事件流/幽灵/存档/领先 ETA 全用它）；label 是卷面可选显示名，
     用于按板块组卷、每板块内部从 1 重新编号的卷子（label 写"板块·题号"，如 "一·3"/"二·1"）。
     21(3) 那种小题仍整题录成第 21 题，不用 label。无 label 的卷子一切照旧。返回 null = 无 label，回落内部题号。 */
  function qLabel(paper, n) { const q = paper && paper.questions.find(x => x.n === n); return (q && q.label) ? q.label : null; }

  function tick() {
    if (!S.running || S.pausing) return;
    wlEnsure(); // 保活巡检：比赛中锁丢了 2 秒内自动补回（灭屏防线）
    updateRaceUI(false);
  }

  /* ---------- 按钮 ---------- */
  fastTap($('#btnDone'), () => {
    if (!S.running || S.pausing) return;
    const cq = currentQ();
    if (!cq) return;
    acUnlock(); sndClick();
    pushEv('done', cq);
    S.done[cq] = raceT();
    if (S.pointer < S.order.length && S.order[S.pointer] === cq) S.pointer++;
    else S.skipped = S.skipped.filter(x => x !== cq);
    const btn = $('#btnDone');
    btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 180);
    if (!currentQ()) { doFinish(); return; }
    updateRaceUI(true);
  });
  fastTap($('#btnSkip'), () => {
    if (!S.running || S.pausing) return;
    const cq = currentQ();
    if (!cq || S.pointer >= S.order.length) return;
    pushEv('skip', cq);
    S.skipped.push(cq); S.pointer++;
    updateRaceUI(true);
  });
  fastTap($('#btnPause'), () => doPause(false));
  function doPause(auto) {
    if (!S.running || S.pausing) return;
    S.pausing = true; S.pauseStart = Date.now();
    pushEv(auto ? 'auto_pause' : 'pause');
    wakeLock(false); // 暂停即允许熄屏（人走开了屏幕不该一直亮着）；继续时 btnResume 重新申请
    $('#abortBar').style.display = 'none'; $('#btnAbort').style.display = ''; // 每次进暂停重置确认条
    $('#pauseOv').classList.add('on');
    $('#pauseWhy').textContent = auto ? '屏幕离开，已自动暂停' : '幽灵也停下了';
  }
  fastTap($('#btnResume'), () => {
    if (!S.pausing) return;
    acUnlock();
    $('#abortBar').style.display = 'none'; $('#btnAbort').style.display = ''; // 继续=天然取消放弃
    S.pausedAccum += Date.now() - S.pauseStart;
    S.pausing = false;
    pushEv('resume');
    $('#pauseOv').classList.remove('on');
    wakeLock(true);
    guardUntil = Date.now() + 350; // 遮罩消失瞬间，落在下方按钮上的幽灵点击/双击第二下都要吞掉
  });
  // 放弃比赛：确认条出现在遮罩顶部（远离下方按钮区，连点误触不到）
  fastTap($('#btnAbort'), () => { $('#btnAbort').style.display = 'none'; $('#abortBar').style.display = 'flex'; });
  fastTap($('#btnAbortYes'), () => {
    S.running = false; S.pausing = false; S.starting = false; S.finishT = null;
    localStorage.removeItem(LS.active);
    $('#abortBar').style.display = 'none'; $('#btnAbort').style.display = '';
    $('#pauseOv').classList.remove('on');
    clearInterval(S.timer);
    wakeLock(false); // 放弃也要放掉常亮锁，否则回卷库后屏幕一直亮
    S.paper = null; // 解锁比赛卷：之后浏览操作可以重新选卷（卷库/赛前）
    guardUntil = Date.now() + 350; // 遮罩消失瞬间，落在下方按钮上的幽灵点击要吞掉
    go('library');
  });

  /* ---------- 结束与结算 ---------- */
  function doFinish() {
    pushEv('finish');
    S.finishT = raceT();
    S.running = false;
    clearInterval(S.timer);
    wakeLock(false);
    const sess = buildSession();            // 此时 S.paper 仍是赛卷
    S.lastResult = sess; lsSet('gp_last', sess);
    const rc = lsGet('gp_results', {}); rc[sess.paper_id] = sess; lsSet('gp_results', rc);
    saveSession(sess);
    // 战绩（与桥端 /list 同结构：last/lastId/lastDay 也要写——离线时卡片印章和日期才不倒退）
    const h = history();
    const rec = h[sess.paper_id] || { wins: 0, losses: 0, best: null };
    if (sess.result.win) rec.wins++; else rec.losses++;
    const diff = sess.result.ghost_submit_sec - sess.result.your_total_sec;
    if (rec.best == null || diff > rec.best) rec.best = diff;
    rec.last = diff; rec.lastId = sess.id; rec.lastDay = dayLocal(new Date());
    h[sess.paper_id] = rec; lsSet(LS.history, h);
    localStorage.removeItem(LS.active);
    S.paper = null; // 全部结算收尾后才解锁赛卷（此前 buildSession/history 都读 S.paper）；S.browsePaper 仍指向这场卷供"再来一卷"
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
        const item = { n: e.q, pred_sec: Math.round(q.pred_sec * S.level), actual_sec: Math.round(acc[e.q] || 0) };
        if (q.label) item.label = q.label; // 显示名快照：之后卷子 label 再改，旧场次结算/导出不漂移
        per.push(item);
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
    const lvName = { '0.85': '挑战', '1': '标准', '1.15': '轻松' }[String(sess.level)] || '标准';
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
      row.innerHTML = `<span class="n num">${r.label ?? qLabel(paper, r.n) ?? r.n}</span>
        <div class="bars">
          <div class="bar pred" style="width:${r.pred_sec / mx * 100}%"></div>
          <div class="bar act${slow ? ' slow' : ''}" style="width:${r.actual_sec / mx * 100}%"></div>
        </div>
        <span class="t num">${fmt(r.pred_sec)} / ${fmt(r.actual_sec)}</span>`;
      wrap.appendChild(row);
    });
  }
  $('#btnAgain').onclick = () => { if (!S.browsePaper) { go('library'); return; } renderBrief(S.browsePaper); go('brief'); };
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
  /* 存档与当前卷是否兼容：题数、题号逐一吻合。不兼容时硬恢复会让事件流里的题号
   * 在新卷里找不到，buildSession 的 questions.find() → undefined → 结算空指针
   * （和"比赛卷被换"同族的坑）。 */
  function archiveCompatible(a) {
    const p = paperById(a.paper_id);
    return !!(p && a.order && a.order.length === p.questions.length &&
      p.questions.every((q, i) => q.n === a.order[i]));
  }
  /* 孤儿存档：绝不静默删档——这是未完成比赛唯一的现场记录。
   * 挪进 gp_orphan（persistActive 只写 gp_active，不会覆盖它），
   * 卷库页挂出明示条让用户找 agent 尽可能修复；桥在线时自动备份进 data/profile/，
   * agent 不依赖设备 localStorage 也能拿到现场。 */
  function orphanArchive(a) {
    lsSet(LS.orphan, a);
    localStorage.removeItem(LS.active);
    renderOrphanBar();
    pushOrphan();
  }
  async function pushOrphan() {
    const o = lsGet(LS.orphan, null);
    if (!o || !bridgeOn) return;
    try {
      await fetch(BRIDGE + '/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relpath: 'profile/active_orphan_' + o.paper_id + '_' + (o.startWall || 0) + '.json', data: o })
      });
    } catch (e) { }
  }
  function renderOrphanBar() {
    const bar = $('#orphanBar'); if (!bar) return;
    const o = lsGet(LS.orphan, null);
    if (!o) { bar.style.display = 'none'; return; }
    const p = paperById(o.paper_id);
    $('#orphanTxt').innerHTML =
      `有一场未完成比赛无法自动恢复${p ? '：《' + p.title + '》' : '（卷 ' + o.paper_id + ' 已不在卷库）'}——存档后卷子被改动过。` +
      `<b>请在聊天里告诉 agent，它会尽可能修复这场存档</b>（桥在线时已自动备份到 data/profile/）。修好后回来点"再试恢复"。`;
    bar.style.display = '';
  }
  $('#orphanRetry').onclick = () => {
    const o = lsGet(LS.orphan, null);
    if (!o) return;
    if (archiveCompatible(o)) {
      lsSet(LS.active, o); localStorage.removeItem(LS.orphan);
      renderOrphanBar(); // 孤儿已清，先收条再进赛道
      if (tryRestore()) return; // 成功：已进赛道（暂停态）
    }
    renderOrphanBar();
    $('#orphanTxt').innerHTML += '<br><span style="color:var(--red-hi)">仍不兼容——等 agent 修好卷子再来。</span>';
  };
  // 桥离线时 agent 拿不到备份：把存档 JSON 复制到剪贴板，用户粘到聊天里交给 agent
  $('#orphanCopy').onclick = async () => {
    const o = lsGet(LS.orphan, null);
    if (!o) return;
    try { await navigator.clipboard.writeText(JSON.stringify(o)); $('#orphanCopy').textContent = '已复制 ✓'; }
    catch (e) { $('#orphanCopy').textContent = '复制失败'; }
    setTimeout(() => { $('#orphanCopy').textContent = '复制存档'; }, 2000);
  };
  // 弃档是销毁证据级的操作：内联二次确认（本 WebView 无 confirm 面板）
  let orphanDropArm = 0;
  $('#orphanDrop').onclick = () => {
    if (Date.now() - orphanDropArm < 3000) {
      localStorage.removeItem(LS.orphan); orphanDropArm = 0;
      $('#orphanDrop').textContent = '弃档';
      renderOrphanBar();
    } else {
      orphanDropArm = Date.now();
      $('#orphanDrop').textContent = '确认弃档？再点一次';
      setTimeout(() => { $('#orphanDrop').textContent = '弃档'; }, 3000);
    }
  };
  function tryRestore() {
    const a = lsGet(LS.active, null);
    if (!a || !a.paper_id) return false;
    if (!archiveCompatible(a)) { orphanArchive(a); return false; }
    const p = paperById(a.paper_id);
    S.paper = p; S.browsePaper = p; S.level = a.level; S.seed = a.seed;
    S.ghost = Ghost.build(p, a.level, a.seed);
    $('#ghostEta').textContent = fmt(S.ghost.predTotal); // 恢复时先给计划总量，下一瞥再校准
    // 校验 seedUsed 一致（引擎确定性）
    S.startWall = a.startWall; S.pausedAccum = a.pausedAccum;
    S.pausing = true; S.pauseStart = Date.now(); // 一律以暂停态恢复
    S.events = a.events; S.pointer = a.pointer; S.order = a.order;
    S.skipped = a.skipped; S.done = a.done;
    S.glimpseRng = (function (x) { return function () { x |= 0; x = x + 0x6D2B79F5 | 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })(S.seed ^ 0x9e3779b9);
    S.lastGlimpse = -1; S.glimpseAt = 0; S.ghostSubmitShown = false;
    S.running = true;
    // 死时间兜底：无论页面被冻结/杀掉多久，恢复后时钟对齐到最后一个事件的时刻
    const lastT = S.events.length ? S.events[S.events.length - 1].t : 0;
    S.pausedAccum = Date.now() - S.startWall - lastT * 1000;
    go('race'); buildTrack();
    $('#pauseOv').classList.add('on');
    $('#pauseWhy').textContent = '页面重开，已从断点恢复（已暂停）';
    // 档位选中态同步成恢复局的真实档位（否则赛前页永远显示"标准"被选中；
    // 同时让 level 变量一致——弃赛后直接重开不会拿错档位）
    level = a.level;
    $$('.level').forEach(b => b.classList.toggle('sel', parseFloat(b.dataset.lv) === a.level));
    S.timer = setInterval(tick, 250);
    updateRaceUI(true);
    return true;
  }

  /* 倒计时遮罩：点按 = 跳过倒计时立即开卷（绑定一次，具体动作由 startRace 通过 S.cdTap 注入） */
  fastTap($('#countdown'), () => { if (S.cdTap) S.cdTap(); });

  /* ---------- 结算图导出（canvas 手绘，无外部依赖） ---------- */
  $('#btnShot').onclick = () => {
    if (!S.lastResult) return;
    acUnlock();
    $('#shotImg').src = renderShot(S.lastResult);
    $('#shotOv').classList.add('on');
  };
  $('#shotOv').onclick = () => $('#shotOv').classList.remove('on');

  function renderShot(sess) {
    const W = 750, pad = 44, rowH = 56;
    const rows = sess.result.per_q;
    const SC = 2; // 2 倍像素渲染，导出更清晰（布局坐标不变）
    const RED = '#e0563c', DIM = '#8d8474', INK = '#d9d2c2', FAINT = '#5d5546', GHOST = '#8ad8c6', GOLD = '#c8a24a';
    const mono = 'ui-monospace,Menlo,monospace', serif = '"PingFang SC",sans-serif';
    const cv = document.createElement('canvas');
    const x = cv.getContext('2d');
    // 头部信息行先量后画：标题太长就标题独占一行、档位·日期换行（必要时标题截断加省略号）——
    // 日期永远不许被顶出画布。量完再定画布高度。
    const paper = paperById(sess.paper_id);
    const lvName = { '0.85': '挑战', '1': '标准', '1.15': '轻松' }[String(sess.level)] || '标准';
    const titleStr = paper ? paper.title : sess.paper_id;
    const metaSuffix = ' · ' + lvName + '档 · ' + (sess.started_at ? dayLocal(new Date(sess.started_at)) : '');
    const metaMax = W - (pad + 128) - pad; // 信息行右缘留白
    let metaExtra = 0, titleLine = titleStr;
    x.font = '19px ' + serif;
    if (x.measureText(titleStr + metaSuffix).width > metaMax) {
      metaExtra = 26;
      if (x.measureText(titleLine).width > metaMax) {
        while (titleLine.length > 1 && x.measureText(titleLine + '…').width > metaMax) titleLine = titleLine.slice(0, -1);
        titleLine += '…';
      }
    }
    const H = 342 + 180 + rows.length * rowH + 80 + metaExtra;
    cv.width = W * SC; cv.height = H * SC;
    x.scale(SC, SC);
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
    x.fillStyle = DIM; x.font = '19px ' + serif;
    if (metaExtra) { // 标题太长：标题一行（超宽已截断加省略号），档位·日期第二行
      x.fillText(titleLine, pad + 128, y + 60);
      x.fillText(metaSuffix.slice(3), pad + 128, y + 86);
    } else {
      x.fillText(titleStr + metaSuffix, pad + 128, y + 70);
    }
    y += 116 + metaExtra;
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
    // 题号列同款实测：有卷面 label 就显示 label；无 label 时两位数以内的数字量宽 < 44，
    // 列宽钳在 44 = 与旧版硬编码几何完全一致
    x.font = '16px ' + mono;
    const qName = r => String(r.label ?? qLabel(paper, r.n) ?? r.n);
    const nColW = Math.max(44, ...rows.map(r => x.measureText(qName(r)).width + 10));
    const barMaxW = W - pad * 2 - nColW - 16 - tColW;
    rows.forEach(r => {
      x.fillStyle = DIM; x.font = '16px ' + mono;
      x.fillText(qName(r), pad, y + 16);
      x.fillStyle = '#3a3123'; rr(pad + nColW, y + 4, Math.max(2, r.pred_sec / mx * barMaxW), 7, 3); x.fill();
      x.fillStyle = r.actual_sec > r.pred_sec * 1.4 ? RED : GOLD;
      rr(pad + nColW, y + 17, Math.max(2, r.actual_sec / mx * barMaxW), 7, 3); x.fill();
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
    state() { return { t: raceT(), pointer: S.pointer, done: Object.keys(S.done).length, ghost: S.ghost && S.ghost.submit }; },
    audio() { return { state: AC ? AC.state : 'none', silent: acSilent }; } // 调试把手：当前 context 状态与无声计数
  };

  /* ---------- 启动 ---------- */
  const bridgeSync = () => bridgeHealth().then(() => { flushPending(); pushOrphan(); }); // 体检→补传待存→备份孤儿存档
  addEventListener('hashchange', route);
  addEventListener('pointerdown', () => acUnlock(), true); // 兜底：任何真实点击都尝试唤醒音频（iOS 只认手势，静音 buffer 预热）
  bridgeSync();
  setInterval(bridgeSync, 15000);
  if (!tryRestore()) route();
})();
