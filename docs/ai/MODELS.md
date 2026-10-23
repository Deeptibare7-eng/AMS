# IT-HAMS AI layer: models and checks

Every algorithm here is our own JavaScript (no ML library, no LLM). Each model follows the contract in
`src/ai/models/baseModel.js`: `train`, `predict` (value + confidence 0–1), `explain` (top factors in plain
language), `evaluate`, `save`/`load` through the model registry (`ai_models`, versioned).

**Measured on the real register** (`it_hams_v3`, 26,736 assets) on 2026-10-23, read-only.
Re-run it any time with:

```bash
node bin/hams-cli.js ai:eval            # time split at 2024-01-01 (default)
node bin/hams-cli.js ai:eval 2025-01-01 # another cut-off
```

---

## 1. Intake classifier (`src/ai/intake/classifier.js`)

**What it does.** From what someone types on Register Asset (name, model number, serial), it suggests the
category, the manufacturer and the catalog model.

**Features** (`models/text/tokenize.js`):
- the words of the name and model number,
- character 3–5-grams inside each word, which are robust to typos and to "Latitude5420" vs "Latitude 5420",
- the whole model number,
- the serial's first three characters and its length (makers use recognisable serial formats).

**Category and manufacturer heads.**
- Two candidates are trained on the older 90% of assets by purchase date:
  - multinomial **Naive Bayes** (`models/naiveBayes.js`, Laplace smoothing α = 0.5),
  - softmax **logistic regression** (`models/logisticRegression.js`): hashed features (2¹⁷ slots), TF-IDF
    weighting, AdaGrad SGD, L2, 5 epochs, seeded.
- The candidate with the higher macro-F1 on the newest 10% wins.
- Its confidence is then calibrated on that newest 10% by **temperature scaling**: one parameter, fitted to
  minimise log loss.
- Finally the winner is retrained on all assets, keeping that temperature.

**Model "head" = catalog matching** (`intake/modelMatcher.js`).
- A classifier can't name a model no earlier asset had. On the time split below, 3,969 of the 5,347 newer
  assets are such models.
- So the typed text is matched against the **Asset Models catalog**, which does list new models:
  - TF-IDF over words and character 3–4-grams, scored by cosine similarity through an inverted index;
  - the result is filtered to the chosen manufacturer when there is one.
- The match score and its margin over the runner-up become a probability with **Platt scaling**, fitted on
  6,000 past assets.

**Results.** Trained on 21,389 assets bought before 2024-01-01, tested on the 5,347 bought since:

| Target | Method chosen | Accuracy | Macro-F1 | Top-3 | Calibration error (ECE) | Precision when confidence ≥ 0.9 (share of answers) |
|---|---|---:|---:|---:|---:|---|
| Category | logistic regression | 99.3% | 73.2% | 100.0% | 0.005 | 99.6% (99.4%) |
| Manufacturer | logistic regression | 98.9% | 73.1% | 99.7% | 0.042 | 99.2% (80.2%) |
| Catalog model | catalog match | 99.3% | 98.6% | 100.0% | 0.005 | 99.3% (100%) |

- **Model choice.** Measured on the newest 10% of the training slice:
  - category: Naive Bayes 89.6%, logistic regression 94.4% macro-F1;
  - manufacturer: Naive Bayes 85.6%, logistic regression 99.8%.
- **Training** takes about 9 s in a worker thread, and the saved model is about 12.6 MB.
- **Known weak spots:**
  - **Desktops bought since 2024:** only 25 in the test slice, recall 16%. Their names don't look like the
    older desktops'.
  - **Rare makers** (Microsoft 12, Acer 1) are never predicted. Their low per-class scores are why macro-F1
    sits far below accuracy.
- **When suggestions appear:**
  - only when confidence is 50% or more;
  - warranty, supplier and cost defaults only once the model is known (picked by the user, or matched with
    80% or more confidence);
  - nothing is filled in until the user clicks **Use**.
- **Retraining:**
  - weekly, Sunday 03:00, and on the first switch-on;
  - a new version is activated only if its held-out macro-F1 is within 0.01 of the active one's (or better).

