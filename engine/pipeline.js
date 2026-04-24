'use strict';

const { scoreStallion, CATEGORY_WEIGHTS } = require('./scoring');
const { evaluateInteractions, applyModifier } = require('./interactions');

// ============================================================
// PROBABILITY MODEL — Base-rate anchored
// ============================================================
//
// Previous approach (removed): score → lookup table → percentages.
// Problem: produced numbers with no external reference point.
//         "elite: 25%" meant nothing without knowing the base rate.
//
// Current approach: score adjusts a documented industry base rate.
//
// Step 1 — Base rates: how often each outcome actually occurs in the
//   Western performance horse population (industry estimates):
//
//   Elite   ~3%   World-class: futurity finalist, top-10 world, >$50k earner
//   Strong  ~12%  Competitive open: places regularly, earns, ranked regionally
//   Average ~45%  Serviceable: participates, limited competitive success
//   Miss    ~40%  Below expectation: does not meet discipline demands
//
// Step 2 — Likelihood ratios: how much a score band multiplies each base rate.
//   A score-90 cross is ~8x more likely than average to produce an elite horse.
//   A score-40 cross is ~0.1x — one-tenth as likely as average.
//
// Step 3 — Normalize: multiply base rate × multiplier per outcome,
//   sum the four products, divide each by the sum → sums to 100%.
//
// The result is meaningful: "This cross is Nx the industry average
// probability of producing an elite horse."
// ============================================================

const BASE_RATES = {
  elite:   0.03,   // 3%  — world-class / futurity finalist / >$50k earner
  strong:  0.12,   // 12% — competitive open / earns regularly
  average: 0.45,   // 45% — serviceable, not consistently competitive
  miss:    0.40,   // 40% — does not meet discipline expectations
};

// Outcome definitions — what each label means in concrete terms
const OUTCOME_DEFINITIONS = {
  elite:   'Futurity finalist, top-10 world standing, or >$50,000 documented earnings',
  strong:  'Competitive at open level, earns in competition, places at regional events',
  average: 'Participates in discipline, limited placings, serviceable mount',
  miss:    'Does not meet discipline physical or behavioral requirements',
};

// Neutral prior for stallion confidence dampening.
// Stallions in a breeding DB are above random average, so 55 (not 50)
// is used as the pull-toward value when data is incomplete.
const NEUTRAL_SCORE = 55;

// Stallion confidence thresholds for risk flagging
const STALLION_CONF_FLAGS = [
  { below: 50, level: 'HIGH'     },
  { below: 70, level: 'MODERATE' },
  { below: 85, level: 'LOW'      },
];

/**
 * Dampen a stallion's score toward NEUTRAL_SCORE based on data confidence.
 * At 100% confidence: effectiveScore === finalScore (no change).
 * At 0% confidence:   effectiveScore === NEUTRAL_SCORE (fully regressed to prior).
 *
 * Formula: finalScore * confidence + NEUTRAL_SCORE * (1 - confidence)
 *
 * @param {number} finalScore  - Post-interaction score (1-99)
 * @param {number} confidence  - Stallion data completeness (0-100)
 * @returns {number}           - Confidence-adjusted effective score
 */
function applyStallionConfidence(finalScore, confidence) {
  const cf = Math.max(0, Math.min(100, confidence)) / 100;
  return Math.round(finalScore * cf + NEUTRAL_SCORE * (1 - cf));
}

// Score bands — four named ranges, each with documented behavior and back-calculated LRs.
// LRs are derived from target percentages so band behavior is guaranteed, not approximate.
// Format: [min, max, label, elite_lr, strong_lr, average_lr, miss_lr]
//
// Band targets (what each label means in probability output):
//   elite_heavy     → elite is the single largest probability (35%)
//   strong_dominant → strong is the single largest probability (42%)
//   mixed           → average leads but no clear dominant; miss rises (32%)
//   risk_increases  → miss is the single largest probability (53%)
const LIKELIHOOD_RATIOS = [
  //  min   max   label               elite   strong  average  miss
  [    90,  99,  'elite_heavy',       11.67,   2.67,   0.56,  0.20 ],
  [    75,  89,  'strong_dominant',    4.00,   3.50,   0.78,  0.28 ],
  [    60,  74,  'mixed',              1.67,   1.58,   0.98,  0.80 ],
  [     0,  59,  'risk_increases',     0.33,   0.50,   0.89,  1.32 ],
];

