import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import outlook as ol  # noqa: E402


def series(values):
    return pd.Series(np.asarray(values, float),
                     index=pd.bdate_range("2020-01-01", periods=len(values)))


@pytest.mark.parametrize("N", [2, 5, 21, 63])
def test_weights_taper_and_normaliser(N):
    w = ol.taper_weights(N)
    assert w[-1] == 0 and np.all(np.diff(w) < 0)       # nearer counts more
    assert np.isclose(w.sum(), (N - 1) * (4 * N + 1) / (6 * N))


def test_target_matches_definition():
    p = series([100, 101, 103, 102, 99, 104, 110])
    N = 3
    w = ol.taper_weights(N)
    o = ol.outlook_target(p, N)
    expect = np.dot(w, [101 - 100, 103 - 100, 102 - 100]) / w.sum()
    assert np.isclose(o.iloc[0], expect)
    assert o.iloc[-N:].isna().all() and o.iloc[:-N].notna().all()


def test_same_endpoints_different_paths():
    """Section 1 of the writeup: equal start and end, different targets."""
    N = 21
    up_early = series([100] + [110] * (N - 1) + [100])
    down_early = series([100] + [90] * (N - 1) + [100])
    a, b = ol.outlook_target(up_early, N).iloc[0], ol.outlook_target(down_early, N).iloc[0]
    assert a > 0 > b


def test_constant_price_gives_zero():
    o = ol.outlook_target(series([50] * 40), 10).dropna()
    assert np.allclose(o, 0)


def test_chrono_split_gaps():
    n, N = 1000, 21
    tr, va, te = ol.chrono_split(n, N, test_frac=0.25)
    assert tr[-1] + N < va[0] and va[-1] + N < te[0]
    assert te[-1] == n - 1


def test_inputs_use_only_past():
    p = ol.synthetic_prices(1, 600)
    X1, d1 = ol.build_inputs(ol.feature_streams(p))
    p2 = p.copy()
    p2.iloc[-50:] *= 3                                  # change the future
    X2, d2 = ol.build_inputs(ol.feature_streams(p2))
    keep = d1 < p.index[-50]
    assert np.array_equal(X1[keep], X2[keep[: len(X2)]])
    assert X1.shape[1] == 6 * ol.HISTORY


def test_backtest_holds_next_day():
    p = series([100, 110, 99, 99])
    sig = series([1, -1, 1, 1])
    bt = ol.backtest(p, sig, cost_bps=0)
    assert np.isclose(bt["strategy"].iloc[0], 0.10)     # long day 0 -> 1
    assert bt["strategy"].iloc[1] == 0                  # flat through the drop


def test_portfolio_weights():
    idx = pd.bdate_range("2020-01-01", periods=3)
    prices = pd.DataFrame({"A": [100, 110, 110], "B": [100, 90, 90]}, index=idx)
    sig = pd.DataFrame({"A": [1, -1, -1], "B": [1, -1, -1]}, index=idx, dtype=float)
    rets, w = ol.portfolio_backtest(prices, sig, cost_bps=0)
    assert np.allclose(w.iloc[0], 0.5) and w.iloc[1].sum() == 0
    assert np.isclose(rets["strategy"].iloc[0], 0.0)    # +10% and -10%


def test_walk_folds_cover_years_without_leakage():
    dates = pd.bdate_range("1995-01-01", "2006-06-30")
    N = 21
    folds = ol.walk_folds(dates, N, first_year=2000, step=2)
    assert [dates[te[0]].year for _, _, te in folds] == [2000, 2002, 2004, 2006]
    for tr, va, te in folds:
        assert tr[-1] + N < va[0] and va[-1] + N < te[0]
    covered = np.concatenate([te for _, _, te in folds])
    assert np.array_equal(covered, np.where(dates.year >= 2000)[0])


def test_label_fit_accepts_per_row_scale():
    y = np.array([0.02, -0.01, np.nan, 0.04])
    scale = np.array([0.02, 0.02, 0.04, 0.04])
    mae, hit = ol.label_fit(np.array([1.0, -0.5, 0.0, 1.0]), y, scale)
    assert np.isclose(mae, 0) and hit == 1


def test_baselines_use_only_past_prices():
    p = ol.synthetic_prices(2, 800)
    b1 = ol.baseline_signals(p)
    p2 = p.copy()
    p2.iloc[-100:] *= 0.5                               # change the future
    b2 = ol.baseline_signals(p2)
    cut = p.index[-100]
    for k in b1:
        a, b = b1[k][b1[k].index < cut], b2[k][b2[k].index < cut]
        pd.testing.assert_series_equal(a, b)


def test_ma_baseline_sign():
    up = series(np.linspace(100, 200, 300))
    down = series(np.linspace(200, 100, 300))
    assert (ol.baseline_signals(up)["200-day MA"].dropna() > 0).all()
    assert (ol.baseline_signals(down)["12-month momentum"].dropna() < 0).all()
