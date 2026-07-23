#!/usr/bin/env node
// 大盘广度快照生成器（服务器端，无浏览器限流风险）
// 用法：node gen_breadth.js  → 生成 breadth.json（供浏览器零分页加载）
// 设计：拉全市场(沪深京)全部股票，按 f12(代码序) 无偏抽样，合并算中位/涨占比/成交额。
const https = require('https');
const fs = require('fs');
const path = require('path');

const FS = 'm:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23';
const FIELDS = 'f2,f3,f6,f12';
const HOST = 'push2delay.eastmoney.com';
const PER = 100;

function get(pn, fid) {
  return new Promise((resolve) => {
    const cb = 'mcb' + Math.random().toString(36).slice(2);
    const url = `https://${HOST}/api/qt/clist/get?pn=${pn}&pz=${PER}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(FS)}&fields=${FIELDS}&cb=${cb}`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try {
          let j = d; if (d.startsWith(cb + '(')) j = d.slice(cb.length + 1, -2);
          const o = JSON.parse(j);
          const diff = (o.data && o.data.diff) || [];
          const total = o.data && o.data.total;
          resolve({ diff, total });
        } catch (e) { resolve({ diff: [], total: 0 }); }
      });
    });
    req.on('error', () => resolve({ diff: [], total: 0 }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ diff: [], total: 0 }); });
  });
}

(async () => {
  const all = [];
  let total = 0;
  const first = await get(1, 'f12');
  if (first.total) total = first.total;
  if (first.diff.length) all.push(...first.diff);
  const pages = total > 0 ? Math.ceil(total / PER) : 56;
  for (let pn = 2; pn <= pages; pn++) {
    const r = await get(pn, 'f12');
    if (r.diff.length) all.push(...r.diff);
    await new Promise(r => setTimeout(r, 30));
  }
  if (all.length < 2000) {
    console.error('拉取不足 2000 只，疑似限流，放弃写入。已拉:', all.length);
    process.exit(1);
  }
  const pct = all.map(x => x.f3).filter(v => typeof v === 'number' && !isNaN(v)).map(v => v / 100).sort((a, b) => a - b);
  const n = pct.length;
  const median = n % 2 ? pct[(n - 1) / 2] : (pct[n / 2 - 1] + pct[n / 2]) / 2;
  const up = pct.filter(x => x > 0).length, dn = pct.filter(x => x < 0).length, flat = n - up - dn;
  const totAmt = all.reduce((s, x) => s + (Number(x.f6) || 0), 0);
  const out = {
    generatedAt: new Date().toISOString().replace('Z', '+08:00'),
    source: 'eastmoney push2delay (server snapshot, regenerated daily)',
    median, up, dn, flat, total: n,
    upPct: +(up / n * 100).toFixed(1),
    totAmt
  };
  fs.writeFileSync(path.join(__dirname, 'breadth.json'), JSON.stringify(out, null, 2));
  console.log('breadth.json written:', JSON.stringify(out));
})();
