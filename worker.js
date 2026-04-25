// ============================================================
// BREEDING PREDICTION ENGINE — Cloudflare Worker
// Routes: POST /api/analyze  GET /api/stallions  GET /api/health
// Stallions loaded from Supabase at first request, cached in memory.
// ============================================================

// ─── In-memory stallion cache ────────────────────────────────
let STALLIONS   = null;
let CACHE_AT    = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function normaliseRow(r) {
  return {
    id:   r.id,
    name: r.name,
    station: r.station,
    genetics: {
      bloodline_cluster:      r.genetics_bloodline_cluster,
      offspring_success_score: r.genetics_offspring_success_score != null
                                ? Number(r.genetics_offspring_success_score) : null,
    },
    physical: {
      height_hands:      r.physical_height_hands    != null ? Number(r.physical_height_hands)    : null,
      weight_class:      r.physical_weight_class,
      bone_density_score:r.physical_bone_density_score != null ? Number(r.physical_bone_density_score) : null,
      balance_score:     r.physical_balance_score   != null ? Number(r.physical_balance_score)   : null,
    },
    mental: {
      trainability: r.mental_trainability != null ? Number(r.mental_trainability) : null,
      reactivity:   r.mental_reactivity   || null,
      consistency:  r.mental_consistency  != null ? Number(r.mental_consistency)  : null,
    },
    health: {
      soundness_score: r.health_soundness_score != null ? Number(r.health_soundness_score) : null,
    },
    performance: {
      earnings:          r.lifetime_earnings_usd          != null ? Number(r.lifetime_earnings_usd)          : null,
      offspring_earnings:r.offspring_earnings_total_usd   != null ? Number(r.offspring_earnings_total_usd)   : null,
      discipline_strength: {
        reining:      r.disc_strength_reining      != null ? Number(r.disc_strength_reining)      : null,
        cutting:      r.disc_strength_cutting      != null ? Number(r.disc_strength_cutting)      : null,
        cowHorse:     r.disc_strength_cowhorse     != null ? Number(r.disc_strength_cowhorse)     : null,
        teamRoping:   r.disc_strength_teamroping   != null ? Number(r.disc_strength_teamroping)   : null,
        barrelRacing: r.disc_strength_barrelracing != null ? Number(r.disc_strength_barrelracing) : null,
        ranchRiding:  r.disc_strength_ranchriding  != null ? Number(r.disc_strength_ranchriding)  : null,
      },
      discipline_earnings: {
        reining:      r.disc_earnings_reining      != null ? Number(r.disc_earnings_reining)      : null,
        cutting:      r.disc_earnings_cutting      != null ? Number(r.disc_earnings_cutting)      : null,
        cowHorse:     r.disc_earnings_cowhorse     != null ? Number(r.disc_earnings_cowhorse)     : null,
        teamRoping:   r.disc_earnings_teamroping   != null ? Number(r.disc_earnings_teamroping)   : null,
        barrelRacing: r.disc_earnings_barrelracing != null ? Number(r.disc_earnings_barrelracing) : null,
        ranchRiding:  r.disc_earnings_ranchriding  != null ? Number(r.disc_earnings_ranchriding)  : null,
      },
    },
    market: {
      stud_fee:     r.market_stud_fee_usd    != null ? Number(r.market_stud_fee_usd)    : null,
      demand_index: r.market_demand_index    != null ? Number(r.market_demand_index)    : null,
    },
    // Flat helper fields the pipeline reads directly
    _sire_line_strength: r.sire_line_strength    || null,
    _proven_crosses:     r.proven_crosses ? r.proven_crosses.split(',').map(s => s.trim()) : [],
    _disciplines:        r.primary_disciplines ? r.primary_disciplines.split('|') : [],
    _athleticism:        r.trait_athleticism  != null ? Number(r.trait_athleticism)  : null,
    _cow_sense:          r.trait_cow_sense    != null ? Number(r.trait_cow_sense)    : null,
    _speed:              r.trait_speed        != null ? Number(r.trait_speed)        : null,
    _stamina:            r.trait_stamina      != null ? Number(r.trait_stamina)      : null,
    _temperament:        r.trait_temperament  != null ? Number(r.trait_temperament)  : null,
  };
}

