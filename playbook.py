"""
Leveraged ETF playbook for a Canadian account (TSX-listed BetaPro funds, in CAD).

Two engines that make money at different times:

  Ladder   Hold the 3x, 2x or 1x version of a market, or cash. Cash whenever the
           index closes below its 200-day average; above it, the calmer the
           market the more leverage: tier = floor(25% / 20-day volatility),
           between 1x and the highest version available. Re-checked weekly
           (Fridays); a break below the 200-day average acts the same day.
  Dip      Brandon's RSI 6-10 rules on the 3x Nasdaq fund: five equal sleeves,
           each buys at the close when its RSI (6, 7, 8, 9 or 10 days) is at or
           below 28 and sells at the close once it is back above 28.

Presets (share of the account in each engine), tested Aug 2002 - Oct 2026 with
simulated funds whose costs are fitted to the real BetaPro funds:
  aggressive   50% Nasdaq ladder, 50% Nasdaq dip       17.3%/yr, worst drop -20%
  diversified  40% Nasdaq ladder, 30% Nasdaq dip,
               15% semis ladder, 15% energy ladder     15.7%/yr, worst drop -16%
Holding a 1x Nasdaq fund over the same years: 15.8%/yr, worst drop -54%.

The dip engine only works when you buy at (or within minutes of) the close of
the day the signal appears: buying a day late cut its return from 27% to about
6% a year. Run the report in the last half hour of trading.

Each report ends with a price board of the funds in WATCH. The bear and
commodity funds there are watch-only: on their real prices they lost money,
both held and as the "downtrend" side of a bull/bear switch (see WATCH_ONLY).

Commands:
  python playbook.py report                         # what to hold now
  python playbook.py report --holdings my.csv       # plus P/L and trades to make
  python playbook.py report --telegram              # also send it to Telegram
  python playbook.py backtest --preset aggressive

Holdings file (keep it out of git; holdings*.csv is ignored): ticker,shares,avg_cost
Telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (see README).
"""

import argparse
import csv
import io
import json
import os
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

TRADING_DAYS = 252
TARGET_VOL, VOL_WINDOW, MA = 0.25, 20, 200
DIP_THRESHOLD, DIP_LENGTHS = 28.0, (6, 7, 8, 9, 10)
ONE_X_FEE = 0.003

# signal: index the rules read. cost: yearly cost per extra unit of leverage,
# fitted on the real 2x BetaPro funds 2010-2026 (SOXL: Direxion). tiers: what to hold.
MARKETS = {
    "nasdaq": {"name": "Nasdaq-100", "signal": "QQQ", "cost": 0.0447,
               "tiers": {3: "TQQQ.TO", 2: "QQU.TO", 1: "XQQ.TO", 0: "CASH.TO"}},
    "sp500": {"name": "S&P 500", "signal": "SPY", "cost": 0.0456,
              "tiers": {3: "TSPX.TO", 2: "SPXU.TO", 1: "XSP.TO", 0: "CASH.TO"}},
    "semis": {"name": "Semiconductors", "signal": "SOXX", "cost": 0.0203,
              "tiers": {3: "SOXL (BetaPro, TSX)", 2: "half SOXL + half XCHP.TO",
                        1: "XCHP.TO", 0: "CASH.TO"}},
    "energy": {"name": "TSX energy", "signal": "XEG.TO", "cost": 0.0159,
               "tiers": {2: "NRGU.TO", 1: "XEG.TO", 0: "CASH.TO"}},
}
DIP = {"name": "Nasdaq dip (RSI 6-10)", "signal": "TQQQ", "fund": "TQQQ.TO", "cash": "CASH.TO"}

PRESETS = {
    "aggressive": {"nasdaq": 0.50, "dip": 0.50},
    "diversified": {"nasdaq": 0.40, "dip": 0.30, "semis": 0.15, "energy": 0.15},
}

