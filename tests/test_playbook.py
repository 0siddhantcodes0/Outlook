import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import playbook as pb  # noqa: E402

IDX = pd.bdate_range("2020-01-01", periods=400)


def calm_uptrend(vol=0.003):
    rng = np.random.default_rng(0)
    return pd.Series(100 * np.exp(np.cumsum(0.001 + rng.normal(0, vol, len(IDX)))), index=IDX)


def test_tier_rises_as_volatility_falls_and_is_capped():
    calm = pb.desired_tier(calm_uptrend(0.003)).dropna()     # ~5% yearly vol
    wild = pb.desired_tier(calm_uptrend(0.012)).dropna()     # ~19%
    assert calm.iloc[-1] == 3 and wild.iloc[-1] == 1
    assert pb.desired_tier(calm_uptrend(0.003), cap=2).dropna().iloc[-1] == 2


def test_below_200_day_means_cash_same_day_even_midweek():
    p = calm_uptrend(0.003).copy()
    p.iloc[-1] = p.iloc[-2] * 0.6                             # crash on the last day
    assert p.index[-1].dayofweek != 4
    assert pb.ladder_tiers(p).iloc[-1] == 0


def test_weekly_recheck_waits_for_friday_to_add_leverage():
    want = pb.desired_tier(calm_uptrend(0.003))
    held = pb.ladder_tiers(calm_uptrend(0.003))
    changes = held[held.diff() > 0].index
    assert all(d.dayofweek == 4 for d in changes[1:])
    assert (held.dropna() <= want.dropna().max()).all()


def test_rsi_matches_wilder_definition():
    c = pd.Series([44, 44.3, 44.1, 43.6, 44.3, 44.8, 45.1, 45.4, 45.8, 46.1,
                   45.9, 46.2, 45.6, 46.2, 46.3, 46.3, 46.0, 46.4, 46.2, 45.6], dtype=float)
    r = pb.rsi(c, 14)
    assert 40 < r.iloc[-1] < 70 and r.notna().iloc[-1]
    falling = pd.Series(np.linspace(100, 50, 40))
    assert (pb.dip_signals(falling).iloc[-1] == 1).all()     # every sleeve oversold


def test_dip_returns_follow_the_sleeves_exactly():
    rng = np.random.default_rng(5)
    idx = pd.bdate_range("2021-01-01", periods=120)
    f3 = pd.Series(rng.normal(0, 0.04, len(idx)), index=idx)
    rf = pd.Series(0.0001, index=idx)
    sig = pb.dip_signals((1 + f3).cumprod())
    books = [(1 + sig[n].shift(1).fillna(0) * f3 + (1 - sig[n].shift(1).fillna(0)) * rf).cumprod()
             for n in sig]                                     # each sleeve: fund after a buy close, cash otherwise
    expected = pd.concat(books, axis=1).mean(axis=1)
    got = (1 + pb.dip_returns(f3, rf, cost=0)).cumprod()
    assert np.allclose(got.iloc[1:], expected.iloc[1:] / expected.iloc[0])


def test_blend_keeps_days_one_market_is_shut():
    a = pd.Series(0.01, index=pd.bdate_range("2022-01-03", periods=10))
    b = a.drop(a.index[4])                                     # market b closed one day
    out = pb.blend({"a": a, "b": b}, {"a": 0.5, "b": 0.5})
    assert len(out) == 10 and np.isclose(out.iloc[4], 0.005)


def test_trades_reach_targets():
    h = pd.DataFrame({"ticker": ["XQQ.TO"], "shares": [100.0], "avg_cost": [50.0]})
    prices = {"XQQ.TO": 60.0, "CASH.TO": 50.0}
    todo, total = pb.trades(h, prices, {"XQQ.TO": 0.5, "CASH.TO": 0.5}, cash=0)
    assert total == 6000
    acts = {t["ticker"]: (t["action"], t["shares"]) for t in todo}
    assert acts == {"CASH.TO": ("BUY", 60), "XQQ.TO": ("SELL", 50)}


def test_holdings_from_env(monkeypatch):
    monkeypatch.setenv("HOLDINGS_CSV", "ticker,shares,avg_cost\nxqq.to,10,50\n")
    h = pb.read_holdings()
    assert h.ticker.tolist() == ["XQQ.TO"] and h.shares.iloc[0] == 10


def test_telegram_posts_message(monkeypatch):
    sent = {}

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"ok": true}'

    def fake_urlopen(url, data, timeout):
        sent["url"], sent["data"] = url, data
        return Resp()

    monkeypatch.setattr(pb.urllib.request, "urlopen", fake_urlopen)
    assert pb.telegram_send("hello", token="T0K", chat_id="42")
    assert sent["url"].endswith("/botT0K/sendMessage") and b"chat_id=42" in sent["data"]


def test_presets_sum_to_one():
    for w in pb.PRESETS.values():
        assert np.isclose(sum(w.values()), 1)
