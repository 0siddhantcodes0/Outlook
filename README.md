# Outlook

A learned indicator of an asset's medium-term price trend. It estimates
whether the price is likely to stay above or below its current level over the
next `N` trading days, with nearer days counting more.

## Target

$$O_t = \frac{1}{Z_N}\sum_{i=1}^{N} w_i\,(P_{t+i} - P_t), \qquad
w_i = 1 - (i/N)^2, \qquad Z_N = \sum_i w_i = \frac{(N-1)(4N+1)}{6N}$$

`O_t / P_t` is the training label, so it doesn't depend on the price level.
It is scaled by its 95th percentile on the training data and clipped to
[-1, 1] to match the tanh output. Two paths with the same start and end
price get different labels: a path that rises early is positive and one
that falls early is negative.

## Pipeline

1. **Features:** a moving average, a standardized deviation from it, and
   log-return volatility at 5- and 10-day windows. The model sees the last
   200 days of each stream (1,200 inputs), and each window is z-scored on
   its own values.
2. **Model:** a residual MLP with a tanh output, MAE loss, Adam at 1e-3 and
   early stopping.
3. **Split:** train, validation and test run in time order. An `N`-day gap
   sits before each later block, so earlier labels never see its prices.
4. **Single asset:** go long when Outlook is above the threshold and stay
   flat otherwise. Compared with buy and hold and with two classic rules
   run the same way, overall and for each regime (bull, sideways or bear).
   The rules are: hold when the price is above its 200-day moving average,
   and hold when the past 12 months' return is positive. Outlook only adds
   value if it beats these free rules.
5. **Portfolio:** one model is trained on all the assets together. Capital
   is split equally among the assets with a positive Outlook. Compared with
   an equal-weight basket, the same rule driven by the two classic signals,
   and a cap-weighted benchmark ticker if you give one.

## Usage

```bash
pip install -r requirements.txt
python outlook.py --ticker XIU.TO                            # single asset
python outlook.py --csv prices.csv                           # columns: Date, Close
python outlook.py --tickers AAPL MSFT JPM XOM --benchmark SPY
python outlook.py --synthetic                                # offline smoke test
python outlook.py --synthetic --n-assets 5                   # offline portfolio
python -m pytest -q tests
```

**Walk-forward.** `--walk-forward 2 --wf-start 2000` retrains the model every
two years on all the data before that point, then tests it on the two years
after. The test covers every year from 2000 on, rather than only the last 25%
of the data. It works in both single-asset and portfolio mode:

```bash
python outlook.py --csv data/SPY.csv --walk-forward 2 --wf-start 2000
```

Options: `--horizon` (N, default 21), `--threshold`, `--cost-bps`,
`--test-frac` and `--epochs`.

**Variations** (all off by default):

- `--band 0.2` trades less. It switches into an asset only when the score
  rises above +0.2 and out only when it falls below −0.2. In between it
  keeps the current position, which avoids flipping in and out around zero.
- `--trend-features` adds the 200-day moving-average gap and the 12-month
  return to the model's inputs as raw values. The existing streams are
  z-scored within each 200-day window, which hides whether the price is
  above or below its long-run trend.
- `--top 3 --rebalance 21` (portfolio mode) holds the 3 highest-scoring
  assets and re-picks them every 21 trading days, instead of holding every
  asset with a positive score. The baseline rules are ranked the same way,
  so the comparison stays fair.

```bash
python outlook.py --tickers XEG.TO XFN.TO XIT.TO XRE.TO --benchmark XIU.TO \
  --start 2001-01-01 --walk-forward 2 --wf-start 2008 --band 0.2
```

Regime labels come from a centred 126-day return (±10%). They look ahead
on purpose: they are only used to group results for evaluation, never as
an input to the model.

## Sample data

`data/SPY.csv` holds daily SPY closes (Feb 1993 – Apr 2018). They are built by
compounding the daily total returns (dividends reinvested) in Zipline's
bundled `SPY_benchmark.csv`, starting at 100. It lets you run the model
without a network connection:

```bash
python outlook.py --csv data/SPY.csv
```
