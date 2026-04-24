'use strict';

// ============================================================
// SCORING ENGINE
// Five weighted categories → raw score (0–100)
// TOTAL = Genetic(0.40) + Physical(0.20) + Traits(0.20)
//       + Performance(0.15) + Market(0.05)
//
// Each category uses partial-input safe weighted averaging:
// null fields are excluded; their weight redistributes to
// provided fields. Score = weightedSum / totalProvidedWeight
// ============================================================

// ─── Scoring weights (stallion data → raw score) ─────────────
// Keys match scoring category names used in scoreGenetic() etc.
const CATEGORY_WEIGHTS = {
  genetic:     0.40,
  physical:    0.20,
  traits:      0.20,
  performance: 0.15,
  market:      0.05,
};

// ─── Confidence weights (mare input completeness → confidence) ─
// Keys match MARE_SCHEMA section names.
// Mental maps to the 'traits' scoring category.
// Cosmetic maps to the 'market' scoring category.
// Health is excluded from confidence (not listed in spec).
const CONFIDENCE_WEIGHTS = {
  genetics:    0.40,
  physical:    0.20,
  mental:      0.20,
  performance: 0.15,
  cosmetic:    0.05,
};

// ─── Sub-field weights within each category ─────────────────
const SUB_WEIGHTS = {
  genetic: {
    discipline_fit:    0.45,   // stallion.performance.discipline_strength[targetDisc]
    offspring_success: 0.35,   // stallion.genetics.offspring_success_score
    sire_line:         0.20,   // mapped from _sire_line_strength enum
  },
  physical: {
    balance_score:     0.40,   // stallion.physical.balance_score
    athleticism:       0.35,   // stallion._athleticism (helper field)
    bone_density:      0.25,   // stallion.physical.bone_density_score
  },
  traits: {                     // default — used when discipline is not provided
    trainability:      0.22,   // blended: stallion × 0.55 + mare × 0.45 when mare provided
    consistency:       0.10,   // blended: stallion × 0.55 + mare × 0.45 when mare provided
    cow_sense:         0.18,
    speed:             0.18,
    stamina:           0.18,
    temperament:       0.14,
  },
  performance: {
    offspring_earnings: 0.40,  // normalized from dollars
    earnings:           0.25,  // normalized from dollars
    offspring_success:  0.35,  // stallion.genetics.offspring_success_score
  },
  market: {
    fee_value:    0.50,        // inverted from stud_fee dollars
    demand_index: 0.50,        // stallion.market.demand_index
  },
};

// ─── Discipline-specific trait weights ──────────────────────
// Each discipline reweights the 5 trait fields to reflect what
// actually matters competitively. Weights must sum to 1.00.
//
// Note: reactivity is handled by the interaction matrix, not here.
// These weights govern scoring emphasis, interactions govern compatibility.
// Discipline-specific trait weights including consistency (blended from both parents).
// Existing 5-trait weights scaled ×0.90 (×0.88 for ranch) to accommodate consistency.
// trainability and consistency are blended from stallion + mare when mare data is present.
// All other traits are stallion-only (not captured in mare schema).
const DISCIPLINE_TRAIT_WEIGHTS = {
  reining: {
    trainability:  0.36,   // precision pattern work — blended when mare provides it
    consistency:   0.10,   // day-to-day pattern reliability — blended
    cow_sense:     0.05,
    speed:         0.18,   // rundown speed
    stamina:       0.13,
    temperament:   0.18,   // calm focus under competition pressure
  },
  cutting: {
    trainability:  0.14,
    consistency:   0.10,
    cow_sense:     0.40,   // primary skill — reading and working cattle
    speed:         0.14,   // burst positioning speed
    stamina:       0.09,
    temperament:   0.13,
  },
  cowHorse: {
    trainability:  0.23,   // both reining and cow phases
    consistency:   0.10,
    cow_sense:     0.27,   // cow work phase
    speed:         0.14,
    stamina:       0.13,
    temperament:   0.13,
  },
  barrelRacing: {
    trainability:  0.14,
    consistency:   0.10,
    cow_sense:     0.05,
    speed:         0.40,   // primary skill
    stamina:       0.18,   // multiple runs, competition day demands
    temperament:   0.13,
  },
  teamRoping: {
    trainability:  0.18,
    consistency:   0.10,   // reliable rate and approach critical
    cow_sense:     0.18,   // tracking and rating the steer
    speed:         0.23,   // header reach; heeler timing
    stamina:       0.22,   // high run volume per day
    temperament:   0.09,
  },
  ranchRiding: {
    trainability:  0.22,   // versatility across tasks — blended
    consistency:   0.12,   // dependable all-day mount — weighted higher here
    cow_sense:     0.13,
    speed:         0.09,
    stamina:       0.22,   // all-day work demands
    temperament:   0.22,   // calm, reliable, safe
  },
};

