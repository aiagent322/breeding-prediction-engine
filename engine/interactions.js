'use strict';

// ============================================================
// INTERACTION ENGINE
// Additive point model: finalScore = rawScore + sum(interaction_points)
// Clamped to [-45, +19] pts to prevent extreme single-direction swings.
//
// REACTIVITY MATRIX (complete):
//
//   Mare \ Stallion |  Low          Moderate    High
//   ----------------+----------------------------------
//   Low             |  -8% (perf*)  0           +10%
//   Moderate        |  0            0           -8%
//   High            |  +10%        -8%          -20%
//
//   * Low x Low penalty only applies to performance disciplines
//     (reining, cutting, cowHorse, barrelRacing) where reactive
//     edge is a competitive requirement. Ranch and team roping: 0.
// ============================================================

// Interaction values are absolute score POINTS, not percentages.
// Additive model: finalScore = rawScore + sum(applied.pts)
// Max combined boost: +19 pts | Max combined penalty: -45 pts (before clamp)
const RULES = {
  HEIGHT_MISMATCH:          { type: 'penalty', pts: -10, key: 'height_mismatch'          },
  DUAL_HIGH_REACTIVITY:     { type: 'penalty', pts: -15, key: 'dual_high_reactivity'     },
  MODERATE_HIGH_REACTIVITY: { type: 'penalty', pts:  -5, key: 'moderate_high_reactivity' },
  LOW_LOW_PERFORMANCE:      { type: 'penalty', pts:  -5, key: 'low_low_performance'      },
  WEAK_GENETIC_LINES:       { type: 'penalty', pts: -20, key: 'weak_genetic_lines'       },
  PROVEN_CROSS:             { type: 'boost',   pts:  +8, key: 'proven_cross'             },
  COMPLEMENTARY_TRAITS:     { type: 'boost',   pts:  +3, key: 'complementary_traits'     },
  STRONG_OFFSPRING:         { type: 'boost',   pts:  +5, key: 'strong_offspring'         },
  TRAIT_COMPENSATION:       { type: 'boost',   pts:  +3, key: 'trait_compensation'       },
};

// Disciplines where reactive sensitivity is a competitive requirement.
// Low x Low offspring may lack the edge for elite performance.
const PERFORMANCE_DISCIPLINES = new Set(['reining', 'cutting', 'cowHorse', 'barrelRacing']);

// Maps mare.preferences.weakness enum value to the stallion field that measures it
const TRAIT_SCORE_MAP = {
  cowSense:    s => s._cow_sense,
  speedRating: s => s._speed,
  stamina:     s => s._stamina,
  trainability:s => s.mental?.trainability,
  temperament: s => s._temperament,
};

const MODIFIER_FLOOR = -45;   // minimum additive penalty (points)
const MODIFIER_CEIL  = +19;   // maximum additive boost (points, all four boosts stacked)

