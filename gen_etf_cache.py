#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 ETF 一级市场宽基净申赎的「共享静态缓存」文件 etf_realtime_cache.json。

用途：
- 把前端 loadEtfRealtimeInflow 的「集思录历史基线 + 东财 f84 总份额日差分」计算逻辑
  用 Python 预跑好，输出一份静态 JSON，部署到 CloudStudio 后【所有访问者共享同一份】、
  页面毫秒级读取、不再每次现场拉东财 JSONP（那正是「一直加载不出来」的卡死根因）。
- 日频数据，缓存按天有效；跨日后页面会自动尝试现场兜底，失败则回退旧文件，绝不卡死。

运行环境要求：能直连东方财富外网接口（统一用 push2delay.eastmoney.com，云端稳定可达）。
（注：push2.eastmoney.com 实时端点在非中国 IP 间歇性断连、push2his.eastmoney.com 历史K线云端完全不可达，
 均已弃用；ETF 份额改走 push2delay，上证收盘改用 push2delay 取当日值并持久化到 etf_history.json 顶层 'sh'。）
  若运行环境走代理且代理不可达，需先清掉代理环境变量（见下方 os.environ.pop）。

【自动化增强】
- 现场拉取失败时，自动回退读取 em_snapshot.json（由自动化任务用 WebFetch 拉取并写出）。
- 生成后把新增交易日写回 etf_history.json，使 51 日窗口真正滑动、差分基准始终正确。
- 末尾打印机器可解析的状态行：STATUS_JSON=...，并写出 gen_etf_cache.status.json。

用法：
  python3 gen_etf_cache.py                 # 常规：尝试现场拉东财，失败回退快照
  python3 gen_etf_cache.py --snapshot     # 强制只用 em_snapshot.json（不现场拉）
  python3 gen_etf_cache.py --no-writeback # 测试用：不写回 etf_history.json
输出：
  ./etf_realtime_cache.json  （结构 = 前端 loadEtfRealtimeInflow 返回值 + generatedAt/date）