// ─── Sire line strength → numeric score ─────────────────────
const SIRE_LINE_SCORES = {
  elite:   95,
  premier: 82,
  strong:  72,
  listed:  58,
  moderate: 50,
  weak:    28,
  unknown: 40,
};

// ─── Earnings normalization (log scale) ─────────────────────
// $0=0, $50k=58, $100k=69, $500k=83, $1M=88, $5M=96, $20M=99
function normalizeEarnings(dollars) {
  if (dollars == null || isNaN(dollars) || dollars <= 0) return null;
  return Math.min(99, Math.round(Math.log10(dollars + 1) / Math.log10(25_000_000) * 99));
}

// ─── Stud fee → value score (inverse log scale) ─────────────
// $0=100, $1k=72, $2k=63, $5k=50, $10k=40, $20k+=28
function normalizeFee(dollars) {
  if (dollars == null || isNaN(dollars)) return null;
  if (dollars <= 0) return 100;
  const scaled = Math.log10(dollars + 1) / Math.log10(30_000);
  return Math.max(18, Math.round(100 - scaled * 72));
}

/**
 * Partial-input safe weighted average.
 * Returns { score, coverage } where coverage is 0–1 indicating
 * what fraction of the total possible weight was provided.
 *
 * @param {object} values  - { fieldName: value | null }
 * @param {object} weights - { fieldName: weight }
 * @returns {{ score: number, coverage: number, provided: number, total: number }}
 */
function wScore(values, weights) {
  let totalW = 0;
  let sumW   = 0;
  let wSum   = 0;
  let n      = 0;
  const tot  = Object.keys(weights).length;

  for (const [field, w] of Object.entries(weights)) {
    sumW += w;
    const v = values[field];
    if (v != null && !isNaN(Number(v))) {
      totalW += w;
      wSum   += Number(v) * w;
      n++;
    }
  }

  return {
    score:    totalW > 0 ? Math.round(wSum / totalW) : 0,
    coverage: sumW > 0 ? totalW / sumW : 0,
    provided: n,
    total:    tot,
  };
}

// ─── Category scorers ────────────────────────────────────────

function scoreGenetic(stallion, mare) {
  const targetDisc = mare?.performance?.discipline;
  const discStrength = targetDisc
    ? (stallion.performance?.discipline_strength?.[targetDisc] ?? null)
    : null;

  return wScore(
    {
      discipline_fit:    discStrength,
      offspring_success: stallion.genetics?.offspring_success_score ?? null,
      sire_line:         SIRE_LINE_SCORES[stallion._sire_line_strength ?? 'unknown'] ?? null,
    },
    SUB_WEIGHTS.genetic,
  );
}

function scorePhysical(stallion) {
  return wScore(
    {
      balance_score: stallion.physical?.balance_score ?? null,
      athleticism:   stallion._athleticism            ?? null,
      bone_density:  stallion.physical?.bone_density_score ?? null,
    },
    SUB_WEIGHTS.physical,
  );
}

/**
 * Blend a stallion value and mare value for an inheritable trait.
 * 55% stallion / 45% mare when both are provided — consistent with projectTraits().
 * Falls back to whichever side has data if the other is null.
 */
function blendMareStallion(stallionVal, mareVal) {
  if (stallionVal == null && mareVal == null) return null;
  if (stallionVal == null) return Math.round(mareVal);
  if (mareVal == null)     return stallionVal;
  return Math.round(stallionVal * 0.55 + mareVal * 0.45);
}

function scoreTraits(stallion, discipline, mare) {
  const weights = DISCIPLINE_TRAIT_WEIGHTS[discipline] ?? SUB_WEIGHTS.traits;

  // trainability and consistency: blended from both parents when mare provides them
  // All other traits: stallion-only (mare schema does not capture cow_sense, speed, stamina)
  return wScore(
    {
      trainability: blendMareStallion(
        stallion.mental?.trainability ?? null,
        mare?.mental?.trainability   ?? null,
      ),
      consistency: blendMareStallion(
        stallion.mental?.consistency ?? null,
        mare?.mental?.consistency   ?? null,
      ),
      cow_sense:   stallion._cow_sense    ?? null,
      speed:       stallion._speed        ?? null,
      stamina:     stallion._stamina      ?? null,
      temperament: stallion._temperament  ?? null,
    },
    weights,
  );
}