# Price board in every report: the funds to watch, by group. Yahoo has no
# prices for the TSX-listed SOXL/SOXS, so the board shows the US ones (USD).
WATCH = [
    ("Nasdaq", ["QQQ", "XQQ.TO", "TQQQ.TO"]),
    ("Semis", ["SOXX", "XCHP.TO", "SOXL", "SOXS"]),
    ("Energy", ["XEG.TO", "NRGU.TO"]),
    ("Oil & gas", ["CL=F", "HOU.TO", "NG=F", "HNU.TO"]),
    ("Volatility", ["^VIX", "VOLX.TO"]),
]
# Watched but never in the plan. Tested on the real funds' prices 2008-2026:
# held, they lost 36% (HOU), 62% (HNU), 48% (VOLX) and 71% (SOXS) a year;
# switching from SOXL to SOXS below the 200-day average turned +25.6%/yr
# into -20.8%/yr (2022 included), and TQQQ to SQQQ turned 32.2% into 5.0%.
WATCH_ONLY = {"SOXS", "HOU.TO", "NG=F", "HNU.TO", "CL=F", "^VIX", "VOLX.TO"}


# ---------------------------------------------------------------- data
def load(tickers, start="1999-01-01"):
    """Daily adjusted closes from Yahoo. During market hours the last row is
    today's bar at the latest price, which is what the 3:45 PM check needs."""
    import yfinance as yf
    tickers = sorted(set(tickers))

    def get(names, **kw):
        out = yf.download(names, start=start, auto_adjust=True, progress=False, **kw)["Close"]
        return out.to_frame(names[0]) if isinstance(out, pd.Series) else out

    raw = get(tickers)
    # A parallel download can drop a ticker (yfinance's cache answers
    # "database is locked" on a fresh machine); fetch those again one by one.
    missing = [t for t in tickers if t not in raw or raw[t].isna().all()]
    if missing:
        again = get(missing, threads=False)
        raw = pd.concat([raw.drop(columns=[t for t in missing if t in raw]), again], axis=1)
    return raw.sort_index()


# ---------------------------------------------------------------- rules
def max_tier(key):
    return max(t for t in MARKETS[key]["tiers"] if t > 0)


def desired_tier(prices, cap=3, target=TARGET_VOL, window=VOL_WINDOW, ma=MA):
    """Tier each day would ask for: 0 below the moving average, else
    floor(target / realised vol) clipped to [1, cap]. NaN until known."""
    vol = prices.pct_change().rolling(window).std() * np.sqrt(TRADING_DAYS)
    avg = prices.rolling(ma).mean()
    tier = np.where(prices > avg, np.clip(np.floor(target / vol), 1, cap), 0.0)
    return pd.Series(tier, index=prices.index).where(vol.notna() & avg.notna())


def ladder_tiers(prices, cap=3, recheck="weekly", **kw):
    """Tier actually held after each close: follows desired_tier on recheck
    days (Fridays, or every day), and drops to cash the same day the index
    closes below its average."""
    want = desired_tier(prices, cap, **kw)
    friday = prices.index.dayofweek == 4
    held, cur = [], np.nan
    for k, w in enumerate(want.to_numpy()):
        if not np.isnan(w) and (np.isnan(cur) or recheck == "daily" or friday[k] or w == 0):
            cur = w
        held.append(cur)
    return pd.Series(held, index=prices.index)


def rsi(close, n):
    """RSI with Wilder smoothing, as TradingView's ta.rsi."""
    ch = close.diff()
    up = ch.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-ch.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


def dip_signals(close, threshold=DIP_THRESHOLD, lengths=DIP_LENGTHS):
    """1 where a sleeve wants to hold the 3x fund after that close, per RSI length."""
    return pd.DataFrame({n: (rsi(close, n) <= threshold).astype(float) for n in lengths})


