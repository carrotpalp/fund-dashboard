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
  /* loadPzd 并发安全：pingzhongdata 脚本把数据挂到 window.Data_* 全局变量，
   * 若多只基金并发加载，后加载的脚本会覆盖全局变量，导致先完成的基金读到错/空数据
   * （复盘按 4 只一批 Promise.all 并发时尤甚，最后那只 QDII 常被覆盖成"数据暂缺"）。
   * 解法：全局串行队列，任意时刻仅一个脚本在飞，onload 时全局变量稳定。 */
  let _pzdChain = Promise.resolve();
  function loadPzd(code){
    const run = ()=> new Promise((resolve)=>{
      let done=false;
      const t=setTimeout(()=>{ if(done) return; done=true; cleanup(); resolve(null); },12000);
      let sc=null;
      function cleanup(){ clearTimeout(t); if(sc&&sc.parentNode) sc.parentNode.removeChild(sc); }
      sc=document.createElement('script');
      sc.onload=()=>{ setTimeout(()=>{ if(done) return; done=true; try{
          const nw=window.Data_netWorthTrend, name=window.fS_name;
          const gt=window.Data_grandTotal, bs=window.Data_buySedemption;
          const pos=window.Data_fundSharesPositions;
          cleanup(); resolve({name:name||'', netWorthTrend:nw||[], grandTotal:gt||null, buySed:bs||null, positions:pos||null});
        }catch(e){ cleanup(); resolve(null); } }, 200); };
      sc.onerror=()=>{ if(done) return; done=true; cleanup(); resolve(null); };
      sc.src=`https://fund.eastmoney.com/pingzhongdata/${code}.js?_=${Date.now()}`;
      document.head.appendChild(sc);
    });
    const next = _pzdChain.then(run, run);
    _pzdChain = next.then(()=>{}, ()=>{});   // 防止链式 reject 阻断后续
    return next;
  }
  // 研报(分析师评级/研报)按个股拉取：东方财富 reportapi list 接口用 code=个股代码 + qType=0 可按个股过滤
  // （实测 code=600519 返回 35 篇，首篇即茅台研报），支持 JSONP(cb=) 与 CORS。详见下方 fetchResearch。
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
  // 东财 push2delay 要求数字市场前缀(0./1./116.)，alpha 前缀(sz./sh.)一律 rc:102 拒绝
  function emSecid(ni){
    if(ni.isHK) return '116.'+ni.code;
    return (ni.market==='sh'?'1':'0')+'.'+ni.code;
  }
  // ETF 折溢价：必须用盘中 IOPV(实时预估净值)计算，不能用 T-1 官方净值(会虚高数个百分点、误报"套利陷阱")
  // 数据源：腾讯 gtimg 实时报价(脚本注入,无 CORS 限制)。下标 [3]=现价 [77]=折溢价率% [78]=IOPV [81]=最新净值
  function fetchEtfPremium(code){
    return new Promise((resolve)=>{
      try{
        const gtid=(/^[5-9]/.test(code)?'sh':'sz')+code;
        const sc=document.createElement('script');
        const t=setTimeout(()=>{ cleanup(); resolve(null); }, 9000);
        function cleanup(){ clearTimeout(t); if(sc.parentNode) sc.parentNode.removeChild(sc); }
        sc.onerror=()=>{ cleanup(); resolve(null); };
        sc.onload=()=>{ try{
          const raw=window['v_'+gtid]; cleanup();
          if(!raw) return resolve(null);
          const a=raw.split('~');
          const price=+(a[3]||''), iopv=+(a[78]||''), premField=+(a[77]||'');
          let premiumPct=null;
          if(price>0 && iopv>0) premiumPct=+((price/iopv-1)*100).toFixed(2);
          else if(!isNaN(premField)) premiumPct=+premField.toFixed(2);
          if(premiumPct==null || isNaN(premiumPct)) return resolve(null);
          resolve({premiumPct, iopv, price, source:'腾讯gtimg·IOPV口径'});
        }catch(e){ cleanup(); resolve(null); } };
        sc.src=`https://qt.gtimg.cn/q=${gtid}`;
        document.head.appendChild(sc);
      }catch(e){ resolve(null); }
    });
  }
  // 交易时段判定（与看板首页同源逻辑）：周一~周五 09:30-11:30 / 13:00-15:00
  function isAshareTradingTime(){
    const now=new Date(); const day=now.getDay();
    if(day===0||day===6) return false;
    const hm=now.getHours()*100+now.getMinutes();
    return (hm>=930&&hm<=1130)||(hm>=1300&&hm<=1500);
  }
  // 大盘广度：收盘后也优先取实时——push2delay 收盘后返回的就是「今日收盘价」，
  // 因此交易时段/已收盘/周末节假日 都先尝试实时(拿到当日已定格数据)；仅当实时拉取失败/样本过少时才降级到 T-1 快照。
  async function fetchMarketBreadth(){
    try{
      const live = await fetchMarketBreadthLive();
      if(live && live.total>=2000) return Object.assign({}, live, {source:'实时·东财push2delay', live:true, fresh:true});
    }catch(e){}
    // 实时失败(限流/网络/接口异常) → 降级回 T-1 快照，不卡白
    try{
      const r = await fetch('breadth.json?_='+Date.now(), {cache:'no-store'});
      if(r.ok){
        const j = await r.json();
        if(j && typeof j.median==='number' && j.total>=2000){
          const freshH = (Date.now() - new Date(j.generatedAt).getTime()) < 3*86400000;
          return Object.assign({}, j, {source:'snapshot·'+(j.source||'eastmoney'), fresh:freshH, snapshotAt:j.generatedAt});
        }
      }
    }catch(e){}
    return null;
  }
  async function fetchMarketBreadthLive(){
    const fs='m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23';
    const fields='f2,f3,f6,f12';
    const host='push2delay.eastmoney.com';
    // 东财 clist 单页最多返回 100 条(pz 被忽略)；fid=f12(代码序)保证跨页为无偏抽样，杜绝「首页=涨幅榜前100」的偏差。
    const PER=100, BATCH=4;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const all=[]; let total=0;
    try{
      const cb='mcb'+Math.random().toString(36).slice(2);
      const d1=await jsonpGet(`https://${host}/api/qt/clist/get?pn=1&pz=${PER}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=${fields}&cb=${cb}`,cb);
      const diff1=(d1&&d1.data&&d1.data.diff)||[];
      if(d1&&d1.data&&typeof d1.data.total==='number') total=d1.data.total;
      if(diff1.length) all.push(...diff1);
    }catch(e){}
    const pages=total>0?Math.ceil(total/PER):56; // 动态页数(首屏读 data.total)，不再硬编码56
    for(let i=1;i<pages;i+=BATCH){
      const lo=i+1, hi=Math.min(i+BATCH,pages); const batch=[];
      for(let pn=lo;pn<=hi;pn++){
        const cb='mcb'+Math.random().toString(36).slice(2);
        const url=`https://${host}/api/qt/clist/get?pn=${pn}&pz=${PER}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=${fields}&cb=${cb}&_=${Date.now()}`;
        batch.push(jsonpGet(url,cb).then(d=>(d&&d.data&&d.data.diff)||[]).catch(()=>[]));
        await sleep(40);
      }
      const res=await Promise.allSettled(batch);
      res.forEach(r=>{ const arr=(r.status==='fulfilled'&&r.value)||[]; if(arr&&arr.length) all.push(...arr); });
      await sleep(60);
    }
    if(all.length<2000) return null; // 被限流/拉取过少 → 诚实失败，绝不展示有偏样本(防再出现 +0.10%/424亿)
    const pct=all.map(x=>x.f3).filter(v=>typeof v==='number'&&!isNaN(v)).map(v=>v/100).sort((a,b)=>a-b);
    const n=pct.length;
    if(!n) return null;
    const median=n%2?(pct[(n-1)/2]+pct[(n+1)/2])/2:pct[n/2];
    const up=pct.filter(x=>x>0).length, dn=pct.filter(x=>x<0).length, flat=n-up-dn;
    const totAmt=all.reduce((s,x)=>s+(Number(x.f6)||0),0);
    return {median, up, dn, flat, total:n, upPct:up/n*100, totAmt, source:host};
  }

  // 研报(分析师评级/研报)按个股拉取：东方财富 reportapi list 接口，code=个股6位代码 + qType=0 可按个股过滤
  // （实测 code=600519 返回 35 篇，首篇即茅台研报）。支持 JSONP(cb=) 与 CORS。
  async function fetchResearch(code, days=120){
    try{
      const end=new Date();
      const beg=new Date(end.getTime()-days*86400000);
      const fmt=d=>`${d.getFullYear()}${(''+(d.getMonth()+1)).padStart(2,'0')}${(''+d.getDate()).padStart(2,'0')}`;
      const url=`https://reportapi.eastmoney.com/report/list?pageSize=20&pageNo=1&beginTime=${fmt(beg)}&endTime=${fmt(end)}&code=${code}&qType=0`;
      const cb='rcb'+Math.random().toString(36).slice(2);
      const d=await jsonpGet(url, cb);
      const data=(d&&d.data)||[]; if(!data.length) return {count:0, ratings:[]};
      const ratings=data.map(x=>({
        title:x.title||'', org:x.orgSName||x.orgName||'', rating:x.emRatingName||x.rating_name||'',
        date:(x.publishDate||'').slice(0,10), change:x.ratingChange
      }));
      const cnt=ratings.length;
      const bull=ratings.filter(r=>/买入|增持|强推|推荐|Outperform|Overweight|买入-A|增持-A/i.test(r.rating)).length;
      const bear=ratings.filter(r=>/卖出|减持|回避|Underweight|卖出-A|减持-A/i.test(r.rating)).length;
      const bullPct=cnt? +((bull/cnt)*100).toFixed(0) : 0;
      return {count:cnt, bull, bear, bullPct, ratings, last:ratings[0]||null};
    }catch(e){ return {count:0, ratings:[], error:''+e}; }
  }

  // 主力资金流 / 机构参与度：东方财富 RPT_DMSK_TS_STOCKNEW（datacenter-web，CORS*，按 SECURITY_CODE 过滤）
  // 返回 PRIME_INFLOW(主力净流入·元)、ORG_PARTICIPATE(机构参与度)、PRIME_COST(主力成本)、RANK、FOCUS
  async function fetchMainForce(code){
    try{
      const url=`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DMSK_TS_STOCKNEW&columns=ALL&filter=(SECURITY_CODE="${code}")&pageSize=1&source=WEB&client=WEB`;
      const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),9000);
      const r=await fetch(url,{signal:ctrl.signal}); clearTimeout(to);
      if(!r.ok) return {na:true};
      const d=await r.json();
      const row=d&&d.result&&d.result.data&&d.result.data[0];
      if(!row) return {na:true};
      return {
        na:false,
        netY: +(((row.PRIME_INFLOW||0)/1e8)).toFixed(2),
        orgParticipate: row.ORG_PARTICIPATE!=null ? +row.ORG_PARTICIPATE.toFixed(3) : null,
        primeCost: row.PRIME_COST!=null ? +row.PRIME_COST.toFixed(2) : null,
        rank: row.RANK!=null ? +row.RANK : null,
        focus: row.FOCUS!=null ? +row.FOCUS.toFixed(1) : null,
        tradeDate: (row.TRADE_DATE||'').slice(0,10),
        source:'东财主力参与度'
      };
    }catch(e){ return {na:true}; }
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
    // 有成交量(个股/ETF)：用局部峰数创新高；无量(基金净值单值曲线)：用"创区间新高次数"更稳健(平滑上行也能数出)
    const hh = vols.some(v=>v>0) ? pv.highs.length : (()=>{ let rm=seg[0].close, c=0; for(const k of seg){ if(k.close>rm){ rm=k.close; c++; } } return c; })();
    const half=Math.max(1,Math.floor(days/2));
    const recentVol=avg(vols.slice(n-half)), prevVol=avg(vols.slice(lowIdx, n-half));
    const hasVol = vols.some(v=>v>0);            // 基金净值序列 vol 恒为 0 → 无成交量概念，不要求放量
    const volUp = !hasVol ? true : (prevVol>0 && recentVol>prevVol*1.05);
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
    const priceSecid = isOCF?null:emSecid(ni);
    let price=null, flow=null;
    if(priceSecid){
      try{ price=await fetchPrice(priceSecid); }catch(e){}
      try{ const q=await fetchQuoteFlow(priceSecid); if(q) flow=mainForceFlow(q); }catch(e){}
      if(price) res.name = price.name||res.name;
    }
    // 研报：个股/ETF/基金均按 code 尝试拉取(reportapi 按 code 过滤，部分指数/ETF也可能有覆盖；无则如实显示)
    // 主力参与度：仅个股有真实字段(东财 RPT_DMSK_TS_STOCKNEW)，基金无此维度
    let research=null, mainForce=null;
    try{ research=await fetchResearch(ni.code); }catch(e){}
    if(isStock){ try{ mainForce=await fetchMainForce(ni.code); }catch(e){} }
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
    let net5=null,total=null,premium=null,premiumSource='';
    if(fund){
      if(fund.grandTotal){ const g=parseGrandTotal(fund.grandTotal); if(g) net5=g.net5; }
      if(fund.buySed) total=totalShares(fund.buySed);
      if(isETF){
        // 折溢价用盘中 IOPV(腾讯gtimg)，与同花顺/东财口径一致；杜绝用 T-1 净值导致的虚高
        try{ const ep=await fetchEtfPremium(item.code); if(ep && ep.premiumPct!=null){ premium=+ep.premiumPct.toFixed(2); premiumSource=ep.source; } }catch(e){}
        if(premium==null){ // 兜底：gtimg 失败时用 现价/T-1净值(标注粗略口径)
          const navY=(fund.netWorthTrend&&fund.netWorthTrend.length)? +fund.netWorthTrend[fund.netWorthTrend.length-1].y : null;
          if(navY && price){ premium=+((price.price/navY-1)*100).toFixed(2); premiumSource='东财·T-1净值(粗略)'; }
        }
      }
    }
    const chip=chipDistribution(klines,120);
    const div=divergenceSignals(klines);
    // 主力资金流：优先用东财「主力参与度」(真实、非零)；个股用 mainForce，基金回退到实时报价 f62
    let flowOut = (mainForce && !mainForce.na) ? mainForce : (flow || {na:true});
    if(flowOut && !flowOut.na && price && price.price && flowOut.primeCost){
      flowOut.priceVsCost = +(price.price/flowOut.primeCost - 1).toFixed(3);
    }
    res.layers={
      L2:v, L3:ps, L2b:sus,
      L4:{isETF,isOCF,net5,total,premium,premiumSource},
      UW:{chip, div, flow:flowOut, sentiment:null}
    };
    res.research = research;
    res.mainForce = mainForce;
    res.dataDate = klines.length ? klines[klines.length-1].date : '';
    const _today = ymd(new Date());
    // 数据截至 = 最近一个“已完成”交易日：盘中 gtimg 会返回当天未完成 bar（日期=today），
    // 但收盘类指标基于 T-1 收盘，故 lastBar 为 today 时回退到上一根 bar 的日期。
    res.dataDateCompleted = (klines.length>=2 && res.dataDate===_today) ? klines[klines.length-2].date : res.dataDate;
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
      if(L.L3.trend==='uptrend'){ T=1; score+=0.5; reasons.push('价格高低点抬高、均线多头，趋势向上(本体确认)'); }
      else if(L.L3.trend==='downtrend'){ T=-1; reasons.push('价格创新低、均线空头，趋势向下(不逆势)'); }
      else if(L.L3.maBull){ T=0.5; score+=0.3; reasons.push('震荡但均线仍多头(结构偏多)'); }
      else if(L.L3.maBear){ T=-0.5; score-=0.3; reasons.push('价格均线空头排列，结构偏弱'); }
      else reasons.push('价格结构震荡（均线无明确方向）'); }
    if(L.L2b){ if(L.L2b.sustained){ score+=0.5; reasons.push('上涨结构持续'+L.L2b.days+'日且放量，偏基本面驱动'); } else reasons.push('上涨持续性不足(偏短线脉冲)'); }
    if(L.L4.isETF||L.L4.isOCF){
      if(L.L4.premium!=null) reasons.push('折溢价'+L.L4.premium.toFixed(2)+'%('+(L.L4.premiumSource||'IOPV口径')+(Math.abs(L.L4.premium)<=3?'·无套利干扰':'·⚠偏离大·套利陷阱风险')+')');
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
    // 主力资金流 / 机构参与度（个股权威验证维度）
    if(uw.flow && !uw.flow.na){
      if(uw.flow.netY>0){ score+=0.5; F=0.5; reasons.push('主力净流入'+uw.flow.netY.toFixed(2)+'亿'); }
      else if(uw.flow.netY<0){ score-=0.5; F=-0.5; reasons.push('主力净流出'+uw.flow.netY.toFixed(2)+'亿，资金在撤'); }
      if(uw.flow.orgParticipate!=null){
        if(uw.flow.orgParticipate>0.5){ score+=0.3; reasons.push('机构参与度'+(uw.flow.orgParticipate*100).toFixed(0)+'%，主力在场'); }
        else if(uw.flow.orgParticipate<0.35){ score-=0.2; reasons.push('机构参与度'+(uw.flow.orgParticipate*100).toFixed(0)+'%，主力参与度低'); }
      }
      if(uw.flow.priceVsCost!=null){
        if(uw.flow.priceVsCost>0.03){ score+=0.2; reasons.push('现价高于主力成本'+(uw.flow.priceVsCost*100).toFixed(1)+'%，主力浮盈持仓'); }
        else if(uw.flow.priceVsCost<-0.03){ score-=0.2; reasons.push('现价低于主力成本'+(Math.abs(uw.flow.priceVsCost)*100).toFixed(1)+'%，主力浮亏承压'); }
      }
    }
    if(uw.div){
      if(uw.div.topDiv){ score-=0.5; reasons.push('量价顶背离，警惕主力派发'); }
      if(uw.div.bottomDiv){ score+=0.5; reasons.push('量价底背离，低位有承接'); }
    }
    // 研报(分析师共识)：实拉 per-stock，作基本面 corroboration
    const rs=res.research;
    if(rs && rs.count>=3){
      if(rs.bullPct>=60){ score+=0.5; reasons.push('近'+rs.count+'篇研报，'+rs.bullPct+'%买入/增持评级，共识向好'); }
      else if(rs.bullPct<=30){ score-=0.3; reasons.push('近'+rs.count+'篇研报仅'+rs.bullPct+'%看好，共识偏冷'); }
      else reasons.push('近'+rs.count+'篇研报，评级中性');
    } else if(rs && rs.count>0){ reasons.push('近期研报较少('+rs.count+'篇)'); }
    // 大盘环境(全局)作为顶层校准
    const mk=global.STATE && global.STATE.market;
    let riskOff=false, riskOn=false;
    if(mk){
      riskOff = mk.median<0 && mk.upPct<45;
      riskOn = mk.upPct>=55 && mk.median>0;
      if(riskOff){ score-=0.5; reasons.push('大盘偏弱(中位'+mk.median.toFixed(2)+'%·涨'+mk.upPct.toFixed(0)+'%)：系统性环境不利，降低风险暴露'); }
      else if(riskOn){ score+=0.3; reasons.push('大盘偏强(中位'+mk.median.toFixed(2)+'%·涨'+mk.upPct.toFixed(0)+'%)：顺势环境'); }
    }
    // 个股权威维度声明：价格趋势(L3)为本体 + 主力资金流(L5)为最终验证与加权
    const isStock = !(L.L4.isETF||L.L4.isOCF);
    if(isStock) reasons.unshift('【个股·权威维度】价格趋势(L3)为本体，主力资金流(L5)为最终验证与加权项');
    // 硬约束：下降趋势 + 主力流出 → 明确不建议（不接下落刀）；绝不逆势抄底
    const trendOk = (L.L3 && (L.L3.trend==='uptrend' || L.L3.maBull));
    const trendLabel = (L.L3 && L.L3.trend==='uptrend') ? '趋势向上' : ((L.L3 && L.L3.maBull) ? '震荡·均线多头' : ((L.L3 && L.L3.trend==='downtrend') ? '趋势向下' : '趋势震荡'));
    let call = (T<=-0.5 && F<=-0.5) ? '不建议' : '观望';
    let blockReason = (T<=-0.5 && F<=-0.5) ? '价格趋势向下且主力资金流出，不接下落刀' : '';
    if(call!=='不建议'){
      if(score>=1.5 && trendOk) call='建议买入';
      else if(score>=1.5 && !trendOk){ blockReason='综合分已够('+score.toFixed(2)+'≥1.5)，但价格趋势未满足买入门槛('+trendLabel+')'; }
      else if(trendOk){ blockReason='趋势向上，但综合分不足('+score.toFixed(2)+'<1.5)'; }
      else { blockReason='价格趋势未满足('+trendLabel+')，且综合分不足('+score.toFixed(2)+'<1.5)'; }
    }
    return {call, score:+score.toFixed(2), reasons, trendOk, trendLabel, blockReason};
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
  .fw-card .fw-score{ font-size:11px; color:var(--txt2); margin:-4px 0 6px; line-height:1.4; }
  .fw-badges{ display:flex; flex-wrap:wrap; gap:5px; margin:6px 0; }
  .fw-badge{ font-size:11px; padding:2px 7px; border-radius:6px; background:var(--panel2); color:var(--txt2); border:1px solid var(--border); }
  .fw-badge.good{ color:#22c55e; border-color:rgba(34,197,94,.4); }
  .fw-badge.bad{ color:#ef4444; border-color:rgba(239,68,68,.4); }
  .fw-badge.warn{ color:#f5a623; border-color:rgba(245,166,35,.4); }
  .fw-reason{ font-size:12px; line-height:1.55; color:var(--txt2); margin-top:6px; }
  .fw-reason b{ color:var(--txt); font-weight:600; }
  .fw-src{ font-size:11px; color:var(--txt2); opacity:.7; margin-top:8px; }
  .fw-chk{ margin-top:8px; border-top:1px dashed var(--border); padding-top:8px; }
  .fw-chk-row{ display:flex; gap:6px; align-items:baseline; line-height:1.7; font-size:11.5px; }
  .fw-chk-row .mk{ font-weight:800; flex:none; }
  .fw-chk-row.ok .mk{ color:#22c55e; }
  .fw-chk-row.no .mk{ color:#ef4444; }
  .fw-chk-row.na .mk{ color:var(--txt3); }
  .fw-chk-row .lb{ color:var(--txt); font-weight:600; flex:none; }
  .fw-chk-row .rs{ color:var(--txt2); }
  .fw-loading,.fw-empty{ padding:18px; color:var(--txt2); }
  /* trend.html L5 水下层 */
  .uw-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-top:8px; }
  .uw-cell{ border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--panel2); }
  .uw-cell .t{ font-size:11px; color:var(--txt2); margin-bottom:3px; }
  .uw-cell .v{ font-size:13px; font-weight:700; }
  .uw-note{ font-size:11px; color:var(--txt2); opacity:.75; margin-top:6px; line-height:1.5; }
  .fw-market{ border:1px solid var(--border); border-radius:10px; padding:10px 14px; background:var(--panel2); margin-bottom:12px; }
  .fw-market .fm-hd{ font-size:12px; color:var(--txt2); margin-bottom:6px; }
  .fw-market .fm-body{ display:flex; flex-wrap:wrap; gap:14px; align-items:baseline; font-size:13px; }
  .fw-market .fm-body b{ font-weight:800; }
  .fw-market .fm-body .up{ color:#ef4444; } .fw-market .fm-body .down{ color:#22c55e; }
  .fw-market .fm-sub{ color:var(--txt2); font-size:11px; }
  .fw-legend{ border:1px dashed var(--border); border-radius:10px; padding:6px 14px; background:var(--panel2); margin-bottom:12px; font-size:12.5px; }
  .fw-legend summary{ cursor:pointer; color:var(--accent); font-weight:700; user-select:none; }
  .fw-legend summary::-webkit-details-marker{ color:var(--accent); }
  .fw-legend-body{ margin-top:8px; line-height:1.65; color:var(--txt); }
  .fw-legend-body p{ margin:6px 0; }
  .fw-legend-body b{ color:var(--txt); }
  `;
  function injectCSS(){
    if(document.getElementById('fw-style')) return;
    const s=document.createElement('style'); s.id='fw-style'; s.textContent=CSS; document.head.appendChild(s);
  }

  /* ----------------------------- AI复盘渲染 ----------------------------- */
  function badge(text, cls){ return `<span class="fw-badge ${cls||''}">${text}</span>`; }
  function verdictClass(call){ return call==='建议买入'?'fw-pill-buy':(call==='不建议'?'fw-pill-sell':'fw-pill-hold'); }

  // 复盘卡片用的逐项 5 步清单：返回 [{t, pass, na, reason}]，pass/fail 与趋势工具 CHECKS 逻辑一致
  function fwChecklist(r){
    const L=r.layers, items=[];
    const L4=L.L4;
    const m = global.STATE && global.STATE.market;
    if(m){ const ok=m.median>=0.001 && m.upPct>=45 && m.totAmt>=6000*1e8;
      items.push({t:'① 大盘环境', pass:ok, na:false, reason:`中位${m.median>=0?'+':''}${(m.median*100).toFixed(2)}%·涨${m.upPct.toFixed(0)}%·成交${(m.totAmt/1e8).toFixed(0)}亿`}); }
    else items.push({t:'① 大盘环境', pass:false, na:true, reason:'见顶部全局环境'});
    const s=L.L2b;
    const structOk = s? s.sustained : false;
    const volMark = (s&&s.volUp)?'✅':'⚠';
    const daysTxt = s? s.days : 0;
    const hhTxt = s? s.hh : 0;
    // ② 实为「价格结构(持续)」判定：持续≥10日 + 创新高≥2次 + 放量确认(基金净值无成交量→放宽)
    let rsTxt = '持续'+daysTxt+'日·创新高'+hhTxt+'次·放量'+volMark;
    rsTxt += structOk ? '：结构持续成立(偏基本面驱动)' : '：放量未确认⚠→结构未确认';
    if(r && r.research && r.research.count>0){ rsTxt += '；研报共识 '+r.research.count+'篇·'+r.research.bullPct+'%买入/增持'; }
    else { rsTxt += (r && (r.asset==='场内ETF'||r.asset==='场外基金')) ? '；研报 无（ETF/基金无个股研报）' : '；研报 无覆盖'; }
    items.push({t:'② 价格结构(持续)', pass:structOk, na:!s, reason:rsTxt});
    const pct=L.L2?L.L2.pct:null;
    items.push({t:'③ 估值不贵', pass: pct!=null && pct<75, na: pct==null, reason: pct!=null?`分位${pct.toFixed(0)}%`:'数据不足'});
    const st=L.L3; const ok4 = st? (st.trend==='uptrend'||(st.trend==='mixed'&&st.maBull)) : false;
    items.push({t:'④ 价格趋势', pass:ok4, na:!st, reason: st?({uptrend:'上升',downtrend:'下降',mixed:'震荡'})[st.trend]+(st.maBull?'·均多':'')+(st.maBear?'·均空':'') :'数据不足'});
    if(L4.isETF||L4.isOCF){
      const premOk = L4.premium==null||Math.abs(L4.premium)<=3;
      const netOk = L4.net5==null||L4.net5>=-5;
      const bothNa = L4.premium==null && L4.net5==null;  // 两项都取不到才标"待数据"，否则按取到项判定
      items.push({t:'⑤ 一级市场', pass:premOk&&netOk, na:bothNa, reason:`折溢价${L4.premium!=null?L4.premium.toFixed(1)+'%('+(L4.premiumSource||'IOPV')+')':'—'}·净申赎${L4.net5!=null?L4.net5.toFixed(1)+'亿':'—'}`});
    }
    // 个股(非基金)无一级市场维度 → 不计入清单、不影响建议
    return items;
  }

  async function renderRecap(sectionEl){
    injectCSS();
    if(!sectionEl) return;
    const wlRaw = (global.STATE && global.STATE.watchlist) || [];
    // 去重：同一代码只分析一次（避免自选误加重复项，如两个 000979）
    const seen={}, items=[]; let dup=0;
    for(const it of wlRaw){ if(!it||!it.code) continue; if(seen[it.code]){ dup++; continue; } seen[it.code]=1; items.push(it); }
    const wl=items;
    sectionEl.innerHTML = '<div class="fw-loading">正在生成复盘（自动拉取各标的数据，无需操作）…</div>';
    if(!wl.length){ sectionEl.innerHTML='<div class="fw-empty">自选股为空 —— 先去添加标的，复盘将自动生成。数据来源：腾讯gtimg / 东方财富。</div>'; return; }
    let breadth=null; try{ breadth=await fetchMarketBreadth(); }catch(e){}
    const sent=sentimentScore(breadth);
    global.STATE.market = breadth;   // 大盘环境直接参与每只标的的判定(fwChecklist ① 与 verdictOf)
    const results=[];
    const limit=4;
    for(let i=0;i<wl.length;i+=limit){
      const batch=wl.slice(i,i+limit);
      const rs=await Promise.all(batch.map(it=>analyzeOne(it).catch(e=>({code:it.code, name:it.name||'', asset:'', ok:false, err:''+e}))));
      results.push(...rs);
    }
    // 数据截至：取首只有效标的的最后一根 K线/净值日期（日线为上一交易日收盘）
    let lastDate='';
    for(const r of results){ if(r.ok && r.dataDateCompleted){ lastDate=r.dataDateCompleted; break; } }
    if(!lastDate) lastDate=ymd(new Date());
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
      if(r.research && r.research.count>0) pb.push(badge('研报'+r.research.count+'篇·'+r.research.bullPct+'%看好', r.research.bullPct>=60?'good':(r.research.bullPct<=30?'bad':'')));
      const reason = vd.reasons.length ? '<b>理由：</b>'+vd.reasons.join('；') : '';
      const priceTxt = r.price ? (r.price.price!=null? (r.asset==='场外基金'?'单位净值 '+r.price.price.toFixed(4):'现价 '+r.price.price.toFixed(r.price.price<10?3:2)+(r.price.pct?'（'+(r.price.pct>=0?'+':'')+r.price.pct.toFixed(2)+'%）':'')) : '') : '';
      const chk=fwChecklist(r);
      const chkHtml=`<div class="fw-chk">`+chk.map(it=>`<div class="fw-chk-row ${it.na?'na':(it.pass?'ok':'no')}"><span class="mk">${it.na?'ℹ':(it.pass?'✓':'✗')}</span><span class="lb">${it.t}</span><span class="rs">${it.reason}</span></div>`).join('')+`</div>`;
      return `<div class="fw-card">
        <div class="hd"><span class="nm">${r.name||r.code}</span><span class="at">${r.asset}</span></div>
        <div class="hd"><span class="cd">${r.code}</span></div>
        <div class="px">${priceTxt}</div>
        <div class="verdict ${verdictClass(vd.call)}">${vd.call}</div>
        <div class="fw-score" title="综合分=${vd.score}，买入门槛：价格趋势向上 + 综合分≥1.5">综合分 ${vd.score} · 趋势门槛${vd.trendOk?'✓':'✗'}${vd.blockReason?' · '+vd.blockReason:''}</div>
        <div class="fw-badges">${pb.join('')}</div>
        <div class="fw-reason">${reason}</div>
        ${chkHtml}
        <div class="fw-src">序列源：${r.srcInfo||'—'}</div>
      </div>`;
    }).join('');
    const summary = `<div class="fw-summary">
      <span class="pill fw-pill-buy">建议买入 ${buy}</span>
      <span class="pill fw-pill-hold">观望 ${hold}</span>
      <span class="pill fw-pill-sell">不建议 ${sell}</span>
      <span style="color:var(--txt2);font-size:12px">共 ${results.length} 只 · 数据截至 ${lastDate}${dup?` · 已去重 ${dup} 个重复代码`:''}</span>
      ${sent?`<span class="pill fw-pill-sent">市场情绪：${sent.label}(${sent.score})</span>`:''}
    </div>`;
    const mk=breadth;
    let regimeTxt='中性环境', regimeCls='fw-pill-hold';
    if(mk){ if(mk.median<0 && mk.upPct<45){ regimeTxt='系统性偏弱·降仓'; regimeCls='fw-pill-sell'; } else if(mk.upPct>=55 && mk.median>0){ regimeTxt='顺势偏强'; regimeCls='fw-pill-buy'; } }
    const marketHtml = mk ? `<div class="fw-market" id="fwMarketBox">
      <div class="fm-hd">大盘环境（直接展示，用于校准每只标的的建议${mk.snapshotAt?(' · 数据 '+mk.snapshotAt.slice(0,10)):''}）</div>
      <div class="fm-body">
        <span>中位涨跌幅 <b class="${mk.median>=0?'up':'down'}">${mk.median>=0?'+':''}${(mk.median*100).toFixed(2)}%</b></span>
        <span>上涨占比 <b>${mk.upPct.toFixed(0)}%</b> <span class="fm-sub">(${mk.up}/${mk.total})</span></span>
        <span>成交额 <b>${(mk.totAmt/1e8).toFixed(0)}亿</b></span>
        ${sent?`<span>情绪 <b>${sent.label}(${sent.score})</b></span>`:''}
        <span class="pill ${regimeCls}">${regimeTxt}</span>
      </div></div>` : '';
    const legendHtml = `<details class="fw-legend">
      <summary>图例与判定说明（✓ / ✗ / ⚠ 是什么？点开看）</summary>
      <div class="fw-legend-body">
        <p><b>✓</b> 该维度条件满足，对建议为<b>正向</b>；<b>✗</b> 该维度条件未满足，会<b>拉低建议等级</b>；<b>⚠</b> 关注/警告——通常是未通过的原因或风险信号（如放量未确认、异常放量、折溢价偏离大）。</p>
        <p><b>② 价格结构(持续)</b> 需同时满足三项才打 ✓：① 上涨持续 ≥10 日；② 区间创新高 ≥2 次；③ 放量确认（近段成交量显著高于前段）。任一项不满足即 ✗。<br>例如润泽科技「持续122日·创新高6次·放量⚠」满足前两项，但<b>放量未确认(⚠)</b>，故整体 ✗——提示量价配合不足、需警惕派发，<b>与研报无关</b>。</p>
        <p><b>研报共识</b> 是<b>独立维度</b>（分析师评级统计），不参与 ② 结构判定，仅在卡片徽章与 ② 备注中展示，作为基本面旁证。研报 100% 买入 ≠ 结构必然成立。</p>
        <p><b>大盘环境</b> 由全市场约 5500 只 A 股实时涨跌计算（上涨占比=上涨家数/总数），用于校准每只标的的建议（系统性偏弱时降仓）。</p>
        <p><b>折溢价(ETF)</b> 用<b>盘中 IOPV（实时预估净值）</b>计算，与同花顺/东财口径一致：溢价% = 现价 ÷ IOPV − 1。正常在 ±3% 内为「无套利干扰」；超过才标 ⚠「套利陷阱风险」。注意：<b>不能用 T-1 官方净值</b>算——板块盘中若大涨，IOPV 跟着涨，相对昨净值的"溢价"会虚高好几分点（例如电网设备ETF华夏曾误显 +5.37%，实为 +0.13%/IOPV）。若显示「东财·T-1净值(粗略)」说明腾讯源未取到，为兜底值，仅供参考。</p>
      </div></details>`;
    sectionEl.innerHTML = `<div class="fw-recap">${summary}${marketHtml}${legendHtml}<div class="fw-cards">${cards}</div>
      <div class="fw-src" style="margin-top:12px">说明：建议为框架综合研判结论（四层+水下层），非个性化投资建议；市场情绪为恐惧贪婪代理。复盘在打开/刷新页面时基于最新可得数据生成；日K线为上一交易日收盘，盘中实时价仅影响现价与资金流。报告仅供参考，不构成个人投资建议。</div></div>`;
    startMarketLive(); // 交易时段让 ① 大盘环境(顶部盒)随首页同频(30s)实时刷新；盘后自动停
  }
  // ① 大盘环境盒实时刷新（仅更新顶部盒，不重算各标卡片，避免无谓请求）
  function marketBoxHtml(mk, sent){
    if(!mk) return '';
    let regimeTxt='中性环境', regimeCls='fw-pill-hold';
    if(mk.median<0 && mk.upPct<45){ regimeTxt='系统性偏弱·降仓'; regimeCls='fw-pill-sell'; }
    else if(mk.upPct>=55 && mk.median>0){ regimeTxt='顺势偏强'; regimeCls='fw-pill-buy'; }
    return `<div class="fw-market" id="fwMarketBox">
      <div class="fm-hd">大盘环境${mk.live?' · <span style="color:var(--up)">实时</span>':''}${mk.snapshotAt?(' · 数据 '+mk.snapshotAt.slice(0,10)):''}</div>
      <div class="fm-body">
        <span>中位涨跌幅 <b class="${mk.median>=0?'up':'down'}">${mk.median>=0?'+':''}${(mk.median*100).toFixed(2)}%</b></span>
        <span>上涨占比 <b>${mk.upPct.toFixed(0)}%</b> <span class="fm-sub">(${mk.up}/${mk.total})</span></span>
        <span>成交额 <b>${(mk.totAmt/1e8).toFixed(0)}亿</b></span>
        ${sent?`<span>情绪 <b>${sent.label}(${sent.score})</b></span>`:''}
        <span class="pill ${regimeCls}">${regimeTxt}</span>
      </div></div>`;
  }
  let _marketTimer=null, _marketRefreshing=false;
  function updateMarketBox(){
    const box=document.getElementById('fwMarketBox');
    if(!box) return;
    const mk=global.STATE.market;
    if(!mk) return;
    const sent=sentimentScore(mk);
    box.outerHTML = marketBoxHtml(mk, sent);
  }
  function startMarketLive(){
    if(_marketTimer) return;
    const tick=async ()=>{
      if(_marketRefreshing) return;
      if(isAshareTradingTime()){
        _marketRefreshing=true;
        try{
          const b=await fetchMarketBreadth();
          if(b){ global.STATE.market=b; updateMarketBox(); }
        }catch(e){} finally{ _marketRefreshing=false; }
      }else{
        clearInterval(_marketTimer); _marketTimer=null;
        // 收盘后补一次实时快照，锁定今日收盘数据（不必持续刷新）
        _marketRefreshing=true;
        try{
          const b=await fetchMarketBreadth();
          if(b){ global.STATE.market=b; updateMarketBox(); }
        }catch(e){} finally{ _marketRefreshing=false; }
      }
    };
    tick();
    _marketTimer=setInterval(tick, 30000); // 交易时段与首页上方市场广度同频(30s)；收盘后补一次即停
  }

  /* ----------------------------- trend.html L5 水下层渲染 ----------------------------- */
  function renderL5(container, klines, opts){
    injectCSS();
    if(!container) return;
    if(!klines){ container.innerHTML='<p class="src">水下层需K线/净值序列，暂未取到。</p>'; return; }
    const chip=chipDistribution(klines,120);
    const div=divergenceSignals(klines);
    // 优先用东财「主力参与度」(真实、非零)；回退到实时报价 f62
    const flow = (opts && opts.mainForce && !opts.mainForce.na) ? opts.mainForce : (opts && opts.quoteFlow ? mainForceFlow(opts.quoteFlow) : {na:true});
    if(flow && !flow.na && opts && opts.price && opts.price.price && flow.primeCost){ flow.priceVsCost = +(opts.price.price/flow.primeCost - 1).toFixed(3); }
    const research = (opts && opts.research && opts.research.count>0) ? opts.research : null;
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
      if(flow.orgParticipate!=null) cells.push(`<div class="uw-cell"><div class="t">机构参与度</div><div class="v">${(flow.orgParticipate*100).toFixed(0)}%</div></div>`);
      if(flow.primeCost!=null) cells.push(`<div class="uw-cell"><div class="t">主力成本</div><div class="v">${flow.primeCost.toFixed(flow.primeCost<10?3:2)}</div></div>`);
      if(flow.priceVsCost!=null){ const pc=flow.priceVsCost*100; cells.push(`<div class="uw-cell"><div class="t">现价/主力成本</div><div class="v" style="color:var(${pc>=0?'--up':'--down'})">${pc>=0?'+':''}${pc.toFixed(1)}%</div></div>`); }
    } else { cells.push(`<div class="uw-cell"><div class="t">主力资金流</div><div class="v">不适用(个股无字段)</div></div>`); }
    if(research){ const rc=research.bullPct; cells.push(`<div class="uw-cell"><div class="t">研报共识(近${research.count}篇)</div><div class="v" style="color:var(${rc>=60?'--up':rc<=30?'--down':'--txt'})">${rc}%看好</div></div>`); }
    const dtags=[];
    if(div.topDiv) dtags.push('<span class="fw-badge bad">量价顶背离·警惕派发</span>');
    if(div.bottomDiv) dtags.push('<span class="fw-badge good">量价底背离·有承接</span>');
    if(div.abnormalVol) dtags.push('<span class="fw-badge warn">异常放量</span>');
    if(div.longUpper) dtags.push('<span class="fw-badge warn">长上影·上方抛压</span>');
    if(div.longLower) dtags.push('<span class="fw-badge good">长下影·低位承接</span>');
    if(!dtags.length) dtags.push('<span class="fw-badge">量价无明显异动</span>');
    container.innerHTML = `<div class="uw-grid">${cells.join('')}</div>
      <div class="fw-badges" style="margin-top:8px">${dtags.join('')}</div>
      <div class="uw-note">水下层为「主力意图/人性博弈」的可量化代理（筹码成本结构、主力资金流/机构参与度、量价背离、研报共识），揭示表面数据之下的深层博弈，非对主力心思的直接读取。个股主力流可能无字段→标记不适用。</div>`;
  }

  // 导出
  global.FW = {
    normalizeInput, fetchKline, loadPzd, navSeries, fetchPrice, fetchQuoteFlow, fetchMarketBreadth,
    fetchResearch, fetchMainForce,
    valuationPct, priceStructure, sustainSignal, parseGrandTotal, totalShares,
    chipDistribution, divergenceSignals, mainForceFlow, sentimentScore,
    analyzeOne, verdictOf, renderRecap, renderL5, injectCSS, fwChecklist
  };
})(window);