/**
 * Compute anchored probability distribution for a given score.
 *
 * Formula per outcome:
 *   adjusted = BASE_RATE[outcome] * LIKELIHOOD_RATIO[scoreBand][outcome]
 *   final    = adjusted / sum(all adjusted) * 100   (normalized to 100%)
 *
 * @param {number} score - Final score (0-99)
 * @returns {{ elite, strong, average, miss, _derivation }}
 */
function scoreToProbability(score) {
  score = Math.max(0, Math.min(99, Math.round(score)));

  // Find the score band
  const band = LIKELIHOOD_RATIOS.find(([min, max]) => score >= min && score <= max)
            ?? LIKELIHOOD_RATIOS[LIKELIHOOD_RATIOS.length - 1];
  const [, , bandLabel, eliteLR, strongLR, avgLR, missLR] = band;

  // Multiply base rates by likelihood ratios
  const adjusted = {
    elite:   BASE_RATES.elite   * eliteLR,
    strong:  BASE_RATES.strong  * strongLR,
    average: BASE_RATES.average * avgLR,
    miss:    BASE_RATES.miss    * missLR,
  };

  // Normalize so all four sum to 100%
  const total = Object.values(adjusted).reduce((s, v) => s + v, 0);
  const normed = {};
  for (const [k, v] of Object.entries(adjusted)) {
    normed[k] = v / total;
  }

  // Convert to integer percentages, enforce sum = 100
  const pct = {
    elite:   Math.round(normed.elite   * 100),
    strong:  Math.round(normed.strong  * 100),
    average: Math.round(normed.average * 100),
    miss:    Math.round(normed.miss    * 100),
  };
  const sum = pct.elite + pct.strong + pct.average + pct.miss;
  if (sum !== 100) {
    const largest = Object.entries(pct).sort((a, b) => b[1] - a[1])[0][0];
    pct[largest] += 100 - sum;
  }

  // Attach derivation so any caller can explain the number
  pct._derivation = {
    score,
    band:       `${band[0]}-${band[1]}`,
    band_label: bandLabel,
    base_rates: { ...BASE_RATES },
    likelihood_ratios: { elite: eliteLR, strong: strongLR, average: avgLR, miss: missLR },
    adjusted_before_norm: {
      elite:   +(adjusted.elite.toFixed(4)),
      strong:  +(adjusted.strong.toFixed(4)),
      average: +(adjusted.average.toFixed(4)),
      miss:    +(adjusted.miss.toFixed(4)),
    },
    note: 'base_rate × likelihood_ratio → normalize → integer percentage',
  };

  return pct;
}

// ─── Trait projector ─────────────────────────────────────────
function projectTraits(stallion, mare) {
  const mTrainability = mare?.mental?.trainability ?? null;
  const mReactivity   = mare?.mental?.reactivity   ?? null;
  const REACT_TEMP    = { low: 90, moderate: 60, high: 28 };
  const mTemp         = mReactivity ? REACT_TEMP[mReactivity] ?? null : null;

  const blend = (sVal, mVal, sw = 0.55, mw = 0.45) => {
    if (sVal == null && mVal == null) return null;
    if (sVal == null) return Math.round(mVal);
    if (mVal == null) return Math.round(sVal);
    return Math.min(100, Math.max(0, Math.round(sVal * sw + mVal * mw)));
  };

  return {
    athleticism:    blend(stallion._athleticism, null),
    trainability:   blend(stallion.mental?.trainability, mTrainability),
    cow_sense:      blend(stallion._cow_sense, null),
    speed:          blend(stallion._speed, null),
    stamina:        blend(stallion._stamina, null),
    temperament:    blend(stallion._temperament, mTemp),
    top_discipline: stallion._disciplines?.[0] ?? null,
  };
}

// ─── Explanation builder (deterministic prose) ───────────────
const DISC_LABELS = {
  reining: 'Reining', cutting: 'Cutting', cowHorse: 'Working Cow Horse',
  teamRoping: 'Team Roping', barrelRacing: 'Barrel Racing', ranchRiding: 'Ranch Riding',
};

const TIER_WHY = {
  Gold:   'highest overall weighted score across all five categories',
  Silver: 'most balanced profile — highest floor score with no critical category weakness',
  Bronze: 'optimal bloodline diversity — distinct genetic family from Gold providing maximum cross variety',
};

