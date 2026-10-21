"""
Strategy lab: rebuild leveraged-ETF strategies and test them on years they were not tuned on.

Builds daily total returns for about 40 US funds back to 1995: the real fund where it exists,
before that a simulation from its index (L x index + (1 - L) x T-bill - a yearly cost fitted on
the overlap; every simulation tracks its real fund at 0.99+ daily correlation). Then runs:

  ea2027       Excellent Adventure 2027 (Composer symphony hEV9lo3WGgAjCCE3D603)
  qld          QLD For The Long Term V1.1 (k2fx2fSEydTaAzW4YkiY), the code playbook.py runs
  ftlt         TQQQ For The Long Term, as written up on azqato.com
  holy-grail   The Holy Grail, as written up on azqato.com
  9sig, hfea   quarterly plans (TQQQ/AGG value averaging; 55% UPRO / 45% TMF)
  current      playbook.py's "diversified" preset on US equivalents
  design-f     50% qld + 50% playbook.py's RSI dip engine

Every strategy trades at the close its signal uses, paying 5 bps per side, and is run again
trading one day late. "Tuned" is Apr 2012 to now, the years these rules were fitted on;
"unseen" is 2000 to Apr 2012, which includes the dot-com crash and 2008.

VXX before 2018 is modelled from the VIX index (daily corr 0.89), so ea2027's figures differ a
little from runs that use an archived VXX series for 2012-2018.

Setup:  pip install yfinance pandas numpy
Run:    python lab.py compare
        python lab.py jitter --strategy design-f
"""

import argparse
import warnings

import numpy as np
import pandas as pd

import playbook as pb

REAL = ("SMH QQQ SPY TQQQ TECL QQQE VOOG VOOV VTV FAS XLP XLY IEF PSQ SOXL SPXL VXX SH QLD QID SSO "
        "TLT SHY BSV UVXY UPRO SQQQ TMF AGG BIL SOXX XLK XLF IVW IVE XLE ERX").split()
INDEXES = "^NDX ^GSPC ^SOX ^IRX ^VIX VUSTX VFITX VFISX VBMFX".split()
# fund: (underlying, leverage); simulated as L x underlying + (1 - L) x T-bill - fitted cost
LEVERED = {"TQQQ": ("QQQ", 3), "QLD": ("QQQ", 2), "QID": ("QQQ", -2), "SQQQ": ("QQQ", -3),
           "PSQ": ("QQQ", -1), "SPXL": ("SPY", 3), "UPRO": ("SPY", 3), "SSO": ("SPY", 2),
           "SH": ("SPY", -1), "SOXL": ("SOXX", 3), "TECL": ("XLK", 3), "FAS": ("XLF", 3),
           "TMF": ("TLT", 3), "ERX": ("XLE", 2)}
OVERHEAT = ["SMH", "QQQ", "SPY", "TQQQ", "TECL", "QQQE", "VOOG", "VOOV", "VTV", "FAS", "XLP", "XLY"]
ERAS = {"tuned": ("2012-04-05", None), "unseen": ("2000-01-03", "2012-04-04"),
        "dot-com": ("2000-03-10", "2002-10-09"), "2008": ("2007-10-09", "2009-03-09"),
        "full": ("2000-01-03", None)}


# ---------------------------------------------------------------- data
def download():
    import yfinance as yf
    raw = yf.download(REAL + INDEXES, start="1990-01-01", auto_adjust=True, progress=False,
                      threads=False)["Close"]
    return raw.sort_index()


def splice(real, proxy):
    """proxy's returns before the real fund's first day, the real fund's after."""
    out = proxy.copy()
    first = real.first_valid_index()
    if first is not None:
        out[out.index >= first] = real[real.index >= first]
    return out


def fit_cost(sim_gross, real):
    """Yearly cost that makes the simulation's average return match the real fund's."""
    ok = real.notna() & sim_gross.notna() & (real.abs() < 0.5)
    return 252 * (sim_gross[ok] - real[ok]).mean() if ok.sum() > 250 else 0.0


