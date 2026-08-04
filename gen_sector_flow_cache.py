#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_sector_flow_cache.py
========================
服务端每日快照：拉取东方财富「行业板块」(m:90+t:2) 当日主力净流入(f62)，
按交易日归档到 sector_flow_history.json，供面板计算「连续x日净流入/净流出」。

- f62 = 主力净流入(元)，归档时换算为 亿元(÷1e8)，保留两位小数。
- 按自然交易日(北京时间)为 key；同一天重复运行会覆盖(取当天最后一次≈收盘值)。
- 非交易日(周六/周日)或拉到的合计主力净流入过小(视为休市/未开盘)时跳过，不污染历史。
- 仅保留最近 KEEP_DAYS 个交易日。

历史仅靠每日累积，无法回填过去(东财板块历史K线不含逐日主力净流入)。
"""
import json
import os
import shutil
import ssl
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sector_flow_history.json")

URL = (
    "https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=300&po=1&np=1&fltt=2&invt=2"
    "&fs=m:90+t:2&fields=f12,f14,f62,f2,f3"
)
KEEP_DAYS = 120
# 全部板块主力净流入绝对值合计低于该值(元)视为非交易时段/休市，跳过
MIN_TOTAL_ABS = 1e8
# 当日解析出的板块数低于该值视为接口异常(返回残缺/空)，保留旧历史不覆盖
MIN_BOARDS = 50


def shanghai_now():
    return datetime.now(timezone(timedelta(hours=8)))


def fetch_clist():
    req = urllib.request.Request(
        URL,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://quote.eastmoney.com/",
        },
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last_err = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
                return json.loads(r.read().decode("utf-8", "ignore"))
        except Exception as e:
            last_err = e
    raise last_err


def backup_existing(out):
    """覆盖前先备份，确保一次坏数据不会抹掉逐日累积的历史。
    保留一个最新 .bak，以及按日期滚动的近 7 份备份。"""
    if not os.path.exists(out):
        return
    try:
        shutil.copy2(out, out + ".bak")
        stamp = datetime.now().strftime("%Y%m%d")
        shutil.copy2(out, out + "." + stamp + ".bak")
        olds = sorted(
            f for f in os.listdir(os.path.dirname(out) or ".")
            if f.startswith(os.path.basename(out) + ".") and f.endswith(".bak")
            and f != os.path.basename(out + ".bak")
        )
        for f in olds[:-7]:
            try:
                os.remove(os.path.join(os.path.dirname(out) or ".", f))
            except OSError:
                pass
    except Exception:
        pass


def main():
    now = shanghai_now()
    today = now.strftime("%Y-%m-%d")
    wd = now.weekday()  # 0=Mon ... 6=Sun
    status = {"ok": False, "date": today, "error": None, "boards": 0}

    try:
        if wd >= 5:
            status["error"] = "weekend-skip"
            print(json.dumps(status, ensure_ascii=False))
            return

        data = fetch_clist()
        diff = (data.get("data") or {}).get("diff") or []
        if not diff:
            status["error"] = "empty"
            print(json.dumps(status, ensure_ascii=False))
            return

        entry = {}
        total_abs = 0.0
        for it in diff:
            code = str(it.get("f12") or "")
            name = str(it.get("f14") or "")
            net = float(it.get("f62") or 0)
            price = float(it.get("f2") or 0)     # 最新价(快照≈收盘)
            chg = float(it.get("f3") or 0)       # 涨跌幅(%)，fltt=2 已归一化
            if not code:
                continue
            # p=收盘价、c=当日涨跌幅(%)，供浏览器重建价格序列、计算 N 日趋势位置（与 .n 并存，向后兼容）
            entry[code] = {"n": round(net / 1e8, 2), "name": name,
                           "p": round(price, 3), "c": round(chg, 2)}
            total_abs += abs(net)

        # 合计主力净流入过小 -> 视为休市/未开盘，跳过以免写入 0 污染历史
        if total_abs < MIN_TOTAL_ABS:
            status["error"] = "no-trading-data-skip"
            print(json.dumps(status, ensure_ascii=False))
            return
        # 当日板块数过少 -> 接口返回残缺/空，保留旧历史，不覆盖
        if len(entry) < MIN_BOARDS:
            status["error"] = "too-few-boards"
            print(json.dumps(status, ensure_ascii=False))
            return

        hist = {
            "updatedAt": None,
            "source": "eastmoney clist m:90+t:2 f62 (主力净流入 main_net, 亿元)",
            "days": {},
        }
        if os.path.exists(OUT):
            try:
                with open(OUT, encoding="utf-8") as f:
                    hist = json.load(f)
                if not isinstance(hist.get("days"), dict):
                    hist["days"] = {}
            except Exception:
                pass

        hist["days"][today] = entry

        keys = sorted(hist["days"].keys())
        if len(keys) > KEEP_DAYS:
            for k in keys[:-KEEP_DAYS]:
                hist["days"].pop(k, None)

        hist["updatedAt"] = now.isoformat()
        backup_existing(OUT)   # 覆盖前先备份，防止一次坏数据抹掉累积历史
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(hist, f, ensure_ascii=False, indent=1)

        status["ok"] = True
        status["boards"] = len(entry)
        print(json.dumps(status, ensure_ascii=False))
    except Exception as e:  # noqa
        status["error"] = f"{type(e).__name__}:{str(e)[:160]}"
        print(json.dumps(status, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