const CAT_LABELS = {
  genetic: 'Genetic', physical: 'Physical', traits: 'Traits',
  performance: 'Performance', market: 'Market',
};

function buildExplanation(scored, mare, tier) {
  const { stallion: s, finalScore, effectiveScore, rawScore, catScores, interactions } = scored;
  const disc = DISC_LABELS[mare?.performance?.discipline ?? s._disciplines?.[0]] ?? 'target discipline';
  const sireTag = (s._sire_line_strength ?? 'unknown').charAt(0).toUpperCase()
                + (s._sire_line_strength ?? 'unknown').slice(1);

  const topCat = Object.entries(catScores).sort((a, b) => b[1] - a[1])[0];
  const boosts    = interactions.applied.filter(r => r.type === 'boost');
  const penalties = interactions.applied.filter(r => r.type === 'penalty');

  const c1 = `${s.name} (${sireTag}-tier, ${s.genetics?.bloodline_cluster ?? 'Unknown'} bloodline) scores ${finalScore}/100 for ${disc} — selected as ${tier}: ${TIER_WHY[tier]}.`;
  const c2 = `Strongest category: ${CAT_LABELS[topCat[0]]} (${topCat[1]}/100).`
    + (boosts.length    ? ` Boosts: ${boosts.map(b    => b.key.replace(/_/g,' ') + ' (+' + b.pts + ' pts)').join(', ')}.` : '')
    + (penalties.length ? ` Penalties: ${penalties.map(p => p.key.replace(/_/g,' ') + ' (' + p.pts + ' pts)').join(', ')}.` : '');
  const netMod = interactions.penaltyTotal + interactions.boostTotal;
  const confAdj = effectiveScore != null && effectiveScore !== finalScore
    ? ` Confidence adjustment: ${finalScore} → ${effectiveScore}.`
    : '';
  const c3 = netMod !== 0
    ? `Net modifier ${netMod > 0 ? '+' : ''}${netMod}% moved raw score ${rawScore} → ${finalScore}.${confAdj}`
    : `No interaction modifiers applied — score reflects pure weighted inputs.${confAdj}`;

  return [c1, c2, c3].join(' ').slice(0, 400);
}

// ─── Mare input confidence ────────────────────────────────────
// Measures how complete the user's mare input is, weighted by
// CONFIDENCE_WEIGHTS. This is the confidence signal in the output —
// stallion DB completeness is fixed; mare input is what drives uncertainty.
const MARE_CONF_FIELDS = {
  genetics:    ['sire', 'dam', 'bloodline_cluster', 'dam_strength_score'],
  physical:    ['height_hands', 'weight_class', 'bone_density_score', 'balance_score'],
  mental:      ['trainability', 'reactivity', 'consistency'],
  performance: ['discipline', 'earnings', 'level'],
  cosmetic:    ['color', 'eye_type'],
  // Preferences are owner inputs — not horse data, so zero confidence weight.
  // They are tracked here so computeMareConfidence can count them as provided fields
  // for the diagnostic total (but they don't affect the weighted confidence score).
};

const MARE_CONF_WEIGHTS = {
  genetics: 0.40, physical: 0.20, mental: 0.20, performance: 0.15, cosmetic: 0.05,
};

function computeMareConfidence(mare) {
  let total = 0;
  for (const [section, fields] of Object.entries(MARE_CONF_FIELDS)) {
    const weight = MARE_CONF_WEIGHTS[section] ?? 0;
    if (weight === 0) continue;  // preferences section — no confidence contribution
    const provided = fields.filter(f => {
      const v = mare?.[section]?.[f];
      return v != null && v !== '';
    }).length;
    total += (provided / fields.length) * weight;
  }
  return Math.round(total * 100);
}


/**
 * Eliminates stallions that fail mandatory compatibility criteria.
 * Only fires rules where mare data is present.
 *
 * Eliminates:
 *   - Discipline mismatch (always enforced — discipline is required)
 *   - Dual high reactivity (when mare reactivity is provided)
 *   - Severely unsound stallions (soundness < 30, regardless of mare)
 *
 * @param {Array}  stallions
 * @param {object} mare
 * @returns {Array} filtered candidates
 */
