/* 卷灵 · 幽灵引擎
 * 赛前用固定 seed 一次生成整条时间线；赛中页面纯按 wall-clock 查表。
 * T_i = pred × form(OU) × stage × lognormal(σ) × event；两遍生成——第一遍量出原始总长，
 * 第二遍整体缩放，使 submit 精确落在 pred×(0.92~1.08)（漂移幅度由 seed 决定，见 tryBuild）。
 */
'use strict';
window.Ghost = (function () {
  const P = {
    rho: 0.7, formSd: 0.12, sigma: 0.25,
    stallHard: 0.20, stallMid: 0.12, stallEasy: 0.03,
    reviewP: 0.4, browseP: 0.6,
    formLo: 0.75, formHi: 1.45,
    warmupN: 2, warmupF: 1.08, slumpF: 1.10, // 低迷窗口位置随 seed 漂移，见 pass()
    checkLo: 0.03, checkHi: 0.08
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function randn(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* 生成幽灵时间线。返回 {events, doneList, submit, writeEnd, seedUsed}
   * events: [{t, ev, q?, note?}]  ev ∈ browse/break/flip/review/stall_skip/q_done/check_begin/submit
   * doneList: [{q, t}] 按完成时间升序（含补做），供 positionAt 查表 */
  function build(paper, level, seed) {
    const pred = paper.questions.reduce((s, q) => s + q.pred_sec, 0) * level;
    const g = tryBuild(paper, level, seed); // 两遍缩放保证 submit 必落 0.92~1.08 倍 pred，无需重摇
    g.seedUsed = seed; g.predTotal = pred;
    return g;
  }

  function tryBuild(paper, level, seed) {
    // 两遍生成：第一遍拿到含附加事件的原始总时长，第二遍整体缩放，
    // 使 submit 落在预测 ×(0.97~1.03)——逐题结构有机，总时长不失控。
    const pred = paper.questions.reduce((s, q) => s + q.pred_sec, 0) * level;
    const tRng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const target = pred * (0.92 + 0.16 * tRng());  // 总量也带点脾气：±8% 带内漂移（用户要求"总量别太稳"）
    const raw = pass(paper, level, seed, 1);
    return pass(paper, level, seed, target / raw.submit);
  }

  function pass(paper, level, seed, mult) {
    const rng = mulberry32(seed >>> 0);
    const qs = paper.questions, n = qs.length;
    const events = [], doneList = [], work = []; // work: 幽灵逐段"真正在做第几题"的窗口（含卡壳整段与补做回做段），显示层据此如实标注
    let form = 1, t = 0;
    if (rng() < P.browseP) { const b = (30 + rng() * 90) * mult; t += b; events.push({ t: 0, ev: 'browse', note: Math.round(b) + 's' }); }
    // 全场 1–3 次停顿，落在随机题前（下标只有 max(1,n-4) 种，钳制 nBrk 防小卷凑不齐死循环）
    const breaks = new Set();
    const nBrk = Math.min(1 + Math.floor(rng() * 3), Math.max(1, n - 4));
    while (breaks.size < nBrk) breaks.add(2 + Math.floor(rng() * Math.max(1, n - 4)));
    const postponed = [];
    let prevType = qs[0].type;
    let wStart = t; // 当前工作窗口起点：browse/停顿/回改结束后重置
    for (let i = 0; i < n; i++) {
      const q = qs[i];
      form = 1 + P.rho * (form - 1) + randn(rng) * P.formSd;
      form = Math.min(P.formHi, Math.max(P.formLo, form));
      const prog = i / n;
      // 低迷窗口每场随种子漂移（原固定 55%~75% 太可预测）
      const slumpLo = 0.4 + ((seed >>> 3) % 100) / 100 * 0.25;
      const slumpHi = slumpLo + 0.15 + ((seed >>> 7) % 100) / 100 * 0.2;
      const stage = i < P.warmupN ? P.warmupF : (prog >= slumpLo && prog <= slumpHi ? P.slumpF : 1);
      let z = randn(rng); z = Math.max(-2.5, Math.min(2.5, z));
      let dur = q.pred_sec * level * form * stage * Math.exp(P.sigma * z) * mult;
      const sp = q.difficulty === 'hard' ? P.stallHard : q.difficulty === 'mid' ? P.stallMid : P.stallEasy;
      const stalled = rng() < sp;
      if (stalled) dur *= 2.5 + rng() * 1.5;
      if (breaks.has(i)) { const b = (20 + rng() * 40) * mult; t += b; events.push({ t, ev: 'break', note: Math.round(b) + 's' }); wStart = t; }
      if (q.type !== prevType) {
        events.push({ t, ev: 'flip' });
        if (rng() < P.reviewP) { const r = (30 + rng() * 60) * mult; t += r; events.push({ t, ev: 'review', note: Math.round(r) + 's' }); wStart = t; }
        prevType = q.type;
      }
      t += dur;
      work.push({ q: q.n, from: wStart, to: t });
      if (stalled && rng() < 0.5 && i < n - 3) {
        events.push({ t, ev: 'stall_skip', q: q.n });
        postponed.push({ q: q.n, extra: dur * 0.5 });
      } else {
        doneList.push({ q: q.n, t });
        events.push({ t, ev: 'q_done', q: q.n, note: stalled ? 'stall' : undefined });
      }
      wStart = t;
    }
    for (const p of postponed) {
      const wFrom = t;
      t += p.extra;
      work.push({ q: p.q, from: wFrom, to: t }); // 补做：幽灵真的翻回去做那道题
      doneList.push({ q: p.q, t });
      events.push({ t, ev: 'q_done', q: p.q, note: 'returned' });
    }
    const writeEnd = t;
    t += writeEnd * (P.checkLo + rng() * (P.checkHi - P.checkLo));
    events.push({ t: writeEnd, ev: 'check_begin' });
    events.push({ t, ev: 'submit' });
    doneList.sort((a, b) => a.t - b.t);
    return { events, doneList, submit: t, writeEnd, work };
  }

  /* t 时刻幽灵的"卷面前沿"位置（0~1）：赛道刻度按卷面题号排，标记就只说题号的语言——
   * 只认主轴窗口（work 数组前 totalQ 个，卷面顺序），单调不回跳：跳题时前沿随翻页照推，
   * 补做/回改/检查期冻结在最后一个主轴窗口末端（翻回去改不改变"做到第几题"）。
   * 首窗开启前（browse 期）为 0；段内保留 0.85 留白；交卷归 1 由调用方处理。
   * "ta 正在写哪题"（含补做回哪题）仍由 workAt/徽章文案如实报，位置与标签各司其职 */
  function frontPos(g, totalQ, t) {
    const w = g.work || [];
    const m = Math.min(totalQ, w.length);
    let cur = -1;
    for (let i = 0; i < m; i++) {
      if (t >= w[i].from) cur = i; else break; // 主轴窗口 from 严格递增，可早停
    }
    if (cur < 0) return 0;
    const win = w[cur];
    const f = t >= win.to ? 1 : Math.min(1, Math.max(0, (t - win.from) / Math.max(1, win.to - win.from)));
    return (win.q - 1 + f * 0.85) / totalQ;
  }

  /* t 时刻幽灵真正身处的题目窗口 {q, from, to}；browse/停顿/回改/检查的间隙返回 null。
   * 卡壳窗 = 整段死磕时间，补做窗 = 回头重做那段——显示层据此标注真实题号，
   * 不再把"下一件完工的事"错当成"正在做的事" */
  function workAt(g, t) {
    const w = g.work || [];
    for (let i = 0; i < w.length; i++) {
      if (t >= w[i].from && t < w[i].to) return w[i];
    }
    return null;
  }

  /* race 时刻 t 秒时幽灵的位置：{done, frac, submitted} */
  function positionAt(g, totalQ, t) {
    if (t <= 0) return { done: 0, frac: 0 };
    if (t >= g.submit) return { done: totalQ, frac: 1, submitted: true };
    const dl = g.doneList;
    let done = 0;
    while (done < dl.length && dl[done].t <= t) done++;
    let frac = 0;
    if (done < dl.length) {
      const prevT = done > 0 ? dl[done - 1].t : 0;
      const nextT = dl[done].t;
      frac = nextT > prevT ? Math.min(1, Math.max(0, (t - prevT) / (nextT - prevT))) : 1;
      frac *= 0.85; // 当前题未做完，标记停在题间
    }
    return { done, frac };
  }

  /* 幽灵完成第 k 题（按完成顺序）的时刻；k=0 → 0；k≥n → 交卷时刻
   * （最后一题"完工"取 submit 而非 writeEnd：领先/落后的终点必须与胜负判定同一条线——
   * 幽灵写完到交卷还有 3–8% 的检查时间，终点取 writeEnd 会在冲刺段凭空多报几分钟落后） */
  function timeOfDone(g, k) {
    if (k <= 0) return 0;
    const dl = g.doneList;
    if (k >= dl.length) return g.submit;
    return dl[k - 1].t;
  }

  /* 复盘摘要：卡壳/回改/停顿事件列表（人类可读） */
  function replayNotes(g) {
    const out = [];
    for (const e of g.events) {
      if (e.ev === 'q_done' && e.note === 'stall') out.push(`第 ${e.q} 题卡壳`);
      if (e.ev === 'stall_skip') out.push(`第 ${e.q} 题卡住，跳过回头补做`);
      if (e.ev === 'review') out.push(`大题间回改 ${e.note}`);
      if (e.ev === 'break') out.push(`停顿 ${e.note}`);
    }
    return out;
  }

  return { build, positionAt, frontPos, timeOfDone, workAt, replayNotes, P };
})();