def universe(P):
    """Daily total returns, one column per ticker, 1995 to the last close. CASH = T-bills."""
    cal = P["^GSPC"].dropna().index
    cal = cal[cal >= "1995-01-01"]
    R = P.reindex(cal).pct_change(fill_method=None)
    rf = (P["^IRX"].reindex(cal).ffill() / 100 / 252).fillna(0)
    u = {}
    u["QQQ"] = splice(R["QQQ"], R["^NDX"])
    u["SPY"] = splice(R["SPY"], R["^GSPC"] + 0.018 / 252)         # S&P dividends before SPY
    u["SOXX"] = splice(R["SOXX"], R["^SOX"])
    u["SMH"] = splice(R["SMH"], u["SOXX"])
    u["XLK"] = splice(R["XLK"], u["QQQ"])
    for t in ("XLF", "XLP", "XLY", "XLE", "IVW", "IVE"):
        u[t] = splice(R[t], u["SPY"])
    u["VOOG"], u["VOOV"] = splice(R["VOOG"], u["IVW"]), splice(R["VOOV"], u["IVE"])
    u["VTV"], u["QQQE"] = splice(R["VTV"], u["IVE"]), splice(R["QQQE"], u["QQQ"])
    u["TLT"], u["IEF"] = splice(R["TLT"], R["VUSTX"]), splice(R["IEF"], R["VFITX"])
    u["SHY"] = splice(R["SHY"], R["VFISX"])
    u["BSV"], u["AGG"] = splice(R["BSV"], u["SHY"]), splice(R["AGG"], R["VBMFX"])
    for f, (base, L) in LEVERED.items():
        gross = L * u[base] + (1 - L) * rf
        real = R[f].where(R.index >= "2020-04-01") if f == "ERX" else R[f]   # ERX was 3x before
        u[f] = splice(R[f] if f != "ERX" else pd.Series(np.nan, index=cal), gross - fit_cost(gross, real) / 252)
    dvix = P["^VIX"].reindex(cal).pct_change(fill_method=None)
    ok = R["VXX"].notna() & dvix.notna()
    slope, icept = np.polyfit(dvix[ok], R["VXX"][ok], 1)
    u["VXX"] = R["VXX"].where(R["VXX"].notna(), icept + slope * dvix)
    ok = R["UVXY"].notna() & u["VXX"].notna()
    s2, i2 = np.polyfit(u["VXX"][ok], R["UVXY"][ok], 1)
    u["UVXY"] = R["UVXY"].where(R["UVXY"].notna(), i2 + s2 * u["VXX"])
    B = pd.DataFrame(u).fillna(0.0)
    B["CASH"] = rf
    return B