async function loadStallions(env) {
  const now = Date.now();
  if (STALLIONS && (now - CACHE_AT) < CACHE_TTL) return STALLIONS;

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/stallions?select=*&limit=500`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  STALLIONS = rows.map(normaliseRow);
  CACHE_AT  = now;
  return STALLIONS;
}

// ============================================================
// INTERACTIONS ENGINE (ported from engine/interactions.js)
// ============================================================

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

const PERFORMANCE_DISCIPLINES = new Set(['reining','cutting','cowHorse','barrelRacing']);

const TRAIT_SCORE_MAP = {
  cowSense:    s => s._cow_sense,
  speedRating: s => s._speed,
  stamina:     s => s._stamina,
  trainability:s => s.mental?.trainability,
  temperament: s => s._temperament,
};

function evaluateInteractions(stallion, mare) {
  const applied = [], skipped = [];
  let modifier = 0;

  const mareHt  = mare?.physical?.height_hands;
  const stallHt = stallion?.physical?.height_hands;
  if (mareHt != null && stallHt != null) {
    const diff = Math.abs(parseFloat(mareHt) - parseFloat(stallHt));
    if (diff > 2) { modifier += RULES.HEIGHT_MISMATCH.pts; applied.push({ ...RULES.HEIGHT_MISMATCH, detail: `Mare ${mareHt}h vs Stallion ${stallHt}h (diff ${diff.toFixed(1)}h)` }); }
    else skipped.push({ key: 'height_mismatch', reason: `Within range (diff ${diff.toFixed(1)}h)` });
  } else skipped.push({ key: 'height_mismatch', reason: 'Mare height not provided' });

  const mareReact  = mare?.mental?.reactivity;
  const stallReact = stallion?.mental?.reactivity;
  if (mareReact == null) {
    ['dual_high_reactivity','moderate_high_reactivity','low_low_performance','complementary_traits']
      .forEach(key => skipped.push({ key, reason: 'Mare reactivity not provided' }));
  } else {
    const pair = `${mareReact}x${stallReact}`;
    if (mareReact === 'high' && stallReact === 'high') {
      modifier += RULES.DUAL_HIGH_REACTIVITY.pts;
      applied.push({ ...RULES.DUAL_HIGH_REACTIVITY, detail: `Dual high reactivity (${pair})` });
      ['moderate_high_reactivity','low_low_performance','complementary_traits'].forEach(k => skipped.push({ key: k, reason: `High x High rule fired` }));
    } else if ((mareReact==='moderate'&&stallReact==='high')||(mareReact==='high'&&stallReact==='moderate')) {
      modifier += RULES.MODERATE_HIGH_REACTIVITY.pts;
      applied.push({ ...RULES.MODERATE_HIGH_REACTIVITY, detail: `Moderate x high reactivity (${pair})` });
      ['dual_high_reactivity','low_low_performance','complementary_traits'].forEach(k => skipped.push({ key: k, reason: `Not that pair` }));
    } else if (mareReact==='low' && stallReact==='low') {
      const discipline = mare?.performance?.discipline;
      if (discipline && PERFORMANCE_DISCIPLINES.has(discipline)) {
        modifier += RULES.LOW_LOW_PERFORMANCE.pts;
        applied.push({ ...RULES.LOW_LOW_PERFORMANCE, detail: `Dual low reactivity in ${discipline}` });
      } else skipped.push({ key: 'low_low_performance', reason: `Low x Low acceptable in ${discipline||'unknown'}` });
      ['dual_high_reactivity','moderate_high_reactivity','complementary_traits'].forEach(k => skipped.push({ key: k, reason: `Not that pair (${pair})` }));
    } else if ((mareReact==='low'&&stallReact==='high')||(mareReact==='high'&&stallReact==='low')) {
      modifier += RULES.COMPLEMENTARY_TRAITS.pts;
      applied.push({ ...RULES.COMPLEMENTARY_TRAITS, detail: `Opposing reactivity (${pair}) — balanced temperament projected` });
      ['dual_high_reactivity','moderate_high_reactivity','low_low_performance'].forEach(k => skipped.push({ key: k, reason: `Not that pair` }));
    } else {
      ['dual_high_reactivity','moderate_high_reactivity','low_low_performance','complementary_traits']
        .forEach(key => skipped.push({ key, reason: `Neutral pair (${pair})` }));
    }
  }

  const damScore = mare?.genetics?.dam_strength_score;
  if (damScore != null) {
    const damWeak  = parseFloat(damScore) < 35;
    const sireWeak = stallion._sire_line_strength==='weak' || stallion._sire_line_strength==='unknown'
                  || (stallion.genetics?.offspring_success_score != null && stallion.genetics.offspring_success_score < 35);
    if (damWeak && sireWeak) { modifier += RULES.WEAK_GENETIC_LINES.pts; applied.push({ ...RULES.WEAK_GENETIC_LINES, detail: `Dam strength ${damScore}/100, sire line: ${stallion._sire_line_strength??'unknown'}` }); }
    else skipped.push({ key: 'weak_genetic_lines', reason: `Not both weak` });
  } else skipped.push({ key: 'weak_genetic_lines', reason: 'Mare dam_strength_score not provided' });

  const mareSire = mare?.genetics?.sire;
  if (mareSire != null && mareSire !== '') {
    if ((stallion._proven_crosses??[]).includes(mareSire)) { modifier += RULES.PROVEN_CROSS.pts; applied.push({ ...RULES.PROVEN_CROSS, detail: `${stallion.name} x ${mareSire} proven cross` }); }
    else skipped.push({ key: 'proven_cross', reason: `${mareSire} not in proven crosses` });
  } else skipped.push({ key: 'proven_cross', reason: 'Mare sire not provided' });

  const discipline  = mare?.performance?.discipline;
  const discEarn    = discipline ? (stallion.performance?.discipline_earnings?.[discipline]??null) : null;
  const offEarnings = discEarn ?? stallion?.performance?.offspring_earnings ?? 0;
  const earnLabel   = discEarn != null ? `(${discipline}) ` : '(total) ';
  if (offEarnings >= 500000) { modifier += RULES.STRONG_OFFSPRING.pts; applied.push({ ...RULES.STRONG_OFFSPRING, detail: `Offspring earnings ${earnLabel}$${offEarnings.toLocaleString()}` }); }
  else skipped.push({ key: 'strong_offspring', reason: `${earnLabel}$${offEarnings.toLocaleString()} below $500k` });

  const weakness = mare?.preferences?.weakness;
  if (weakness && weakness !== '') {
    const getScore = TRAIT_SCORE_MAP[weakness];
    const sScore = getScore ? getScore(stallion) : null;
    if (sScore != null && sScore >= 85) { modifier += RULES.TRAIT_COMPENSATION.pts; applied.push({ ...RULES.TRAIT_COMPENSATION, detail: `Stallion ${sScore}/100 in ${weakness} — compensates mare weakness` }); }
    else skipped.push({ key: 'trait_compensation', reason: sScore!=null ? `Stallion ${weakness}=${sScore}/100 (below 85)` : `Data not available` });
  } else skipped.push({ key: 'trait_compensation', reason: 'Mare weakness not specified' });

  const rawModifier = modifier;
  modifier = Math.max(-45, Math.min(19, modifier));
  return {
    modifier, rawModifier, wasClamped: modifier !== rawModifier, applied, skipped,
    penaltyTotal: applied.filter(r=>r.type==='penalty').reduce((s,r)=>s+r.pts,0),
    boostTotal:   applied.filter(r=>r.type==='boost').reduce((s,r)=>s+r.pts,0),
  };
}

function applyModifier(rawScore, modifier) {
  return Math.min(99, Math.max(1, Math.round(rawScore + modifier)));
}

// ============================================================
// SCORING ENGINE (ported from engine/scoring.js)
// ============================================================

const CATEGORY_WEIGHTS  = { genetic:0.40, physical:0.20, traits:0.20, performance:0.15, market:0.05 };
const CONFIDENCE_WEIGHTS = { genetics:0.40, physical:0.20, mental:0.20, performance:0.15, cosmetic:0.05 };
const SUB_WEIGHTS = {
  genetic:     { discipline_fit:0.45, offspring_success:0.35, sire_line:0.20 },
  physical:    { balance_score:0.40, athleticism:0.35, bone_density:0.25 },
  traits:      { trainability:0.22, consistency:0.10, cow_sense:0.18, speed:0.18, stamina:0.18, temperament:0.14 },
  performance: { offspring_earnings:0.40, earnings:0.25, offspring_success:0.35 },
  market:      { fee_value:0.50, demand_index:0.50 },
};
const DISCIPLINE_TRAIT_WEIGHTS = {
  reining:      { trainability:0.36, consistency:0.10, cow_sense:0.05, speed:0.18, stamina:0.13, temperament:0.18 },
  cutting:      { trainability:0.14, consistency:0.10, cow_sense:0.40, speed:0.14, stamina:0.09, temperament:0.13 },
  cowHorse:     { trainability:0.23, consistency:0.10, cow_sense:0.27, speed:0.14, stamina:0.13, temperament:0.13 },
  barrelRacing: { trainability:0.14, consistency:0.10, cow_sense:0.05, speed:0.40, stamina:0.18, temperament:0.13 },
  teamRoping:   { trainability:0.18, consistency:0.10, cow_sense:0.18, speed:0.23, stamina:0.22, temperament:0.09 },
  ranchRiding:  { trainability:0.22, consistency:0.12, cow_sense:0.13, speed:0.09, stamina:0.22, temperament:0.22 },
};
const SIRE_LINE_SCORES = { elite:95, premier:82, strong:72, listed:58, moderate:50, weak:28, unknown:40 };

function normalizeEarnings(dollars) {
  if (dollars==null||isNaN(dollars)||dollars<=0) return null;
  return Math.min(99, Math.round(Math.log10(dollars+1)/Math.log10(25_000_000)*99));
}
function normalizeFee(dollars) {
  if (dollars==null||isNaN(dollars)) return null;
  if (dollars<=0) return 100;
  return Math.max(18, Math.round(100 - Math.log10(dollars+1)/Math.log10(30_000)*72));
}
function wScore(values, weights) {
  let totalW=0, wSum=0, n=0;
  const sumW = Object.values(weights).reduce((a,v)=>a+v,0);
  const tot  = Object.keys(weights).length;
  for (const [field,w] of Object.entries(weights)) {
    const v = values[field];
    if (v!=null && !isNaN(Number(v))) { totalW+=w; wSum+=Number(v)*w; n++; }
  }
  return { score: totalW>0 ? Math.round(wSum/totalW) : 0, coverage: sumW>0 ? totalW/sumW : 0, provided:n, total:tot };
}
function blendMareStallion(sv, mv) {
  if (sv==null&&mv==null) return null;
  if (sv==null) return Math.round(mv);
  if (mv==null) return sv;
  return Math.round(sv*0.55+mv*0.45);
}
function scoreGenetic(stallion, mare) {
  const td = mare?.performance?.discipline;
  return wScore({ discipline_fit: td?(stallion.performance?.discipline_strength?.[td]??null):null, offspring_success: stallion.genetics?.offspring_success_score??null, sire_line: SIRE_LINE_SCORES[stallion._sire_line_strength??'unknown']??null }, SUB_WEIGHTS.genetic);
}
function scorePhysical(stallion) {
  return wScore({ balance_score: stallion.physical?.balance_score??null, athleticism: stallion._athleticism??null, bone_density: stallion.physical?.bone_density_score??null }, SUB_WEIGHTS.physical);
}
function scoreTraits(stallion, discipline, mare) {
  const weights = DISCIPLINE_TRAIT_WEIGHTS[discipline]??SUB_WEIGHTS.traits;
  return wScore({ trainability: blendMareStallion(stallion.mental?.trainability??null, mare?.mental?.trainability??null), consistency: blendMareStallion(stallion.mental?.consistency??null, mare?.mental?.consistency??null), cow_sense: stallion._cow_sense??null, speed: stallion._speed??null, stamina: stallion._stamina??null, temperament: stallion._temperament??null }, weights);
}
function scorePerformance(stallion, discipline) {
  const discE = discipline?(stallion.performance?.discipline_earnings?.[discipline]??null):null;
  const earnToScore = discE ?? stallion.performance?.offspring_earnings ?? null;
  return wScore({ offspring_earnings: normalizeEarnings(earnToScore), earnings: normalizeEarnings(stallion.performance?.earnings), offspring_success: stallion.genetics?.offspring_success_score??null }, SUB_WEIGHTS.performance);
}
function scoreMarket(stallion) {
  return wScore({ fee_value: normalizeFee(stallion.market?.stud_fee), demand_index: stallion.market?.demand_index??null }, SUB_WEIGHTS.market);
}
function scoreStallion(stallion, mare) {
  const discipline = mare?.performance?.discipline??null;
  const gen=scoreGenetic(stallion,mare), phy=scorePhysical(stallion), tr=scoreTraits(stallion,discipline,mare), per=scorePerformance(stallion,discipline), mkt=scoreMarket(stallion);
  const allCats = [
    {score:gen.score,coverage:gen.coverage,weight:CATEGORY_WEIGHTS.genetic},
    {score:phy.score,coverage:phy.coverage,weight:CATEGORY_WEIGHTS.physical},
    {score:tr.score, coverage:tr.coverage, weight:CATEGORY_WEIGHTS.traits},
    {score:per.score,coverage:per.coverage,weight:CATEGORY_WEIGHTS.performance},
    {score:mkt.score,coverage:mkt.coverage,weight:CATEGORY_WEIGHTS.market},
  ];
  const activeCats   = allCats.filter(c=>c.coverage>0);
  const activeWeight = activeCats.reduce((s,c)=>s+c.weight,0);
  const rawScore     = activeWeight>0 ? activeCats.reduce((s,c)=>s+c.score*(c.weight/activeWeight),0) : 0;
  const confidence   = gen.coverage*CONFIDENCE_WEIGHTS.genetics + phy.coverage*CONFIDENCE_WEIGHTS.physical + tr.coverage*CONFIDENCE_WEIGHTS.mental + per.coverage*CONFIDENCE_WEIGHTS.performance + mkt.coverage*CONFIDENCE_WEIGHTS.cosmetic;
  return { stallion, rawScore:Math.round(rawScore), catScores:{genetic:gen.score,physical:phy.score,traits:tr.score,performance:per.score,market:mkt.score}, catCoverage:{genetic:Math.round(gen.coverage*100),physical:Math.round(phy.coverage*100),traits:Math.round(tr.coverage*100),performance:Math.round(per.coverage*100),market:Math.round(mkt.coverage*100)}, confidence:Math.round(confidence*100) };
}

// ============================================================
// PIPELINE (ported from engine/pipeline.js)
// ============================================================

const BASE_RATES = { elite:0.03, strong:0.12, average:0.45, miss:0.40 };
const OUTCOME_DEFINITIONS = { elite:'Futurity finalist, top-10 world standing, or >$50,000 documented earnings', strong:'Competitive at open level, earns in competition, places at regional events', average:'Participates in discipline, limited placings, serviceable mount', miss:'Does not meet discipline physical or behavioral requirements' };
const NEUTRAL_SCORE = 55;
const STALLION_CONF_FLAGS = [{ below:50, level:'HIGH' },{ below:70, level:'MODERATE' },{ below:85, level:'LOW' }];
const LIKELIHOOD_RATIOS = [[90,99,'elite_heavy',11.67,2.67,0.56,0.20],[75,89,'strong_dominant',4.00,3.50,0.78,0.28],[60,74,'mixed',1.67,1.58,0.98,0.80],[0,59,'risk_increases',0.33,0.50,0.89,1.32]];

function applyStallionConfidence(finalScore, confidence) {
  const cf = Math.max(0,Math.min(100,confidence))/100;
  return Math.round(finalScore*cf + NEUTRAL_SCORE*(1-cf));
}
function scoreToProbability(score) {
  score = Math.max(0,Math.min(99,Math.round(score)));
  const band = LIKELIHOOD_RATIOS.find(([min,max])=>score>=min&&score<=max)??LIKELIHOOD_RATIOS[LIKELIHOOD_RATIOS.length-1];
  const [,,bandLabel,eliteLR,strongLR,avgLR,missLR] = band;
  const adjusted = { elite:BASE_RATES.elite*eliteLR, strong:BASE_RATES.strong*strongLR, average:BASE_RATES.average*avgLR, miss:BASE_RATES.miss*missLR };
  const total = Object.values(adjusted).reduce((s,v)=>s+v,0);
  const pct = { elite:Math.round(adjusted.elite/total*100), strong:Math.round(adjusted.strong/total*100), average:Math.round(adjusted.average/total*100), miss:Math.round(adjusted.miss/total*100) };
  const sum = pct.elite+pct.strong+pct.average+pct.miss;
  if (sum!==100) { const largest=Object.entries(pct).sort((a,b)=>b[1]-a[1])[0][0]; pct[largest]+=100-sum; }
  pct._derivation = { score, band:`${band[0]}-${band[1]}`, band_label:bandLabel, base_rates:{...BASE_RATES}, likelihood_ratios:{elite:eliteLR,strong:strongLR,average:avgLR,miss:missLR}, adjusted_before_norm:{elite:+(adjusted.elite.toFixed(4)),strong:+(adjusted.strong.toFixed(4)),average:+(adjusted.average.toFixed(4)),miss:+(adjusted.miss.toFixed(4))}, note:'base_rate × likelihood_ratio → normalize → integer percentage' };
  return pct;
}
function projectTraits(stallion, mare) {
  const mTrainability = mare?.mental?.trainability??null;
  const mReactivity   = mare?.mental?.reactivity??null;
  const REACT_TEMP = {low:90,moderate:60,high:28};
  const mTemp = mReactivity ? REACT_TEMP[mReactivity]??null : null;
  const blend = (sv,mv,sw=0.55,mw=0.45) => { if(sv==null&&mv==null)return null; if(sv==null)return Math.round(mv); if(mv==null)return Math.round(sv); return Math.min(100,Math.max(0,Math.round(sv*sw+mv*mw))); };
  return { athleticism:blend(stallion._athleticism,null), trainability:blend(stallion.mental?.trainability,mTrainability), cow_sense:blend(stallion._cow_sense,null), speed:blend(stallion._speed,null), stamina:blend(stallion._stamina,null), temperament:blend(stallion._temperament,mTemp), top_discipline:stallion._disciplines?.[0]??null };
}
const DISC_LABELS = { reining:'Reining', cutting:'Cutting', cowHorse:'Working Cow Horse', teamRoping:'Team Roping', barrelRacing:'Barrel Racing', ranchRiding:'Ranch Riding' };
const TIER_WHY = { Gold:'highest overall weighted score across all five categories', Silver:'most balanced profile — highest floor score with no critical category weakness', Bronze:'optimal bloodline diversity — distinct genetic family from Gold providing maximum cross variety' };
const CAT_LABELS = { genetic:'Genetic', physical:'Physical', traits:'Traits', performance:'Performance', market:'Market' };

function buildExplanation(scored, mare, tier) {
  const { stallion:s, finalScore, effectiveScore, rawScore, catScores, interactions } = scored;
  const disc = DISC_LABELS[mare?.performance?.discipline??s._disciplines?.[0]]??'target discipline';
  const sireTag = (s._sire_line_strength??'unknown').charAt(0).toUpperCase()+(s._sire_line_strength??'unknown').slice(1);
  const topCat = Object.entries(catScores).sort((a,b)=>b[1]-a[1])[0];
  const boosts=interactions.applied.filter(r=>r.type==='boost'), penalties=interactions.applied.filter(r=>r.type==='penalty');
  const c1=`${s.name} (${sireTag}-tier, ${s.genetics?.bloodline_cluster??'Unknown'} bloodline) scores ${finalScore}/100 for ${disc} — selected as ${tier}: ${TIER_WHY[tier]}.`;
  const c2=`Strongest category: ${CAT_LABELS[topCat[0]]} (${topCat[1]}/100).`+(boosts.length?` Boosts: ${boosts.map(b=>b.key.replace(/_/g,' ')+'(+'+b.pts+' pts)').join(', ')}.`:'')+( penalties.length?` Penalties: ${penalties.map(p=>p.key.replace(/_/g,' ')+'('+p.pts+' pts)').join(', ')}.`:'');
  const netMod=interactions.penaltyTotal+interactions.boostTotal;
  const confAdj=effectiveScore!=null&&effectiveScore!==finalScore?` Confidence adjustment: ${finalScore} → ${effectiveScore}.`:'';
  const c3=netMod!==0?`Net modifier ${netMod>0?'+':''}${netMod}% moved raw score ${rawScore} → ${finalScore}.${confAdj}`:`No interaction modifiers applied.${confAdj}`;
  return [c1,c2,c3].join(' ').slice(0,400);
}

const MARE_CONF_FIELDS = { genetics:['sire','dam','bloodline_cluster','dam_strength_score'], physical:['height_hands','weight_class','bone_density_score','balance_score'], mental:['trainability','reactivity','consistency'], performance:['discipline','earnings','level'], cosmetic:['color','eye_type'] };
const MARE_CONF_WEIGHTS = { genetics:0.40, physical:0.20, mental:0.20, performance:0.15, cosmetic:0.05 };

function computeMareConfidence(mare) {
  let total=0;
  for (const [section,fields] of Object.entries(MARE_CONF_FIELDS)) {
    const weight = MARE_CONF_WEIGHTS[section]??0;
    if (weight===0) continue;
    const provided = fields.filter(f=>{const v=mare?.[section]?.[f]; return v!=null&&v!=='';}).length;
    total+=(provided/fields.length)*weight;
  }
  return Math.round(total*100);
}

function hardFilter(stallions, mare) {
  const targetDisc=mare?.performance?.discipline, mareReact=mare?.mental?.reactivity;
  const budget=mare?.preferences?.budget, avail=mare?.preferences?.availability;
  return stallions.filter(s=>{
    if (targetDisc && !s._disciplines?.includes(targetDisc)) return false;
    if (mareReact==='high' && s.mental?.reactivity==='high') return false;
    if (s.health?.soundness_score!=null && s.health.soundness_score<30) return false;
    if (budget==='under2k' && s.market?.stud_fee!=null && s.market.stud_fee>2000) return false;
    if (budget==='under5k' && s.market?.stud_fee!=null && s.market.stud_fee>5000) return false;
    if (avail==='open' && s.market?.demand_index!=null && s.market.demand_index>85) return false;
    return true;
  });
}
function scoreAll(candidates, mare) {
  return candidates.map(stallion=>{
    const scored=scoreStallion(stallion,mare);
    const interactions=evaluateInteractions(stallion,mare);
    const finalScore=applyModifier(scored.rawScore,interactions.modifier);
    const effectiveScore=applyStallionConfidence(finalScore,scored.confidence);
    return {...scored,interactions,finalScore,effectiveScore};
  }).sort((a,b)=>b.effectiveScore-a.effectiveScore);
}
function selectTiers(scored) {
  if (!scored.length) return [];
  const gold={...scored[0],tier:'Gold'}, rest=scored.slice(1);
  if (!rest.length) return [gold];
  const minCat=s=>Math.min(...Object.values(s.catScores));
  const variance=s=>{const vals=Object.values(s.catScores),mean=vals.reduce((a,v)=>a+v,0)/vals.length;return vals.reduce((a,v)=>a+(v-mean)**2,0)/vals.length;};
  const silver={...rest.reduce((b,s)=>{const sm=minCat(s),bm=minCat(b);if(sm>bm)return s;if(sm<bm)return b;const sv=variance(s),bv=variance(b);if(sv<bv)return s;if(sv>bv)return b;return s.effectiveScore>b.effectiveScore?s:b;},rest[0]),tier:'Silver'};
  const notSilver=rest.filter(s=>s.stallion.id!==silver.stallion.id);
  if (!notSilver.length) return [gold,silver];
  const goldCluster=gold.stallion.genetics?.bloodline_cluster;
  const bronze={...notSilver.reduce((b,s)=>{if(!b)return s;const sd=s.stallion.genetics?.bloodline_cluster!==goldCluster,bd=b.stallion.genetics?.bloodline_cluster!==goldCluster;if(sd&&!bd)return s;if(!sd&&bd)return b;if(s.effectiveScore!==b.effectiveScore)return s.effectiveScore>b.effectiveScore?s:b;return s.rawScore>b.rawScore?s:b;},notSilver[0]),tier:'Bronze'};
  return [gold,silver,bronze];
}
function buildOutput(tiers, mare, confidence) {
  const matches=tiers.map(t=>{
    const prob=scoreToProbability(t.finalScore);
    const derivation=prob._derivation;
    const {_derivation,...probability}=prob;
    const stallionConf=t.confidence;
    const confFlagLevel=(STALLION_CONF_FLAGS.find(f=>stallionConf<f.below)??{}).level??null;
    const confFlag=confFlagLevel?[{level:confFlagLevel,type:'stallion_data_confidence',message:`Stallion record ${stallionConf}% complete — score adjusted from ${t.finalScore} to ${t.effectiveScore}`}]:[];
    return {
      tier:t.tier, stallion_name:t.stallion.name, score:t.effectiveScore, raw_score:t.finalScore,
      stallion_data_confidence:stallionConf,
      category_scores:{genetic:t.catScores.genetic,physical:t.catScores.physical,traits:t.catScores.traits,performance:t.catScores.performance,market:t.catScores.market},
      category_coverage:{genetic:t.catCoverage.genetic,physical:t.catCoverage.physical,traits:t.catCoverage.traits,performance:t.catCoverage.performance,market:t.catCoverage.market},
      probability,
      probability_derivation:{score_band:derivation.band,likelihood_ratios:derivation.likelihood_ratios,adjusted_raw:derivation.adjusted_before_norm,note:derivation.note},
      traits:projectTraits(t.stallion,mare),
      risk:{flags:[...t.interactions.applied.filter(r=>r.type==='penalty').map(r=>({level:Math.abs(r.pts)>=10?'HIGH':Math.abs(r.pts)>=4?'MODERATE':'LOW',type:r.key,message:r.detail})),...confFlag],penalty_total:t.interactions.penaltyTotal,boost_total:t.interactions.boostTotal,net_modifier:t.interactions.penaltyTotal+t.interactions.boostTotal},
      explanation:buildExplanation(t,mare,t.tier),
    };
  });
  return { matches, confidence:Math.round(confidence), probability_methodology:{model:'base_rate_anchored',base_rates:BASE_RATES,definitions:OUTCOME_DEFINITIONS,description:'probability = normalize(base_rate * likelihood_ratio). Score band determines likelihood_ratio per outcome.'} };
}
function runPipeline(allStallions, mare) {
  const t0=Date.now();
  const filtered=hardFilter(allStallions,mare);
  const scored=scoreAll(filtered,mare);
  const tiers=selectTiers(scored);
  const mareConf=computeMareConfidence(mare);
  const output=buildOutput(tiers,mare,mareConf);
  return { output, diagnostics:{totalStallions:allStallions.length,afterHardFilter:filtered.length,afterScoring:scored.length,tiersSelected:tiers.length,durationMs:Date.now()-t0,mare:{discipline:mare?.performance?.discipline,fieldsProvided:Object.values(mare||{}).flatMap(s=>Object.values(s||{})).filter(v=>v!=null).length}} };
}

// ============================================================
// INPUT VALIDATION
// ============================================================

const VALID = {
  disciplines:  ['reining','cutting','cowHorse','teamRoping','barrelRacing','ranchRiding'],
  reactivity:   ['low','moderate','high'],
  weight_class: ['light','medium','heavy'],
  earnings:     ['none','regional','listed','stakes','elite'],
  perf_levels:  ['green','amateur','regional','open','elite'],
  budget:       ['under2k','under5k','any'],
  availability: ['open','limited'],
  weakness:     ['cowSense','speedRating','stamina','trainability','temperament'],
  eye_types:    ['standard','blue','partial_blue','glass'],
};
const NUMERIC_RANGES = [['genetics','dam_strength_score',0,100],['physical','height_hands',13.0,17.3],['physical','bone_density_score',0,100],['physical','balance_score',0,100],['mental','trainability',0,100],['mental','consistency',0,100],['health','soundness_score',0,100]];
const ENUM_FIELDS = [['performance','discipline',VALID.disciplines],['performance','earnings',VALID.earnings],['performance','level',VALID.perf_levels],['mental','reactivity',VALID.reactivity],['physical','weight_class',VALID.weight_class],['cosmetic','eye_type',VALID.eye_types],['preferences','budget',VALID.budget],['preferences','availability',VALID.availability],['preferences','weakness',VALID.weakness]];

function validateMareInput(mare) {
  const errors=[];
  if (!mare||typeof mare!=='object') return ['Request body must be a JSON object'];
  if (!mare?.performance?.discipline) errors.push('performance.discipline: required field is missing');
  for (const [section,field,min,max] of NUMERIC_RANGES) {
    const val=mare?.[section]?.[field]; if(val==null)continue;
    const n=Number(val);
    if(isNaN(n)) errors.push(`${section}.${field}: must be a number, got "${val}"`);
    else if(n<min||n>max) errors.push(`${section}.${field}: ${n} out of range [${min}–${max}]`);
  }
  for (const [section,field,allowed] of ENUM_FIELDS) {
    const val=mare?.[section]?.[field]; if(val==null||val==='')continue;
    if(!allowed.includes(val)) errors.push(`${section}.${field}: "${val}" not valid — must be one of: ${allowed.join(', ')}`);
  }
  return errors;
}

// ============================================================
// CORS HELPER
// ============================================================

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  };
}

function json(data, status=200, extraHeaders={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ============================================================
// API KEY AUTH
// ============================================================

function checkApiKey(request, env) {
  const expected = env.BREEDING_API_KEY;
  if (!expected) return null; // open mode
  const provided = request.headers.get('X-Api-Key');
  if (!provided) return json({ error:'UNAUTHORIZED', message:'X-Api-Key header required.' }, 401);
  if (provided !== expected) return json({ error:'FORBIDDEN', message:'Invalid API key.' }, 403);
  return null;
}

// ============================================================
// WORKER ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const cors   = corsHeaders(env);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // ── POST /api/analyze ──────────────────────────────────
    if (method === 'POST' && url.pathname === '/api/analyze') {
      const authErr = checkApiKey(request, env);
      if (authErr) return authErr;
      let body;
      try { body = await request.json(); }
      catch { return json({ error:'BAD_REQUEST', message:'Invalid JSON.' }, 400, cors); }
      const errors = validateMareInput(body);
      if (errors.length) return json({ error:'VALIDATION_ERROR', message:'Input validation failed.', errors }, 400, cors);
      try {
        const stallions = await loadStallions(env);
        const { output, diagnostics } = runPipeline(stallions, body);
        if (!output.matches.length) return json({ matches:[], confidence:0, message:'No stallions matched.', diagnostics }, 200, cors);
        return json({ ...output, diagnostics }, 200, cors);
      } catch (err) {
        return json({ error:'PIPELINE_ERROR', message:err.message }, 500, cors);
      }
    }

    // ── GET /api/stallions ─────────────────────────────────
    if (method === 'GET' && url.pathname === '/api/stallions') {
      const authErr = checkApiKey(request, env);
      if (authErr) return authErr;
      try {
        const stallions = await loadStallions(env);
        const disc = url.searchParams.get('discipline');
        const data = disc ? stallions.filter(s=>s._disciplines?.includes(disc)) : stallions;
        return json({ count:data.length, stallions:data }, 200, cors);
      } catch (err) {
        return json({ error:'DB_ERROR', message:err.message }, 500, cors);
      }
    }

    // ── GET /api/health ────────────────────────────────────
    if (method === 'GET' && url.pathname === '/api/health') {
      const stallionCount = STALLIONS?.length ?? 0;
      const cacheAge = CACHE_AT ? Math.round((Date.now()-CACHE_AT)/1000) : null;
      return json({ status:'ok', stallions:stallionCount, source:'supabase', cache_age_seconds:cacheAge, version:'1.1.0' }, 200, cors);
    }

    return json({ error:'NOT_FOUND', message:`No route for ${method} ${url.pathname}` }, 404, cors);
  },
};
