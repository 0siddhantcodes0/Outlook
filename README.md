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

## Leveraged ETF backtester (`leverage.py`)

Tests three ways of using daily-reset leveraged ETFs (BetaPro, Direxion
and similar) on real prices, with costs fitted to the real funds.

| Mode | What it tests |
|---|---|
| `hold` | Holding an L× fund on an index, optionally only while the index is above its 200-day average (cash earns T-bills otherwise) |
| `swing` | Trading a real fund every few days, buying at the open or near the close and selling at the open or near the close, from daily open/close prices |
| `rotate` | Each month, holding the top K sectors by recent momentum as L× funds. It also reruns the rule on every possible rebalance day, because one run can look great or terrible purely from which day of the month it trades |
| `signal` | Today's picks for the 2x sector rotation: which BetaPro funds to hold, from the latest close |

```bash
python leverage.py swing --ticker SOXL --entry open --exit close --hold 3 --cost-bps 5
python leverage.py swing --ticker SOXL --entry close --exit open --hold 3 --trend-index SOXX
python leverage.py hold --index SPY --leverage 3 --trend --start 2000-01-01
python leverage.py rotate --indexes SOXX QQQ XEG.TO XFN.TO GDX SPY --leverage 3 --top 2 --trend
```

**Monthly signal.** `signal` ranks the indexes behind six BetaPro 2x
TSX-listed funds by their 3-month return:

| Index | Fund |
|---|---|
| QQQ | QQU |
| SPY | SPXU |
| XEG | NRGU |
| XFN | CFOU |
| XGD | GDXU |
| XIU | CNDU |

It picks the top 2, and sends a pick's share to cash when its index is
below its 200-day average. `--capital` shows dollar amounts for a leveraged
sleeve of `--satellite` (default 25%) of the portfolio:

```bash
python leverage.py signal --capital 20000
```

Tested from 2003 to 2026 on all 21 rebalance days, this rotation at 2x made
a typical 14.6% a year (range 5.7–20.9%), with typical worst drops of −60%.
As a 25% sleeve beside 75% S&P 500, rebalanced every January, the total made
13.0% a year (range 11.0–14.9%) with a −52% worst drop. Holding the S&P 500
alone made 11.8% a year with a −55% worst drop.

**How simulated funds work.** Each day a simulated fund returns L × the
index, minus (L−1) × the T-bill rate for the money it borrows, minus a
yearly cost per unit of extra leverage. That cost was fitted on 2010–2026
daily prices of the real funds, and it is far above the 1.15% management fee:

| Real fund | Tracks | Yearly cost per unit of extra leverage |
|---|---|---|
| CNDU | 2x TSX 60 | 2.58% |
| SPXU.TO | 2x S&P 500 | 4.56% |
| QQU | 2x Nasdaq-100 | 4.59% |
| NRGU | 2x TSX energy | 1.59% |
| CFOU | 2x TSX financials | 1.72% |
| GDXU | 2x gold miners | 1.00% |
| SOXL (US) | 3x semiconductors | 2.03% |

**Cost per trade matters.** `swing` charges `--cost-bps` on every buy and
sell. That covers half the bid-ask spread plus commission. The spread is
tiny for US SOXL, but TSX BetaPro funds trade $1–20M a day, so their
spreads are wider. At 80+ round trips a year, 0.10% per side costs about
17% a year.

## Portfolio backtester in CAD (`portfolio.py`)

This backtests fixed-weight ETF portfolios in Canadian dollars. US-listed
funds are converted at the daily CADUSD rate. Holdings drift between
rebalances; at each rebalance they reset to target weights, with a cost
charged on what gets traded.

