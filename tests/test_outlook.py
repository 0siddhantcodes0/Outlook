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


def test_align_parts_uses_common_dates():
    a = ol.synthetic_prices(3, 500)
    b = ol.synthetic_prices(4, 500)
    b.iloc[10:16] = b.iloc[10]                          # flat week: 0/0 z-score
    parts = {"a": ol.prepare_asset(a, 21), "b": ol.prepare_asset(b, 21)}
    assert len(parts["a"][2]) != len(parts["b"][2])
    al = ol.align_parts(parts)
    assert al["a"][2].equals(al["b"][2])
    for X, y, d in al.values():
        assert len(X) == len(y) == len(d)


def test_band_keeps_position_inside_band():
    sig = series([0.3, 0.1, -0.1, -0.3, 0.1, 0.3])
    assert ol.positions(sig, band=0.2).tolist() == [1, 1, 1, 0, 0, 1]
    assert ol.positions(sig).tolist() == [1, 1, 0, 0, 1, 1]  # band 0 = old rule


def test_top_k_and_rebalance():
    idx = pd.bdate_range("2020-01-01", periods=4)
    prices = pd.DataFrame(100.0, index=idx, columns=list("ABC"))
    sig = pd.DataFrame({"A": [3, 1, 1, 3], "B": [2, 3, 3, 2], "C": [1, 2, 2, 1]},
                       index=idx, dtype=float)
    _, w = ol.portfolio_backtest(prices, sig, cost_bps=0, top=2)
    assert w.iloc[0].tolist() == [0.5, 0.5, 0] and w.iloc[1].tolist() == [0, 0.5, 0.5]
    _, w2 = ol.portfolio_backtest(prices, sig, cost_bps=0, top=2, rebalance=2)
    assert w2.iloc[1].tolist() == w2.iloc[0].tolist()   # held between rebalances
    assert w2.iloc[2].tolist() == [0, 0.5, 0.5]


def test_trend_features_appended_and_past_only():
    p = ol.synthetic_prices(5, 900)
    X0, _, d0 = ol.prepare_asset(p, 21)
    X1, _, d1 = ol.prepare_asset(p, 21, trend=True)
    assert X1.shape[1] == X0.shape[1] + 2
    assert d1[0] >= d0[0]                                # needs 252 days more
    p2 = p.copy(); p2.iloc[-60:] *= 2
    X2, _, d2 = ol.prepare_asset(p2, 21, trend=True)
    keep = d1 < p.index[-60]
    assert np.array_equal(X1[keep], X2[: keep.sum()])