## 2. Smart defaults (`intake/defaults.js`)

Nearest neighbours by catalog model:
- **Warranty:** the most common warranty term (months between warranty start and end) among assets of
  that model, with its share as the confidence.
- **Supplier:** the most common supplier for that model at the chosen location, or everywhere when the
  location has fewer than 3.
- **Cost:** the median cost of the last 3 years, or of all years when there are fewer than 3 recent
  purchases. The confidence falls as the spread between the 25th and 75th percentile grows.
- **Minimum:** 3 similar assets.

## 3. Duplicate warnings (`quality/duplicates.js`)

Matches are exact after normalising:
- **Serial** without case, spaces or dashes. The app itself only refuses an identical serial.
- **FAMS barcode number**, with placeholders ignored: "Pending", "N/A", "Client Provided", "0".
- **Host name**: one token, not a stock code, note or vendor label.

**Not flagged on purpose: serials one character apart.**
- On the real register there are 3,704 such pairs.
- They come out as look-alike characters 1,387, swaps 1,670, and insertions/deletions 647. Nearly all are
  siblings from one order: Dell tags in a batch share most characters (80C4271 / B0C4271 / G0C4271).
- The check was built (deletion-neighbourhood index + Damerau distance), measured, and removed as too noisy.

## 4. Category consistency (`quality/categoryCheck.js` + rules)

- **Out-of-fold logistic regression.** Assets are split into 5 folds by id, and each fold is predicted by a
  model trained on the other four. An asset is therefore never judged by a model that learnt its own label.
- **"Category looks wrong" (medium)** needs two independent signals:
  - 80% or more of the model's 5+ assets use another category, AND
  - the out-of-fold classifier reads the asset that way with 0.8 or more confidence.
  - Confidence is the weaker of the two.
  - Real register: 26 assets.
- **"Category and model disagree" (low)** is the first signal alone: either the category or the model is
  wrong. On the real register this is 298 assets, many of them real VMs given a laptop or desktop model
  (e.g. "vmappd01-VM" on Latitude 5410), so no change is proposed for these.
- **Catalog fix.** An Asset Models entry is flagged when 80% or more of its 20+ assets disagree with it.
  Real register:
  - "Latitude E5450" is filed as VM, but 621 of 729 of its assets are Laptops;
  - "OptiPlex 7010" is filed as VM, but 822 of 910 are Desktops.

The ML-only check was measured and dropped: 50 mismatches at p ≥ 0.8, some for spurious reasons such as a
person's name inside a VM's host name.

## 5. Catalog spelling duplicates (`quality/catalog.js`)

- **Candidates:** **MinHash** signatures (64 hashes over 3-character shingles) with **LSH** banding (32 bands
  of 2 rows) propose candidate pairs without comparing every pair.
- **Confirmation:** a pair is a spelling variant only when the names are equal ignoring case, spaces and
  punctuation, or differ by a small typo (Damerau ≤ 2) in one 6+-letter word without digits.
- **Real register:** 6 groups, for example "OptiPlex 5050" / "Optiplex 5050" and
  "ThinkCentre M720 Tower" / "ThinkCenter M720 Tower".
- **What isn't a variant:** "Latitude E5450" / "Latitude 5450", "760" / "760n" and "Type 21ME" / "21MC" are
  different models, and correctly not paired.

## 6. Data health score (`quality/rules.js`, `quality/dataHealth.js`)

- **Score:** each active asset gets **100 − Σ (30 high, 15 medium, 5 low) × confidence**, floored at 0.
- **Grades:** Good 90+, Fair 70–89, Poor below 70.
- **Retired assets** are not scored.

Real register, dry run on 2026-10-23: **average 83**. 8,989 Good, 3,681 Fair, 5,346 Poor; 6.4 s for
18,016 active assets.

