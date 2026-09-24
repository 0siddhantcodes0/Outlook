"""
Outlook: a learned medium-term trend indicator.

Implements the writeup end to end:
  1. Target: quadratic-tapered, weighted average of future price displacements
  2. Features: MA, standardized deviation, and volatility streams at 5 and 10
     day windows, 200 days of history each (1,200 inputs)
  3. Model: residual MLP, tanh output, MAE loss, Adam 1e-3, 30 epochs
  4. Backtest: long when the signal is above a threshold, flat otherwise,
     compared with buy and hold on an out-of-sample test period, overall
     and split by market regime (bull / sideways / bear)
  5. Portfolio: one model trained on a pool of assets, capital spread
     equally over assets with a positive Outlook, compared with an
     equal-weight basket and an optional cap-weighted benchmark ticker

Setup:
  pip install keras tensorflow yfinance pandas numpy matplotlib

Run:
  python outlook.py --ticker XIU.TO
  python outlook.py --csv prices.csv          # columns: Date, Close
  python outlook.py --synthetic               # offline smoke test
  python outlook.py --tickers AAPL MSFT JPM XOM --benchmark SPY
  python outlook.py --synthetic --n-assets 5   # offline portfolio test
"""

import argparse
import os

os.environ.setdefault("KERAS_BACKEND", "tensorflow")

import numpy as np
import pandas as pd

# ---------------------------------------------------------------- config
WINDOWS = (5, 10)        # feature window lengths k
HISTORY = 200            # observations of history per feature stream
DROPOUT = 0.3
LR = 1e-3
EPOCHS = 30
BATCH = 64