function scorePerformance(stallion, discipline) {
  // Use discipline-specific offspring earnings when available.
  // Falls back to total offspring_earnings for stallions without the breakdown,
  // preserving backward compatibility with legacy/undifferentiated records.
  const discEarnings = discipline
    ? (stallion.performance?.discipline_earnings?.[discipline] ?? null)
    : null;
  const totalEarnings = stallion.performance?.offspring_earnings ?? null;
  const earnToScore   = discEarnings ?? totalEarnings;  // prefer discipline-specific

  return wScore(
    {
      offspring_earnings: normalizeEarnings(earnToScore),
      earnings:           normalizeEarnings(stallion.performance?.earnings),
      offspring_success:  stallion.genetics?.offspring_success_score ?? null,
    },
    SUB_WEIGHTS.performance,
  );
}

function scoreMarket(stallion) {
  return wScore(
    {
      fee_value:    normalizeFee(stallion.market?.stud_fee),
      demand_index: stallion.market?.demand_index ?? null,
    },
    SUB_WEIGHTS.market,
  );
}

/**
 * Score a single stallion against a mare.
 * Returns raw score, per-category breakdown, and coverage metrics.
 *
 * @param {object} stallion - Stallion DB record
 * @param {object} mare     - Mare schema data object
 * @returns {object}
 */
function scoreStallion(stallion, mare) {
  const discipline = mare?.performance?.discipline ?? null;
  const gen  = scoreGenetic(stallion, mare);
  const phy  = scorePhysical(stallion);
  const tr   = scoreTraits(stallion, discipline, mare);   // discipline-specific weights, blends mare traits
  const per  = scorePerformance(stallion, discipline);
  const mkt  = scoreMarket(stallion);

  // Between-category null redistribution.
  // A category with coverage = 0 (all fields null) is excluded from the sum.
  // Its weight is redistributed proportionally across the remaining categories
  // by dividing each active score by the sum of active weights instead of 1.0.
  //
  // Example: market is fully null (stud_fee and demand_index both missing).
  //   Broken:  raw = gen*0.40 + phy*0.20 + tr*0.20 + per*0.15 + 0*0.05 -> 5% weight lost
  //   Fixed:   activeWeight = 0.95, raw = gen*(0.40/0.95) + ... -> sums to full score
  const allCats = [
    { score: gen.score, coverage: gen.coverage, weight: CATEGORY_WEIGHTS.genetic     },
    { score: phy.score, coverage: phy.coverage, weight: CATEGORY_WEIGHTS.physical    },
    { score: tr.score,  coverage: tr.coverage,  weight: CATEGORY_WEIGHTS.traits      },
    { score: per.score, coverage: per.coverage, weight: CATEGORY_WEIGHTS.performance },
    { score: mkt.score, coverage: mkt.coverage, weight: CATEGORY_WEIGHTS.market      },
  ];

  const activeCats   = allCats.filter(c => c.coverage > 0);
  const activeWeight = activeCats.reduce((sum, c) => sum + c.weight, 0);
  const rawScore     = activeWeight > 0
    ? activeCats.reduce((sum, c) => sum + c.score * (c.weight / activeWeight), 0)
    : 0;

  // Confidence intentionally does NOT redistribute -- a missing category
  // should reduce confidence. Zero coverage = zero contribution.
  const confidence =
    gen.coverage  * CONFIDENCE_WEIGHTS.genetics    +
    phy.coverage  * CONFIDENCE_WEIGHTS.physical    +
    tr.coverage   * CONFIDENCE_WEIGHTS.mental      +
    per.coverage  * CONFIDENCE_WEIGHTS.performance +
    mkt.coverage  * CONFIDENCE_WEIGHTS.cosmetic;

  return {
    stallion,
    rawScore:    Math.round(rawScore),
    catScores: {
      genetic:     gen.score,
      physical:    phy.score,
      traits:      tr.score,
      performance: per.score,
      market:      mkt.score,
    },
    catCoverage: {
      genetic:     Math.round(gen.coverage * 100),
      physical:    Math.round(phy.coverage * 100),
      traits:      Math.round(tr.coverage * 100),
      performance: Math.round(per.coverage * 100),
      market:      Math.round(mkt.coverage * 100),
    },
    confidence:  Math.round(confidence * 100),
  };
}

module.exports = {
  scoreStallion,
  scoreGenetic,
  scorePhysical,
  scoreTraits,
  scorePerformance,
  scoreMarket,
  blendMareStallion,
  normalizeEarnings,
  normalizeFee,
  CATEGORY_WEIGHTS,
  CONFIDENCE_WEIGHTS,
  SUB_WEIGHTS,
  DISCIPLINE_TRAIT_WEIGHTS,
  SIRE_LINE_SCORES,
};
