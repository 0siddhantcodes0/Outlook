import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lab  # noqa: E402

IDX = pd.bdate_range("2020-01-01", periods=300)


def test_splice_uses_proxy_before_the_fund_exists():
    proxy = pd.Series(0.01, index=IDX)
    real = pd.Series(np.nan, index=IDX); real.iloc[100:] = 0.02
    out = lab.splice(real, proxy)
    assert (out.iloc[:100] == 0.01).all() and (out.iloc[100:] == 0.02).all()


def test_fit_cost_recovers_a_known_drag():
    rng = np.random.default_rng(0)
    gross = pd.Series(rng.normal(0, 0.02, 2000))
    assert abs(lab.fit_cost(gross, gross - 0.03 / 252) - 0.03) < 1e-9


def test_backtest_earns_next_day_and_pays_for_turnover():
    B = pd.DataFrame({"A": 0.01, "CASH": 0.0}, index=IDX)
    W = pd.DataFrame({"A": 0.0, "CASH": 1.0}, index=IDX)
    W.iloc[10:, :] = [1.0, 0.0]                             # switch at the close of day 10
    r = lab.backtest(W, B, delay=1, bps=10)
    assert np.isclose(r.iloc[10], -2 * 10 / 1e4)            # both sides paid at day 10's close
    assert np.isclose(r.iloc[11], 0.01)                     # day 11: in A
    assert np.isclose(r.iloc[9], 0.0)
    late = lab.backtest(W, B, delay=2, bps=0)
    assert late.iloc[11] == 0.0 and np.isclose(late.iloc[12], 0.01)


def lab_with(rsi):
    cols = sorted(set(lab.OVERHEAT) | {"IEF", "PSQ", "SOXL", "SPXL", "VXX", "SH", "CASH"})
    L = lab.Lab(pd.DataFrame(0.0, index=IDX[:4], columns=cols))
    base = np.full(4, 50.0)
    for t in set(lab.OVERHEAT) | {"IEF"}:
        L._rsi[t, 10] = rsi.get(t, base)
    L._rsi["PSQ", 20] = rsi.get("PSQ", base)
    return L


def test_ea2027_first_matching_rule_wins():
    a = lambda *v: np.array(v, dtype=float)
    L = lab_with({"SMH": a(20, 50, 50, 50), "QQQ": a(20, 20, 50, 50), "SPY": a(50, 50, 50, 50),
                  "XLP": a(90, 90, 90, 50), "IEF": a(50, 50, 50, 60), "PSQ": a(50, 50, 50, 55)})
    picks = L.ea2027().idxmax(axis=1).tolist()
    assert picks == ["SOXL", "TQQQ", "VXX", "TQQQ"]          # SMH dip beats QQQ dip beats overheat
    L2 = lab_with({"IEF": np.full(4, 40.0), "PSQ": np.full(4, 60.0)})
    assert L2.ea2027().idxmax(axis=1).eq("SH").all()


def test_fixed_weights_reset_each_quarter():
    idx = pd.bdate_range("2021-01-01", "2021-12-31")
    B = pd.DataFrame({"X": 0.01, "Y": 0.0, "CASH": 0.0}, index=idx)
    L = lab.Lab(B)
    r = L.fixed({"X": 0.5, "Y": 0.5})
    first = r.index[0]
    assert np.isclose(r[first], 0.005)                       # half the money in X on day one
    q_end = r[r.index.month == 3].index[-1]
    nxt = r.index[r.index.get_loc(q_end) + 1]
    assert np.isclose(r[nxt], 0.005)                         # back to 50/50 after the reset