| Issue | Severity | Assets |
|---|---|---:|
| Not linked to a purchase order | low | 7,547 |
| No purchase cost | medium | 6,108 |
| No FAMS barcode (blank, placeholder or not a barcode; client-provided assets excluded) | medium | 6,015 |
| No supplier | low | 2,708 |
| In Stock but returned to client (Machine Name) | high | 1,787 |
| No warranty term (start = end) | low | 1,234 |
| Machine Name holds a note | low | 355 |
| Category and model disagree | low | 298 |
| FAMS barcode on another asset | medium | 298 |
| Catalog model has a spelling variant | low | 265 |
| Host name on another asset | medium | 166 |
| In Stock but with a vendor | medium | 76 |
| Category looks wrong | medium | 26 |
| FAMS barcode has a note | low | 12 |
| Cost far from similar assets (<25% or >300% of the model median, 10+ peers) | medium | 9 |
| Stock site code not recognised | medium | 8 |
| Deployed but named as stock | medium | 7 |
| Serial number on another asset (written differently) | high | 2 |
| Status and holder disagree | high | 2 |

**Module scores:**

| Module | Score | What it measures |
|---|---:|---|
| Hardware | 83 | Average asset score |
| Catalog | 65 | Models filed under their assets' category 217/219; without a spelling variant 424/436; with an end-of-life period 0/436 |
| People | 0 | Employees with a real name 10/7,204, email 0, department 0, location 10 (the directory holds CTIDs only) |
| Procurement | 89 | POs with a vendor 461/461, with an amount 458/461, linked to assets 461/461; active assets linked to a PO 10,469/18,016 |

**Proposals.** The scan would propose 18 fixes in AI Approvals:
- 16 asset groups covering 26 assets, grouped by model, location and category change;
- the 2 catalog fixes.

A pending fix whose problem has gone is marked expired at the next scan.

## 7. Smart search (M3, `search/`)

**What it does.** It ranks assets for the words typed in the Hardware search box or Ctrl+K, across 15 fields,
and says why each one matched.

**Analysis** (`search/analyzer.js`, the same for the index and the query):
- lower case, accents removed;
- plurals ("laptops" → laptop);
- CTID / host-name parts ("RaviK7" → ravik7 + ravi + k7);
- model numbers without their letter prefix ("E5450" → also 5450);
- identifiers also as one compact word ("CM7QX512-001" → cm7qx512001);
- units ("16 GB" → 16gb);
- "L&T" → lnt;
- stop words dropped.

**Ranking: BM25F** (`search/bm25.js`).
- For each field f:
  `tf~ = Σ_f w_f · tf_f / (1 − b_f + b_f · len_f / avglen_f)`, then
  `score = idf · tf~ · (k1 + 1) / (k1 + tf~)` with k1 = 1.2 and `idf = ln(1 + (N − df + 0.5)/(df + 0.5))`.
- **Field weights:** tag and serial 3; FAMS barcode, name (host name) and holder (CTID) 2.5; model and
  category 2; maker, status and location 1.5; Machine Name and specs 1; supplier and client / project 0.6;
  notes / order numbers 0.4.
- An asset's score is the sum, over the query words, of the best-scoring form of each word.

**Forms of a word:**

| Form | Weight | When |
|---|---:|---|
| Exact | 1 | always |
| Synonym | 0.9 | from the domain dictionary, only if that word occurs in the register; shares the word's document frequency |
| Completion | 0.5–0.9 (more for a longer typed part) | 3+ letters; the last word always, others when not a word themselves; up to 50, most common first |
| Typo, 1 edit | 0.75 (0.6 for identifiers) | not a word in the register (or a word on ≤ 2 assets when a 1-edit neighbour is on 20+); 4+ characters; never all digits |
| Typo, 2 edits | 0.55 | words of 8+ letters without digits |

- **Typo candidates** come from a trigram index over the ~100,000 words of the register. A candidate must
  share enough letter triples (an edit changes at most 4 of them; a swap of two neighbours does change 4).
  The optimal-string-alignment distance then decides, with an early stop beyond the limit.
- **Matching.** Every word must match. If no asset matches them all, the assets that match the most words are
  shown, with a note. Words no asset has are left out, with a note. An asset whose name, tag or serial contains
  the typed text always matches (the old search), so nothing it found is lost.