# ---------------------------------------------------------------- backtest
def fund_returns(index_returns, rf, cost):
    """Daily returns of cash and the 1x, 2x, 3x versions of an index."""
    return {0: rf, 1: index_returns - ONE_X_FEE / TRADING_DAYS,
            2: 2 * index_returns - rf - cost / TRADING_DAYS,
            3: 3 * index_returns - 2 * rf - 2 * cost / TRADING_DAYS}


def ladder_returns(prices, rf, cost, cap=3, switch_cost=0.001, recheck="weekly"):
    tiers = ladder_tiers(prices, cap, recheck)
    F = fund_returns(prices.pct_change(), rf.reindex(prices.index).ffill().fillna(0), cost)
    held = tiers.shift(1)
    r = sum((held == L) * F[L].fillna(0) for L in F)
    r = r - tiers.diff().abs().fillna(0).shift(1).fillna(0) * switch_cost
    return r[held.notna()]


def dip_returns(f3, rf, threshold=DIP_THRESHOLD, cost=0.001):
    """Five sleeves trading the 3x fund at the signal close, each compounding
    on its own; idle money earns rf (a cash ETF)."""
    rf = rf.reindex(f3.index).ffill().fillna(0)
    sig = dip_signals((1 + f3).cumprod(), threshold)
    books = []
    for n in sig:
        held = sig[n].shift(1).fillna(0)
        r = held * f3 + (1 - held) * rf - sig[n].diff().abs().fillna(0) * cost
        books.append((1 + r).cumprod())
    return pd.concat(books, axis=1).mean(axis=1).pct_change().fillna(0)


def blend(parts, weights):
    """Monthly rebalanced mix of daily return series. Markets keep different
    holidays, so a day one market is shut counts as 0% for it rather than
    dropping the day (and everyone else's return) from the mix."""
    df = pd.DataFrame(parts)[list(weights)]
    df = df[df.index >= max(df[c].first_valid_index() for c in df)].fillna(0)
    w = pd.Series(weights, dtype=float)
    vals, out, month = w.copy(), [], df.index[0].month
    for d, row in df.iterrows():
        if d.month != month:
            vals, month = w * vals.sum(), d.month
        prev = vals.sum()
        vals = vals * (1 + row)
        out.append(vals.sum() / prev - 1)
    return pd.Series(out, index=df.index)


def stats(r):
    eq = (1 + r).cumprod()
    yrs = (r.index[-1] - r.index[0]).days / 365.25
    yearly = (1 + r).groupby(r.index.year).prod() - 1
    return {"CAGR": eq.iloc[-1] ** (1 / yrs) - 1, "MaxDD": (eq / eq.cummax() - 1).min(),
            "WorstYear": yearly.min(), "LosingYears": int((yearly < 0).sum()),
            "Years": len(yearly), "Growth of $1": eq.iloc[-1]}


def backtest(preset, start="2002-08-01", extra_cost=0.0, trade_cost=0.001):
    weights = PRESETS[preset]
    need = {MARKETS[k]["signal"] for k in weights if k != "dip"} | {"QQQ", "^IRX"}
    P = load(sorted(need), "1999-01-01")
    rf = P["^IRX"].ffill() / 100 / TRADING_DAYS
    parts = {}
    for k in weights:
        if k == "dip":   # simulated 3x Nasdaq, so the test reaches back before TQQQ existed
            q = P["QQQ"].dropna()
            f3 = fund_returns(q.pct_change(), rf.reindex(q.index).ffill().fillna(0),
                              MARKETS["nasdaq"]["cost"] + extra_cost)[3].dropna()
            parts[k] = dip_returns(f3, rf, cost=trade_cost)
        else:
            m = MARKETS[k]
            parts[k] = ladder_returns(P[m["signal"]].dropna(), rf, m["cost"] + extra_cost,
                                      cap=max_tier(k), switch_cost=trade_cost)
    q = P["QQQ"].dropna().pct_change() - ONE_X_FEE / TRADING_DAYS
    port = blend(parts, weights)
    port = port[port.index >= start]
    return port, q[q.index >= start].dropna()