# ---------------------------------------------------------------- strategies
class Lab:
    def __init__(self, B):
        self.B, self.LV = B, (1 + B).cumprod()
        self._rsi = {}

    def rsi(self, t, n):
        if (t, n) not in self._rsi:
            self._rsi[t, n] = pb.rsi(self.LV[t], n).to_numpy()
        return self._rsi[t, n]

    def sma(self, t, n):
        return self.LV[t].rolling(n).mean().to_numpy()

    def one(self, picks):
        """One ticker per day -> weight frame."""
        picks = np.asarray(picks)
        W = pd.DataFrame(0.0, index=self.B.index, columns=self.B.columns)
        for t in set(picks):
            W.loc[picks == t, t] = 1.0
        return W

    # --- Composer strategies
    def ea2027(self, smh=23, qqq=28, spy=28, hot=79, tq=31, n=10, psq_n=20):
        r = {t: self.rsi(t, n) for t in OVERHEAT}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            hottest = np.nanmax(np.vstack([r[t] for t in OVERHEAT]), axis=0)
        return self.one(np.select(
            [r["SMH"] < smh, r["QQQ"] < qqq, r["SPY"] < spy, hottest > hot, r["TQQQ"] < tq,
             self.rsi("IEF", n) > self.rsi("PSQ", psq_n)],
            ["SOXL", "TQQQ", "SPXL", "VXX", "TQQQ", "TQQQ"], "SH"))

    def qld(self, ma=200, ma_short=20, **thresholds):
        sig = self.LV[pb.QLD_V11["signals"]]
        return self.one(pb.qld_v11_targets(sig, ma, ma_short, **thresholds))

    def ftlt(self, hot=79, hot2=80, tq_lo=31, spy_lo=30, sq_lo=31, ma=200):
        up = self.LV["SPY"].to_numpy() > self.sma("SPY", ma)
        t10, s10 = self.rsi("TQQQ", 10), self.rsi("SPY", 10)
        down20 = self.LV["TQQQ"].to_numpy() < self.sma("TQQQ", 20)
        sq_or_tlt = np.where(self.rsi("SQQQ", 10) >= self.rsi("TLT", 10), "SQQQ", "TLT")
        return self.one(np.select(
            [up & ((t10 > hot) | (self.rsi("SPXL", 10) > hot2)), up, t10 < tq_lo, s10 < spy_lo, down20,
             self.rsi("SQQQ", 10) < sq_lo], ["UVXY", "TQQQ", "TECL", "UPRO", sq_or_tlt, "SQQQ"], "TQQQ"))

    def holy_grail(self):
        up = self.LV["TQQQ"].to_numpy() > self.sma("TQQQ", 200)
        t10 = self.rsi("TQQQ", 10)
        down20 = self.LV["TQQQ"].to_numpy() < self.sma("TQQQ", 20)
        bear = self.one(np.select(
            [t10 < 31, self.rsi("SOXL", 10) < 30, down20],
            ["TECL", "SOXL", np.where(self.rsi("SQQQ", 10) >= self.rsi("BSV", 10), "SQQQ", "BSV")], "TQQQ"))
        bull = 0.8 * self.one(np.where(t10 > 79, "UVXY", "TQQQ"))
        bull["CASH"] += 0.2
        return bull.where(pd.Series(up, index=bull.index), bear, axis=0)

    # --- playbook.py engines on US equivalents
    def ladder(self, signal, funds):
        """funds: {tier: {ticker: weight}}; Friday re-check, cash below the 200-day."""
        tiers = pb.ladder_tiers(self.LV[signal], cap=max(funds))
        W = pd.DataFrame(0.0, index=self.B.index, columns=self.B.columns)
        for t, mix in funds.items():
            for f, w in mix.items():
                W.loc[tiers == t, f] += w
        W.loc[tiers.isna(), "CASH"] += 1
        return W

    def dip(self, threshold=28, lo=6, hi=10):
        on = pb.dip_signals(self.LV["TQQQ"], threshold, range(lo, hi + 1)).mean(axis=1).fillna(0)
        W = pd.DataFrame(0.0, index=self.B.index, columns=self.B.columns)
        W["TQQQ"], W["CASH"] = on, 1 - on
        return W

    def current(self):
        nas = self.ladder("QQQ", {3: {"TQQQ": 1}, 2: {"QLD": 1}, 1: {"QQQ": 1}, 0: {"CASH": 1}})
        semis = self.ladder("SOXX", {3: {"SOXL": 1}, 2: {"SOXL": .5, "SMH": .5}, 1: {"SMH": 1}, 0: {"CASH": 1}})
        energy = self.ladder("XLE", {2: {"ERX": 1}, 1: {"XLE": 1}, 0: {"CASH": 1}})
        return 0.4 * nas + 0.3 * self.dip() + 0.15 * semis + 0.15 * energy

    def design_f(self, qld_kw=None, dip_kw=None):
        return 0.5 * self.qld(**(qld_kw or {})) + 0.5 * self.dip(**(dip_kw or {}))

    # --- quarterly plans (return series, not weights)
    def nine_sig(self):
        """60/40 TQQQ/AGG start; each quarter the TQQQ target is last quarter's TQQQ balance
        x 1.09; buys use at most 90% of the bonds; after a 30% fall from the 2-year quarterly
        high the next two sell signals are skipped."""
        idx, B = self.B.index, self.B
        q_end = set(pd.Series(idx, index=idx).groupby(idx.to_period("Q")).max())
        tq, bd, level, highs, skip, line = 0.6, 0.4, 1.0, [], 0, None
        rt, rb, out = B["TQQQ"].to_numpy(), B["AGG"].to_numpy(), np.zeros(len(idx))
        for k, d in enumerate(idx):
            v0 = tq + bd
            tq, bd, level = tq * (1 + rt[k]), bd * (1 + rb[k]), level * (1 + rt[k])
            out[k] = (tq + bd) / v0 - 1
            if d in q_end:
                highs = (highs + [level])[-8:]
                if level <= 0.7 * max(highs) and skip == 0:
                    skip = 2
                gap = (line * 1.09 if line is not None else tq) - tq
                if gap > 0:
                    buy = min(gap, 0.9 * bd); tq, bd = tq + buy, bd - buy
                elif gap < 0:
                    if skip:
                        skip -= 1
                    else:
                        tq, bd = tq + gap, bd - gap
                line = tq
        return pd.Series(out, index=idx)

    def fixed(self, weights, freq="Q"):
        idx = self.B.index
        ends = set(pd.Series(idx, index=idx).groupby(idx.to_period(freq)).max())
        w0 = np.array(list(weights.values())); R = self.B[list(weights)].to_numpy()
        cur, out = w0.copy(), np.zeros(len(idx))
        for k, d in enumerate(idx):
            g = cur * (1 + R[k]); out[k] = g.sum() / cur.sum() - 1; cur = g / g.sum()
            if d in ends:
                cur = w0.copy()
        return pd.Series(out, index=idx)