- **Match %** shown per asset: the average weight of the best form of each word.

**Evaluation** (`eval/searchEval.js`).
- There is no search log yet, so the labelled queries are generated from the register with a fixed seed:
  100 per kind, 1,100 in all.
- Each query is ranked by the old search (name / tag / serial contains the text, newest first) and by smart
  search.
- **MRR@10** = mean of 1 / rank of the first relevant asset (0 beyond 10). **P@10** = relevant share of the
  top 10, out of at most 10 relevant.
- **Bias:** the query kinds and the synonym list were written by us and tuned while measuring. The numbers
  show what the search can do on the register's own vocabulary, not how real users type.
- Opened Ctrl+K results are kept in `ai_feedback`, for measuring on real searches later.

Real register, 26,736 assets, 2026-10-23:

| Query kind | n | MRR@10 old → smart | Top-10 hit old → smart | No result old → smart |
|---|---:|---|---|---|
| Serial | 100 | 100% → 100% | 100% → 100% | 0% → 0% |
| Serial with a typo | 100 | 1.0% → 91.7% | 1.0% → 96.0% | 96% → 0% |
| Asset tag | 100 | 100% → 100% | 100% → 100% | 0% → 0% |
| Host name | 100 | 99.5% → 100% | 100% → 100% | 0% → 0% |
| Host name with a typo | 100 | 0% → 90.7% | 0% → 94.0% | 96% → 1% |
| FAMS barcode | 100 | 100% → 100% | 100% → 100% | 0% → 0% |
| CTID + category ("RaviK7 laptop") | 100 | 0% → 100% | 0% → 100% | 100% → 0% |
| "lappy" + CTID | 100 | 0% → 99.5% | 0% → 100% | 100% → 0% |
| Model + site ("Latitude 5420 Powai") | 100 | 0% → 98.0% | 0% → 100% | 100% → 0% |
| Site code + model ("BLR OptiPlex 7010") | 100 | 0% → 94.2% | 0% → 100% | 100% → 0% |
| Model with a typo | 100 | 0% → 96.3% | 0% → 98.0% | 100% → 0% |
| **All** | **1,100** | **36.4% → 97.3%** | **36.5% → 98.9%** | **62.9% → 0.1%** |

- **Speed:** ranking takes 1.0 ms at the median and 2.4 ms at p95. The Hardware list's database part (count +
  page of 15 from the ranked ids) takes 14 ms at the median, 38 ms at p95, 84 ms at most.
- **Index:** built in 2.3 s in a worker; 99,840 words and 1.19 million postings (14 MB of typed arrays).
- **Exact identifiers stay at 100%.** "FAMS barcode" also scores 100% for the old search, because on most
  assets the barcode is the asset tag.
- **Misses that remain:**
  - A typo that spells another real asset's serial or host name ("PG7Z2QK5") finds that asset. It exists, so
    the search can't know the typo.
  - A serial typo can also find its batch siblings (Dell tags in one order differ by one character). They
    rank lower, marked "1 letter apart".
- **Not covered:** questions in plain language ("laptops due for refresh in Pune") are M6. Employee names: the
  directory holds CTIDs only, so "Ravi" works through the CTID "RaviK7", but a surname doesn't.

## 8. Refresh risk (M4, `models/weibullRisk.js`, `lifecycle/`)

**What it does.** For every active laptop, desktop and thin client, it estimates the chance of being retired
in the next 6, 12 and 24 months, with a confidence and the reasons.

**The data problem.** The register says *whether* each asset is retired, but not *when*. This is
"current-status" data: one look at each asset at its present age. The method below is built for exactly that.

**Model: Weibull with proportional effects, fitted to current-status data.**
- The model: S(a | x) = exp(−H(a) · e^(β·x)).
- The chance that an asset of age a is already retired is then 1 − exp(−exp(ln H(a) + β·x)). That is a
  binary regression with the complementary log-log link. It is concave, so Newton's method (IRLS) fits it in
  about 5 steps.
