"""
Fixed-weight portfolio backtester in Canadian dollars.

Holds a set of ETFs at target weights, lets them drift, and resets them on
a schedule (yearly by default) with a trading cost on what changes. US-listed
funds are converted to CAD with the daily CADUSD rate, so a Canadian and a
US version of the same idea can be compared on equal terms.

Built-in portfolios: the "Higher growth" portfolio from kellyportfolios.com
(eight US-listed funds, as published on 6 Sep 2026) and Canadian versions of
it, plus XEQT as a plain all-equity benchmark. See PORTFOLIOS for the weights
and the reasons behind each substitute.

Setup:
  pip install yfinance pandas numpy

Run:
  python portfolio.py compare
  python portfolio.py compare --rebalance quarterly --start 2023-10-01
  python portfolio.py compare --portfolios us-factors canadian-factors xeqt
  python portfolio.py holdings --portfolio hybrid --capital 50000
"""

import argparse

import numpy as np
import pandas as pd

TRADING_DAYS = 252

# Each holding: (ticker, weight, yearly fee, account, what it is). A ticker
# without an exchange suffix is US-listed and priced in USD.
PORTFOLIOS = {
    "us": {
        "name": "Higher growth, US original",
        "holdings": [
            ("RSST", 0.35, 0.0099, "RRSP", "US stocks + managed futures, stacked ($1 of each per $1)"),
            ("AVLV", 0.10, 0.0015, "RRSP", "US large value, profitability screen"),
            ("AVUV", 0.05, 0.0025, "RRSP", "US small value, profitability screen"),
            ("SPMO", 0.10, 0.0013, "RRSP", "S&P 500 momentum (top 100)"),
            ("DFIV", 0.15, 0.0027, "RRSP", "International large value"),
            ("AVDV", 0.10, 0.0036, "RRSP", "International small value"),
            ("IDMO", 0.10, 0.0025, "RRSP", "International developed momentum"),
            ("AVES", 0.05, 0.0036, "RRSP", "Emerging markets value"),
        ],
    },
    "hybrid": {
        "name": "Higher growth, RSST in RRSP + Canadian-listed rest",
        "holdings": [
            ("RSST", 0.35, 0.0099, "RRSP", "No Canadian fund stacks trend on stocks; buy the US fund"),
            ("FCUV.TO", 0.10, 0.0035, "TFSA", "Fidelity U.S. Value (for AVLV; weekly corr 0.88)"),
            ("XSMC.TO", 0.05, 0.0021, "TFSA", "iShares S&P U.S. Small-Cap (for AVUV; no value tilt)"),
            ("XMTM.TO", 0.10, 0.0032, "TFSA", "iShares MSCI USA Momentum (for SPMO; corr 0.75)"),
            ("FCIV.TO", 0.15, 0.0045, "TFSA", "Fidelity International Value (for DFIV; corr 0.90)"),
            ("XEF.TO", 0.10, 0.0023, "TFSA", "iShares Core MSCI EAFE IMI (for AVDV; no value tilt)"),
            ("ZXM-B.TO", 0.10, 0.0064, "TFSA", "CI Intl Momentum, unhedged (for IDMO; thinly traded)"),
            ("ZEM.TO", 0.05, 0.0027, "TFSA", "BMO MSCI Emerging Markets (for AVES; no value tilt)"),
        ],
    },
    "canadian": {
        "name": "Higher growth, all Canadian-listed",
        "holdings": [
            ("XUS.TO", 0.35, 0.0009, "TFSA", "iShares Core S&P 500 (RSST's stock half only; no trend)"),
            ("FCUV.TO", 0.10, 0.0035, "TFSA", "Fidelity U.S. Value (for AVLV)"),
            ("XSMC.TO", 0.05, 0.0021, "TFSA", "iShares S&P U.S. Small-Cap (for AVUV)"),
            ("XMTM.TO", 0.10, 0.0032, "TFSA", "iShares MSCI USA Momentum (for SPMO)"),
            ("FCIV.TO", 0.15, 0.0045, "TFSA", "Fidelity International Value (for DFIV)"),
            ("XEF.TO", 0.10, 0.0023, "TFSA", "iShares Core MSCI EAFE IMI (for AVDV)"),
            ("ZXM-B.TO", 0.10, 0.0064, "TFSA", "CI Intl Momentum, unhedged (for IDMO)"),
            ("ZEM.TO", 0.05, 0.0027, "TFSA", "BMO MSCI Emerging Markets (for AVES)"),
        ],
    },
    # The 65% outside RSST, rescaled to 100%: these funds have prices from
    # Oct 2021, so the substitutes can be compared through the 2022 fall.
    "us-factors": {
        "name": "Value + momentum part, US funds",
        "holdings": [],
    },
    "canadian-factors": {
        "name": "Value + momentum part, Canadian substitutes",
        "holdings": [],
    },
    "xeqt": {
        "name": "XEQT, plain all-equity",
        "holdings": [("XEQT.TO", 1.00, 0.0020, "TFSA", "iShares Core Equity ETF Portfolio")],
    },
}

