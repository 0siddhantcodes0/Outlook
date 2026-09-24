"""
Leveraged ETF backtester.

Three ways to use a daily-reset leveraged fund, each tested on real prices
with realistic costs:

  hold    buy and hold, optionally only while the index is above its
          200-day average (cash earns T-bills otherwise)
  swing   trade every few days with a chosen entry and exit time of day
          (buy at the open or near the close, sell at the open or near the
          close), from daily open/close prices
  rotate  each month hold the top K "hot" sectors by recent momentum,
          at 1x, 2x or 3x, optionally with the 200-day rule

Leveraged funds are simulated from their index so tests can reach back
before the funds existed. The simulated fund returns L x the index each day,
minus (L-1) x the T-bill rate for the borrowed money, minus a yearly cost
fitted to the real BetaPro/Direxion funds (fee, swap spread, currency hedge).

Setup:
  pip install yfinance pandas numpy

Run:
  python leverage.py swing --ticker SOXL --entry open --exit close --hold 3
  python leverage.py swing --ticker SOXL --entry close --exit open --hold 3 --cost-bps 5
  python leverage.py hold --index SPY --leverage 2 --trend
  python leverage.py rotate --indexes SOXX QQQ XEG.TO XFN.TO GDX SPY --leverage 3 --top 2 --trend
"""

import argparse

import numpy as np
import pandas as pd

# Yearly cost beyond L x index minus (L-1) x T-bills, per unit of extra
# leverage, fitted on 2010-06 to 2026-09 daily prices of the real funds:
#   CNDU vs 2x XIU 2.58%, SPXU.TO vs 2x SPY 4.56%, QQU vs 2x QQQ 4.59%,
#   NRGU vs 2x XEG 1.59%, CFOU vs 2x XFN 1.72%, GDXU vs 2x XGD 1.00%,
#   SOXL (Direxion) vs 3x SOXX 4.05% (2.03% per unit)
COST_PER_UNIT = {"XIU.TO": 0.0258, "SPY": 0.0456, "QQQ": 0.0459, "XEG.TO": 0.0159,
                 "XFN.TO": 0.0172, "XGD.TO": 0.0100, "SOXX": 0.0203}
DEFAULT_COST = 0.0350     # used for indexes without a calibrated fund
TRADING_DAYS = 252