def backtest(W, B, delay=1, bps=5.0):
    """Weights chosen at close t earn day t+delay; bps charged per side on what changes."""
    gross = (W.shift(delay) * B).sum(axis=1)
    turnover = W.diff().abs().sum(axis=1).shift(delay - 1).fillna(0)
    return (1 + gross) * (1 - turnover * bps / 1e4) - 1


def window(r, era):
    a, b = ERAS[era]
    r = r[r.index >= a]
    return r if b is None else r[r.index <= b]


def stats(r):
    eq = (1 + r).cumprod(); yrs = (r.index[-1] - r.index[0]).days / 365.25
    return eq.iloc[-1] ** (1 / yrs) - 1, (eq / eq.cummax() - 1).min()


def strategies(lab):
    """name -> (weights or None, daily returns if quarterly)"""
    return {"ea2027": (lab.ea2027(), None), "qld": (lab.qld(), None), "ftlt": (lab.ftlt(), None),
            "holy-grail": (lab.holy_grail(), None), "9sig": (None, lab.nine_sig()),
            "hfea": (None, lab.fixed({"UPRO": .55, "TMF": .45})), "current": (lab.current(), None),
            "design-f": (lab.design_f(), None)}


def compare(lab):
    rows = {}
    for name, (W, q) in strategies(lab).items():
        r = backtest(W, lab.B) if W is not None else q
        row = {e: "{:6.1f}% / {:4.0f}%".format(*[x * 100 for x in stats(window(r, e))]) for e in ERAS}
        if W is not None:
            row["one day late"] = "{:6.1f}% / {:4.0f}%".format(*[x * 100 for x in stats(window(backtest(W, lab.B, 2), "full"))])
            row["switches/yr"] = round(W.diff().abs().sum(axis=1)["2000":].sum() / 2 / ((lab.B.index[-1] - pd.Timestamp("2000-01-03")).days / 365.25), 1)
        rows[name] = row
    for t in ("TQQQ", "QQQ", "SPY"):
        rows[f"hold {t}"] = {e: "{:6.1f}% / {:4.0f}%".format(*[x * 100 for x in stats(window(lab.B[t], e))]) for e in ERAS}
    return pd.DataFrame(rows).T.fillna("")


def jitter(lab, name, draws=40, seed=7):
    """Nudge every threshold by up to +/-3 (windows +/-1, moving averages +/-20) at random."""
    rng = np.random.default_rng(seed)
    d = lambda v, k: int(v + rng.integers(-k, k + 1))
    make = {
        "ea2027": lambda: lab.ea2027(smh=d(23, 3), qqq=d(28, 3), spy=d(28, 3), hot=d(79, 3), tq=d(31, 3), n=d(10, 1), psq_n=d(20, 3)),
        "qld": lambda: lab.qld(ma=d(200, 20), ma_short=d(20, 3), hot=d(79, 3), qqq=d(30, 3), spy=d(30, 3), qid=d(31, 3)),
        "ftlt": lambda: lab.ftlt(hot=d(79, 3), hot2=d(80, 3), tq_lo=d(31, 3), spy_lo=d(30, 3), sq_lo=d(31, 3), ma=d(200, 20)),
        "design-f": lambda: lab.design_f({"ma": d(200, 20), "ma_short": d(20, 3), "hot": d(79, 3), "qqq": d(30, 3),
                                          "spy": d(30, 3), "qid": d(31, 3)}, {"threshold": d(28, 3), "lo": d(6, 1), "hi": d(10, 1)}),
    }[name]
    out = []
    for _ in range(draws):
        r = backtest(make(), lab.B)
        out.append([stats(window(r, e))[0] for e in ("tuned", "unseen", "full")])
    return pd.DataFrame(out, columns=["tuned", "unseen", "full"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    sub.add_parser("compare", help="every strategy in every era")
    j = sub.add_parser("jitter", help="how much a strategy depends on its exact thresholds")
    j.add_argument("--strategy", choices=["ea2027", "qld", "ftlt", "design-f"], default="design-f")
    j.add_argument("--draws", type=int, default=40)
    a = ap.parse_args()
    lab = Lab(universe(download()))
    pd.set_option("display.width", 200)
    if a.mode == "compare":
        print(f"CAGR / worst drop. Same-close fills, 5 bps per side. Data to {lab.B.index[-1].date()}.\n")
        print(compare(lab).to_string())
    else:
        J = jitter(lab, a.strategy, a.draws)
        print(f"{a.strategy}: CAGR over {a.draws} random nudges (10th / median / 90th percentile)")
        for c in J:
            print(f"  {c:7s} {J[c].quantile(.1)*100:6.1f}% / {J[c].median()*100:6.1f}% / {J[c].quantile(.9)*100:6.1f}%")


if __name__ == "__main__":
    main()