function hardFilter(stallions, mare) {
  const targetDisc = mare?.performance?.discipline;
  const mareReact  = mare?.mental?.reactivity;

  const budget = mare?.preferences?.budget;
  const avail  = mare?.preferences?.availability;

  return stallions.filter(s => {
    if (targetDisc && !s._disciplines?.includes(targetDisc)) return false;
    if (mareReact === 'high' && s.mental?.reactivity === 'high') return false;
    if (s.health?.soundness_score != null && s.health.soundness_score < 30) return false;
    // Budget ceiling — only filter when fee is known; null fee = unknown, not disqualifying
    if (budget === 'under2k' && s.market?.stud_fee != null && s.market.stud_fee > 2000) return false;
    if (budget === 'under5k' && s.market?.stud_fee != null && s.market.stud_fee > 5000) return false;
    // Availability — only filter when demand_index is known
    if (avail === 'open' && s.market?.demand_index != null && s.market.demand_index > 85) return false;
    return true;
  });
}

// ─── Stage 2: Score all candidates ───────────────────────────
/**
 * Scores every filtered candidate and applies interaction modifiers.
 * Returns full result objects sorted by finalScore descending.
 *
 * @param {Array}  candidates - Output of hardFilter()
 * @param {object} mare
 * @returns {Array} scored + sorted results
 */
function scoreAll(candidates, mare) {
  return candidates
    .map(stallion => {
      const scored          = scoreStallion(stallion, mare);
      const interactions    = evaluateInteractions(stallion, mare);
      const finalScore      = applyModifier(scored.rawScore, interactions.modifier);
      const effectiveScore  = applyStallionConfidence(finalScore, scored.confidence);
      return { ...scored, interactions, finalScore, effectiveScore };
    })
    .sort((a, b) => b.effectiveScore - a.effectiveScore);  // rank by confidence-adjusted score
}

// ─── Stage 3: Gold / Silver / Bronze selection ────────────────
/**
 * Gold:   highest finalScore
 * Silver: highest floor — best minimum category score (most balanced)
 * Bronze: highest bloodline diversity from Gold, then by score
 *
 * @param {Array} scored - Output of scoreAll(), sorted desc
 * @returns {Array}      - 1–3 tier-tagged results
 */
function selectTiers(scored) {
  if (!scored.length) return [];

  const gold  = { ...scored[0], tier: 'Gold' };
  const rest  = scored.slice(1);
  if (!rest.length) return [gold];

  const minCat = s => Math.min(...Object.values(s.catScores));
  const variance = s => {
    const vals = Object.values(s.catScores);
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  };
  // Silver: highest floor (minCat), tiebreak by lowest variance (most balanced),
  // final tiebreak by highest effective score
  const silver = {
    ...rest.reduce((b, s) => {
      const sm = minCat(s), bm = minCat(b);
      if (sm > bm) return s;
      if (sm < bm) return b;
      const sv = variance(s), bv = variance(b);
      if (sv < bv) return s;
      if (sv > bv) return b;
      return s.effectiveScore > b.effectiveScore ? s : b;
    }, rest[0]),
    tier: 'Silver',
  };

  const notSilver = rest.filter(s => s.stallion.id !== silver.stallion.id);
  if (!notSilver.length) return [gold, silver];

  const goldCluster = gold.stallion.genetics?.bloodline_cluster;
  const bronze = {
    ...notSilver.reduce((b, s) => {
      if (!b) return s;
      const sDiverse = s.stallion.genetics?.bloodline_cluster !== goldCluster;
      const bDiverse = b.stallion.genetics?.bloodline_cluster !== goldCluster;
      if (sDiverse && !bDiverse) return s;
      if (!sDiverse && bDiverse) return b;
      // Same diversity status: tiebreak by effective score, then raw score
      if (s.effectiveScore !== b.effectiveScore) return s.effectiveScore > b.effectiveScore ? s : b;
      return s.rawScore > b.rawScore ? s : b;
    }, notSilver[0]),
    tier: 'Bronze',
  };

  return [gold, silver, bronze];
}

// ─── Output builder ──────────────────────────────────────────
/**
 * Transforms tier-tagged scored results into canonical JSON output.
 *
 * @param {Array}  tiers      - Output of selectTiers()
 * @param {object} mare       - Mare data for trait projection
 * @param {number} confidence - Average confidence score (0–100)
 * @returns {object}          - Canonical { matches, confidence }
 */
