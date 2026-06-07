import { createClient } from "@supabase/supabase-js";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) throw new Error("SUPABASE_URL missing");
if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY missing");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Global flow thresholds (ETH-scale, ~16 strikes) ─────────────────────────
const FLOW_STRONG    = 1_000_000;
const FLOW_MODERATE  =   250_000;
const FLOW_NEUTRAL   =    50_000; // below this = no conviction

// ─── ATM-specific thresholds (5-strike window only) ──────────────────────────
const ATM_FLOW_STRONG   = 200_000;
const ATM_FLOW_MODERATE =  75_000;

// ─── Other constants ──────────────────────────────────────────────────────────
const VELOCITY_EXPANSION = 100_000;
const DOMINANCE_STRONG   = 0.70;
const DOMINANCE_MODERATE = 0.55;
const ATM_HALF_WINDOW    = 2;     // ±2 strikes by index
const CONFIDENCE_BASE    = 40;
const REVERSAL_STREAK    = 4;     // runs of same bias before reversal counts

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function getState() {
  const { data, error } = await supabase
    .from("eth_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error("eth_state read failed: " + error.message);
  return data;
}

async function insertAIHistory(payload) {
  const { error } = await supabase.from("eth_ai_history").insert(payload);
  if (error) throw new Error("eth_ai_history insert failed: " + error.message);
}

async function getRecentAIHistory(limit = 8) {
  const { data, error } = await supabase
    .from("eth_ai_history")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("eth_ai_history read failed: " + error.message);
  return (data || []).reverse(); // oldest → newest
}

async function updateStateAIContext(aiContext) {
  const { error } = await supabase
    .from("eth_state")
    .update({ ai_context: aiContext })
    .eq("id", 1);
  if (error) throw new Error("eth_state ai_context update failed: " + error.message);
}

// ─── 1. DIRECTION ─────────────────────────────────────────────────────────────
function detectBias(netFlow) {
  if (Math.abs(netFlow) < FLOW_NEUTRAL) return "NEUTRAL";
  return netFlow > 0 ? "BULLISH" : "BEARISH";
}

// ─── 2. FLOW MAGNITUDE ───────────────────────────────────────────────────────
function detectFlowMagnitude(netFlow) {
  const abs = Math.abs(netFlow);
  if (abs >= FLOW_STRONG)   return "STRONG";
  if (abs >= FLOW_MODERATE) return "MODERATE";
  return "WEAK";
}

// ─── 3. STRENGTH + DOMINANCE ─────────────────────────────────────────────────
function detectStrength(bullishStrikes, bearishStrikes, bias) {
  const total = bullishStrikes + bearishStrikes;
  if (total === 0) return { strength: "WEAK", dominance: 50, dominanceScore: 0 };

  const dominantCount = bias === "BULLISH" ? bullishStrikes : bearishStrikes;
  const dominanceFrac = dominantCount / total;
  const dominanceScore = bullishStrikes - bearishStrikes;

  let strength;
  if (dominanceFrac >= DOMINANCE_STRONG)        strength = "STRONG";
  else if (dominanceFrac >= DOMINANCE_MODERATE) strength = "MODERATE";
  else                                           strength = "WEAK";

  return {
    strength,
    dominance:      Math.round(dominanceFrac * 100),
    dominanceScore,
  };
}

// ─── 4. FLOW ACCELERATION ────────────────────────────────────────────────────
function detectAcceleration(flowVelocity, bias) {
  const v = Number(flowVelocity) || 0;
  if (bias === "NEUTRAL") return "BALANCED";

  if (bias === "BULLISH") {
    if (v >  VELOCITY_EXPANSION) return "EXPANSION";
    if (v < -VELOCITY_EXPANSION) return "SLOWDOWN";
    return "BALANCED";
  }
  // BEARISH: velocity is negative when accelerating downward
  if (v < -VELOCITY_EXPANSION) return "EXPANSION";
  if (v >  VELOCITY_EXPANSION) return "SLOWDOWN";
  return "BALANCED";
}

// ─── 5. ATM PRESSURE — index-based window, separate thresholds ───────────────
function analyzeATMPressure(strikeFlows, atm) {
  if (!Array.isArray(strikeFlows) || !strikeFlows.length) {
    return { atmPressure: "UNKNOWN", atmNetFlow: 0, atmStrikes: [] };
  }

  // Find ATM index by closest strike
  let atmIndex = 0;
  let best = Infinity;
  strikeFlows.forEach((sf, i) => {
    const diff = Math.abs(Number(sf.strike) - Number(atm));
    if (diff < best) { best = diff; atmIndex = i; }
  });

  // Slice exactly ±2 by index (5 strikes regardless of point spacing)
  const lo = Math.max(0, atmIndex - ATM_HALF_WINDOW);
  const hi = Math.min(strikeFlows.length - 1, atmIndex + ATM_HALF_WINDOW);
  const window = strikeFlows.slice(lo, hi + 1);

  // Raw flows only — ignore pct fields
  const atmNetFlow = window.reduce(
    (sum, sf) => sum + ((Number(sf.peFlow) || 0) - (Number(sf.ceFlow) || 0)),
    0
  );

  // Use ATM-specific thresholds (smaller window = lower threshold)
  let atmPressure;
  if (atmNetFlow >= ATM_FLOW_STRONG)        atmPressure = "STRONG_BULL_PRESSURE";
  else if (atmNetFlow >= ATM_FLOW_MODERATE) atmPressure = "BULLISH_PRESSURE";
  else if (atmNetFlow <= -ATM_FLOW_STRONG)  atmPressure = "STRONG_BEAR_PRESSURE";
  else if (atmNetFlow <= -ATM_FLOW_MODERATE) atmPressure = "BEARISH_PRESSURE";
  else                                       atmPressure = "NEUTRAL";

  return {
    atmPressure,
    atmNetFlow,
    atmStrikes: window.map(sf => sf.strike),
  };
}

// ─── 6. SIGNAL — clear hierarchy, no duplicate conditions ────────────────────
//
// Priority order (highest → lowest):
//
//  TIER 1 — STRONG magnitude writer activity (most reliable)
//    CE↓ PE↑ + STRONG  → CALL_SHORT_COVERING   (very bullish)
//    PE↓ CE↑ + STRONG  → PUT_UNWINDING         (very bearish)
//
//  TIER 2 — Normal writer buildup (moderate or weak magnitude)
//    CE↑ PE↓           → CALL_WRITER_BUILDUP   (bearish)
//    PE↑ CE↓           → PUT_WRITER_BUILDUP    (bullish)
//    CE↓ PE↑ (weak)    → CALL_WRITER_EXIT      (mild bullish)
//    PE↓ CE↑ (weak)    → PUT_WRITER_EXIT       (mild bearish)
//
//  TIER 3 — Both sides building / falling
//    CE↑ PE↑           → OI_BUILDUP / BULL_BREAKOUT / BEAR_BREAKDOWN
//    CE↓ PE↓           → OI_UNWINDING
//
//  TIER 4 — Exhaustion
//    STRONG + SLOWDOWN → BULL/BEAR_EXHAUSTION
//
//  TIER 5 — Generic directional
//    BULLISH_FLOW / BEARISH_FLOW / NO_SIGNAL

function detectSignal(bias, magnitude, acceleration, ceFlow, peFlow) {
  const ce = Number(ceFlow) || 0;
  const pe = Number(peFlow) || 0;

  // ── TIER 1: Strong writer activity ───────────────────────────────────────
  if (magnitude === "STRONG") {
    if (ce < 0 && pe > 0) return "CALL_SHORT_COVERING";  // very bullish
    if (pe < 0 && ce > 0) return "PUT_UNWINDING";         // very bearish
  }

  // ── TIER 2: Directional buildup / exit ───────────────────────────────────
  if (ce > 0 && pe < 0) return "CALL_WRITER_BUILDUP";   // CE building, PE unwinding → bearish
  if (pe > 0 && ce < 0) return "PUT_WRITER_BUILDUP";    // PE building, CE unwinding → bullish
  if (ce < 0 && pe > 0) return "CALL_WRITER_EXIT";      // CE exiting (mild bullish)
  if (pe < 0 && ce > 0) return "PUT_WRITER_EXIT";       // PE exiting (mild bearish)

  // ── TIER 3: Both sides moving ─────────────────────────────────────────────
  if (ce > 0 && pe > 0) {
    if (magnitude === "WEAK") return "OI_TRAP";
    if (bias === "BULLISH" && acceleration === "EXPANSION") return "BULL_BREAKOUT";
    if (bias === "BEARISH" && acceleration === "EXPANSION") return "BEAR_BREAKDOWN";
    return "OI_BUILDUP";
  }
  if (ce < 0 && pe < 0) return "OI_UNWINDING";

  // ── TIER 4: Exhaustion ────────────────────────────────────────────────────
  if (magnitude === "STRONG" && acceleration === "SLOWDOWN") {
    return bias === "BULLISH" ? "BULL_EXHAUSTION" : "BEAR_EXHAUSTION";
  }

  // ── TIER 5: Generic ───────────────────────────────────────────────────────
  if (bias === "BULLISH") return "BULLISH_FLOW";
  if (bias === "BEARISH") return "BEARISH_FLOW";
  return "NO_SIGNAL";
}

// ─── 7. NEXT MOVE ─────────────────────────────────────────────────────────────
function predictNextMove(signal) {
  const UP = [
    "CALL_SHORT_COVERING", "PUT_WRITER_BUILDUP",
    "CALL_WRITER_EXIT", "BULL_BREAKOUT", "BULLISH_FLOW",
  ];
  const DOWN = [
    "PUT_UNWINDING", "CALL_WRITER_BUILDUP",
    "PUT_WRITER_EXIT", "BEAR_BREAKDOWN", "BEARISH_FLOW",
  ];
  const WATCH = [
    "BULL_EXHAUSTION", "BEAR_EXHAUSTION",
    "OI_TRAP", "OI_BUILDUP", "OI_UNWINDING",
  ];

  if (UP.includes(signal))    return "UP";
  if (DOWN.includes(signal))  return "DOWN";
  if (WATCH.includes(signal)) return "WATCH";
  return "SIDEWAYS";
}

// ─── 8. REGIME ────────────────────────────────────────────────────────────────
function buildRegime(bias, acceleration, collectorRegime) {
  if (collectorRegime && collectorRegime !== "BALANCED") return collectorRegime;
  if (bias === "NEUTRAL") return "BALANCING";
  return `${bias}_${acceleration}`;
}

// ─── 9. MARKET STRUCTURE — correct reversal detection ────────────────────────
//
// Reversal logic:
//   1. Take previous N history entries (excluding current run).
//   2. Check if ALL of them share the same bias (= confirmed streak).
//   3. If current bias is different from streak bias → REVERSAL.
//   This prevents false reversals from noisy single-run flips.

function detectMarketStructure(bias, magnitude, acceleration, signal, history) {
  if (history.length < 2) {
    if (bias === "NEUTRAL") return "BALANCING";
    return bias === "BULLISH" ? "TRENDING_UP" : "TRENDING_DOWN";
  }

  // Only look at history (not current run) for streak detection
  const prevEntries = history.slice(-(REVERSAL_STREAK));
  const streakBias  = prevEntries[0].market_bias;
  const isStreak    = prevEntries.every(h => h.market_bias === streakBias);
  const streakFlipped = isStreak && streakBias !== bias &&
    streakBias !== "NEUTRAL" && bias !== "NEUTRAL";

  if (streakFlipped) return "REVERSAL";

  // Trending
  if (bias === "BULLISH" && magnitude !== "WEAK" && acceleration !== "SLOWDOWN") return "TRENDING_UP";
  if (bias === "BEARISH" && magnitude !== "WEAK" && acceleration !== "SLOWDOWN") return "TRENDING_DOWN";

  // Writer patterns
  if (["PUT_WRITER_BUILDUP", "CALL_SHORT_COVERING"].includes(signal)) return "ACCUMULATION";
  if (["CALL_WRITER_BUILDUP", "PUT_UNWINDING"].includes(signal))       return "DISTRIBUTION";

  // Exhaustion = potential reversal brewing
  if (["BULL_EXHAUSTION", "BEAR_EXHAUSTION"].includes(signal)) return "REVERSAL";

  return "BALANCING";
}

// ─── 10. CONFIDENCE — no double counting ─────────────────────────────────────
//
// Sources and their max contribution:
//   Base                     = 40
//   Flow magnitude           = +20 (STRONG) / +10 (MODERATE)   [flow size]
//   Strike dominance %       = ±15                              [breadth]
//   Acceleration             = +10 (EXPANSION) / -8 (SLOWDOWN) [momentum]
//   History consistency      = +10 (same bias) / -15 (flipping)
//   Strengthening dominance  = +5
//   Neutral penalty          = cap at 50
//
// Deliberately excluded to avoid double-counting:
//   - magnitude (already accounts for flow size; dominance handles breadth separately)
//   - strength label (derived from dominance, which is already counted)

function computeConfidence(bias, magnitude, acceleration, dominance, netFlow, history) {
  let score = CONFIDENCE_BASE;

  // Flow magnitude (one contribution for flow size)
  const absFlow = Math.abs(netFlow);
  if (absFlow >= FLOW_STRONG)   score += 20;
  else if (absFlow >= FLOW_MODERATE) score += 10;

  // Strike breadth (separate dimension — how wide the participation is)
  score += Math.round((dominance - 50) * 0.3); // ±15 max

  // Momentum
  if (acceleration === "EXPANSION") score += 10;
  if (acceleration === "SLOWDOWN")  score -= 8;

  // History consistency
  if (history.length >= 3) {
    const recent = history.slice(-3).map(h => h.market_bias);
    const allSame = recent.every(b => b === bias);
    const strengthening =
      history.length >= 2 &&
      (history[history.length - 1].dominance || 50) >
      (history[history.length - 2].dominance || 50);

    if (allSame)       score += 10;
    if (strengthening) score += 5;

    const flipping = recent[0] !== recent[recent.length - 1];
    if (flipping) score -= 15;
  }

  if (bias === "NEUTRAL") score = Math.min(score, 50);

  return Math.min(95, Math.max(10, score));
}

// ─── 11. REVERSAL DETECTION (for warning field) ───────────────────────────────
function detectReversal(history, currentBias) {
  if (history.length < REVERSAL_STREAK) return false;

  const streak    = history.slice(-REVERSAL_STREAK);
  const streakBias = streak[0].market_bias;
  const isStreak  = streak.every(h => h.market_bias === streakBias);
  const flipped   = streakBias !== currentBias &&
    streakBias !== "NEUTRAL" && currentBias !== "NEUTRAL";

  return isStreak && flipped;
}

// ─── 12. WARNING ──────────────────────────────────────────────────────────────
function detectWarning(signal, history, bias, acceleration, isReversal) {
  if (isReversal)                           return "REVERSAL_ALERT";
  if (signal === "BULL_EXHAUSTION")         return "BULL_EXHAUSTION_WARNING";
  if (signal === "BEAR_EXHAUSTION")         return "BEAR_EXHAUSTION_WARNING";
  if (signal === "OI_TRAP")                 return "OI_TRAP_DETECTED";
  if (acceleration === "SLOWDOWN")          return "TREND_SLOWDOWN";

  if (history.length >= 3) {
    const dom = history.slice(-3).map(h => Number(h.dominance) || 50);
    const falling = dom[0] > dom[1] && dom[1] > dom[2];
    if (falling && bias !== "NEUTRAL")      return "WEAKENING_TREND";
  }

  return null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("ETH Analyzer v2 started");

  const state = await getState();
  console.log("State loaded:", {
    expiry:        state.expiry,
    atm:           state.atm,
    price:         state.price,
    net_flow:      state.net_flow,
    flow_velocity: state.flow_velocity,
    flow_bias:     state.flow_bias,
    flow_regime:   state.flow_regime,
  });

  const {
    expiry, atm, price,
    net_flow, flow_velocity, flow_bias, flow_regime,
    ce_flow, pe_flow,
    bullish_strikes, bearish_strikes,
    strike_flows,
    strongest_bull_strike, strongest_bear_strike,
  } = state;

  const history  = await getRecentAIHistory(8);
  console.log(`AI history rows: ${history.length}`);

  const netFlow  = Number(net_flow)        || 0;
  const ceFlow   = Number(ce_flow)         || 0;
  const peFlow   = Number(pe_flow)         || 0;
  const bullStrk = Number(bullish_strikes) || 0;
  const bearStrk = Number(bearish_strikes) || 0;

  // ── Pipeline ──────────────────────────────────────────────────────────────
  const bias         = detectBias(netFlow);
  const magnitude    = detectFlowMagnitude(netFlow);
  const { strength, dominance, dominanceScore } = detectStrength(bullStrk, bearStrk, bias);
  const acceleration = detectAcceleration(flow_velocity, bias);
  const { atmPressure, atmNetFlow, atmStrikes } = analyzeATMPressure(strike_flows, atm);
  const regime       = buildRegime(bias, acceleration, flow_regime);
  const signal       = detectSignal(bias, magnitude, acceleration, ceFlow, peFlow);
  const nextMove     = predictNextMove(signal);
  const isReversal   = detectReversal(history, bias);
  const confidence   = computeConfidence(bias, magnitude, acceleration, dominance, netFlow, history);
  const warning      = detectWarning(signal, history, bias, acceleration, isReversal);
  const marketStructure = detectMarketStructure(bias, magnitude, acceleration, signal, history);

  const flowVelocityLabel =
    acceleration === "EXPANSION" ? "INCREASING" :
    acceleration === "SLOWDOWN"  ? "DECREASING" : "STABLE";

  // ── AI_CONTEXT ────────────────────────────────────────────────────────────
  const aiContext = {
    marketBias:      bias,
    marketStrength:  magnitude,
    marketStructure,
    confidence,
    flowBias:        bias,
    flowVelocity:    flowVelocityLabel,
    regime,
    atmPressure,
    atmNetFlow,
    dominance,
    dominanceScore,
    signal,
    nextMove,
    warning,

    meta: {
      expiry,
      atm:                 Number(atm)    || 0,
      price:               Number(price)  || 0,
      netFlow,
      ceFlow,
      peFlow,
      bullishStrikes:      bullStrk,
      bearishStrikes:      bearStrk,
      strongestBullStrike: strongest_bull_strike,
      strongestBearStrike: strongest_bear_strike,
      atmStrikes,
      rawFlowRegime:       flow_regime,
      rawFlowVelocity:     Number(flow_velocity) || 0,
    },
  };

  console.log("AI_CONTEXT:");
  console.log(JSON.stringify(aiContext, null, 2));

  // ── Persist ───────────────────────────────────────────────────────────────
  await insertAIHistory({
    expiry,
    atm:              Number(atm)   || 0,
    price:            Number(price) || 0,
    market_bias:      bias,
    strength:         magnitude,
    dominance,
    dominance_score:  dominanceScore,
    confidence,
    signal,
    regime,
    next_move:        nextMove,
    atm_pressure:     atmPressure,
    atm_net_flow:     atmNetFlow,
    flow_velocity:    flowVelocityLabel,
    market_structure: marketStructure,
    warning,
    ai_context:       aiContext,
  });

  await updateStateAIContext(aiContext);

  console.log("eth_ai_history inserted | eth_state.ai_context updated");
  console.log("ETH Analyzer v2 complete");
}

main().catch(err => {
  console.error("Analyzer error:", err);
  process.exit(1);
});
