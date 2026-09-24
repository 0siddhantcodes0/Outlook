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
   flat otherwise. Compared with buy and hold, overall and for each
   regime (bull, sideways or bear).
5. **Portfolio:** one model is trained on all the assets together. Capital
   is split equally among the assets with a positive Outlook. Compared with
   an equal-weight basket and a cap-weighted benchmark ticker if you give one.

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

Options: `--horizon` (N, default 21), `--threshold`, `--cost-bps`,
`--test-frac` and `--epochs`.

Regime labels come from a centred 126-day return (±10%). They look ahead
on purpose: they are only used to group results for evaluation, never as
an input to the model.
