import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) throw new Error("SUPABASE_URL missing");
if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY missing");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const API_BASE = "https://api.india.delta.exchange/v2";

const EXPIRY_UTC_HOUR = 8;
const SNAPSHOT_STRIKES = 8;
const GRAPH_STRIKES = 3;

function parseExpiry(symbol) {
  const m = String(symbol || "").match(/-(\d{6})$/);
  if (!m) return null;

  const raw = m[1];
  const day = parseInt(raw.slice(0, 2), 10);
  const month = parseInt(raw.slice(2, 4), 10) - 1;
  const year = 2000 + parseInt(raw.slice(4, 6), 10);

  return {
    query:
      String(day).padStart(2, "0") +
      "-" +
      String(month + 1).padStart(2, "0") +
      "-" +
      year,
    activeUntil: new Date(Date.UTC(year, month, day, EXPIRY_UTC_HOUR, 0, 0))
  };
}

async function delta(path) {
  const res = await fetch(API_BASE + path);
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response preview:", text.slice(0, 300));
  const json = JSON.parse(text);
  if (!json.success) {
    throw new Error(json.error?.message || "Delta request failed");
  }
  return json.result || [];
}

async function getActiveETHExpiry() {
  const all = await delta(
    "/tickers?contract_types=call_options,put_options&underlying_asset_symbols=ETH"
  );

  const expiryMap = {};
  for (const t of all) {
    const e = parseExpiry(t.symbol);
    if (e) expiryMap[e.query] = e;
  }

  const expiries = Object.values(expiryMap).sort(
    (a, b) => a.activeUntil - b.activeUntil
  );

  const now = new Date();
  return expiries.find(x => x.activeUntil > now) || expiries[0];
}

async function getOptionChain(expiry) {
  return delta(
    "/tickers?" +
      "contract_types=call_options,put_options" +
      "&underlying_asset_symbols=ETH" +
      "&expiry_date=" +
      encodeURIComponent(expiry)
  );
}