# ---------------------------------------------------------------- data
def load(ticker, start="1995-01-01", ohlc=False):
    """Adjusted daily closes (or Open/High/Low/Close frame) from Yahoo."""
    import yfinance as yf
    df = yf.download(ticker, start=start, auto_adjust=True, progress=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.dropna()
    if df.empty:
        raise SystemExit(f"No prices downloaded for {ticker!r}")
    if ohlc:
        return df[df["Volume"] > 0][["Open", "High", "Low", "Close"]]
    return df["Close"].astype(float)


def tbill(index, start="1995-01-01"):
    """Daily T-bill return from the 13-week yield (^IRX), aligned to index."""
    y = load("^IRX", start)
    return (y / 100 / TRADING_DAYS).reindex(index).ffill().fillna(0.0)


# ---------------------------------------------------------------- funds
def leveraged(index_returns, L, rf, cost_per_unit=DEFAULT_COST):
    """Daily returns of an L x daily-reset fund on an index (L >= 1).
    index_returns, rf: Series or DataFrame / Series aligned on dates."""
    if L == 1:
        return index_returns
    rf = rf.reindex(index_returns.index)
    if isinstance(index_returns, pd.DataFrame):
        fin = index_returns.mul(0).add(rf, axis=0)
    else:
        fin = rf
    return L * index_returns - (L - 1) * fin - (L - 1) * cost_per_unit / TRADING_DAYS


def trend_on(prices, window=200):
    """True when the price closed above its `window`-day average, shifted one
    day so each day only uses the previous close."""
    return (prices > prices.rolling(window).mean()).shift(1, fill_value=False)


# ---------------------------------------------------------------- hold
def hold(index_prices, L, rf, cost_per_unit=DEFAULT_COST, trend=False,
         switch_cost=0.001):
    """Hold an L x fund; with trend=True only while the index is above its
    200-day average, earning T-bills otherwise."""
    r = leveraged(index_prices.pct_change().dropna(), L, rf, cost_per_unit)
    if not trend:
        return r
    on = trend_on(index_prices).reindex(r.index).astype(float)
    switches = on.diff().abs().fillna(on.iloc[0])
    return on * r + (1 - on) * rf.reindex(r.index) - switches * switch_cost


# ---------------------------------------------------------------- swing
def swing_schedule(n, entry, exit, hold_days, allowed):
    """Which overnight and daytime stretches a repeating swing trade holds.
    night[k]: held from close k-1 to open k; day[k]: held open k to close k;
    trades[k]: buys + sells on day k. allowed[k]: may enter on day k.
      entry=open:  buy at day i's open, sell at day i+hold-1's exit
      entry=close: buy near day i's close, sell at day i+hold's exit"""
    night = np.zeros(n, bool); day = np.zeros(n, bool); trades = np.zeros(n)
    i = 1
    while i < n - 1:
        if not allowed[i]:
            i += 1
            continue
        if entry == "open":
            j = min(i + hold_days - 1, n - 1)
            day[i:j + 1] = True
            night[i + 1:j + 1] = True
            if exit == "open":                     # sell at the open of day j+1
                j = min(j + 1, n - 1)
                night[j] = True
                day[j] = False if j > i else day[j]
            trades[i] += 1; trades[j] += 1
            i = j + 1
        else:
            j = min(i + hold_days, n - 1)
            night[i + 1:j + 1] = True
            day[i + 1:j + (1 if exit == "close" else 0)] = True
            trades[i] += 1; trades[j] += 1
            i = j if exit == "open" else j + 1     # sold at the open: re-buy that afternoon
    return night, day, trades


def swing(ohlc, entry="open", exit="close", hold_days=3, cost=0.0005, trend=None):
    """Daily returns of repeating swing trades on real open/close prices.
    'close' stands in for selling or buying late in the day (3-4 PM).
    cost: per side (half the bid-ask spread plus commission, as a fraction).
    trend: optional boolean Series; entries only on days it is True
    (use trend_on(index) so it only uses the previous close).
    Returns (daily returns, round trips per year)."""
    O, C = ohlc["Open"].to_numpy(), ohlc["Close"].to_numpy()
    n = len(ohlc)
    gap = np.r_[0.0, O[1:] / C[:-1] - 1]
    daytime = C / O - 1
    allowed = np.ones(n, bool) if trend is None else \
        trend.reindex(ohlc.index).fillna(False).to_numpy(bool)
    night, day, trades = swing_schedule(n, entry, exit, hold_days, allowed)
    r = (1 + gap * night) * (1 + daytime * day) * (1 - cost) ** trades - 1
    return pd.Series(r, index=ohlc.index), trades.sum() / 2 / (n / TRADING_DAYS)


def overnight_daytime(ohlc):
    """Split close-to-close returns into overnight (close -> next open) and
    daytime (open -> close) parts, each annualised."""
    g = ohlc["Open"] / ohlc["Close"].shift(1) - 1
    d = ohlc["Close"] / ohlc["Open"] - 1
    ann = lambda r: (1 + r.dropna()).prod() ** (TRADING_DAYS / r.dropna().size) - 1
    return {"overnight": ann(g), "daytime": ann(d),
            "close_to_close": ann(ohlc["Close"].pct_change())}


# ---------------------------------------------------------------- rotate
def rotate(index_prices, L, rf, top=2, lookback=63, every=21, trend=False,
           switch_cost=0.001, cost_per_unit=None):
    """Every `every` days hold the `top` indexes with the highest return over
    the past `lookback` days, each as an L x fund, equal weight. With
    trend=True a pick below its 200-day average is held as T-bills instead.
    Picks use only the previous close. Returns (daily returns, turnover/yr)."""
    P = index_prices.dropna()
    cpu = {c: (cost_per_unit or {}).get(c, COST_PER_UNIT.get(c, DEFAULT_COST))
           for c in P.columns}
    ret = P.pct_change().fillna(0.0)
    lr = pd.concat({c: leveraged(ret[c], L, rf, cpu[c]) for c in P.columns}, axis=1)
    mom = (P / P.shift(lookback) - 1).shift(1)
    above = trend_on(P)
    w = np.zeros(P.shape)
    cur = np.zeros(P.shape[1])
    first = max(lookback, 200 if trend else 0) + 1     # all inputs known from here
    for k in range(len(P)):
        if k >= first and (k - first) % every == 0:
            cur = np.zeros(P.shape[1])
            for c in mom.iloc[k].nlargest(top).index:
                j = P.columns.get_loc(c)
                if not trend or above.iloc[k, j]:
                    cur[j] = 1.0 / top
        w[k] = cur
    w = pd.DataFrame(w, index=P.index, columns=P.columns)
    turn = w.diff().abs().sum(axis=1).fillna(w.iloc[0].sum())
    r = (w * lr).sum(axis=1) + (1 - w.sum(axis=1)) * rf.reindex(P.index) - turn * switch_cost
    start = P.index[min(len(P) - 1, first)]
    r, turn = r[r.index >= start], turn[turn.index >= start]
    return r, turn.sum() / (len(r) / TRADING_DAYS)


def rotate_all_days(index_prices, L, rf, every=21, **kw):
    """Run rotate() once for every possible rebalance day of the cycle.
    One run can look great or awful purely because of which day of the
    month it trades (3x top-2 sectors, 2007-2026: -1% to +23% a year), so
    judge a rotation by the spread of these runs, not by one of them.
    Returns a DataFrame of stats, one row per offset, over common dates."""
    runs = [rotate(index_prices.iloc[k:], L, rf, every=every, **kw)[0] for k in range(every)]
    start = max(r.index[0] for r in runs)
    return pd.DataFrame([stats(r[r.index >= start]) for r in runs])


# ---------------------------------------------------------------- report
def stats(r):
    eq = (1 + r).cumprod()
    yrs = len(r) / TRADING_DAYS
    yearly = (1 + r).groupby(r.index.year).prod() - 1
    return {"CAGR": eq.iloc[-1] ** (1 / yrs) - 1,
            "Sharpe": np.sqrt(TRADING_DAYS) * r.mean() / (r.std() + 1e-12),
            "MaxDD": (eq / eq.cummax() - 1).min(),
            "WorstYear": yearly.min(), "BestYear": yearly.max(),
            "Growth of $1": eq.iloc[-1]}


def show(rows):
    print(pd.DataFrame({k: stats(v) for k, v in rows.items()}).T.round(3).to_string())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="mode", required=True)

    h = sub.add_parser("hold", help="buy and hold an L x fund, optional 200-day rule")
    h.add_argument("--index", default="SPY")
    h.add_argument("--leverage", type=int, default=2)
    h.add_argument("--trend", action="store_true")
    h.add_argument("--start", default="1995-01-01")

    s = sub.add_parser("swing", help="swing trade a real fund with entry/exit times")
    s.add_argument("--ticker", default="SOXL")
    s.add_argument("--entry", choices=["open", "close"], default="open")
    s.add_argument("--exit", choices=["open", "close"], default="close")
    s.add_argument("--hold", type=int, default=3, help="days per trade")
    s.add_argument("--cost-bps", type=float, default=5, help="per side")
    s.add_argument("--trend-index", help="only enter when this index is above its 200-day average")
    s.add_argument("--start", default="2010-01-01")

    r = sub.add_parser("rotate", help="hold the top K hot sectors at L x")
    r.add_argument("--indexes", nargs="+", default=["SOXX", "QQQ", "XEG.TO", "XFN.TO", "GDX", "SPY"])
    r.add_argument("--leverage", type=int, default=3)
    r.add_argument("--top", type=int, default=2)
    r.add_argument("--lookback", type=int, default=63)
    r.add_argument("--every", type=int, default=21)
    r.add_argument("--trend", action="store_true")
    r.add_argument("--start", default="2005-01-01")
    a = ap.parse_args()

    if a.mode == "hold":
        warm = str(pd.Timestamp(a.start) - pd.DateOffset(years=2))[:10]
        p = load(a.index, warm)                  # history before --start for the 200-day average
        rf = tbill(p.index, warm)
        cpu = COST_PER_UNIT.get(a.index, DEFAULT_COST)
        rows = {f"{a.index} 1x": p.pct_change().dropna(),
                f"{a.leverage}x hold": hold(p, a.leverage, rf, cpu)}
        if a.trend:
            rows[f"{a.leverage}x + 200-day rule"] = hold(p, a.leverage, rf, cpu, trend=True)
        show({k: v[v.index >= a.start] for k, v in rows.items()})

    elif a.mode == "swing":
        d = load(a.ticker, a.start, ohlc=True)
        split = overnight_daytime(d)
        print(f"{a.ticker} {d.index[0].date()} to {d.index[-1].date()}: overnight "
              f"{split['overnight']:.1%}/yr, daytime {split['daytime']:.1%}/yr")
        tr = trend_on(load(a.trend_index, a.start)) if a.trend_index else None
        sw, rt = swing(d, a.entry, a.exit, a.hold, a.cost_bps / 1e4, tr)
        print(f"Round trips per year: {rt:.0f}")
        show({"Buy & hold": d["Close"].pct_change().fillna(0.0),
              f"Swing: buy {a.entry}, sell {a.exit}, {a.hold} days": sw})

    else:
        P = pd.concat({t: load(t, a.start) for t in a.indexes}, axis=1).dropna()
        rf = tbill(P.index, a.start)
        rot, turn = rotate(P, a.leverage, rf, a.top, a.lookback, a.every, a.trend)
        print(f"{P.index[0].date()} to {P.index[-1].date()}, turnover {turn:.1f}x per year")
        ref = "SPY" if "SPY" in P else P.columns[0]
        show({f"Rotation {a.leverage}x top {a.top}": rot,
              f"{ref} 1x": P[ref].pct_change().reindex(rot.index)})
        spread = rotate_all_days(P, a.leverage, rf, every=a.every, top=a.top,
                                 lookback=a.lookback, trend=a.trend)
        print(f"\nSame rule on each of the {a.every} possible rebalance days:")
        print(spread[["CAGR", "MaxDD"]].describe().loc[["min", "50%", "max"]]
              .rename(index={"50%": "median"}).round(3).to_string())


if __name__ == "__main__":
    main()