function buildOutput(tiers, mare, confidence) {
  const matches = tiers.map(t => {
    const prob = scoreToProbability(t.finalScore);
    const derivation = prob._derivation;
    // Strip _derivation from the canonical probability object — it surfaces at top level
    const { _derivation, ...probability } = prob;

    // Stallion confidence risk flag
    const stallionConf = t.confidence;
    const confFlagLevel = (STALLION_CONF_FLAGS.find(f => stallionConf < f.below) ?? {}).level ?? null;
    const confFlag = confFlagLevel ? [{
      level:   confFlagLevel,
      type:    'stallion_data_confidence',
      message: `Stallion record ${stallionConf}% complete — score adjusted from ${t.finalScore} to ${t.effectiveScore}`,
    }] : [];

    return {
      tier:                     t.tier,
      stallion_name:            t.stallion.name,
      score:                    t.effectiveScore,    // confidence-adjusted ranking score
      raw_score:                t.finalScore,        // pre-confidence-adjustment
      stallion_data_confidence: stallionConf,        // 0–100, drives the adjustment
      category_scores: {
        genetic:     t.catScores.genetic,
        physical:    t.catScores.physical,
        traits:      t.catScores.traits,
        performance: t.catScores.performance,
        market:      t.catScores.market,
      },
      category_coverage: {
        genetic:     t.catCoverage.genetic,
        physical:    t.catCoverage.physical,
        traits:      t.catCoverage.traits,
        performance: t.catCoverage.performance,
        market:      t.catCoverage.market,
      },
      probability,
      probability_derivation: {
        score_band:        derivation.band,
        likelihood_ratios: derivation.likelihood_ratios,
        adjusted_raw:      derivation.adjusted_before_norm,
        note:              derivation.note,
      },
      traits:      projectTraits(t.stallion, mare),
      risk: {
        flags: [
          ...t.interactions.applied
            .filter(r => r.type === 'penalty')
            .map(r => ({
              level:   Math.abs(r.pts) >= 10 ? 'HIGH' : Math.abs(r.pts) >= 4 ? 'MODERATE' : 'LOW',
              type:    r.key,
              message: r.detail,
            })),
          ...confFlag,
        ],
        penalty_total: t.interactions.penaltyTotal,
        boost_total:   t.interactions.boostTotal,
        net_modifier:  t.interactions.penaltyTotal + t.interactions.boostTotal,
      },
      explanation: buildExplanation(t, mare, t.tier),
    };
  });

  return {
    matches,
    confidence: Math.round(confidence),
    probability_methodology: {
      model:        'base_rate_anchored',
      base_rates:   BASE_RATES,
      definitions:  OUTCOME_DEFINITIONS,
      description:  'probability = normalize(base_rate * likelihood_ratio). Score band determines likelihood_ratio per outcome.',
    },
  };
}

// ─── Main pipeline ───────────────────────────────────────────
/**
 * Full 3-stage pipeline. Returns canonical output + diagnostics.
 *
 * @param {Array}  allStallions - Full stallion DB
 * @param {object} mare         - Mare schema data object
 * @returns {object}            - { output, diagnostics }
 */
function runPipeline(allStallions, mare) {
  const t0 = Date.now();

  // Stage 1: Hard filter
  const filtered = hardFilter(allStallions, mare);

  // Stage 2: Score all
  const scored = scoreAll(filtered, mare);

  // Stage 3: Select tiers
  const tiers = selectTiers(scored);

  // Aggregate confidence
  const avgConf = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.confidence, 0) / scored.length)
    : 0;

  const mareConf = computeMareConfidence(mare);
  const output   = buildOutput(tiers, mare, mareConf);

  const diagnostics = {
    totalStallions:   allStallions.length,
    afterHardFilter:  filtered.length,
    afterScoring:     scored.length,
    tiersSelected:    tiers.length,
    durationMs:       Date.now() - t0,
    mare: {
      discipline:         mare?.performance?.discipline,
      fieldsProvided:     Object.values(mare || {}).flatMap(s => Object.values(s || {})).filter(v => v != null).length,
    },
  };

  return { output, diagnostics };
}

module.exports = {
  hardFilter,
  scoreAll,
  selectTiers,
  buildOutput,
  runPipeline,
  scoreToProbability,
  projectTraits,
  BASE_RATES,
  LIKELIHOOD_RATIOS,
  OUTCOME_DEFINITIONS,
};
