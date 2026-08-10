#!/usr/bin/env python3
"""扫描 data/papers/*.json → 生成 app/papers.js（页面以 <script src> 离线加载）。
建卷/改卷后必须运行：python3 bridge/build_papers_js.py"""
import json, glob, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
papers = []
for f in sorted(glob.glob(os.path.join(ROOT, 'data/papers/*.json'))):
    if f.endswith('index.json'):
        continue
    with open(f) as fp:
        p = json.load(fp)
    # 基本校验
    for k in ('id', 'title', 'subject', 'questions'):
        assert k in p, f"{f} 缺字段 {k}"
    ns = [q['n'] for q in p['questions']]
    assert ns == list(range(1, len(ns) + 1)), f"{p['id']} 题号不连续: {ns}"
    for q in p['questions']:
        assert q.get('pred_sec', 0) > 0, f"{p['id']} 第{q.get('n')}题 pred_sec 缺失或<=0"
        assert q.get('type') and q.get('difficulty'), f"{p['id']} 第{q.get('n')}题 缺 type/difficulty"
    papers.append(p)
out = 'window.PAPERS_DATA = ' + json.dumps(papers, ensure_ascii=False) + ';\n'
dst = os.path.join(ROOT, 'app/papers.js')
with open(dst, 'w') as fp:
    fp.write(out)
print(f'papers.js 已生成：{len(papers)} 份卷 → {dst}')

# WebView 缓存顽固：给 index.html 的子资源打上版本戳强制刷新
import re, time
idx_html = os.path.join(ROOT, 'app/index.html')
with open(idx_html) as fp:
    html = fp.read()
v = str(int(time.time()))
html = re.sub(r'(src|href)="(papers\.js|ghost\.js|app\.js|style\.css)(\?v=\d+)?"',
              rf'\1="\2?v={v}"', html)
with open(idx_html, 'w') as fp:
    fp.write(html)
print(f'index.html 版本戳 → v={v}')
