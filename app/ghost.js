/* 卷灵 · 幽灵引擎
 * 赛前用固定 seed 一次生成整条时间线；赛中页面纯按 wall-clock 查表。
 * T_i = pred × form(OU) × stage × lognormal(σ) × event，总时长校验 ±8% 内，超限换 seed 重摇。
 */
'use strict';
window.Ghost = (function () {
  const P = {
    rho: 0.7, formSd: 0.12, sigma: 0.25,
    stallHard: 0.20, stallMid: 0.12, stallEasy: 0.03,
    reviewP: 0.4, browseP: 0.6,
    formLo: 0.75, formHi: 1.45,
    warmupN: 2, warmupF: 1.08, slumpLo: 0.55, slumpHi: 0.75, slumpF: 1.10,
    checkLo: 0.03, checkHi: 0.08, tolLo: 0.92, tolHi: 1.08
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
    let best = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const g = tryBuild(paper, level, seed + attempt);
      if (!best || Math.abs(g.submit - pred) < Math.abs(best.submit - pred)) best = g;
      if (g.submit >= P.tolLo * pred && g.submit <= P.tolHi * pred) {
        g.seedUsed = seed + attempt; g.predTotal = pred; return g;
      }
    }
    best.seedUsed = seed + 999; best.predTotal = pred; return best;
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
    const events = [], doneList = [];
    let form = 1, t = 0;
    if (rng() < P.browseP) { const b = (30 + rng() * 90) * mult; t += b; events.push({ t: 0, ev: 'browse', note: Math.round(b) + 's' }); }
    // 全场 1–3 次停顿，落在随机题前
    const breaks = new Set();
    const nBrk = 1 + Math.floor(rng() * 3);
    while (breaks.size < nBrk) breaks.add(2 + Math.floor(rng() * Math.max(1, n - 4)));
    const postponed = [];
    let prevType = qs[0].type;
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
      if (breaks.has(i)) { const b = (20 + rng() * 40) * mult; t += b; events.push({ t, ev: 'break', note: Math.round(b) + 's' }); }
      if (q.type !== prevType) {
        events.push({ t, ev: 'flip' });
        if (rng() < P.reviewP) { const r = (30 + rng() * 60) * mult; t += r; events.push({ t, ev: 'review', note: Math.round(r) + 's' }); }
        prevType = q.type;
      }
      t += dur;
      if (stalled && rng() < 0.5 && i < n - 3) {
        events.push({ t, ev: 'stall_skip', q: q.n });
        postponed.push({ q: q.n, extra: dur * 0.5 });
      } else {
        doneList.push({ q: q.n, t });
        events.push({ t, ev: 'q_done', q: q.n, note: stalled ? 'stall' : undefined });
      }
    }
    for (const p of postponed) {
      t += p.extra;
      doneList.push({ q: p.q, t });
      events.push({ t, ev: 'q_done', q: p.q, note: 'returned' });
    }
    const writeEnd = t;
    t += writeEnd * (P.checkLo + rng() * (P.checkHi - P.checkLo));
    events.push({ t: writeEnd, ev: 'check_begin' });
    events.push({ t, ev: 'submit' });
    doneList.sort((a, b) => a.t - b.t);
    return { events, doneList, submit: t, writeEnd };
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

  /* 幽灵完成第 k 题（按完成顺序）的时刻；k=0 → 0 */
  function timeOfDone(g, k) {
    if (k <= 0) return 0;
    const dl = g.doneList;
    return dl[Math.min(k, dl.length) - 1].t;
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

  return { build, positionAt, timeOfDone, replayNotes, P };
})();