"""
import json
import os
import sys
import datetime

# 强制直连（云端/本机若设了不可用代理，清掉以免卡死）
for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]:
    os.environ.pop(k, None)

BASE = os.path.dirname(os.path.abspath(__file__))
HIST_PATH = os.path.join(BASE, "etf_history.json")
OUT_PATH = os.path.join(BASE, "etf_realtime_cache.json")
SNAP_PATH = os.path.join(BASE, "em_snapshot.json")
STATUS_PATH = os.path.join(BASE, "gen_etf_cache.status.json")

ETFS = ["510050", "510300", "510500", "512100", "588000", "159915"]
NAMES = {
    "510050": "上证50ETF", "510300": "沪深300ETF", "510500": "中证500ETF",
    "512100": "中证1000ETF", "588000": "科创50ETF", "159915": "创业板ETF",
}

FORCE_SNAPSHOT = "--snapshot" in sys.argv
NO_WRITEBACK = "--no-writeback" in sys.argv


def today_str():
    return datetime.date.today().strftime("%Y-%m-%d")


def _weekday(dt_str):
    y, m, d = map(int, dt_str.split("-"))
    return datetime.date(y, m, d).weekday()  # 0=Mon ... 6=Sun


def fetch_em(code):
    """拉东财单只行情 f84=总份额(份), f43=价格(0.001元), f169=折溢价率(万分之一)。
    用 urllib 直连（与 gen_sector_flow_cache.py 一致），避免 requests 在部分环境走代理导致连不上 push2。"""
    import urllib.request, ssl, json as _json
    secid = ("0." if code[:2] in ("15", "16", "18") else "1.") + code
    url = f"https://push2delay.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f43,f57,f84,f169"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"})
    last_err = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                data = _json.load(r).get("data", {})
            shares = float(data.get("f84", 0) or 0)
            if shares <= 0:
                return None
            return {
                "shares": shares,
                "price": float(data.get("f43", 0) or 0) / 1000.0,
                "prem": float(data.get("f169", 0) or 0) / 100.0,
                "name": data.get("f57") or NAMES[code],
            }
        except Exception as e:
            last_err = e
    print("  err", code, repr(last_err)[:120])
    return None


def fetch_em_all():
    out = {}
    for code in ETFS:
        v = fetch_em(code)
        if v:
            out[code] = v
    return out


def fetch_sh_today():
    """云端可用：用 push2delay 取上证指数(1.000001)当日收盘。
    历史日线改用 etf_history.json 顶层 'sh' 持久化字典（每天仅追加当日），
    不再依赖 push2his（云端不可达，HTTP 000）。返回当日收盘点位或 None。"""
    import urllib.request, ssl, json as _json
    secid = "1.000001"
    url = f"https://push2delay.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f43,f57,f60,f169"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"})
    try:
        with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
            d = _json.load(r).get("data", {})
        f43 = d.get("f43")
        if f43 is not None:
            # 指数点位经 push2delay 返回时单位 0.01（指数按2位小数存储，与个股 0.001 不同），需 ÷100
            return float(f43) / 100.0
    except Exception as e:
        print("  sh today err", repr(e)[:120])
    return None


def load_snapshot():
    """em_snapshot.json 结构：
    {"date":"2026-07-20",
     "em":{"510050":{"shares":..,"price":..,"prem":..,"name":..}, ...},
     "sh":{"2026-07-20":3764.15, ...}}
    """
    if not os.path.exists(SNAP_PATH):
        return None
    try:
        return json.load(open(SNAP_PATH, encoding="utf-8"))
    except Exception as e:
        print("  snapshot read err", repr(e)[:120])
        return None


def main():
    hist = json.load(open(HIST_PATH, encoding="utf-8"))
    today = today_str()

    status = {"date": today, "source": None, "coverage": 0, "ok": False,
              "error": None, "windowDays": 0, "netAmtToday": None, "netShareToday": None}

    # 跳过非交易日（周末）：避免把「休市日」当成新交易日追加一条近零数据
    if _weekday(today) >= 5:
        status["error"] = "weekend-skip"
        status["ok"] = True  # 非错误，仅是跳过
        print(f"SKIP {today} 为周末，不追加交易日")
        print("STATUS_JSON=" + json.dumps(status, ensure_ascii=False))
        with open(STATUS_PATH, "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=1)
        return

    # cache 初始化：用集思录历史作为基线（服务端权威源）
    cache = {}
    for d in [k for k in hist if k.startswith("2026-")]:
        cache[d] = {"per": {c: dict(hist[d]["per"][c]) for c in hist[d]["per"]}}

    snap = load_snapshot() if not FORCE_SNAPSHOT else load_snapshot()

    # 1) 现场拉东财今日 6 只宽基总份额
    em_per = {} if FORCE_SNAPSHOT else fetch_em_all()
    if not em_per and snap and snap.get("date") == today and snap.get("em"):
        print("  现场拉取为空，回退 em_snapshot.json（当日）")
        em_per = {c: v for c, v in snap["em"].items() if c in ETFS}

    jsl_today = hist.get(today, {})
    jsl_complete = jsl_today and all(c in jsl_today.get("per", {}) for c in ETFS)

    if em_per and not jsl_complete:
        sorted_dates = sorted([k for k in cache if k < today])
        last_date = sorted_dates[-1] if sorted_dates else None
        last_per = cache[last_date]["per"] if last_date else {}
        # 盘中保护：东财 f84(总份额)在每个交易日收盘结算后才更新；盘中跑会得到与
        # 上一已结算日相同的份额，做差分必然得 0 → 产生虚假"当日净申赎=0"。
        # 检测：6 只 ETF 的当前 f84 == 上一日 f84 → 东财未更新 → 跳过今日，沿用 last_date 为最新。
        all_unchanged = bool(last_per) and all(
            em_per.get(c) and em_per[c]["shares"] == (last_per.get(c, {}) or {}).get("shares")
            for c in ETFS
        )
        if all_unchanged:
            print(f"  push2delay f84 尚未更新({today} 仍 = {last_date} 收盘值)，跳过今日，沿用 {last_date} 为最新")
        else:
            per_today = {}
            for code in ETFS:
                cur = em_per.get(code)
                if not cur:
                    continue
                base = (last_per.get(code, {}) or {}).get("shares", 0) or 0
                cur = dict(cur)
                cur["net"] = (cur["shares"] - base) if base else 0
                cur["nav"] = cur["price"]
                per_today[code] = cur
            if per_today:
                cache[today] = {"per": per_today,
                                 "ts": int(datetime.datetime.now().timestamp() * 1000),
                                 "_source": "eastmoney" if not FORCE_SNAPSHOT else "snapshot"}

    # 2) 上证指数收盘（右轴参考）——云端用 push2delay 取当日收盘，历史从 etf_history.json 顶层 'sh' 持久化字典读取
    dates = sorted([k for k in cache if k.startswith("2026-")])
    sh_store = dict(hist.get("sh", {})) if not FORCE_SNAPSHOT else {}
    if not FORCE_SNAPSHOT and today not in sh_store and _weekday(today) < 5:
        c = fetch_sh_today()
        if c:
            sh_store[today] = c
    sh_map = {d: sh_store.get(d) for d in dates}
    if not any(sh_map.values()) and snap and snap.get("sh"):
        print("  上证现场拉取为空，回退 em_snapshot.json 的 sh 段")
        sh_map = {k: float(v) for k, v in snap["sh"].items()}
    sh_close = [sh_map.get(d) for d in dates]

    # 3) 序列
    net_share, net_amt = [], []
    for d in dates:
        per = cache[d]["per"]
        ns = na = 0.0
        for c in ETFS:
            v = per.get(c)
            if not v:
                continue
            net = v.get("net", 0) or 0
            ns += net
            if v.get("nav"):
                na += net * v["nav"]
        net_share.append(ns / 1e8)   # 亿份
        net_amt.append(na / 1e8)     # 亿元

    def sum_last(arr, k):
        n = min(k, len(arr))
        return sum(arr[len(arr) - n:])

    last = dates[-1]
    yesterday = dates[-2] if len(dates) > 1 else None
    periods = {
        "当日": {"date": last, "shares": net_share[-1], "amt": net_amt[-1]},
        "昨日": {"date": yesterday, "shares": net_share[-2], "amt": net_amt[-2]} if yesterday else None,
        "近5日": {"date": dates[max(0, len(dates) - 5)], "shares": sum_last(net_share, 5), "amt": sum_last(net_amt, 5)},
        "近20日": {"date": dates[max(0, len(dates) - 20)], "shares": sum_last(net_share, 20), "amt": sum_last(net_amt, 20)},
        "近60日": {"date": dates[max(0, len(dates) - 60)], "shares": sum_last(net_share, len(dates)), "amt": sum_last(net_amt, len(dates))},
    }
    last_per = cache[last]["per"]
    today_coverage = sum(1 for c in ETFS if c in last_per)
    today_available = [{"code": c, "name": NAMES[c]} for c in ETFS if c in last_per]
    today_missing = [{"code": c, "name": NAMES[c]} for c in ETFS if c not in last_per]

    src = cache.get(today, {}).get("_source", "precomputed")
    out = {
        "generatedAt": datetime.datetime.now().isoformat(),
        "date": last,
        "dates": [d[5:] for d in dates],
        "fullDates": dates,
        "netShareSeries": net_share,
        "netAmtSeries": net_amt,
        "shClose": sh_close,
        "latest": {"date": last, "netAmt": net_amt[-1], "netShares": net_share[-1]},
        "periods": periods,
        "windowDays": len(dates),
        "todayCoverage": today_coverage,
        "todayAvailable": today_available,
        "todayMissing": today_missing,
        "prevDate": last,
        "prevPer": {c: {"shares": last_per[c]["shares"], "price": last_per[c].get("price"),
                       "nav": last_per[c].get("nav"), "name": last_per[c].get("name", NAMES[c])}
                   for c in ETFS if c in last_per},
        "updatedAt": int(datetime.datetime.now().timestamp() * 1000),
        "_source": "precomputed",
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    # 4) 写回历史，使窗口滑动、差分基准持续正确
    if not NO_WRITEBACK:
        cache["sh"] = sh_store  # 持久化上证收盘字典（云端不再依赖 push2his）
        with open(HIST_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=1)

    status.update({
        "date": last, "source": src, "coverage": today_coverage, "ok": True,
        "windowDays": len(dates),
        "netAmtToday": round(net_amt[-1], 3),
        "netShareToday": round(net_share[-1], 3),
        "available": [x["code"] for x in today_available],
        "missing": [x["code"] for x in today_missing],
    })
    print(f"OK generated date={last} coverage={today_coverage}/6 windowDays={len(dates)}")
    print(f"netAmtToday={round(net_amt[-1],2)} netShareToday={round(net_share[-1],2)}")
    print(f"available={[x['code'] for x in today_available]} missing={[x['code'] for x in today_missing]}")
    print("STATUS_JSON=" + json.dumps(status, ensure_ascii=False))
    with open(STATUS_PATH, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