async function getState() {
  const { data, error } = await supabase
    .from("eth_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return data;
}

async function updateState(payload) {
  const { error } = await supabase
    .from("eth_state")
    .update(payload)
    .eq("id", 1);
  if (error) throw error;
}

async function insertSnapshot(payload) {
  const { error } = await supabase.from("eth_snapshots").insert(payload);
  if (error) throw error;
}

async function insertGraph(payload) {
  const { error } = await supabase.from("eth_graph").insert(payload);
  if (error) throw error;
}

async function main() {
  console.log("ETH collector started");

  const activeExpiry = await getActiveETHExpiry();
  console.log("Active expiry:", activeExpiry.query);

  const chain = await getOptionChain(activeExpiry.query);
  const state = (await getState()) || {};

  const prevSnapshot = state.snapshot || null;
  const prevCumFlow = Number(state.cum_flow || 0);
  const prevNetFlow = Number(state.net_flow || 0);
  console.log("Previous state loaded");

  const prevOI = {};
  if (prevSnapshot) {
    for (const row of prevSnapshot) {
      prevOI[row.strike] = {
        ce: Number(row.CE?.oi_contracts ?? row.CE?.oi ?? 0),
        pe: Number(row.PE?.oi_contracts ?? row.PE?.oi ?? 0)
      };
    }
  }

  const spot =
    Number(chain.find(x => Number(x.spot_price))?.spot_price) || 0;
  console.log("Spot:", spot);

  const strikes = {};
  for (const t of chain) {
    const strike = Number(t.strike_price);
    if (!strike) continue;
    if (!strikes[strike]) strikes[strike] = { strike, CE: null, PE: null };
    if (t.contract_type === "call_options") strikes[strike].CE = t;
    if (t.contract_type === "put_options") strikes[strike].PE = t;
  }

  const rows = Object.values(strikes).sort((a, b) => a.strike - b.strike);

  let atmIndex = 0;
  let best = Infinity;
  rows.forEach((r, i) => {
    const diff = Math.abs(r.strike - spot);
    if (diff < best) { best = diff; atmIndex = i; }
  });

  const atm = rows[atmIndex].strike;
  console.log("ATM:", atm);

  // FIX 1: Declare these outside the loop so they are accessible after it
  let ceFlow = 0;
  let peFlow = 0;
  const strikeFlows = [];
  let strongestBullStrike = null;
  let strongestBearStrike = null;
  let bullishStrikes = 0;
  let bearishStrikes = 0;

  const snapshotWindow = rows.slice(
    Math.max(0, atmIndex - SNAPSHOT_STRIKES),
    atmIndex + SNAPSHOT_STRIKES + 1
  );

  const graphWindow = rows.slice(
    Math.max(0, atmIndex - GRAPH_STRIKES),
    atmIndex + GRAPH_STRIKES + 1
  );

  for (const row of snapshotWindow) {
    const strike = row.strike;

    const currentCE = Number(row.CE?.oi_contracts ?? row.CE?.oi ?? 0);
    const currentPE = Number(row.PE?.oi_contracts ?? row.PE?.oi ?? 0);

    const previous = prevOI[strike] || { ce: currentCE, pe: currentPE };

    const ceDelta = currentCE - previous.ce;
    const peDelta = currentPE - previous.pe;

    // FIX 2: Accumulate ceFlow/peFlow BEFORE using them for net/bias/regime
    ceFlow += ceDelta;
    peFlow += peDelta;

    strikeFlows.push({ strike, ceFlow: ceDelta, peFlow: peDelta });

    const strikeNetFlow = peDelta - ceDelta;
    if (strikeNetFlow > 0) bullishStrikes++;
    if (strikeNetFlow < 0) bearishStrikes++;

    if (!strongestBullStrike || strikeNetFlow > strongestBullStrike.flow) {
      strongestBullStrike = { strike, flow: strikeNetFlow };
    }
    if (!strongestBearStrike || strikeNetFlow < strongestBearStrike.flow) {
      strongestBearStrike = { strike, flow: strikeNetFlow };
    }
  }

  // FIX 2 (cont): Compute aggregate metrics once, after the loop completes
  const netFlow = peFlow - ceFlow;
  const flowVelocity = netFlow - prevNetFlow;
  const cumFlow = prevCumFlow + netFlow;

  const flowBias =
    netFlow > 0 ? "BULLISH" : netFlow < 0 ? "BEARISH" : "NEUTRAL";

  let flowRegime = "BALANCED";
  if (flowBias === "BULLISH" && flowVelocity > 0) flowRegime = "BULLISH_EXPANSION";
  if (flowBias === "BULLISH" && flowVelocity < 0) flowRegime = "BULLISH_SLOWDOWN";
  if (flowBias === "BEARISH" && flowVelocity < 0) flowRegime = "BEARISH_EXPANSION";
  if (flowBias === "BEARISH" && flowVelocity > 0) flowRegime = "BEARISH_SLOWDOWN";

  console.log("CE Flow:", ceFlow);
  console.log("PE Flow:", peFlow);
  console.log("Net Flow:", netFlow);
  console.log("Flow Velocity:", flowVelocity);
  console.log("Flow Bias:", flowBias);
  console.log("Flow Regime:", flowRegime);
  console.log("Cum Flow:", cumFlow);
  console.log("Snapshot strikes:", snapshotWindow.length);

  await insertSnapshot({
    expiry: activeExpiry.query,
    atm,
    spot_price: spot,
    snapshot: snapshotWindow
  });

  for (const row of graphWindow) {
    // FIX 3: Include strike so each graph row is identifiable
    await insertGraph({
      expiry: activeExpiry.query,
      strike: row.strike,
      atm,
      spot_price: spot,
      ce_oi: row.CE ? Number(row.CE.oi_contracts ?? row.CE.oi ?? 0) : 0,
      pe_oi: row.PE ? Number(row.PE.oi_contracts ?? row.PE.oi ?? 0) : 0
    });
  }

  await updateState({
  expiry: activeExpiry.query,
  atm,
  price: spot,

  snapshot: snapshotWindow,
  strike_flows: strikeFlows,

  ce_flow: ceFlow,
  pe_flow: peFlow,
  net_flow: netFlow,
  cum_flow: cumFlow,

  flow_bias: flowBias,
  flow_velocity: flowVelocity,
  flow_regime: flowRegime,

  bullish_strikes: bullishStrikes,
  bearish_strikes: bearishStrikes,

  strongest_bull_strike:
    strongestBullStrike,

  strongest_bear_strike:
    strongestBearStrike
});

  console.log("Snapshot saved");
  console.log("Graph saved");
  console.log("State updated");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
