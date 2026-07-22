/* =========================================================================
 * framework.js — 四层趋势框架 + 水下层(主力意图/人性博弈代理) 共享引擎
 * 被 index.html(AI复盘) 与 trend.html(L5水下层) 共用。
 * 取数端点全部沿用已验证源：腾讯gtimg K线 / pingzhongdata 净值 / 东财push2delay 实时价与资金流。
 * 纯浏览器、零手动、无后端、无API Key。
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ----------------------------- 数学工具 ----------------------------- */
  function avg(a){ if(!a||!a.length) return 0; return a.reduce((x,y)=>x+y,0)/a.length; }
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function MA(arr,n){
    const out=new Array(arr.length).fill(null); let sum=0;
    for(let i=0;i<arr.length;i++){ sum+=arr[i]; if(i>=n) sum-=arr[i-n]; if(i>=n-1) out[i]=sum/n; }
    return out;
  }
  function EMA(arr,n){
    const k=2/(n+1), out=new Array(arr.length); let prev=arr[0]; out[0]=arr[0];
    for(let i=1;i<arr.length;i++){ prev=arr[i]*k+prev*(1-k); out[i]=prev; }
    return out;
  }
  function MACD(closes){
    const e12=EMA(closes,12), e26=EMA(closes,26);
    const dif=closes.map((_,i)=>e12[i]-e26[i]);
    const dea=EMA(dif,9);
    const bar=dif.map((d,i)=>2*(d-dea[i]));
    return {dif,dea,bar};
  }
  function pivots(klines, win=5){
    const highs=[], lows=[];
    for(let i=win;i<klines.length-win;i++){
      let isH=true,isL=true;
      for(let j=i-win;j<=i+win;j++){ if(klines[j].high>klines[i].high) isH=false; if(klines[j].low<klines[i].low) isL=false; }
      if(isH) highs.push({i, price:klines[i].high});
      if(isL) lows.push({i, price:klines[i].low});
    }
    return {highs,lows};
  }
  function classifyStructure(piv){
    const hh=piv.highs, ll=piv.lows;
    const ups = hh.length>=2 ? hh[hh.length-1].price>hh[hh.length-2].price : null;
    const downs = ll.length>=2 ? ll[ll.length-1].price>ll[ll.length-2].price : null;
    let trend='mixed';
    if(ups===true && downs===true) trend='uptrend';
    else if(ups===false && downs===false) trend='downtrend';
    return {higherHighs:ups, higherLows:downs, trend};
  }
  function ymd(d){ const p=n=>(''+n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }

  /* ----------------------------- 资产识别 ----------------------------- */
  function normalizeInput(raw){
    let c=(raw||'').trim().toLowerCase().replace(/\s/g,'');
    if(c.startsWith('hk')) return {isHK:true, market:'hk', code:c.slice(2).padStart(5,'0')};
    if(/^\d{4,5}$/.test(c)) return {isHK:true, market:'hk', code:c.padStart(5,'0')};
    if(/^\d{6}$/.test(c)) return {isHK:false, market:(/^[5-9]/.test(c)?'sh':'sz'), code:c};
    return null;
  }

  /* ----------------------------- 取数 ----------------------------- */
  function jsonpGet(url, cbName){
    return new Promise((resolve,reject)=>{
      const sc=document.createElement('script');
      const t=setTimeout(()=>{cleanup();reject(new Error('timeout'));},15000);
      function cleanup(){ clearTimeout(t); try{delete window[cbName];}catch(e){} if(sc.parentNode) sc.parentNode.removeChild(sc); }
      window[cbName]=(d)=>{ cleanup(); resolve(d); };
      sc.onerror=()=>{ cleanup(); reject(new Error('script error')); };
      sc.src=url+(url.indexOf('cb=')>=0?'':'&cb='+cbName);
      document.head.appendChild(sc);
    });
  }
  async function fetchKline(code, market, limit=200){
    const param = market==='hk' ? `hk${code}` : `${market}${code}`;
    const path = market==='hk' ? 'hkfqkline' : 'fqkline';
    const url=`https://web.ifzq.gtimg.cn/appstock/app/${path}/get?param=${param},day,,,${limit},qfq`;
    const ctrl=new AbortController();
    const to=setTimeout(()=>ctrl.abort(),9000);
    const r=await fetch(url,{signal:ctrl.signal}); clearTimeout(to);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d=await r.json();
    const node=d&&d.data ? (d.data[param]||(Object.values(d.data)[0])) : null;
    const arr=node ? (node.qfqday||node.day||null) : null;
    if(arr && arr.length) return arr.map(p=>({date:p[0], open:+p[1], close:+p[2], high:+p[3], low:+p[4], vol:+p[5], amount:0, amp:0}));
    throw new Error('gtimg K线为空');
  }
  function loadPzd(code){
    return new Promise((resolve)=>{
      const t=setTimeout(()=>{ cleanup(); resolve(null); },13000);
      let sc=null;
      function cleanup(){ clearTimeout(t); if(sc&&sc.parentNode) sc.parentNode.removeChild(sc); }
      sc=document.createElement('script');
      sc.onload=()=>{ setTimeout(()=>{ try{
          const nw=window.Data_netWorthTrend, name=window.fS_name;
          const gt=window.Data_grandTotal, bs=window.Data_buySedemption;
          const pos=window.Data_fundSharesPositions;
          cleanup(); resolve({name:name||'', netWorthTrend:nw||[], grandTotal:gt||null, buySed:bs||null, positions:pos||null});
        }catch(e){ cleanup(); resolve(null); } }, 600); };
      sc.onerror=()=>{ cleanup(); resolve(null); };
      sc.src=`https://fund.eastmoney.com/pingzhongdata/${code}.js?_=${Date.now()}`;
      document.head.appendChild(sc);
    });
  }
  function navSeries(fund){
    const nw=fund&&fund.netWorthTrend;
    if(!nw||!nw.length) return null;
    const arr=nw.filter(p=>p&&p.y>0).map(p=>({
      date:new Date(p.x).toISOString().slice(0,10),
      open:p.y, close:p.y, high:p.y, low:p.y, vol:0, amount:0, amp:0, nav:p.y
    }));
    return arr.length?arr:null;
  }
  async function fetchPrice(secid){
    if(!secid) return null;
    try{
      const cb='pcb'+Math.random().toString(36).slice(2);
      const url=`https://push2delay.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f60,f169&cb=${cb}&_=${Date.now()}`;
      const d=await jsonpGet(url, cb);
      const x=d&&d.data; if(!x) return null;
      const code=secid.split('.')[1];
      const isFund=/^(15|16|18|51|56|58)/.test(code);
      const isHK=secid.startsWith('116.');
      const unit=(isFund||isHK)?1000:100;
      return {price:x.f43/unit, prevClose:x.f60/unit, pct:x.f169/100, name:x.f58};
    }catch(e){ return null; }
  }
  // 主力资金流：额外取 f62(主力净流入) / f184(主力净流入占比)
  async function fetchQuoteFlow(secid){
    if(!secid) return null;
    try{
      const cb='qf'+Math.random().toString(36).slice(2);
      const url=`https://push2delay.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f60,f169,f62,f184&cb=${cb}&_=${Date.now()}`;
      const d=await jsonpGet(url, cb);
      const x=d&&d.data; if(!x) return null;
      return x;
    }catch(e){ return null; }
  }
  async function fetchMarketBreadth(){
    const fs='m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23';
    const fields='f2,f3,f6,f12';
    const pz=6000; const host='push2delay.eastmoney.com';
    try{
      const cb='mcb'+Math.random().toString(36).slice(2);
      const url=`https://${host}/api/qt/clist/get?pn=1&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fs)}&fields=${fields}&cb=${cb}&_=${Date.now()}`;
      const d=await jsonpGet(url, cb);
      const arr=d&&d.data&&d.data.diff;
      if(!arr||!arr.length) return null;
      const pct=arr.map(x=>x.f3/100).sort((a,b)=>a-b);
      const n=pct.length;
      const median=n%2?(pct[(n-1)/2]+pct[(n+1)/2])/2:pct[n/2];
      const up=pct.filter(x=>x>0).length, dn=pct.filter(x=>x<0).length;
      const totAmt=arr.reduce((s,x)=>s+(x.f6||0),0);
      return {median, up, dn, total:n, upPct:up/n*100, totAmt, source:host};
    }catch(e){ return null; }
  }

  /* ----------------------------- L2/L3 指标 ----------------------------- */
  function valuationPct(klines, win=252){
    if(!klines||klines.length<2) return null;
    const arr=klines.slice(-win).map(k=>k.close);
    const cur=arr[arr.length-1];
    const sorted=arr.slice().sort((a,b)=>a-b);
    const rank=sorted.filter(x=>x<=cur).length;
    return {pct: rank/sorted.length*100, lo:sorted[0], hi:sorted[sorted.length-1], cur};
  }
  function priceStructure(klines){
    if(!klines||klines.length<20) return {trend:'mixed', maBull:false, hh:null, hl:null};
    const piv=pivots(klines,5);
    const st=classifyStructure(piv);
    const closes=klines.map(k=>k.close);
    const i=closes.length-1;
    const ma5=MA(closes,5), ma20=MA(closes,20), ma60=MA(closes,60), ma10=MA(closes,10);
    const maBull = ma5[i]>ma20[i] && ma20[i]>ma60[i] && ma10[i]>ma20[i];
    const maBear = ma5[i]<ma20[i] && ma20[i]<ma60[i];
    return {trend:st.trend, maBull, maBear, hh:st.higherHighs, hl:st.higherLows};
  }
  function sustainSignal(klines){
    const n=klines.length;
    if(n<20) return {days:0, hh:0, volUp:false, sustained:false};
    const closes=klines.map(k=>k.close), vols=klines.map(k=>k.vol);
    let lowIdx=n-1;
    for(let i=n-1;i>=0;i--){ if(closes[i] < closes[n-1]*0.92){ lowIdx=i+1; break; } }
    const days=n-1-lowIdx;
    const seg=klines.slice(lowIdx);
    const pv=pivots(seg,5);
    const hh=pv.highs.length;
    const half=Math.max(1,Math.floor(days/2));
    const recentVol=avg(vols.slice(n-half)), prevVol=avg(vols.slice(lowIdx, n-half));
    const volUp= prevVol>0 && recentVol>prevVol*1.05;
    const sustained = days>=10 && hh>=2 && volUp;
    return {days, hh, volUp, sustained};
  }

  /* ----------------------------- L4 一级市场 ----------------------------- */
  function parseGrandTotal(gt){
    if(!gt || !gt.length || !gt[0].data || gt[0].data.length<2) return null;
    const pts=gt[0].data.map(([ts,v])=>({t:ts, c:v})).sort((a,b)=>a.t-b.t);
    const daily=pts.map((p,i)=>({d:tsToDate(p.t), s: i? +(p.c-pts[i-1].c).toFixed(2):0}));
    const last=pts[pts.length-1].c, ref=pts[Math.max(0,pts.length-6)].c;
    const net5=+(last-ref).toFixed(2);
    return {daily, net5};
  }
  function totalShares(bs){
    if(!bs || !bs.length) return null;
    const row=bs.find(x=>x.name==='总份额');
    if(!row || !row.data || !row.data.length) return null;
    return +row.data[row.data.length-1];
  }
  function tsToDate(ts){
    // 东财份额序列时间戳有的是秒、有的是毫秒，做兼容
    let t = ts>1e12? ts : ts*1000;
    try{ return new Date(t).toISOString().slice(0,10); }catch(e){ return ''+ts; }
  }

  /* ============================ 水下层(核心新增) ============================
   * 说明：主力意图 / 人性博弈无法直接观测。以下均为"群体行为的可量化代理"，
   * 用来揭示表面数据之下的深层博弈，而非"读心"。每个指标都标注代理性质。 */

  // 1) 筹码分布 / 成本集中度：从量价推断持仓成本结构与获利盘压力
  function chipDistribution(klines, win=120){
    if(!klines||klines.length<10) return {na:true};
    const arr=klines.slice(-win);
    const cur=arr[arr.length-1].close;
    let totVol=0, wSum=0, profVol=0; const priced=[];
    for(const k of arr){
      const v=(k.vol||1);
      totVol+=v; wSum+=k.close*v;
      if(k.close<cur) profVol+=v;
      priced.push({p:k.close, w:v});
    }
    const avgCost=wSum/totVol;
    const profitRatio=profVol/totVol*100;
    priced.sort((a,b)=>a.p-b.p);
    let cum=0; const P=q=>{ const target=totVol*q; for(const it of priced){ cum+=it.w; if(cum>=target) return it.p; } return priced[priced.length-1].p; };
    const p10=P(0.1), p90=P(0.9);
    const concentration=(p90-p10)/avgCost; // 相对集中度，越小越集中
    return {na:false, avgCost:+avgCost.toFixed(3), profitRatio:+profitRatio.toFixed(1), concentration:+concentration.toFixed(3), cur};
  }

  // 2) 量价背离 / 异动：捕捉派发(顶背离)、承接(底背离)、异常放量、长上下影博弈
  function divergenceSignals(klines){
    const n=klines.length;
    const res={topDiv:false, bottomDiv:false, abnormalVol:false, longUpper:false, longLower:false};
    if(n<30) return res;
    const closes=klines.map(k=>k.close), vols=klines.map(k=>k.vol);
    const ma20v=MA(vols,20); const i=n-1;
    if(ma20v[i] && vols[i] > ma20v[i]*3) res.abnormalVol=true;
    const k=klines[i];
    const body=Math.abs(k.close-k.open); const rng=(k.high-k.low)||1e-9;
    if((k.high-Math.max(k.open,k.close))/rng > 0.6 && body/rng < 0.35) res.longUpper=true;
    if((Math.min(k.open,k.close)-k.low)/rng > 0.6 && body/rng < 0.35) res.longLower=true;
    const mac=MACD(closes); const piv=pivots(klines,5);
    if(piv.highs.length>=2){
      const a=piv.highs[piv.highs.length-2], b=piv.highs[piv.highs.length-1];
      if(b.price>a.price && mac.dif[b.i] < mac.dif[a.i]) res.topDiv=true;
    }
    if(piv.lows.length>=2){
      const a=piv.lows[piv.lows.length-2], b=piv.lows[piv.lows.length-1];
      if(b.price<a.price && mac.dif[b.i] > mac.dif[a.i]) res.bottomDiv=true;
    }
    return res;
  }

  // 3) 主力资金流：从实时报价 f62 取主力净流入（A股/ETF 可用，港股/基金可能无此字段）
  function mainForceFlow(x){
    if(!x || x.f62==null) return {na:true};
    return {na:false, netY:+(x.f62/1e8).toFixed(2), pct: x.f184!=null ? +(x.f184/100).toFixed(2) : null};
  }

  // 4) 市场情绪指数：恐惧贪婪代理（涨占比 + 中位数 + 成交）
  function sentimentScore(breadth){
    if(!breadth) return null;
    const breadthC = clamp(breadth.upPct, 0, 100);
    const medianC = clamp((breadth.median+3)/6*100, 0, 100);
    const amtC = clamp(breadth.totAmt/1e8/12000*100, 0, 100);
    const score = +(0.5*breadthC + 0.3*medianC + 0.2*amtC).toFixed(0);
    let label='中性';
    if(score<20) label='极度恐惧'; else if(score<40) label='恐惧'; else if(score<60) label='中性'; else if(score<80) label='贪婪'; else label='极度贪婪';
    return {score, label, median:breadth.median, upPct:breadth.upPct, totAmt:breadth.totAmt};
  }

  /* ----------------------------- 单标的综合分析 ----------------------------- */
  async function analyzeOne(item){
    const res={code:item.code, name:item.name||'', asset:'', srcInfo:'', ok:false, err:''};
    const ni=normalizeInput(item.code);
    if(!ni){ res.err='无法识别代码'; return res; }
    let fund=null;
    try{ fund=await loadPzd(item.code); }catch(e){}
    const isFund=!!fund;
    const isETF = isFund && /^(15|16|18|50|51|55|56|58|59)/.test(item.code);
    const isOCF = isFund && !isETF;
    const isStock = !isFund;
    res.asset = isOCF?'场外基金':(isETF?'场内ETF':(ni.isHK?'港股个股':'A股个股'));
    const priceSecid = isOCF?null:(ni.isHK?'116.'+ni.code:(ni.market+'.'+ni.code));
    let price=null, flow=null;
    if(priceSecid){
      try{ price=await fetchPrice(priceSecid); }catch(e){}
      try{ const q=await fetchQuoteFlow(priceSecid); if(q) flow=mainForceFlow(q); }catch(e){}
      if(price) res.name = price.name||res.name;
    }
    let klines=null, srcInfo='';
    if(isOCF && fund){ klines=navSeries(fund); srcInfo='净值历史(pingzhongdata)'; }
    else{
      try{ klines=await fetchKline(ni.code, ni.market, 200); srcInfo='腾讯gtimg K线'; }
      catch(e){ if(isETF&&fund){ klines=navSeries(fund); srcInfo='净值历史兜底(pingzhongdata)'; } }
    }
    res.srcInfo=srcInfo;
    if(isOCF && fund && fund.netWorthTrend && fund.netWorthTrend.length){
      const last=fund.netWorthTrend[fund.netWorthTrend.length-1];
      price={price:+last.y, prevClose:null, pct:0, name:fund.name||res.name}; res.name=fund.name||res.name;
    }
    res.price=price; res.flow=flow; res.fund=fund;
    if(!klines){ res.err='K线/净值序列获取失败'; return res; }
    // —— 四层 + 水下 ——
    const v=valuationPct(klines,252);
    const ps=priceStructure(klines);
    const sus=sustainSignal(klines);
    let net5=null,total=null,premium=null;
    if(fund){
      if(fund.grandTotal){ const g=parseGrandTotal(fund.grandTotal); if(g) net5=g.net5; }
      if(fund.buySed) total=totalShares(fund.buySed);
      const navY = (fund.netWorthTrend&&fund.netWorthTrend.length)? +fund.netWorthTrend[fund.netWorthTrend.length-1].y : null;
      if(isETF && navY && price) premium=+((price.price/navY-1)*100).toFixed(2);
    }
    const chip=chipDistribution(klines,120);
    const div=divergenceSignals(klines);
    res.layers={
      L2:v, L3:ps, L2b:sus,
      L4:{isETF,isOCF,net5,total,premium},
      UW:{chip, div, flow, sentiment:null}
    };
    res.ok=true;
    return res;
  }

  /* ----------------------------- 明确建议(决策) -----------------------------
   * 综合四层 + 水下，给出明确三态之一：建议买入 / 观望 / 不建议。
   * 不模糊、不把判断推回用户；但每条建议附"核心理由"（证据），并保留合规免责。 */
  function verdictOf(res){
    const L=res.layers; const reasons=[];
    if(!L) return {call:'不建议', score:0, reasons:['数据缺失，无法研判']};
    let score=0, T=0, F=0;
    if(L.L2){
      if(L.L2.pct<40){ score+=1; reasons.push('估值处近一年低位('+L.L2.pct.toFixed(0)+'分位)，赔率好'); }
      else if(L.L2.pct<=75){ reasons.push('估值中等('+L.L2.pct.toFixed(0)+'分位)'); }
      else { score-=1; reasons.push('估值偏贵('+L.L2.pct.toFixed(0)+'分位)，上方空间受限'); }
    }
    if(L.L3){
      if(L.L3.trend==='uptrend'){ T=1; reasons.push('价格高低点抬高、均线多头，趋势向上'); }
      else if(L.L3.trend==='downtrend'){ T=-1; reasons.push('价格创新低、均线空头，趋势向下'); }
      else if(L.L3.maBull){ T=0.5; reasons.push('震荡但均线仍多头'); }
      else if(L.L3.maBear){ T=-0.5; reasons.push('价格均线空头排列，结构偏弱'); }
      else reasons.push('价格结构震荡（均线无明确方向）');
    }
    if(L.L2b){ if(L.L2b.sustained){ score+=0.5; reasons.push('上涨结构持续'+L.L2b.days+'日且放量，偏基本面驱动'); } else reasons.push('上涨持续性不足(偏短线脉冲)'); }
    if(L.L4.isETF||L.L4.isOCF){
      if(L.L4.premium!=null) reasons.push('折溢价'+L.L4.premium.toFixed(2)+'%'+(Math.abs(L.L4.premium)<=3?'(无套利干扰)':'⚠偏离大'));
      if(L.L4.net5!=null){
        if(L.L4.net5>=-5){ score+=0.5; reasons.push('近5日净申赎'+L.L4.net5.toFixed(2)+'亿份，一级市场无撤离'); }
        else { score-=0.5; reasons.push('近5日净赎回'+L.L4.net5.toFixed(2)+'亿份，一级市场在撤'); }
      }
    }
    const uw=L.UW;
    if(uw.chip && !uw.chip.na){
      if(uw.chip.profitRatio>=60){ score+=0.3; reasons.push('获利盘'+uw.chip.profitRatio.toFixed(0)+'%，筹码未松动'); }
      else if(uw.chip.profitRatio<=35){ score-=0.2; reasons.push('获利盘仅'+uw.chip.profitRatio.toFixed(0)+'%，套牢盘重、抛压待释放'); }
    }
    if(uw.flow && !uw.flow.na){
      if(uw.flow.netY>0){ score+=0.5; F=0.5; reasons.push('主力净流入'+uw.flow.netY.toFixed(2)+'亿'); }
      else if(uw.flow.netY<0){ score-=0.5; F=-0.5; reasons.push('主力净流出'+uw.flow.netY.toFixed(2)+'亿，资金在撤'); }
    }
    if(uw.div){
      if(uw.div.topDiv){ score-=0.5; reasons.push('量价顶背离，警惕主力派发'); }
      if(uw.div.bottomDiv){ score+=0.5; reasons.push('量价底背离，低位有承接'); }
    }
    // 硬约束：趋势向下 + 主力流出 → 明确不建议（即便估值低，也不接下落刀）
    let call = (T<=-0.5 && F<=-0.5) ? '不建议' : (score>=2 ? '建议买入' : '观望');
    return {call, score:+score.toFixed(2), reasons};
  }

  /* ----------------------------- CSS(一次性注入) ----------------------------- */
  const CSS = `
  .fw-recap{ margin:10px 0; }
  .fw-summary{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--panel2); margin-bottom:12px; }
  .fw-summary .pill{ padding:3px 10px; border-radius:999px; font-size:13px; font-weight:700; }
  .fw-pill-buy{ background:rgba(239,68,68,.15); color:#ef4444; }
  .fw-pill-hold{ background:rgba(245,166,35,.15); color:#f5a623; }
  .fw-pill-sell{ background:rgba(34,197,94,.15); color:#22c55e; }
  .fw-pill-sent{ background:rgba(78,161,255,.15); color:#4ea1ff; }
  .fw-cards{ display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
  .fw-card{ border:1px solid var(--border); border-radius:10px; padding:12px 14px; background:var(--panel); }
  .fw-card .hd{ display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .fw-card .nm{ font-weight:700; font-size:15px; color:var(--txt); }
  .fw-card .cd{ font-size:12px; color:var(--txt2); }
  .fw-card .at{ font-size:11px; color:var(--txt2); border:1px solid var(--border); border-radius:6px; padding:1px 6px; }
  .fw-card .px{ font-size:13px; margin:4px 0 8px; color:var(--txt2); }
  .fw-card .verdict{ font-size:18px; font-weight:800; padding:6px 0; }
  .fw-badges{ display:flex; flex-wrap:wrap; gap:5px; margin:6px 0; }
  .fw-badge{ font-size:11px; padding:2px 7px; border-radius:6px; background:var(--panel2); color:var(--txt2); border:1px solid var(--border); }
  .fw-badge.good{ color:#22c55e; border-color:rgba(34,197,94,.4); }
  .fw-badge.bad{ color:#ef4444; border-color:rgba(239,68,68,.4); }
  .fw-badge.warn{ color:#f5a623; border-color:rgba(245,166,35,.4); }
  .fw-reason{ font-size:12px; line-height:1.55; color:var(--txt2); margin-top:6px; }
  .fw-reason b{ color:var(--txt); font-weight:600; }
  .fw-src{ font-size:11px; color:var(--txt2); opacity:.7; margin-top:8px; }
  .fw-loading,.fw-empty{ padding:18px; color:var(--txt2); }
  /* trend.html L5 水下层 */
  .uw-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-top:8px; }
  .uw-cell{ border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--panel2); }
  .uw-cell .t{ font-size:11px; color:var(--txt2); margin-bottom:3px; }
  .uw-cell .v{ font-size:13px; font-weight:700; }
  .uw-note{ font-size:11px; color:var(--txt2); opacity:.75; margin-top:6px; line-height:1.5; }
  `;
  function injectCSS(){
    if(document.getElementById('fw-style')) return;
    const s=document.createElement('style'); s.id='fw-style'; s.textContent=CSS; document.head.appendChild(s);
  }

  /* ----------------------------- AI复盘渲染 ----------------------------- */
  function badge(text, cls){ return `<span class="fw-badge ${cls||''}">${text}</span>`; }
  function verdictClass(call){ return call==='建议买入'?'fw-pill-buy':(call==='不建议'?'fw-pill-sell':'fw-pill-hold'); }

  async function renderRecap(sectionEl){
    injectCSS();
    if(!sectionEl) return;
    const wl = (global.STATE && global.STATE.watchlist) || [];
    sectionEl.innerHTML = '<div class="fw-loading">正在生成复盘（自动拉取各标的数据，无需操作）…</div>';
    if(!wl.length){ sectionEl.innerHTML='<div class="fw-empty">自选股为空 —— 先去添加标的，复盘将自动生成。数据来源：腾讯gtimg / 东方财富。</div>'; return; }
    let breadth=null; try{ breadth=await fetchMarketBreadth(); }catch(e){}
    const sent=sentimentScore(breadth);
    const results=[];
    const limit=4;
    for(let i=0;i<wl.length;i+=limit){
      const batch=wl.slice(i,i+limit);
      const rs=await Promise.all(batch.map(it=>analyzeOne(it).catch(e=>({code:it.code, name:it.name||'', asset:'', ok:false, err:''+e}))));
      results.push(...rs);
    }
    // 汇总
    let buy=0,hold=0,sell=0;
    const cards=results.map(r=>{
      if(!r.ok){ return `<div class="fw-card"><div class="hd"><span class="nm">${r.name||r.code||'?'}</span><span class="cd">${r.code||''}</span></div><div class="verdict" style="color:var(--txt2)">数据暂缺</div><div class="fw-reason">${r.err||'该标的行情源暂未取到，稍后点「重新生成」重试。'}</div></div>`; }
      const vd=verdictOf(r);
      if(vd.call==='建议买入') buy++; else if(vd.call==='不建议') sell++; else hold++;
      const L=r.layers;
      const pb=[];
      if(L.L2) pb.push(badge('估值'+L.L2.pct.toFixed(0)+'分位', L.L2.pct<40?'good':(L.L2.pct>75?'bad':'')));
      if(L.L3) pb.push(badge('趋势'+({uptrend:'向上',downtrend:'向下',mixed:'震荡'})[L.L3.trend]+(L.L3.maBull?'·均多':''), L.L3.trend==='uptrend'?'good':(L.L3.trend==='downtrend'?'bad':'')));
      if(L.L2b) pb.push(badge('结构持续'+(L.L2b.sustained?'✓':(L.L2b.days+'日')), L.L2b.sustained?'good':''));
      if(L.L4.isETF||L.L4.isOCF){
        if(L.L4.net5!=null) pb.push(badge('净申赎'+L.L4.net5.toFixed(1)+'亿', L.L4.net5>=-5?'good':'bad'));
        if(L.L4.premium!=null) pb.push(badge('折溢价'+L.L4.premium.toFixed(1)+'%', Math.abs(L.L4.premium)<=3?'':(L.L4.premium>0?'warn':'warn')));
      }
      const uw=L.UW;
      if(uw.chip&&!uw.chip.na) pb.push(badge('获利盘'+uw.chip.profitRatio.toFixed(0)+'%', uw.chip.profitRatio>=60?'good':(uw.chip.profitRatio<=35?'bad':'')));
      if(uw.flow&&!uw.flow.na) pb.push(badge('主力'+(uw.flow.netY>=0?'+':'')+uw.flow.netY.toFixed(1)+'亿', uw.flow.netY>0?'good':'bad'));
      if(uw.div){ if(uw.div.topDiv) pb.push(badge('顶背离⚠','bad')); if(uw.div.bottomDiv) pb.push(badge('底背离','good')); if(uw.div.abnormalVol) pb.push(badge('异常放量','warn')); }
      const reason = vd.reasons.length ? '<b>理由：</b>'+vd.reasons.join('；') : '';
      const priceTxt = r.price ? (r.price.price!=null? (r.asset==='场外基金'?'单位净值 '+r.price.price.toFixed(4):'现价 '+r.price.price.toFixed(r.price.price<10?3:2)+(r.price.pct?'（'+(r.price.pct>=0?'+':'')+r.price.pct.toFixed(2)+'%）':'')) : '') : '';
      return `<div class="fw-card">
        <div class="hd"><span class="nm">${r.name||r.code}</span><span class="at">${r.asset}</span></div>
        <div class="hd"><span class="cd">${r.code}</span></div>
        <div class="px">${priceTxt}</div>
        <div class="verdict ${verdictClass(vd.call)}">${vd.call}</div>
        <div class="fw-badges">${pb.join('')}</div>
        <div class="fw-reason">${reason}</div>
        <div class="fw-src">序列源：${r.srcInfo||'—'}</div>
      </div>`;
    }).join('');
    const summary = `<div class="fw-summary">
      <span class="pill fw-pill-buy">建议买入 ${buy}</span>
      <span class="pill fw-pill-hold">观望 ${hold}</span>
      <span class="pill fw-pill-sell">不建议 ${sell}</span>
      <span style="color:var(--txt2);font-size:12px">共 ${results.length} 只 · 复盘日 ${(wl.__date||'')||ymd(new Date())}</span>
      ${sent?`<span class="pill fw-pill-sent">市场情绪：${sent.label}(${sent.score})</span>`:''}
    </div>`;
    sectionEl.innerHTML = `<div class="fw-recap">${summary}<div class="fw-cards">${cards}</div>
      <div class="fw-src" style="margin-top:12px">说明：建议为框架综合研判结论（四层+水下层），非个性化投资建议；市场情绪为恐惧贪婪代理。报告仅供参考，不构成个人投资建议。</div></div>`;
  }

  /* ----------------------------- trend.html L5 水下层渲染 ----------------------------- */
  function renderL5(container, klines, quoteFlow){
    injectCSS();
    if(!container) return;
    if(!klines){ container.innerHTML='<p class="src">水下层需K线/净值序列，暂未取到。</p>'; return; }
    const chip=chipDistribution(klines,120);
    const div=divergenceSignals(klines);
    const flow=quoteFlow? mainForceFlow(quoteFlow) : {na:true};
    const cells=[];
    if(!chip.na){
      const cCls = chip.profitRatio>=60?'good':(chip.profitRatio<=35?'bad':'');
      cells.push(`<div class="uw-cell"><div class="t">筹码·获利盘比例</div><div class="v" style="color:var(${cCls==='good'?'--up':cCls==='bad'?'--down':'--txt'})">${chip.profitRatio.toFixed(0)}%</div></div>`);
      cells.push(`<div class="uw-cell"><div class="t">筹码·平均成本</div><div class="v">${chip.avgCost.toFixed(chip.avgCost<10?3:2)}</div></div>`);
      cells.push(`<div class="uw-cell"><div class="t">筹码·相对集中度</div><div class="v">${chip.concentration.toFixed(3)} ${chip.concentration<0.15?'（高度集中）':chip.concentration<0.3?'（集中）':'（分散）'}</div></div>`);
    } else { cells.push(`<div class="uw-cell"><div class="t">筹码分布</div><div class="v">数据不足</div></div>`); }
    if(!flow.na){
      const fCls = flow.netY>0?'good':'bad';
      cells.push(`<div class="uw-cell"><div class="t">主力净流入</div><div class="v" style="color:var(${fCls==='good'?'--up':'--down'})">${flow.netY>=0?'+':''}${flow.netY.toFixed(2)}亿</div></div>`);
      if(flow.pct!=null) cells.push(`<div class="uw-cell"><div class="t">主力净流入占比</div><div class="v">${flow.pct.toFixed(1)}%</div></div>`);
    } else { cells.push(`<div class="uw-cell"><div class="t">主力资金流</div><div class="v">不适用</div></div>`); }
    const dtags=[];
    if(div.topDiv) dtags.push('<span class="fw-badge bad">量价顶背离·警惕派发</span>');
    if(div.bottomDiv) dtags.push('<span class="fw-badge good">量价底背离·有承接</span>');
    if(div.abnormalVol) dtags.push('<span class="fw-badge warn">异常放量</span>');
    if(div.longUpper) dtags.push('<span class="fw-badge warn">长上影·上方抛压</span>');
    if(div.longLower) dtags.push('<span class="fw-badge good">长下影·低位承接</span>');
    if(!dtags.length) dtags.push('<span class="fw-badge">量价无明显异动</span>');
    container.innerHTML = `<div class="uw-grid">${cells.join('')}</div>
      <div class="fw-badges" style="margin-top:8px">${dtags.join('')}</div>
      <div class="uw-note">水下层为「主力意图/人性博弈」的可量化代理（筹码成本结构、主力资金流、量价背离），揭示表面数据之下的深层博弈，非对主力心思的直接读取。个股主力流可能无字段→标记不适用。</div>`;
  }

  // 导出
  global.FW = {
    normalizeInput, fetchKline, loadPzd, navSeries, fetchPrice, fetchQuoteFlow, fetchMarketBreadth,
    valuationPct, priceStructure, sustainSignal, parseGrandTotal, totalShares,
    chipDistribution, divergenceSignals, mainForceFlow, sentimentScore,
    analyzeOne, verdictOf, renderRecap, renderL5, injectCSS
  };
})(window);