It includes the **Higher growth** portfolio from
[kellyportfolios.com](https://kellyportfolios.com/portfolios/higher-growth/),
as published on 6 Sep 2026, in several versions:

| Key | What it holds |
|---|---|
| `us` | The eight original US-listed funds |
| `hybrid` | RSST, which has no Canadian equivalent, held in an RRSP, plus Canadian-listed substitutes for the other seven funds |
| `canadian` | All Canadian-listed, with XUS taking RSST's place (this loses the trend-following part) |
| `us-factors` / `canadian-factors` | Just the value and momentum part (the 65% outside RSST), rescaled to 100%. These funds have prices from Oct 2021, so the comparison covers 2022 |
| `xeqt` | Plain all-equity benchmark |

```bash
python portfolio.py compare                    # us, hybrid, canadian and xeqt, yearly rebalance
python portfolio.py compare --portfolios us-factors canadian-factors xeqt
python portfolio.py holdings --portfolio hybrid --capital 50000
```

Results in CAD with real funds (yearly rebalancing, 10 bps per unit traded):

| Portfolio | Sep 2023 – Sep 2026 | Worst drop |
|---|---|---|
| US original | 25.7%/yr | −19.2% |
| Hybrid | 23.3%/yr | −18.9% |
| All Canadian | 23.1%/yr | −15.2% |
| XEQT | 21.6%/yr | −15.1% |

| Value + momentum part only | Oct 2021 – Sep 2026 | Worst drop |
|---|---|---|
| US funds | 18.3%/yr | −17.9% |
| Canadian substitutes | 14.7%/yr | −21.2% |
| XEQT | 14.1%/yr | −19.1% |

The Canadian substitutes mostly behave like XEQT. The parts of the portfolio
that differ most from the market, RSST's trend stack and the small-cap value
and emerging-markets value funds, have no Canadian-listed equivalent.
Adjusted prices add dividends back in full, so the 15% US withholding tax
that applies outside an RRSP is not deducted.

## Leverage playbook for a Canadian account (`playbook.py`)

This is a rules-based plan for TSX-listed BetaPro funds, priced in CAD and
tradeable commission-free on Wealthsimple. It uses two engines, which make
money at different times.

| Engine | Rule | Holds |
|---|---|---|
| **Ladder** | Cash whenever the index closes below its 200-day average. Above it: tier = floor(25% ÷ 20-day volatility), from 1x up to the highest version available. Rechecked on Fridays; a break below the 200-day average acts the same day | Nasdaq: TQQQ.TO / QQU / XQQ / CASH.TO · S&P: TSPX / SPXU / XSP · Semis: BetaPro SOXL / XCHP · Energy: NRGU / XEG |
| **Dip** | Brandon's RSI 6–10 rules on 3x Nasdaq. Five sleeves; each buys at the close when its RSI is at or below 28, and sells at the close once it's back above 28 | TQQQ.TO, otherwise CASH.TO |

| Preset | Weights | Aug 2002 – Oct 2026 (simulated) | Worst drop | Losing years |
|---|---|---|---|---|
| `aggressive` | 50% Nasdaq ladder, 50% dip | 17.3%/yr | −20% | 2 of 25 |
| `diversified` | 40% Nasdaq ladder, 30% dip, 15% semis ladder, 15% energy ladder | 15.7%/yr | −16% | 2 of 25 |
| `design-f` | 50% QLD V1.1, 50% dip | 40.2%/yr | −34% | 4 of 25 |
| Nasdaq 1x, hold | | 15.8%/yr | −54% | 3 of 25 |
| 3x Nasdaq, hold | | about 19.6%/yr | −95% | |

Simulated funds use yearly costs fitted to the real BetaPro 2x funds
(2010–2026), plus 0.1% per trade. With an extra 2% per unit of leverage,
which is roughly today's CAD hedging cost, `aggressive` made 16.8%/yr.

**The dip engine depends on buying at the close of the signal day.** Buying
one close later cut its return from about 27% to about 6% a year. RSI dip
rules also failed on the TSX 60 and on energy, so the dip engine trades only
3x Nasdaq.

```bash
python playbook.py report                                   # what to hold now
python playbook.py report --capital 20000                   # first buys for a new account
python playbook.py report --holdings holdings.csv --cash 500 --preset diversified
python playbook.py backtest --preset aggressive --extra-cost 0.02
```

**Holdings file.** Columns are `ticker,shares,avg_cost`, for example
`TQQQ.TO,100,30.00`. Name it `holdings*.csv`, which `.gitignore` keeps out of
this public repository, or put its contents in the `HOLDINGS_CSV`
environment variable.

### Daily Telegram report

1. In Telegram, message **@BotFather**, send `/newbot` and follow the steps.
   Copy the token it gives you.
2. Send any message to your new bot. Then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat` → `id` number.
3. Test it from your computer:
   `TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... python playbook.py report --telegram`
4. To send it from GitHub:
   - In the repository settings, add the secrets `TELEGRAM_BOT_TOKEN`,
     `TELEGRAM_CHAT_ID` and optionally `HOLDINGS_CSV`.
   - Add the variable `PLAYBOOK_ENABLED` = `true`, and optionally
     `PLAYBOOK_PRESET`.
   - Use **Actions → playbook-report → Run workflow** to test it.
5. Start the workflow on a schedule from outside GitHub. GitHub's own
   scheduler started this job 2½ to 6 hours late in October 2026, after the
   close, so the workflow has no schedule of its own. Instead, something
   that keeps time calls GitHub's API at about 9:45 AM and 3:33 PM Toronto
   time on weekdays. Here that is a Claude routine; a cron job with a token
   that can run workflows works too:
   `POST /repos/<owner>/<repo>/actions/workflows/playbook-report.yml/dispatches`
   with body `{"ref": "main"}`. Started this way, the run begins within
   seconds.

The message starts with **MARKET OPEN update** or **CLOSE update**. Morning
numbers are provisional, because the plan acts on prices near 4:00 PM.

**Price board.** Each report ends with a board of the funds to watch: price,
today's change, the change over 5 trading days, and whether the fund is above
(▲) or below (▼) its own 200-day average. ★ marks a fund in today's plan,
with its weight. The groups are Nasdaq (QQQ, XQQ, TQQQ.TO), semis (SOXX,
XCHP, SOXL, SOXS), energy (XEG, NRGU), oil and gas (crude, HOU, natural gas,
HNU) and volatility (VIX, VOLX). Yahoo has no prices for the TSX-listed
SOXL/SOXS, so the board shows the US funds, in USD.

Funds marked **watch** are on the board for their price action only. They
are never signals, because on the real funds' prices they lost money:

| Real fund prices, 2008–2026 | Per year |
|---|---|
| Hold HOU (2x crude oil) | −35.7% |
| Hold HNU (2x natural gas) | −61.9% |
| Hold VOLX (VIX futures) | −47.7% |
| SOXL above SOXX's 200-day average, cash below | +25.6% |
| Same, but SOXS instead of cash below (2010–2026) | −20.8% |
| TQQQ above QQQ's 200-day average, cash below | +32.2% |
| Same, but SQQQ instead of cash below | +5.0% |

Even in 2022, when semis fell all year, holding SOXS through the downtrend
did worse than cash (−89% vs −72%). Sharp rallies inside bear markets wreck
3x inverse funds, so the plan holds cash when the trend is down.

### Design F: QLD V1.1 plus the dip engine

`design-f` puts half the account in **QLD V1.1** and half in the RSI dip engine. QLD V1.1 is
"QLD For The Long Term V1.1", Composer symphony `k2fx2fSEydTaAzW4YkiY`. It holds one fund at
a time, and the first matching rule wins:

```
if SPY > its 200-day average:  TLT if RSI(QLD,10) > 79, else QLD
elif RSI(QQQ,10) < 30:         QLD or SHY, whichever has the lower RSI(12)
elif RSI(SPY,10) < 30:         SSO or SHY, whichever has the lower RSI(12)
elif QLD > its 20-day average: QID if RSI(QID,9) < 31, else QLD
else:                          QID or BSV, whichever has the higher RSI(10)
```

Signals read the US funds. The report names the TSX fund to buy for each one:

| Signal | Buy | Daily corr. with the US fund |
|---|---|---|
| QLD (2x Nasdaq) | QQU.TO | 1.00 |
| QID (2x short Nasdaq) | QQD.TO | 1.00 |
| SSO (2x S&P 500) | SPXU.TO | 1.00 |
| TLT (US long bonds) | XTLH.TO | 0.99 |
| SHY / BSV | CASH.TO | |

The bot's QLD V1.1 picks matched the symphony's own signal history on all 597 days
checked (June 2024 to October 2026). The two halves make money at different times (daily
correlation 0.43). That's why the blend's worst drop is much smaller than QLD V1.1's own.

| 2000–2026, US funds, same-close fills | Per year | Worst drop | One day late |
|---|---|---|---|
| QLD V1.1 alone | 58.1% | −82% | 15.4% |
| `design-f` | 44.9% | −47% | 13.8% |
| `diversified` | 16.1% | −27% | 10.8% |

Like the dip engine, QLD V1.1 needs trades done before 4:00 PM on the signal day. It also
switches about 21 times a year. In a TFSA, trading that often can lead the CRA to tax the
account as a business, so an RRSP is the safer place for it.

By default, the Telegram workflow adds a short **Design F preview** to each report until
you make it your plan. Set the repository variable `PLAYBOOK_PRESET` to `design-f` to switch,
or set `PLAYBOOK_ALSO` to `none` to drop the preview.

## Strategy lab (`lab.py`)

Rebuilds the Composer strategies in the Azqato and Composer Atlas guides and tests them, with
these presets, on the years they weren't tuned on. Before each leveraged fund existed, its
returns are simulated from its index with a cost fitted to the real fund, so every test
reaches back to 2000. That covers the dot-com crash and 2008, while the Composer rules were
fitted on 2012 onward.

```bash
python lab.py compare                       # every strategy, every era, and one day late
python lab.py jitter --strategy design-f    # results with every threshold nudged at random
```

| Per year / worst drop | 2012–26 (tuned) | 2000–12 (unseen) | Dot-com crash |
|---|---|---|---|
| Excellent Adventure 2027 | 142% / −46% | −20% / −100% | −89% / −100% |
| QLD V1.1 | 71% / −37% | 45% / −82% | −14% / −82% |
| TQQQ For The Long Term | 159% / −54% | 31% / −91% | −49% / −91% |
| Holy Grail | 132% / −47% | 27% / −79% | −41% / −79% |
| 9 Sig | 40% / −77% | −15% / −99% | −79% / −98% |
| `design-f` | 46% / −25% | 44% / −47% | 36% / −47% |
| `diversified` | 18% / −14% | 14% / −27% | 11% / −27% |
| Hold TQQQ | 39% / −82% | −36% / −100% | −95% / −100% |

VXX before 2018 is modelled from the VIX index, which is the roughest input. It only affects
Excellent Adventure.
