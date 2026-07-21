#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
场外基金当日估算收益生成器（供 GitHub Action 云端定时运行）。

为什么需要它：
  天天基金/东财的基金净值与持仓接口（api.fund.eastmoney.com、fundf10.eastmoney.com）
  校验 Referer，纯静态 GitHub Pages 页面无法在浏览器里直接跨域获取。
  因此改为：云端（GitHub Actions，有固定公网出口、可自由设置 Referer）定时计算，
  把结果写成 fund_estimates.json 提交回仓库；GitHub Pages 页面直接读这个同源 JSON，
  无需任何本地代理或用户手动脚本。

估算方法（与主流平台一致）：
  估算涨幅 ≈ 股票占净比% × 前十大持仓股按权重平均实时涨跌幅
  估算净值 = 最新官方净值 × (1 + 估算涨幅)
  股票占净比由“前十大持仓占净值比例之和 ÷ 0.62”反推（前十大约占股票仓位 60-62%）。

仅使用 Python 标准库，便于在 GitHub Actions (ubuntu-latest) 直接运行，无需 pip 安装。
"""
import urllib.request
import json
import re
import sys
import os
import datetime

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
EM_REFERER = "http://fundf10.eastmoney.com/"

# 北京时间的“现在”（中国无夏令时，UTC+8 固定偏移即可）
def now_bj():
    return datetime.datetime.utcnow() + datetime.timedelta(hours=8)

def http_get(url, referer=EM_REFERER, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")

def get_nav(code):
    url = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=%s&pageIndex=1&pageSize=2" % code
    txt = http_get(url)
    d = json.loads(txt)
    lst = d.get("Data", {}).get("LSJZList", [])
    if not lst:
        return None
    last = lst[0]
    prev = lst[1] if len(lst) > 1 else {}
    nav = float(last.get("DWJZ", 0) or 0)
    prev_nav = float(prev.get("DWJZ", 0) or 0) or nav
    nav_date = (last.get("FSRQ") or "")[:10]
    fund_type = d.get("Data", {}).get("FundType") or ""
    return {"nav": nav, "prevNav": prev_nav, "navDate": nav_date, "fundType": fund_type}

def extract_content(js):
    # 响应形如：var apidata = { content:"<table>...</table>", ... }; 提取 content 字符串
    m = re.search(r'content\s*:\s*"((?:\\.|[^"\\])*)"', js)
    if not m:
        return None
    s = m.group(1)
    s = (s.replace('\\"', '"').replace("\\n", "\n").replace("\\r", "\r")
           .replace("\\/", "/").replace("\\t", "\t").replace("\\\\", "\\"))
    return s

def get_holdings(code):
    y = now_bj().year
    quarters = [(y, 6), (y, 3), (y - 1, 12), (y - 1, 9), (y, 9), (y, 12)]
    for yy, mm in quarters:
        url = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=%s&year=%d&month=%d"
               % (code, yy, mm))
        try:
            js = http_get(url)
        except Exception:
            continue
        content = extract_content(js)
        if not content:
            continue
        holdings = parse_holdings(content)
        name = ""
        nm = re.search(r"title='([^']+)'", content)
        if nm:
            name = nm.group(1)
        if holdings:
            return {"holdings": holdings, "fundName": name}
    return {"holdings": [], "fundName": ""}

def parse_holdings(html):
    out = []
    for trm in re.finditer(r"<tr>([\s\S]*?)</tr>", html):
        row = trm.group(1)
        code = re.search(r"(\d{6})", row)
        pctm = re.search(r"(\d+\.\d+)%", row)
        if code and pctm:
            w = float(pctm.group(1))
            if w > 0:
                out.append({"code": code.group(1), "weight": w})
    return out

def to_secid(code):
    return ("1." + code) if code.startswith("6") else ("0." + code)

def get_stock_chg(secid):
    url = "https://push2delay.eastmoney.com/api/qt/stock/get?secid=%s&fields=f43,f170,f57,f58&cb=x" % secid
    try:
        txt = http_get(url, referer="https://quote.eastmoney.com/")
    except Exception:
        return None
    txt = txt.strip()
    # 响应形如 x({...}); 剥掉 JSONP 包裹
    if txt.startswith("x("):
        txt = txt[2:]
        if txt.endswith(");"):
            txt = txt[:-2]
        elif txt.endswith(")"):
            txt = txt[:-1]
    try:
        d = json.loads(txt)
    except Exception:
        return None
    data = d.get("data")
    if not data:
        return None
    chg = data.get("f170")
    try:
        # f170 为涨跌幅×100（如 1.53% 返回 153），还原为百分比
        return float(chg) / 100.0
    except (TypeError, ValueError):
        return None

def is_trading_now():
    now = now_bj()
    if now.weekday() >= 5:
        return False
    t = now.time()
    morning = datetime.time(9, 30) <= t <= datetime.time(11, 30)
    afternoon = datetime.time(13, 0) <= t <= datetime.time(15, 0)
    return morning or afternoon

def main():
    codes = []
    # 优先读 funds.json（由页面自动同步的自选场外基金列表），其次 fund_list.txt（手动覆盖）
    try:
        with open("funds.json", encoding="utf-8") as f:
            fj = json.load(f)
        fc = fj.get("codes") or fj.get("funds") or []
        if isinstance(fc, list):
            codes = [str(c).strip() for c in fc if str(c).strip()]
    except FileNotFoundError:
        pass
    except Exception:
        pass
    if not codes:
        try:
            with open("fund_list.txt", encoding="utf-8") as f:
                for line in f:
                    c = line.strip()
                    if c and not c.startswith("#"):
                        codes.append(c)
        except FileNotFoundError:
            codes = []
    if not codes:
        print("funds.json / fund_list.txt 均无有效基金代码，跳过。", file=sys.stderr)
        # 仍写出一个空结构，避免页面报错
        with open("fund_estimates.json", "w", encoding="utf-8") as f:
            json.dump({"updatedAt": now_bj().isoformat(timespec="seconds"),
                       "generatedBy": "github-action", "funds": {}}, f, ensure_ascii=False, indent=2)
        return

    out = {"updatedAt": now_bj().isoformat(timespec="seconds"), "generatedBy": "github-action", "funds": {}}
    trading = is_trading_now()
    today = now_bj().strftime("%Y-%m-%d")
    print("trading_now=%s today=%s" % (trading, today))
    for code in codes:
        try:
            nd = get_nav(code)
            if not nd or not (nd["nav"] > 0):
                print("  %s 跳过：无有效净值" % code)
                continue
            nav = nd["nav"]
            prevNav = nd["prevNav"]
            navDate = nd["navDate"]
            ftype = nd["fundType"]
            isOfficialToday = (navDate == today)
            rec = {"code": code, "name": "", "nav": nav, "prevNav": prevNav,
                   "navDate": navDate, "isQDII": False, "isToday": True}
            if isOfficialToday:
                # 当日正式净值已披露 → 冻结，显示真实涨跌
                rec["estNav"] = nav
                rec["estChgPct"] = round((nav - prevNav) / prevNav * 100, 4) if prevNav > 0 else 0.0
                rec["estChgAmt"] = round(nav - prevNav, 4)
                rec["isOfficial"] = True
                rec["estTime"] = navDate
            else:
                # 当日正式净值尚未披露（navDate < 今天）：无论盘中还是盘后，都算“今天的估算”。
                # 盘后股价已定，算出来即为收盘估算；官方净值披露后才会切到 isOfficial。
                hd = get_holdings(code)
                rec["name"] = hd["fundName"]
                rec["isOfficial"] = False
                if hd["holdings"]:
                    topW = sum(h["weight"] for h in hd["holdings"])
                    stockPct = max(0.0, min(100.0, topW / 0.62))
                    chgs = []
                    for h in hd["holdings"]:
                        c = get_stock_chg(to_secid(h["code"]))
                        if c is not None:
                            chgs.append((h["weight"], c))
                    if chgs:
                        wsum = sum(w for w, _ in chgs)
                        wavg = sum(w * c for w, c in chgs) / wsum if wsum else 0.0
                        estChgPct = stockPct / 100.0 * wavg
                        estNav = nav * (1 + estChgPct / 100.0)
                        rec["estNav"] = round(estNav, 4)
                        rec["estChgPct"] = round(estChgPct, 2)
                        rec["estChgAmt"] = round(estNav - nav, 4)
                        rec["stockPct"] = round(stockPct, 2)
                        rec["topWeightSum"] = round(topW, 2)
                        rec["holdingsCount"] = len(hd["holdings"])
                        rec["estTime"] = now_bj().strftime("%Y-%m-%d %H:%M")
                    else:
                        # 持仓股取不到实时报价 → 无法估算，回退展示最近官方净值（标注待披露）
                        rec["estNav"] = nav
                        rec["estChgPct"] = round((nav - prevNav) / prevNav * 100, 2) if prevNav > 0 else 0.0
                        rec["estChgAmt"] = round(nav - prevNav, 4)
                else:
                    rec["estNav"] = nav
                    rec["estChgPct"] = round((nav - prevNav) / prevNav * 100, 2) if prevNav > 0 else 0.0
                    rec["estChgAmt"] = round(nav - prevNav, 4)
            rec["isQDII"] = bool(re.search(r"QDII|纳斯达克|标普|道琼斯|环球|海外",
                                            (rec.get("name", "") or "") + " " + (ftype or "")))
            out["funds"][code] = rec
            print("  %s nav=%.4f estNav=%s chg=%s official=%s"
                  % (code, nav, rec.get("estNav"), rec.get("estChgPct"), rec["isOfficial"]))
        except Exception as e:
            print("  %s ERROR %s" % (code, e), file=sys.stderr)
    # 仅当估算数据真正变化时才写文件，避免每个调度周期都产生无意义 commit
    changed = True
    if os.path.exists("fund_estimates.json"):
        try:
            with open("fund_estimates.json", encoding="utf-8") as f:
                old = json.load(f)
            if old.get("funds") == out["funds"]:
                changed = False
        except Exception:
            pass
    if changed:
        with open("fund_estimates.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print("wrote fund_estimates.json with %d funds" % len(out["funds"]))
    else:
        print("fund_estimates.json 无变化，跳过写入")

if __name__ == "__main__":
    main()