for _src, _dst in (("us", "us-factors"), ("canadian", "canadian-factors")):
    PORTFOLIOS[_dst]["holdings"] = [(t, w / 0.65, f, a, n)
                                    for t, w, f, a, n in PORTFOLIOS[_src]["holdings"][1:]]

FREQ = {"never": None, "yearly": "YE", "quarterly": "QE", "monthly": "ME"}


def is_usd(ticker):
    return "." not in ticker


def weights(key):
    return pd.Series({t: w for t, w, *_ in PORTFOLIOS[key]["holdings"]})


def fee(key):
    return sum(w * f for _, w, f, *_ in PORTFOLIOS[key]["holdings"])


# ---------------------------------------------------------------- data
def load_cad(tickers, start="2015-01-01"):
    """Adjusted daily closes in CAD; US-listed funds converted with CADUSD.
    Adjusted closes add back dividends in full, before any withholding tax."""
    import yfinance as yf
    tickers = sorted(set(tickers))
    need_fx = any(is_usd(t) for t in tickers)
    raw = yf.download(tickers + (["CADUSD=X"] if need_fx else []), start=start,
                      auto_adjust=True, progress=False)["Close"]
    if isinstance(raw, pd.Series):
        raw = raw.to_frame(tickers[0])
    fx = raw["CADUSD=X"].ffill() if need_fx else None
    out = {}
    for t in tickers:
        s = raw[t].dropna()
        if s.empty:
            raise SystemExit(f"No prices for {t!r}")
        out[t] = s / fx.reindex(s.index).ffill() if is_usd(t) else s
    # A thinly traded fund can go days without a trade; carry its last price
    # over short gaps so it doesn't cut every comparison short.
    return pd.DataFrame(out).sort_index().ffill(limit=5)


# ---------------------------------------------------------------- backtest
def backtest(prices, target, rebalance="yearly", cost=0.001):
    """Daily returns of holding `target` weights (Series, sums to 1) with
    drift, reset at the end of each `rebalance` period. `cost` is charged on
    the traded fraction at each reset and on the initial buy.
    Starts when every holding has a price. Returns (returns, turnover/yr)."""
    P = prices[target.index].dropna()
    R = P.pct_change().iloc[1:].to_numpy()
    w = target.to_numpy(dtype=float)
    ends = set()
    if FREQ[rebalance]:
        idx = P.index[1:]
        ends = set(pd.Series(idx, index=idx).groupby(idx.to_period(FREQ[rebalance][0])).max())
        ends.discard(idx[-1])                  # the last day is not a reset
    out = np.empty(len(R))
    traded = w.sum()                       # initial purchase
    first_cost = traded * cost
    for k, d in enumerate(P.index[1:]):
        g = w * (1 + R[k])
        out[k] = g.sum() - 1
        w = g / g.sum()
        if d in ends:
            t = np.abs(target.to_numpy() - w).sum()
            traded += t
            out[k] -= t * cost
            w = target.to_numpy(dtype=float)
    out[0] -= first_cost
    r = pd.Series(out, index=P.index[1:])
    return r, traded / (len(r) / TRADING_DAYS)