- For a plain Weibull, ln H(a) = b0 + k ln a, so the coefficient of ln(age) is the Weibull shape k.
- **Piecewise shape.** One shape can't follow a refresh policy (3% of laptops are retired at 4 years, 63% at
  6). So the shape may change at 3, 4, 5, 6 and 8 years: ln H gets hinge terms max(0, ln a − ln t). These are
  Weibull pieces joined at the knots, lightly penalised so the curve stays smooth. H is kept non-decreasing
  (a running maximum).
- **One curve per category.** A category needs 200+ assets and 50+ retirements. VMs (2 ever retired) get no
  curve.
- **Forward-looking risk:** 1 − S(a + h)/S(a).

**What counts:**
- A refresh is any retirement except *Lost*, *Absconding* and *Returned to Client*; those assets are left out
  of training.
- Client-provided assets are not scored, because they go back to the client.

**Covariates describe the machine, not its purchase year:**
- 8 GB RAM or less;
- processor too old for Windows 11 (Intel 7th gen or earlier);
- warranty term (4+ years, under 3 years).
- RAM and processor may only *raise* the risk. If one fits the other way (a purchase-year artefact), it is
  dropped and the curve refitted.
- **Left out on purpose:**
  - *Asset model.* In a single snapshot, model ≈ purchase year. It fits held-out assets slightly better
    (laptop Brier 0.0766), but it says "the 2021 laptops are kept longer" when really their refresh hasn't
    come yet. It forecast 13% for 5-year-old laptops against 47–48% from age alone.
  - *Current OS.* Active machines were upgraded to Windows 11; retired ones never were, so OS would predict
    backwards.
  - *Missing processor.* A gap in the data is not a reason to refresh.

**Confidence** = (assets of that category within half a year of this age) / (that + 60) × the category's
held-out AUC rescaled (0.5 → 0, 0.9 → 1). It is lowered when the asset is older than the history covers.

**Measured on the real register** (2026-10-23, read-only). 20% of assets are held out by id; the target is
"already retired at its age". Lower Brier is better:

| Category | Assets (retired) | Model | Isotonic age curve | Single-shape Weibull | Overall rate | AUC | Calibration error |
|---|---|---:|---:|---:|---:|---:|---:|
| Laptop | 15,785 (4,359) | **0.0810** | 0.0810 | 0.0969 | 0.1968 | 0.945 | 0.019 |
| Desktop | 4,539 (3,882) | 0.0848 | 0.0796 | 0.0992 | 0.1227 | 0.831 | 0.050 |
| Thin Client | 1,021 (369) | **0.2192** | 0.2277 | 0.2193 | 0.2345 | 0.646 | 0.039 |
| All | 4,277 held out | 0.0886 | | 0.1034 | | 0.947 | 0.020 |

- **Laptops: 12-month risk of active assets by age, model vs the register's cross-section** ((F(a+1) − F(a)) /
  (1 − F(a)) from the isotonic curve):

  | Age | 4 y | 4.5 y | 5 y | 5.5 y | 6 y | 7 y |
  |---|---:|---:|---:|---:|---:|---:|
  | Model | 7.8% | 19.6% | 48.8% | 45.6% | 28.0% | 25.5% |
  | Cross-section | 7.2% | 23.4% | 39.1% | 57.9% | 44.9% | 29.6% |

  This assumes a laptop bought in 2021 will be treated at 6 like 2020's were. The M1 snapshots will test it
  for real: compare these forecasts with who is actually retired in 6–12 months.
- **Covariates (risk multiplier at the same age):**
  - laptops: 8 GB RAM or less ×1.27, warranty under 3 years ×0.40, 4+ years ×0.89;
  - desktops: processor too old for Windows 11 ×1.07.
- **Half retired by:** laptops 5.9 years, thin clients 6.2, desktops 6.7.
- **Forecast:** 12,735 active assets scored; about 2,760 expected to be retired in the next 12 months
  (laptops ~2,190, desktops ~330, thin clients ~240); 1,875 at high risk (50%+).