# ---------------------------------------------------------------- data
def synthetic_prices(seed=0, n=4000):
    """Regime-switching random walk: 250-day blocks of up/flat/down drift."""
    rng = np.random.default_rng(seed)
    regime = np.repeat(rng.choice([-1, 0, 1], size=n // 250 + 1), 250)[:n]
    rets = 0.0004 * regime + 0.012 * rng.standard_normal(n)
    idx = pd.bdate_range("2010-01-01", periods=n)
    return pd.Series(100 * np.exp(np.cumsum(rets)), index=idx, name="Close")


def load_prices(ticker=None, csv=None, start="2005-01-01", synthetic=False):
    if synthetic:
        return synthetic_prices(0)
    if csv:
        df = pd.read_csv(csv, parse_dates=["Date"], index_col="Date")
        return df["Close"].dropna().astype(float)
    import yfinance as yf
    df = yf.download(ticker, start=start, auto_adjust=True, progress=False)
    close = df["Close"]
    if isinstance(close, pd.DataFrame):  # newer yfinance returns a frame
        close = close.iloc[:, 0]
    close = close.dropna().astype(float)
    if close.empty:
        raise SystemExit(f"No prices downloaded for {ticker!r}; check the "
                         "ticker and network, or pass --csv")
    return close


# ---------------------------------------------------------------- target
def taper_weights(N):
    """w_i = 1 - (i/N)^2 for i = 1..N."""
    i = np.arange(1, N + 1)
    return 1.0 - (i / N) ** 2


def outlook_target(prices, N):
    """O_t = (1/Z_N) * sum_i w_i (P_{t+i} - P_t). NaN for the last N rows."""
    p = prices.to_numpy()
    w = taper_weights(N)
    Z = w.sum()
    assert np.isclose(Z, (N - 1) * (4 * N + 1) / (6 * N))  # closed form check
    out = np.full(len(p), np.nan)
    for t in range(len(p) - N):
        out[t] = np.dot(w, p[t + 1:t + N + 1] - p[t]) / Z
    return pd.Series(out, index=prices.index, name="outlook")


# ---------------------------------------------------------------- features
def feature_streams(prices):
    """Three streams at each window length: MA, standardized deviation, vol."""
    logret = np.log(prices).diff()
    cols = {}
    for k in WINDOWS:
        ma = prices.rolling(k).mean()
        sd = prices.rolling(k).std()
        cols[f"ma{k}"] = ma
        cols[f"z{k}"] = (prices - ma) / sd
        cols[f"vol{k}"] = logret.rolling(k).std()
    return pd.DataFrame(cols)


def build_inputs(streams):
    """For each date, stack the last HISTORY values of every stream, each
    history z-scored on its own window. Returns X (n, 6*HISTORY) and dates."""
    arr = streams.to_numpy()
    n, s = arr.shape
    rows, dates = [], []
    for t in range(HISTORY - 1, n):
        win = arr[t - HISTORY + 1:t + 1]          # (HISTORY, s)
        if np.isnan(win).any():
            continue
        mu, sd = win.mean(0), win.std(0) + 1e-8
        rows.append(((win - mu) / sd).T.reshape(-1))  # stream-major
        dates.append(streams.index[t])
    return np.asarray(rows, dtype="float32"), pd.DatetimeIndex(dates)


# ---------------------------------------------------------------- model
def build_model(input_dim):
    import keras
    from keras import layers

    x_in = keras.Input((input_dim,))
    h = layers.Dense(256, activation="relu")(x_in)
    h = layers.BatchNormalization()(h)
    h = layers.Dropout(DROPOUT)(h)

    for _ in range(2):  # residual blocks: 256 -> 512 -> 256, then add
        f = layers.Dense(512, activation="relu")(h)
        f = layers.BatchNormalization()(f)
        f = layers.Dropout(DROPOUT)(f)
        f = layers.Dense(256)(f)
        h = layers.Activation("relu")(layers.Add()([h, f]))

    h = layers.Dense(128, activation="relu")(h)
    h = layers.BatchNormalization()(h)
    h = layers.Dropout(DROPOUT)(h)
    h = layers.Dense(64, activation="relu")(h)
    h = layers.BatchNormalization()(h)
    out = layers.Dense(1, activation="tanh")(h)

    model = keras.Model(x_in, out)
    model.compile(optimizer=keras.optimizers.Adam(LR), loss="mae")
    return model


# ---------------------------------------------------------------- training
def prepare_asset(prices, N):
    """Inputs, scale-free target and dates for one price series.
    O_t is divided by P_t because the raw value scales with price."""
    X, dates = build_inputs(feature_streams(prices))
    y = (outlook_target(prices, N) / prices).reindex(dates).to_numpy()
    return X, y, dates


def chrono_split(n, N, test_frac, val_frac=0.15):
    """Train / validation / test index ranges in time order. An N-row gap
    before each later block keeps earlier labels (which look N rows ahead)
    from seeing prices inside it."""
    split = int(n * (1 - test_frac))
    vsplit = int((split - N) * (1 - val_frac))
    tr = np.arange(0, vsplit - N)
    va = np.arange(vsplit, split - N)
    te = np.arange(split, n)
    return tr, va, te


def train_outlook(X_tr, y_tr, X_va, y_va, epochs, verbose=2):
    """Fit on the target scaled by its train 95th percentile and clipped
    into the tanh range. Returns (model, scale)."""
    import keras

    scale = np.quantile(np.abs(y_tr), 0.95)
    norm = lambda y: np.clip(y / scale, -1, 1).astype("float32")
    model = build_model(X_tr.shape[1])
    stop = keras.callbacks.EarlyStopping(patience=8, restore_best_weights=True)
    model.fit(X_tr, norm(y_tr), validation_data=(X_va, norm(y_va)),
              epochs=epochs, batch_size=BATCH, shuffle=True,
              callbacks=[stop], verbose=verbose)
    return model, scale


def label_fit(signal, y, scale):
    """Out-of-sample MAE and direction hit rate where the label exists."""
    ok = ~np.isnan(y)
    y_n = np.clip(y[ok] / scale, -1, 1)
    s = np.asarray(signal)[ok]
    return np.mean(np.abs(s - y_n)), np.mean(np.sign(s) == np.sign(y_n))


# ---------------------------------------------------------------- backtest
def backtest(prices, signal, threshold=0.0, cost_bps=5):
    """Decide at close t, hold over t -> t+1. Cost charged on each switch."""
    px = prices.reindex(signal.index)
    fwd = px.pct_change().shift(-1).fillna(0.0)
    pos = (signal > threshold).astype(float)
    trades = pos.diff().abs().fillna(pos.iloc[0])
    strat = pos * fwd - trades * cost_bps / 1e4
    return pd.DataFrame({"strategy": strat, "buy_hold": fwd, "position": pos})


def portfolio_backtest(prices, signals, threshold=0.0, cost_bps=5):
    """prices, signals: DataFrames (dates x assets). Equal weight over the
    assets whose Outlook is above the threshold, cash when none are.
    Returns daily strategy returns, equal-weight basket returns, weights."""
    px = prices.reindex(signals.index)
    fwd = px.pct_change().shift(-1).fillna(0.0)
    on = (signals > threshold).astype(float)
    w = on.div(on.sum(axis=1).replace(0, np.nan), axis=0).fillna(0.0)
    turnover = w.diff().abs().sum(axis=1).fillna(w.iloc[0].abs().sum())
    strat = (w * fwd).sum(axis=1) - turnover * cost_bps / 1e4
    basket = fwd.mean(axis=1)
    return pd.DataFrame({"strategy": strat, "equal_weight": basket}), w


def regimes(prices, window=126, band=0.10):
    """Label each date bull / sideways / bear by the asset's return over a
    centred window. For evaluation only (it looks ahead by design)."""
    half = window // 2
    ret = prices.shift(-half) / prices.shift(half) - 1
    lab = pd.Series("sideways", index=prices.index)
    lab[ret > band] = "bull"
    lab[ret < -band] = "bear"
    return lab.where(ret.notna(), None)


def stats(r):
    eq = (1 + r).cumprod()
    yrs = len(r) / 252
    cagr = eq.iloc[-1] ** (1 / yrs) - 1 if yrs > 0 else np.nan
    sharpe = np.sqrt(252) * r.mean() / (r.std() + 1e-12)
    mdd = (eq / eq.cummax() - 1).min()
    return {"CAGR": cagr, "Sharpe": sharpe, "MaxDD": mdd, "Total": eq.iloc[-1] - 1}


def regime_table(returns, labels):
    """Annualised return and Sharpe of each column of `returns` per regime."""
    rows = {}
    labels = labels.reindex(returns.index)
    for reg in ("bull", "sideways", "bear"):
        m = labels == reg
        if m.sum() < 20:
            continue
        for col in returns:
            r = returns.loc[m, col]
            rows[(reg, col)] = {"days": int(m.sum()),
                                "ann_ret": r.mean() * 252,
                                "Sharpe": np.sqrt(252) * r.mean() / (r.std() + 1e-12)}
    return pd.DataFrame(rows).T


def plot(prices, signal, bt, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    px = prices.reindex(signal.index)
    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(px.index, px, color="tab:blue", lw=1, label="Price")
    d = bt["position"].diff()
    buys, sells = d[d > 0].index, d[d < 0].index
    ax.scatter(buys, px.loc[buys], marker="^", color="green", s=40, label="Buy")
    ax.scatter(sells, px.loc[sells], marker="v", color="red", s=40, label="Sell")
    ax2 = ax.twinx()
    ax2.plot(signal.index, signal, "g--", lw=0.8, label="Outlook")
    ax2.axhline(0, color="grey", lw=0.5)
    ax2.set_ylim(-1.05, 1.05)
    ax.legend(loc="upper left")
    ax2.legend(loc="upper right")
    ax.set_title("Outlook backtest (test period)")
    fig.tight_layout()
    fig.savefig(path, dpi=130)


def plot_equity(returns, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 5))
    for col in returns:
        ax.plot(returns.index, (1 + returns[col]).cumprod(), lw=1.2, label=col)
    ax.axhline(1, color="grey", lw=0.5)
    ax.legend(loc="upper left")
    ax.set_title(title)
    fig.tight_layout()
    fig.savefig(path, dpi=130)


# ---------------------------------------------------------------- main
def run_single(a):
    prices = load_prices(a.ticker, a.csv, a.start, a.synthetic)
    N = a.horizon
    print(f"{len(prices)} prices, {prices.index[0].date()} to {prices.index[-1].date()}")

    X, y, dates = prepare_asset(prices, N)
    tr, va, te = chrono_split(len(dates), N, a.test_frac)
    tr, va = tr[~np.isnan(y[tr])], va[~np.isnan(y[va])]

    model, scale = train_outlook(X[tr], y[tr], X[va], y[va], a.epochs)
    signal = pd.Series(model.predict(X[te], verbose=0).ravel(), index=dates[te])

    mae, hit = label_fit(signal, y[te], scale)
    print(f"\nTest MAE {mae:.3f} | direction hit rate {hit:.1%}")

    bt = backtest(prices, signal, a.threshold, a.cost_bps)
    rets = bt[["strategy", "buy_hold"]].rename(
        columns={"strategy": "Outlook", "buy_hold": "Buy & hold"})
    res = pd.DataFrame({c: stats(rets[c]) for c in rets})
    print(f"\nTest period {dates[te][0].date()} to {dates[te][-1].date()}")
    print(f"Time in market {bt['position'].mean():.0%}, "
          f"trades {int(bt['position'].diff().abs().sum())}")
    print(res.round(3).to_string())
    print("\nBy market regime:")
    print(regime_table(rets, regimes(prices)).round(3).to_string())

    plot(prices, signal, bt, "outlook_backtest.png")
    print("\nSaved chart to outlook_backtest.png")


def run_portfolio(a):
    if a.synthetic:
        prices = pd.DataFrame({f"SYN{i}": synthetic_prices(i)
                               for i in range(a.n_assets)})
    else:
        prices = pd.DataFrame({t: load_prices(t, start=a.start)
                               for t in a.tickers})
    prices = prices.dropna()  # common calendar so every asset splits alike
    N = a.horizon
    print(f"{prices.shape[1]} assets, {len(prices)} common dates, "
          f"{prices.index[0].date()} to {prices.index[-1].date()}")

    # One model, pooled over assets: more examples than any single series
    parts = {c: prepare_asset(prices[c], N) for c in prices}
    dates = next(iter(parts.values()))[2]
    tr, va, te = chrono_split(len(dates), N, a.test_frac)
    pool = lambda idx, j: np.concatenate([p[j][idx] for p in parts.values()])
    X_tr, y_tr, X_va, y_va = pool(tr, 0), pool(tr, 1), pool(va, 0), pool(va, 1)
    k_tr, k_va = ~np.isnan(y_tr), ~np.isnan(y_va)

    model, scale = train_outlook(X_tr[k_tr], y_tr[k_tr],
                                 X_va[k_va], y_va[k_va], a.epochs)
    signals = pd.DataFrame(
        {c: model.predict(p[0][te], verbose=0).ravel() for c, p in parts.items()},
        index=dates[te])

    mae, hit = label_fit(signals.to_numpy().ravel(),
                         np.column_stack([p[1][te] for p in parts.values()]).ravel(),
                         scale)
    print(f"\nTest MAE {mae:.3f} | direction hit rate {hit:.1%}")

    rets, w = portfolio_backtest(prices, signals, a.threshold, a.cost_bps)
    rets.columns = ["Outlook portfolio", "Equal weight"]
    if a.benchmark:
        bench = load_prices(a.benchmark, start=a.start)
        rets[a.benchmark] = (bench.pct_change().shift(-1)
                             .reindex(rets.index).fillna(0.0))
    res = pd.DataFrame({c: stats(rets[c]) for c in rets})
    print(f"\nTest period {dates[te][0].date()} to {dates[te][-1].date()}")
    print(f"Average assets held {(w > 0).sum(axis=1).mean():.1f} of {w.shape[1]}, "
          f"fully in cash {(w.sum(axis=1) == 0).mean():.0%} of days")
    print(res.round(3).to_string())

    # Regime of the market: the benchmark if given, else the basket
    mkt = (bench if a.benchmark else (1 + rets["Equal weight"]).cumprod())
    print("\nBy market regime:")
    print(regime_table(rets, regimes(mkt)).round(3).to_string())

    plot_equity(rets, "outlook_portfolio.png", "Outlook portfolio (test period)")
    print("\nSaved chart to outlook_portfolio.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", default="SPY")
    ap.add_argument("--tickers", nargs="+",
                    help="several tickers: train one pooled model, run the portfolio")
    ap.add_argument("--benchmark", help="cap-weighted benchmark ticker, e.g. SPY")
    ap.add_argument("--csv")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--n-assets", type=int, default=0,
                    help="with --synthetic, run the portfolio on this many assets")
    ap.add_argument("--start", default="2005-01-01")
    ap.add_argument("--horizon", type=int, default=21, help="N, trading days")
    ap.add_argument("--threshold", type=float, default=0.0)
    ap.add_argument("--cost-bps", type=float, default=5)
    ap.add_argument("--test-frac", type=float, default=0.25)
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    a = ap.parse_args()

    if a.tickers or (a.synthetic and a.n_assets > 1):
        run_portfolio(a)
    else:
        run_single(a)


if __name__ == "__main__":
    main()