# ---------------------------------------------------------------- report
def read_holdings(path=None):
    """ticker,shares,avg_cost from a file, or from the HOLDINGS_CSV variable."""
    text = open(path).read() if path else os.environ.get("HOLDINGS_CSV", "")
    if not text.strip():
        return pd.DataFrame(columns=["ticker", "shares", "avg_cost"])
    df = pd.DataFrame(list(csv.DictReader(io.StringIO(text))))
    df["ticker"] = df["ticker"].str.strip().str.upper()
    return df.astype({"shares": float, "avg_cost": float})


def plan_today(P, weights):
    """Rows of (engine, weight, holding, reason) from the latest closes."""
    rows = []
    for k, w in weights.items():
        if k == "dip":
            c = P[DIP["signal"]].dropna()
            sig = dip_signals(c).iloc[-1]
            vals = {n: rsi(c, n).iloc[-1] for n in DIP_LENGTHS}
            on = int(sig.sum())
            near = [n for n, v in vals.items() if abs(v - DIP_THRESHOLD) < 2]
            reason = "RSI " + ", ".join(f"{n}:{v:.0f}" for n, v in vals.items())
            if near:
                reason += f" (RSI {', '.join(map(str, near))} within 2 of 28: recheck at the close)"
            rows.append({"engine": DIP["name"], "key": k, "weight": w, "hold": {
                DIP["fund"]: w * on / 5, DIP["cash"]: w * (5 - on) / 5},
                "summary": f"{on}/5 sleeves in", "reason": reason})
        else:
            m = MARKETS[k]
            p = P[m["signal"]].dropna()
            want = desired_tier(p, max_tier(k)).iloc[-1]
            held = ladder_tiers(p, max_tier(k)).iloc[-1]
            avg = p.rolling(MA).mean().iloc[-1]
            vol = p.pct_change().rolling(VOL_WINDOW).std().iloc[-1] * np.sqrt(TRADING_DAYS)
            label = m["tiers"][int(held)]
            reason = (f"{m['signal']} {p.iloc[-1] / avg - 1:+.1%} vs 200-day, "
                      f"20-day vol {vol:.0%}")
            if want != held:
                reason += f"; asks for {int(want)}x at Friday's re-check"
            hold = {}
            if "half" in label:
                hold = {m["tiers"][3]: w / 2, m["tiers"][1]: w / 2}
            else:
                hold = {label: w}
            rows.append({"engine": f"{m['name']} ladder", "key": k, "weight": w, "hold": hold,
                         "summary": f"{int(held)}x" if held else "cash", "reason": reason})
    return rows


def target_holdings(rows):
    out = {}
    for r in rows:
        for t, w in r["hold"].items():
            out[t] = out.get(t, 0) + w
    return out


def trades(holdings, prices, targets, cash=0.0):
    """Shares to buy (+) or sell (-) to move holdings to target weights.
    Funds without a price (e.g. BetaPro SOXL) are listed with amounts only."""
    h = holdings.set_index("ticker") if len(holdings) else pd.DataFrame(columns=["shares", "avg_cost"])
    value = {t: h.loc[t, "shares"] * prices.get(t, np.nan) for t in h.index}
    total = np.nansum(list(value.values())) + cash
    out = []
    for t in sorted(set(targets) | set(h.index)):
        want = targets.get(t, 0) * total
        have = value.get(t, 0.0)
        px = prices.get(t, np.nan)
        diff = want - (0 if np.isnan(have) else have)
        if abs(diff) < max(25, 0.005 * total):
            continue
        out.append({"ticker": t, "action": "BUY" if diff > 0 else "SELL", "amount": abs(diff),
                    "shares": np.floor(abs(diff) / px) if px and not np.isnan(px) else None})
    return out, total


def phase(now):
    """Which update this is, from the Toronto time."""
    if now.dayofweek >= 5 or now.hour < 9 or now.hour >= 16:
        return "MARKET CLOSED"
    return "MARKET OPEN update" if now.hour < 12 else "CLOSE update"