- **Weak spots:**
  - **Thin clients:** two purchase batches, so AUC is only 0.65 and their confidence reads low.
  - **Desktops:** nearly all are 6–8 years old, so there is little age range to learn from.
  - **8+ year-old laptops** still active are mostly stale "In Stock" records; their measured risk is low,
    because so few are being retired.

## 9. Unusual assets (M4, `models/isolationForest.js`, `anomaly/`)

**What it does.** It finds active assets that look unusual next to the other assets of their model, held by
someone with many devices, or very old and still active.

**Features** (robust z-scores: distance from the model's median in units of its spread, for models with 10+
values):
- cost, RAM, processor generation, purchase date and warranty term, each against the model's;
- ln(1 + active devices of the holder);
- age.

A generic model name ("MacBook Pro", "Cloud") spans many years, so its spread is wide and its members aren't
all unusual.

**Isolation Forest.**
- 100 trees, each built on 256 assets, seeded.
- score = 2^(−E[path length] / c(256)), with c(n) = 2(ln(n−1) + 0.5772) − 2(n−1)/n.
- **Flagged when** the score is in the top 1% (and at least 0.6) *and* at least one reason is worth a look on
  its own. A reason qualifies if it is:
  - 2+ spreads from the model's usual value,
  - a holder with 3+ devices, or
  - 10+ years old.
- **Why:** for each feature, the score drop when that value is replaced by the ordinary one; the top 3 are
  shown in plain words ("4 GB RAM; Latitude 5420 usually has 16 GB").
- A feature that never varies in the training sample is never split on, so an unusual value there can't be
  seen.

**Measured on the real register** (2026-10-23, read-only):
- **Flagged:** 182 of 18,016 active assets (score 0.62+), in 86 groups. Scoring takes 0.4 s.
- **Corrupted copies of real assets** (300, among a 20% sample of real assets): AUC 0.898.

  | Corruption | AUC |
  |---|---:|
  | RAM 4× or ¼ of its model | 0.93 |
  | Cost 5× or ⅕ | 0.90 |
  | Bought 6 years from its model | 0.88 |
  | Holder with 15 devices | 0.92 |
  | 10-year warranty | 0.86 |
  | Processor 5 generations off | 0.89 |

- **Top 30 groups labelled by me** (the developer, not a user):
  - **The criteria.** "Worth a look" means at least one quoted reason shows the record contradicting its model
    in a way a real device can't (processor, RAM or purchase year impossible for the model, a desktop filed as
    VM) or an asset far past its life still active. "Probably expected" means a project or pool account holding
    many cloud VMs.
  - **The result:** 23 worth a look, 5 probably expected (holders of 17–60 cloud VMs), 2 unclear (recent cloud
    VMs with no warranty). **Precision about 77% by my labels.**
  - Real labels come from the **Real issue / Expected** buttons on Alerts. The page shows the running share.
- **Systemic finding.** Many 2022–2026 purchases are filed under 2010-era model names, for example a
  "Latitude E5420" (2011) bought in 2022 with a 10th–11th gen processor and 32 GB. The same goes for E5500,
  E5510, E7450, 5480, 5490 and HP 840 G3. The model field looks wrong for these, not the device.

## 10. Cost forecast, refresh plan and licence compliance (M5, `cost/`, `compliance/`)

### Replacement need (the forecast)

- **What it is:** for every active asset scored by refresh risk, the chance of being retired in each of the
  next 8 quarters (from its cumulative risk at 3, 6, … 24 months), times its category's replacement cost.
  Summed per quarter and category.
- **Replacement cost:** the median priced purchase of the last 24 months when there are 30 or more of them,
  otherwise the median of the latest 100 purchases. The basis is shown with the number, and it can be changed
  on Refresh Planning.
