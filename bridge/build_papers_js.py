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
if not papers:
    print('提示：卷库为空。可复制 examples/demo-paper.json 到 data/papers/ 体验演示卷，或按 docs/ 格式自建。')
# 注：子资源缓存由 index.html 的运行期引导破戳（?t=Date.now()），构建期无需再碰 index.html
