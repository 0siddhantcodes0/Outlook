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


def test_phase_labels_follow_toronto_clock():
    at = lambda s: pd.Timestamp(s, tz="America/Toronto")
    assert pb.phase(at("2026-10-19 09:45")) == "MARKET OPEN update"      # Monday
    assert pb.phase(at("2026-10-19 15:33")) == "CLOSE update"
    assert pb.phase(at("2026-10-18 15:33")) == "MARKET CLOSED"           # Sunday


def test_price_board_moves_tags_and_stale_prices():
    idx = pd.bdate_range("2025-01-01", periods=260)
    P = pd.DataFrame({"QQQ": 100 * 1.001 ** np.arange(260),               # steady riser
                      "SOXS": 100 * 0.995 ** np.arange(260),              # steady decliner
                      "XQQ.TO": 50.0}, index=idx)
    P.iloc[-1, P.columns.get_loc("XQQ.TO")] = np.nan                      # no trade yet today
    lines = pb.watch_lines(P, {"XQQ.TO": 0.4, "CASH.TO": 0.6})
    row = {ln.split()[0]: ln for ln in lines if ln.startswith("   ")}
    assert "US$ +0.1%  5d +0.5% ▲" in row["QQQ"]
    assert row["SOXS"].endswith("▼ watch")
    assert "★40%" in row["XQQ.TO"]
    assert "(last trade" in row["XQQ.TO"] and "+0.0%" in row["XQQ.TO"]
    assert row["TQQQ.TO"].endswith("no price")


def test_load_refetches_tickers_a_batch_dropped(monkeypatch):
    idx = pd.bdate_range("2026-01-01", periods=5)
    calls = []

    def fake_download(names, threads=True, **kw):
        calls.append((list(names), threads))
        close = pd.DataFrame({n: 1.0 for n in names}, index=idx)
        if threads:
            close["SOXL"] = np.nan                     # dropped in the parallel batch
        return pd.concat({"Close": close}, axis=1)

    monkeypatch.setitem(sys.modules, "yfinance", type(sys)("yfinance"))
    monkeypatch.setattr(sys.modules["yfinance"], "download", fake_download, raising=False)
    P = pb.load(["QQQ", "SOXL"])
    assert calls == [(["QQQ", "SOXL"], True), (["SOXL"], False)]
    assert P["SOXL"].notna().all() and list(P.columns).count("SOXL") == 1


def qld_row(**kw):
    x = {"spy": 100.0, "spy200": 90.0, "qld": 50.0, "qld20": 48.0, "QLD10": 50.0, "QQQ10": 50.0,
         "SPY10": 50.0, "QLD12": 50.0, "SHY12": 50.0, "SSO12": 50.0, "QID9": 50.0, "QID10": 50.0, "BSV10": 50.0}
    x.update(kw)
    return x


def test_qld_v11_rules_in_order():
    assert pb.qld_v11_pick(qld_row())[0] == "QLD"                                   # uptrend
    assert pb.qld_v11_pick(qld_row(QLD10=79.5))[0] == "TLT"                         # overheated
    assert pb.qld_v11_pick(qld_row(QLD10=79.0))[0] == "QLD"                         # strict >
    down = dict(spy=80.0)
    assert pb.qld_v11_pick(qld_row(**down, QQQ10=29, QLD12=40, SHY12=45))[0] == "QLD"
    assert pb.qld_v11_pick(qld_row(**down, QQQ10=29, QLD12=45, SHY12=45))[0] == "QLD"   # tie: first listed
    assert pb.qld_v11_pick(qld_row(**down, QQQ10=29, QLD12=46, SHY12=45))[0] == "SHY"
    assert pb.qld_v11_pick(qld_row(**down, SPY10=29, SSO12=60, SHY12=45))[0] == "SHY"
    assert pb.qld_v11_pick(qld_row(**down, QID9=30))[0] == "QID"                    # QLD above 20-day
    assert pb.qld_v11_pick(qld_row(**down))[0] == "QLD"
    below = dict(spy=80.0, qld=40.0)
    assert pb.qld_v11_pick(qld_row(**below, QID10=50, BSV10=50))[0] == "QID"
    assert pb.qld_v11_pick(qld_row(**below, QID10=40, BSV10=50))[0] == "BSV"
    assert pb.qld_v11_pick(qld_row(**down, QQQ10=29, QLD12=40, SHY12=45), qqq=28)[0] == "QLD"   # tunable


def synthetic_closes(n=400, seed=2):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2024-01-01", periods=n)
    q = 100 * np.exp(np.cumsum(rng.normal(0.0008, 0.012, n)))
    s = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.009, n)))
    P = pd.DataFrame({"QQQ": q, "SPY": s, "SHY": 80 + 0 * q, "BSV": 75 + 0 * q}, index=idx)
    P["SHY"] *= np.exp(np.cumsum(rng.normal(0, 0.001, n))); P["BSV"] *= np.exp(np.cumsum(rng.normal(0, 0.001, n)))
    r = P.pct_change().fillna(0)
    for f, base, L in (("QLD", "QQQ", 2), ("QID", "QQQ", -2), ("SSO", "SPY", 2), ("TQQQ", "QQQ", 3)):
        P[f] = 50 * (1 + L * r[base]).cumprod()
    return P


def test_design_f_plan_uses_tsx_funds_and_sums_to_one():
    P = synthetic_closes()
    rows = pb.plan_today(P, pb.PRESETS["design-f"])
    hold = pb.target_holdings(rows)
    assert np.isclose(sum(hold.values()), 1.0)
    assert set(hold) <= {"QQU.TO", "QQD.TO", "SPXU.TO", "XTLH.TO", "CASH.TO", "TQQQ.TO"}
    qrow = next(r for r in rows if r["key"] == "qld")
    assert qrow["summary"] in pb.QLD_V11["funds"] and "SPY" in qrow["reason"]
    t = pb.qld_v11_targets(P)
    assert t.iloc[-1] == qrow["summary"]


def test_preview_shares_engines_already_shown():
    P = synthetic_closes()
    lines = pb.preview_lines("design-f", pb.plan_today(P, pb.PRESETS["design-f"]), shown={"dip"})
    assert lines[0].startswith("DESIGN F PREVIEW")
    assert any("same signal as above" in ln for ln in lines) and lines[-1].strip().startswith("Would hold:")


def test_engine_tickers_cover_signals_and_funds():
    signals, funds = pb.engine_tickers(pb.PRESETS["design-f"])
    assert set(pb.QLD_V11["signals"]) <= signals and "TQQQ" in signals
    assert {"QQU.TO", "QQD.TO", "SPXU.TO", "XTLH.TO", "CASH.TO", "TQQQ.TO"} <= funds


def test_qld_returns_charges_each_switch():
    P = synthetic_closes(600).drop(columns=["QLD", "QID", "SSO", "TQQQ"])
    P["TLT"] = 90 * np.exp(np.cumsum(np.random.default_rng(4).normal(0, 0.008, len(P))))
    rf = pd.Series(0.0001, index=P.index)
    free, paid = pb.qld_returns(P, rf, trade_cost=0), pb.qld_returns(P, rf, trade_cost=0.001)
    assert len(free) == len(paid) > 300 and np.isfinite(free).all()
    switches = ((1 + free) / (1 + paid) > 1 + 1e-12).sum()
    assert np.isclose(((free - paid) > 1e-12).sum(), switches) and switches > 0