- **Real register, 2026-10-23 (read-only, scored in memory):**
  - **Replacement costs:** laptop ₹ (figure kept out of the public copy) (2,842 purchases in 24 months); desktop ₹ (figure kept out of the public copy) (latest 100,
    2020–2026); thin client ₹ (figure kept out of the public copy)
  - **Next 12 months:** about 2,760 assets, **≈ ₹ (figure kept out of the public copy)**. Next 24 months: about 4,830, ≈ ₹ (figure kept out of the public copy).
  - **By quarter:** about 640–720 assets (₹ (figure kept out of the public copy)) in each of the next six quarters, falling after that
    as the 2021–22 batches pass their refresh.
  - **Where it sits:** over half of the expected retirements are spare stock, not machines in use (1,204 of
    the in-use assets).
- **Not backtested:** it can't be, because retirement dates aren't recorded. It inherits refresh risk's
  assumption (MODELS.md §8).

### Spend pace (the baseline)

- **Data:** quarterly purchase-order spend (all POs are in INR), 2018-Q3 to 2026-Q3, 33 quarters, averaging
  ₹ (figure kept out of the public copy) a quarter. Asset costs were not used: they are missing for most 2023–mid-2024 purchases.
- **Holt-Winters (ours):** damped trend; no / additive / multiplicative quarterly seasons; weights chosen by
  grid search on one-step error.
- **Backtest:** a rolling origin from 2023-Q1, each method refitted on the data before the quarter it
  predicts. Error as a share of the average quarter (for the next four quarters, of the average four
  quarters):

  | Method | One quarter ahead | Next four quarters |
  |---|---:|---:|
  | Holt-Winters (picks: no season, alpha 0.1) | 168% | 91% |
  | Same quarter last year | 171% | 78% |
  | Mean of the last 4 quarters | 148% | 78% |
  | Last quarter | **138%** | **75%** |

- **Verdict: spend timing is not forecastable from its own history** on this register. It comes in waves:
  ₹ (figure kept out of the public copy) in 2022-Q2, then ₹ (figure kept out of the public copy) quarters, then ₹ (figure kept out of the public copy) in 2025-Q4.
- **What is shown instead:** the dashboard gives the long-run pace (≈ ₹ (figure kept out of the public copy) a year) with that warning, and
  the need above is the figure to plan with. That the need (₹ (figure kept out of the public copy)) is well above the past pace is itself
  the finding.

### Refresh plan

- **Candidates** are active scored assets: in use (assigned or Deployed) in full, spare stock at half weight
  and only when asked.
- **Priority** is the chance of being retired within the horizon (6, 12 or 24 months). **Cost** is the
  category's replacement cost.
- **0/1 knapsack** (`models/knapsack.js`):
  - greedy by priority per rupee;
  - a dynamic programme over the budget in 2,000 steps, with costs rounded *up* so the plan never exceeds
    the budget, and any leftover filled greedily;
  - the better of the two is used.
- **Real register** (in-use assets, 12 months):
  - ₹ (figure kept out of the public copy) → 714 assets, covering ~365 of ~1,204 expected retirements (30%);
  - ₹ (figure kept out of the public copy) → 1,393 (57%);
  - ₹ (figure kept out of the public copy) → 2,750 (83%).
  - Every plan stays within budget, and each takes about 15 ms.
  - The dynamic programme equals greedy here: within a category every asset costs the same. It wins when
    costs differ; see the test with items A, B, C.
- **Sign-off:** the plan goes to AI Approvals, and accepting it records the decision only. Nothing is
  purchased or changed.

### Licence compliance (rules, dormant)

- **The ten rules:**
  - over-allocated;
  - expired but assigned;
  - ended subscription still allocated;
  - in use and expiring within 60 days;
  - renewal due within 30 days;
  - seats held by leavers (suspended or archived users) or retired/deleted assets;
  - duplicate licence key;
  - software allocated to a leaver;
  - unused seats (5+ and a fifth, 90+ days after purchase, with savings at purchase price);
  - available seats not adding up.
- **Real register:** 0 licences and 0 software records, so it is dormant. It is tested on synthetic licences
  (all 10 rules fire).

## 11. Feature snapshots (M1, `features/`)

These have no model yet. They are the history that later models (refresh risk, anomalies) will learn from.
See ARCHITECTURE.md.
