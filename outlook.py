"""
Outlook: a learned medium-term trend indicator.

Implements the writeup end to end:
  1. Target: quadratic-tapered, weighted average of future price displacements
  2. Features: MA, standardized deviation, and volatility streams at 5 and 10
     day windows, 200 days of history each (1,200 inputs)
  3. Model: residual MLP, tanh output, MAE loss, Adam 1e-3, 30 epochs
  4. Backtest: long when the signal is above a threshold, flat otherwise,
     compared with buy and hold on an out-of-sample test period

Setup:
  pip install keras tensorflow yfinance pandas numpy matplotlib

Run:
  python outlook.py --ticker XIU.TO
  python outlook.py --csv prices.csv          # columns: Date, Close
  python outlook.py --synthetic               # offline smoke test
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
def load_prices(ticker=None, csv=None, start="2005-01-01", synthetic=False):
    if synthetic:
        rng = np.random.default_rng(0)
        n = 4000
        regime = np.repeat(rng.choice([-1, 0, 1], size=n // 250 + 1), 250)[:n]
        rets = 0.0004 * regime + 0.012 * rng.standard_normal(n)
        idx = pd.bdate_range("2010-01-01", periods=n)
        return pd.Series(100 * np.exp(np.cumsum(rets)), index=idx, name="Close")
    if csv:
        df = pd.read_csv(csv, parse_dates=["Date"], index_col="Date")
        return df["Close"].dropna().astype(float)
    import yfinance as yf
    df = yf.download(ticker, start=start, auto_adjust=True, progress=False)
    close = df["Close"]
    if isinstance(close, pd.DataFrame):  # newer yfinance returns a frame
        close = close.iloc[:, 0]
    return close.dropna().astype(float)


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


# ---------------------------------------------------------------- backtest
def backtest(prices, signal, threshold=0.0, cost_bps=5):
    """Decide at close t, hold over t -> t+1. Cost charged on each switch."""
    px = prices.reindex(signal.index)
    fwd = px.pct_change().shift(-1).fillna(0.0)
    pos = (signal > threshold).astype(float)
    trades = pos.diff().abs().fillna(pos.iloc[0])
    strat = pos * fwd - trades * cost_bps / 1e4
    return pd.DataFrame({"strategy": strat, "buy_hold": fwd, "position": pos})


def stats(r):
    eq = (1 + r).cumprod()
    yrs = len(r) / 252
    cagr = eq.iloc[-1] ** (1 / yrs) - 1 if yrs > 0 else np.nan
    sharpe = np.sqrt(252) * r.mean() / (r.std() + 1e-12)
    mdd = (eq / eq.cummax() - 1).min()
    return {"CAGR": cagr, "Sharpe": sharpe, "MaxDD": mdd, "Total": eq.iloc[-1] - 1}


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


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", default="SPY")
    ap.add_argument("--csv")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--start", default="2005-01-01")
    ap.add_argument("--horizon", type=int, default=21, help="N, trading days")
    ap.add_argument("--threshold", type=float, default=0.0)
    ap.add_argument("--cost-bps", type=float, default=5)
    ap.add_argument("--test-frac", type=float, default=0.25)
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    a = ap.parse_args()

    prices = load_prices(a.ticker, a.csv, a.start, a.synthetic)
    N = a.horizon
    print(f"{len(prices)} prices, {prices.index[0].date()} to {prices.index[-1].date()}")

    # Target, made scale free by dividing by P_t (raw O_t scales with price)
    y_raw = outlook_target(prices, N) / prices

    X, dates = build_inputs(feature_streams(prices))
    y = y_raw.reindex(dates).to_numpy()

    # Chronological split with an N-day gap so train labels never
    # see prices inside the test period
    n = len(dates)
    split = int(n * (1 - a.test_frac))
    tr = np.arange(0, split - N)
    te = np.arange(split, n)
    tr = tr[~np.isnan(y[tr])]

    # Normalize the target with train data only, clip into tanh range
    scale = np.quantile(np.abs(y[tr]), 0.95)
    y_n = np.clip(y / scale, -1, 1).astype("float32")

    model = build_model(X.shape[1])
    model.fit(X[tr], y_n[tr], validation_split=0.15, epochs=a.epochs,
              batch_size=BATCH, shuffle=True, verbose=2)

    signal = pd.Series(model.predict(X[te], verbose=0).ravel(), index=dates[te])

    # Out-of-sample label fit (only where the label exists)
    ok = ~np.isnan(y[te])
    mae = np.mean(np.abs(signal.values[ok] - y_n[te][ok]))
    hit = np.mean(np.sign(signal.values[ok]) == np.sign(y_n[te][ok]))
    print(f"\nTest MAE {mae:.3f} | direction hit rate {hit:.1%}")

    bt = backtest(prices, signal, a.threshold, a.cost_bps)
    res = pd.DataFrame({"Outlook": stats(bt["strategy"]),
                        "Buy & hold": stats(bt["buy_hold"])})
    print(f"\nTest period {dates[te][0].date()} to {dates[te][-1].date()}")
    print(f"Time in market {bt['position'].mean():.0%}, "
          f"trades {int(bt['position'].diff().abs().sum())}")
    print(res.round(3).to_string())

    plot(prices, signal, bt, "outlook_backtest.png")
    print("\nSaved chart to outlook_backtest.png")


if __name__ == "__main__":
    main()
