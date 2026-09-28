import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import portfolio as pf  # noqa: E402

IDX = pd.bdate_range("2021-01-01", "2023-12-31")


def test_builtin_weights_sum_to_one():
    for k in pf.PORTFOLIOS:
        assert np.isclose(pf.weights(k).sum(), 1.0), k


def test_hybrid_keeps_rsst_and_canadian_has_no_usd_funds():
    assert "RSST" in pf.weights("hybrid")
    assert not any(pf.is_usd(t) for t in pf.weights("canadian").index)
    assert pf.is_usd("RSST") and not pf.is_usd("XEF.TO")


def test_backtest_matches_manual_rebalancing():
    # A doubles steadily through each year, B is flat; yearly reset to 50/50
    days = pd.Series(np.arange(len(IDX)), index=IDX)
    per_year = days.groupby(IDX.year).transform("count").to_numpy()
    a = np.cumprod(np.r_[1.0, (2.0 ** (1 / per_year[1:]))])
    P = pd.DataFrame({"A": a, "B": 1.0}, index=IDX)
    r, turn = pf.backtest(P, pd.Series({"A": 0.5, "B": 0.5}), "yearly", cost=0)
    yearly = (1 + r).groupby(r.index.year).prod()
    # full years: 50% doubles -> 1.5x; 2021 misses its first day's growth
    assert np.allclose(yearly.loc[[2022, 2023]], 1.5, atol=1e-3)
    assert turn > 0


def test_no_rebalance_is_buy_and_hold():
    P = pd.DataFrame({"A": np.linspace(1, 3, len(IDX)), "B": np.linspace(1, 0.5, len(IDX))}, index=IDX)
    r, _ = pf.backtest(P, pd.Series({"A": 0.5, "B": 0.5}), "never", cost=0)
    assert np.isclose((1 + r).prod(), 0.5 * 3 + 0.5 * 0.5)


def test_costs_reduce_returns():
    rng = np.random.default_rng(0)
    P = pd.DataFrame(np.exp(np.cumsum(rng.normal(0, 0.01, (len(IDX), 2)), axis=0)),
                     index=IDX, columns=["A", "B"])
    w = pd.Series({"A": 0.5, "B": 0.5})
    r0, _ = pf.backtest(P, w, "monthly", cost=0)
    r1, _ = pf.backtest(P, w, "monthly", cost=0.01)
    assert (1 + r1).prod() < (1 + r0).prod()


def test_holdings_amounts():
    t = pf.holdings("hybrid", 40000)
    assert np.isclose(t.amount.sum(), 40000)
    assert t.loc[t.ticker == "RSST", "account"].item() == "RRSP"
