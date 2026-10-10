import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import leverage as lv  # noqa: E402

IDX = pd.bdate_range("2020-01-01", periods=300)


def test_leveraged_is_l_times_index_before_costs():
    r = pd.Series(np.random.default_rng(0).normal(0, 0.01, 300), index=IDX)
    rf = pd.Series(0.0, index=IDX)
    assert np.allclose(lv.leveraged(r, 3, rf, cost_per_unit=0), 3 * r)
    # borrowing: 2x pays one unit of T-bills plus the yearly cost per unit
    rf1 = pd.Series(0.0001, index=IDX)
    out = lv.leveraged(r, 2, rf1, cost_per_unit=0.0252)
    assert np.allclose(out, 2 * r - 0.0001 - 0.0001)


def test_trend_uses_previous_close_only():
    p = pd.Series(np.r_[np.full(250, 100.0), np.full(50, 200.0)], index=IDX)
    on = lv.trend_on(p)
    assert not on.iloc[250]          # jump happens at day 250's close
    assert on.iloc[251]              # known from day 251 on


def test_swing_schedule_segments():
    allowed = np.ones(10, bool)
    night, day, trades = lv.swing_schedule(10, "open", "close", 3, allowed)
    assert day[1:4].all() and night[2:4].all() and not night[4]   # out overnight 3->4
    night, day, trades = lv.swing_schedule(10, "close", "open", 1, allowed)
    assert night[2:].all() and not day.any()                      # overnight only


def test_swing_captures_overnight_gains_only_when_held_overnight():
    # every gain happens overnight: open = previous close * 1.01, close = open
    closes = 100 * 1.01 ** np.arange(60)
    ohlc = pd.DataFrame({"Open": np.r_[100, closes[:-1] * 1.01], "Close": closes},
                        index=IDX[:60])
    ohlc["Close"] = ohlc["Open"]
    day_only, _ = lv.swing(ohlc, "open", "close", 1, cost=0)
    overnight, _ = lv.swing(ohlc, "close", "open", 1, cost=0)
    assert np.isclose((1 + day_only).prod(), 1)
    assert (1 + overnight).prod() > 1.5


def test_rotate_holds_the_rising_asset():
    up = 100 * 1.001 ** np.arange(300)
    down = 100 * 0.999 ** np.arange(300)
    P = pd.DataFrame({"A": up, "B": down}, index=IDX)
    rf = pd.Series(0.0, index=IDX)
    r, _ = lv.rotate(P, 1, rf, top=1, lookback=20, every=10, switch_cost=0)
    assert np.allclose(r.iloc[5:], 0.001)


def test_rotate_all_days_runs_every_offset():
    rng = np.random.default_rng(1)
    P = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (300, 3)), axis=0)),
                     index=IDX, columns=list("ABC"))
    out = lv.rotate_all_days(P, 2, pd.Series(0.0, index=IDX), every=5, top=1, lookback=20)
    assert len(out) == 5 and out["CAGR"].notna().all()


def test_signal_picks_top_momentum_and_applies_trend_rule():
    P = pd.DataFrame({
        "UP": 100 * 1.002 ** np.arange(300),                             # steady riser, above its 200-day
        "SPIKE": np.r_[np.full(200, 200.0), np.full(37, 60.0),          # crashed, now rebounding hard
                       np.linspace(60, 80, 63)],                         # but still below its 200-day
        "FLAT": np.full(300, 100.0)}, index=IDX)
    out = lv.signal(P, top=2, lookback=63, funds={"UP": "UPX"})
    assert list(out.index[:2]) == ["SPIKE", "UP"]                     # ranked by 63-day return
    assert out.loc["UP", "fund"] == "UPX" and out.loc["UP", "weight"] == 0.5
    assert out.loc["SPIKE", "weight"] == 0                            # top 2 but below its 200-day
    assert out.loc["cash", "weight"] == 0.5
    no_trend = lv.signal(P, top=2, lookback=63, trend=False)
    assert no_trend.loc["SPIKE", "weight"] == 0.5 and no_trend.loc["cash", "weight"] == 0


def test_signal_matches_rotate_picks():
    rng = np.random.default_rng(3)
    P = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.01, (300, 4)), axis=0)),
                     index=IDX, columns=list("ABCD"))
    held = lv.signal(P.iloc[:-1], top=2, lookback=63, trend=False)   # picks at yesterday's close
    picks = set(held.index[held["weight"] > 0]) - {"cash"}
    rf = pd.Series(0.0, index=IDX)
    lr = lv.rotate(P, 1, rf, top=2, lookback=63, every=1, switch_cost=0)[0]
    assert np.isclose(lr.iloc[-1], P.pct_change().iloc[-1][sorted(picks)].mean())