function evaluateInteractions(stallion, mare) {
  const applied = [];
  const skipped = [];
  let modifier  = 0;

  // PENALTY 1: Height mismatch > 2 hands
  const mareHt  = mare?.physical?.height_hands;
  const stallHt = stallion?.physical?.height_hands;
  if (mareHt != null && stallHt != null) {
    const diff = Math.abs(parseFloat(mareHt) - parseFloat(stallHt));
    if (diff > 2) {
      modifier += RULES.HEIGHT_MISMATCH.pts;
      applied.push({ ...RULES.HEIGHT_MISMATCH, detail: `Mare ${mareHt}h vs Stallion ${stallHt}h (diff ${diff.toFixed(1)}h)` });
    } else {
      skipped.push({ key: 'height_mismatch', reason: `Within range (diff ${diff.toFixed(1)}h)` });
    }
  } else {
    skipped.push({ key: 'height_mismatch', reason: 'Mare height not provided' });
  }

  // PENALTIES 2-4 + BOOST 2: Reactivity matrix
  // Evaluated as one block — only one reactivity rule fires per pair.
  const mareReact  = mare?.mental?.reactivity;
  const stallReact = stallion?.mental?.reactivity;

  if (mareReact == null) {
    ['dual_high_reactivity','moderate_high_reactivity','low_low_performance','complementary_traits']
      .forEach(key => skipped.push({ key, reason: 'Mare reactivity not provided' }));

  } else {
    const pair = `${mareReact}x${stallReact}`;

    if (mareReact === 'high' && stallReact === 'high') {
      modifier += RULES.DUAL_HIGH_REACTIVITY.pts;
      applied.push({ ...RULES.DUAL_HIGH_REACTIVITY, detail: `Dual high reactivity (${pair}) — offspring temperament risk` });
      skipped.push({ key: 'moderate_high_reactivity', reason: `High x High rule fired (${pair})` });
      skipped.push({ key: 'low_low_performance',      reason: `Not low x low (${pair})` });
      skipped.push({ key: 'complementary_traits',     reason: `Same-direction reactivity (${pair})` });

    } else if (
      (mareReact === 'moderate' && stallReact === 'high') ||
      (mareReact === 'high'     && stallReact === 'moderate')
    ) {
      modifier += RULES.MODERATE_HIGH_REACTIVITY.pts;
      applied.push({ ...RULES.MODERATE_HIGH_REACTIVITY, detail: `Moderate x high reactivity (${pair}) — slight temperament mismatch` });
      skipped.push({ key: 'dual_high_reactivity',  reason: `Not dual-high (${pair})` });
      skipped.push({ key: 'low_low_performance',   reason: `Not low x low (${pair})` });
      skipped.push({ key: 'complementary_traits',  reason: `Moderate x High is a penalty cell (${pair})` });

    } else if (mareReact === 'low' && stallReact === 'low') {
      const discipline = mare?.performance?.discipline;
      if (discipline && PERFORMANCE_DISCIPLINES.has(discipline)) {
        modifier += RULES.LOW_LOW_PERFORMANCE.pts;
        applied.push({ ...RULES.LOW_LOW_PERFORMANCE, detail: `Dual low reactivity in ${discipline} — may cap performance ceiling` });
      } else {
        skipped.push({
          key: 'low_low_performance',
          reason: discipline
            ? `Low x Low acceptable in ${discipline} (calm is an asset)`
            : 'Discipline not provided — low x low not evaluated',
        });
      }
      skipped.push({ key: 'dual_high_reactivity',     reason: `Not dual-high (${pair})` });
      skipped.push({ key: 'moderate_high_reactivity', reason: `Not moderate x high (${pair})` });
      skipped.push({ key: 'complementary_traits',     reason: `Same-level reactivity (${pair})` });

    } else if (
      (mareReact === 'low'  && stallReact === 'high') ||
      (mareReact === 'high' && stallReact === 'low')
    ) {
      modifier += RULES.COMPLEMENTARY_TRAITS.pts;
      applied.push({ ...RULES.COMPLEMENTARY_TRAITS, detail: `Opposing reactivity (${pair}) — balanced temperament projected` });
      skipped.push({ key: 'dual_high_reactivity',     reason: `Not dual-high (${pair})` });
      skipped.push({ key: 'moderate_high_reactivity', reason: `Not moderate x high (${pair})` });
      skipped.push({ key: 'low_low_performance',      reason: `Not low x low (${pair})` });

    } else {
      // Neutral cells: Low x Moderate, Moderate x Low, Moderate x Moderate
      ['dual_high_reactivity','moderate_high_reactivity','low_low_performance','complementary_traits']
        .forEach(key => skipped.push({ key, reason: `Neutral pair (${pair})` }));
    }
  }

  // PENALTY 5: Weak dam x weak sire line
  const damScore = mare?.genetics?.dam_strength_score;
  if (damScore != null) {
    const damWeak  = parseFloat(damScore) < 35;
    const sireWeak = stallion._sire_line_strength === 'weak' ||
                     stallion._sire_line_strength === 'unknown' ||
                     (stallion.genetics?.offspring_success_score != null &&
                      stallion.genetics.offspring_success_score < 35);
    if (damWeak && sireWeak) {
      modifier += RULES.WEAK_GENETIC_LINES.pts;
      applied.push({ ...RULES.WEAK_GENETIC_LINES, detail: `Dam strength ${damScore}/100, sire line: ${stallion._sire_line_strength ?? 'unknown'}` });
    } else {
      skipped.push({ key: 'weak_genetic_lines', reason: `Not both weak (dam: ${damScore}, sire: ${stallion._sire_line_strength})` });
    }
  } else {
    skipped.push({ key: 'weak_genetic_lines', reason: 'Mare dam_strength_score not provided' });
  }

  // BOOST 1: Proven cross
  const mareSire = mare?.genetics?.sire;
  if (mareSire != null && mareSire !== '') {
    if ((stallion._proven_crosses ?? []).includes(mareSire)) {
      modifier += RULES.PROVEN_CROSS.pts;
      applied.push({ ...RULES.PROVEN_CROSS, detail: `${stallion.name} x ${mareSire} is a documented proven cross` });
    } else {
      skipped.push({ key: 'proven_cross', reason: `${mareSire} not in proven crosses list` });
    }
  } else {
    skipped.push({ key: 'proven_cross', reason: 'Mare sire not provided' });
  }

  // BOOST 3: Strong offspring record — discipline-specific earnings preferred.
  // Uses discipline_earnings[targetDisc] when available so a barrel sire's $20M
  // doesn't inflate his team roping score. Falls back to total offspring_earnings
  // for stallions without the per-discipline breakdown.
  const discipline   = mare?.performance?.discipline;
  const discEarn     = discipline
    ? (stallion.performance?.discipline_earnings?.[discipline] ?? null)
    : null;
  const offEarnings  = discEarn ?? stallion?.performance?.offspring_earnings ?? 0;
  const earnLabel    = discEarn != null ? `(${discipline}) ` : '(total) ';
  if (offEarnings >= 500000) {
    modifier += RULES.STRONG_OFFSPRING.pts;
    applied.push({ ...RULES.STRONG_OFFSPRING, detail: `Offspring earnings ${earnLabel}$${offEarnings.toLocaleString()}` });
  } else {
    skipped.push({ key: 'strong_offspring', reason: `${earnLabel}$${offEarnings.toLocaleString()} below $500k threshold` });
  }

  // BOOST 4: Trait compensation — stallion is strong in mare's documented weak trait
  // Fires when mare.preferences.weakness is set and stallion scores >= 85 in that trait.
  // Separate from COMPLEMENTARY_TRAITS (reactivity-based) — both can fire on the same pair.
  const weakness = mare?.preferences?.weakness;
  if (weakness && weakness !== '') {
    const getScore = TRAIT_SCORE_MAP[weakness];
    const stallionScore = getScore ? getScore(stallion) : null;
    if (stallionScore != null && stallionScore >= 85) {
      modifier += RULES.TRAIT_COMPENSATION.pts;
      applied.push({
        ...RULES.TRAIT_COMPENSATION,
        detail: `Stallion ${stallionScore}/100 in ${weakness.replace(/([A-Z])/g,' $1').toLowerCase().trim()} — compensates documented mare weakness`,
      });
    } else {
      skipped.push({
        key: 'trait_compensation',
        reason: stallionScore != null
          ? `Stallion ${weakness} = ${stallionScore}/100 (below 85 threshold)`
          : `Stallion ${weakness} data not available`,
      });
    }
  } else {
    skipped.push({ key: 'trait_compensation', reason: 'Mare weakness preference not specified' });
  }

  // Clamp
  const rawModifier = modifier;
  modifier = Math.max(MODIFIER_FLOOR, Math.min(MODIFIER_CEIL, modifier));

  return {
    modifier,
    rawModifier,
    wasClamped:   modifier !== rawModifier,
    applied,
    skipped,
    penaltyTotal: applied.filter(r => r.type === 'penalty').reduce((s, r) => s + r.pts, 0),
    boostTotal:   applied.filter(r => r.type === 'boost').reduce((s, r) => s + r.pts, 0),
  };
}

function applyModifier(rawScore, modifier) {
  // Additive: modifier is accumulated points, not a percentage fraction
  return Math.min(99, Math.max(1, Math.round(rawScore + modifier)));
}

module.exports = { evaluateInteractions, applyModifier, RULES, PERFORMANCE_DISCIPLINES };