def watch_lines(P, targets=None):
    """One line per watched fund: price, change on its last trading day and
    over 5 trading days, above/below its 200-day average, and its weight in
    today's plan. P holds raw (not forward-filled) closes."""
    targets = targets or {}
    series = {t: P[t].dropna() for g in WATCH for t in g[1] if t in P and P[t].notna().sum() > 5}
    if not series:
        return []
    # newest trading day on either stock market (futures also trade on Sundays)
    latest = max(s.index[-1] for t, s in series.items() if not t.endswith("=F"))
    lines = ["PRICE BOARD: price, today, 5 days, vs 200-day avg (\u25b2 above / \u25bc below)"]
    for group, tickers in WATCH:
        lines.append(f" {group}")
        for t in tickers:
            if t not in series:
                lines.append(f"   {t:<8} no price")
                continue
            s = series[t]
            up = s.iloc[-1] > s.iloc[-200:].mean() if len(s) >= 200 else None
            note = "" if s.index[-1] >= latest else f" (last trade {s.index[-1]:%a})"
            w = sum(v for k, v in targets.items() if k.split(" ")[0] == t)
            tag = f" \u2605{w:.0%}" if w > 0 else (" watch" if t in WATCH_ONLY else "")
            usd = "" if t.endswith(".TO") or t.startswith("^") else " US$"
            arrow = "" if up is None else (" \u25b2" if up else " \u25bc")
            lines.append(f"   {t:<8}{s.iloc[-1]:>8.2f}{usd} {s.iloc[-1] / s.iloc[-2] - 1:+.1%}"
                         f"  5d {s.iloc[-1] / s.iloc[-6] - 1:+.1%}{arrow}{tag}{note}")
    lines.append(" \u2605 = in today's plan. 'watch' funds are not signals: tested 2008-26 they lost "
                 "money held, and swapping into SOXS/SQQQ in downtrends did worse than cash.")
    return lines


def render(rows, P, preset, holdings=None, cash=0.0, capital=None, board=None):
    now = pd.Timestamp.now(tz="America/Toronto")
    last = P.dropna(how="all").index[-1].date()
    lines = [f"{phase(now)} - LEVERAGE PLAYBOOK ({preset})",
             f"{now:%a %d %b %Y %H:%M} ET, prices to {last}", ""]
    if phase(now) == "MARKET OPEN update":
        lines += ["Morning numbers are provisional: the plan acts on prices near 4:00 PM.", ""]
    for r in rows:
        held = ", ".join(f"{t} {w:.0%}" for t, w in r["hold"].items() if w > 0)
        lines.append(f"{r['engine']} [{r['weight']:.0%}]: {r['summary']} -> {held}")
        lines.append(f"   {r['reason']}")
    targets = target_holdings(rows)
    prices = {t: P[t].dropna().iloc[-1] for t in P.columns if P[t].notna().any()}
    if holdings is not None and len(holdings):
        lines += ["", "YOUR HOLDINGS"]
        tot_cost = tot_val = 0.0
        for _, h in holdings.iterrows():
            px = prices.get(h.ticker, np.nan)
            val, cost = h.shares * px, h.shares * h.avg_cost
            tot_cost += cost
            tot_val += 0 if np.isnan(val) else val
            pl = (val / cost - 1) if cost and not np.isnan(val) else np.nan
            lines.append(f"   {h.ticker:9s} {h.shares:>8.0f} @ {h.avg_cost:7.2f} -> {px:7.2f}"
                         f"  ${val:>10,.0f}  {pl:+.1%}" if not np.isnan(px) else
                         f"   {h.ticker:9s} {h.shares:>8.0f} (no price)")
        if tot_cost:
            lines.append(f"   Total ${tot_val + cash:,.0f} (cash ${cash:,.0f}), "
                         f"P/L on positions {tot_val / tot_cost - 1:+.1%}")
    if (holdings is not None and len(holdings)) or capital:
        h = holdings if holdings is not None else pd.DataFrame(columns=["ticker", "shares", "avg_cost"])
        todo, total = trades(h, prices, targets, cash if len(h) else (capital or 0))
        lines += ["", f"TRADES to match the plan (account ${total:,.0f})"]
        if not todo:
            lines.append("   none: already on target")
        for t in todo:
            sh = f"{t['shares']:.0f} shares" if t["shares"] is not None else "check price"
            lines.append(f"   {t['action']:4s} {t['ticker']:9s} ${t['amount']:>9,.0f}  (~{sh})")
    if board is not None:
        lines += [""] + watch_lines(board, targets)
    lines += ["", "Dip trades: buy/sell in the last 10 minutes before 4:00 PM ET. "
              "Ladder changes: Fridays, or any day the index closes below its 200-day."]
    return "\n".join(lines)