def stats(r):
    eq = (1 + r).cumprod()
    # calendar years: mixed TSX/NYSE calendars give more than 252 rows a year
    yrs = (r.index[-1] - r.index[0]).days / 365.25
    dd = eq / eq.cummax() - 1
    return {"CAGR": eq.iloc[-1] ** (1 / yrs) - 1,
            "Vol": r.std() * np.sqrt(TRADING_DAYS),
            "Sharpe": np.sqrt(TRADING_DAYS) * r.mean() / (r.std() + 1e-12),
            "MaxDD": dd.min(), "Growth of $1": eq.iloc[-1]}


def compare(keys, prices, rebalance="yearly", cost=0.001, start=None):
    """Backtest several portfolios over their common dates."""
    runs = {k: backtest(prices, weights(k), rebalance, cost)[0] for k in keys}
    first = max(r.index[0] for r in runs.values())
    if start:
        first = max(first, pd.Timestamp(start))
    runs = {k: r[r.index >= first] for k, r in runs.items()}
    table = pd.DataFrame({PORTFOLIOS[k]["name"]: {**stats(r), "Fee/yr": fee(k)}
                          for k, r in runs.items()}).T
    ref = runs[keys[0]]
    table["Corr to first"] = [r.corr(ref) for r in runs.values()]
    return table, runs


def holdings(key, capital):
    rows = [{"ticker": t, "weight": w, "amount": w * capital, "fee": f,
             "account": a, "note": n} for t, w, f, a, n in PORTFOLIOS[key]["holdings"]]
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    c = sub.add_parser("compare", help="backtest the built-in portfolios side by side")
    c.add_argument("--portfolios", nargs="+", default=["us", "hybrid", "canadian", "xeqt"],
                   choices=list(PORTFOLIOS))
    c.add_argument("--rebalance", choices=list(FREQ), default="yearly")
    c.add_argument("--cost-bps", type=float, default=10, help="per unit traded")
    c.add_argument("--start", help="first date to compare from (after all funds exist)")
    h = sub.add_parser("holdings", help="what to buy, where, for a given amount")
    h.add_argument("--portfolio", choices=list(PORTFOLIOS), default="hybrid")
    h.add_argument("--capital", type=float, default=10000)
    a = ap.parse_args()

    if a.mode == "compare":
        tickers = [t for k in a.portfolios for t in weights(k).index]
        prices = load_cad(tickers)
        table, runs = compare(a.portfolios, prices, a.rebalance, a.cost_bps / 1e4, a.start)
        first = next(iter(runs.values())).index
        print(f"In CAD, {first[0].date()} to {first[-1].date()}, rebalanced {a.rebalance}, "
              f"{a.cost_bps:g} bps per unit traded. Fees are already inside fund prices; "
              "the Fee/yr column is for reference.\n")
        print(table.round(3).to_string())
    else:
        t = holdings(a.portfolio, a.capital)
        print(f"{PORTFOLIOS[a.portfolio]['name']}: ${a.capital:,.0f}, "
              f"weighted fee {fee(a.portfolio):.2%} a year\n")
        view = t.assign(weight=t.weight.map("{:.0%}".format),
                        amount=t.amount.map("${:,.0f}".format),
                        fee=t.fee.map("{:.2%}".format))
        print(view.to_string(index=False))
        if any(is_usd(x) for x in t.ticker):
            print("\nUS-listed funds: hold in an RRSP (no 15% US withholding on their US "
                  "dividends there) and convert CAD with Norbert's gambit (DLR.TO -> DLR.U.TO).")


if __name__ == "__main__":
    main()