def telegram_send(text, token=None, chat_id=None):
    token = token or os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to send to Telegram.")
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=20) as r:
        return json.load(r).get("ok", False)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    r = sub.add_parser("report", help="what to hold now, with optional P/L, trades and Telegram")
    r.add_argument("--preset", choices=list(PRESETS), default="aggressive")
    r.add_argument("--holdings", help="CSV: ticker,shares,avg_cost (or set HOLDINGS_CSV)")
    r.add_argument("--cash", type=float, default=0.0, help="uninvested cash in the account")
    r.add_argument("--capital", type=float, help="no holdings yet: plan trades for this amount")
    r.add_argument("--telegram", action="store_true")
    r.add_argument("--near-close-only", action="store_true",
                   help="do nothing unless it is 3:00-3:59 PM in Toronto on a weekday "
                        "(lets a scheduler run at fixed UTC times across daylight saving)")
    b = sub.add_parser("backtest", help="test a preset with simulated funds")
    b.add_argument("--preset", choices=list(PRESETS), default="aggressive")
    b.add_argument("--start", default="2002-08-01")
    b.add_argument("--extra-cost", type=float, default=0.0,
                   help="added yearly cost per unit of leverage, e.g. 0.02 for today's CAD hedge")
    a = ap.parse_args()

    if a.mode == "report":
        now = pd.Timestamp.now(tz="America/Toronto")
        if a.near_close_only and not (now.dayofweek < 5 and now.hour == 15):
            print(f"{now:%a %H:%M} in Toronto: outside the 3 PM hour, nothing sent.")
            return
        weights = PRESETS[a.preset]
        rows_needed = {MARKETS[k]["signal"] for k in weights if k != "dip"} | {DIP["signal"]}
        holdings = read_holdings(a.holdings)
        tradeable = {t for k in weights if k != "dip" for t in MARKETS[k]["tiers"].values()}
        tradeable |= {DIP["fund"], DIP["cash"]} | set(holdings["ticker"])
        tradeable = {t for t in tradeable if t.endswith(".TO") and " " not in t}
        start = str(pd.Timestamp.today() - pd.DateOffset(years=2))[:10]
        plan_cols = sorted(rows_needed | tradeable)
        raw = load(plan_cols + [t for g in WATCH for t in g[1]], start)
        # futures trade on Sundays; keep those rows out of the plan's daily data
        P = raw[[c for c in plan_cols if c in raw]].dropna(how="all").ffill(limit=5)
        text = render(plan_today(P, weights), P, a.preset, holdings, a.cash, a.capital, board=raw)
        print(text)
        if a.telegram:
            print("\nTelegram:", "sent" if telegram_send(text) else "failed")
    else:
        port, ndx = backtest(a.preset, a.start, a.extra_cost)
        table = pd.DataFrame({f"Playbook ({a.preset})": stats(port), "Nasdaq 1x hold": stats(ndx)}).T
        print(f"{port.index[0].date()} to {port.index[-1].date()}, simulated funds, 0.1% per trade\n")
        print(table.round(3).to_string())


if __name__ == "__main__":
    main()
