import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL missing");
}

if (!SUPABASE_SERVICE_KEY) {
  throw new Error("SUPABASE_SERVICE_KEY missing");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
);

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

  const activeUntil = new Date(
    Date.UTC(year, month, day, EXPIRY_UTC_HOUR, 0, 0)
  );

  const query =
    String(day).padStart(2, "0") +
    "-" +
    String(month + 1).padStart(2, "0") +
    "-" +
    year;

  return {
    query,
    activeUntil
  };
}

async function delta(path) {
  const res = await fetch(API_BASE + path);
  const json = await res.json();

  if (!json.success) {
    throw new Error(
      json.error?.message || "Delta request failed"
    );
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

    if (e) {
      expiryMap[e.query] = e;
    }
  }

  const expiries = Object.values(expiryMap)
    .sort((a, b) => a.activeUntil - b.activeUntil);

  if (!expiries.length) {
    throw new Error("No ETH expiry found");
  }

  const now = new Date();

  return (
    expiries.find(x => x.activeUntil > now) ||
    expiries[0]
  );
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

function oiContracts(t) {
  return Number(t.oi_contracts ?? t.oi ?? 0);
}

function volumeContracts(t) {
  const volume = Number(t.volume || 0);
  const cv = Number(t.contract_value || 0);

  if (volume && cv) {
    return Math.round(volume / cv);
  }

  return volume;
}

function covirRatio(oi, vol) {
  return vol === 0 ? 0 : oi / vol;
}

function normalizePair(a, b) {
  const total = a + b;

  if (!total) {
    return { a: 0, b: 0 };
  }

  return {
    a: (a / total) * 100,
    b: (b / total) * 100
  };
}

async function main() {
  console.log("ETH collector started");

  const activeExpiry = await getActiveETHExpiry();

  console.log(
    "Active expiry:",
    activeExpiry.query
  );

  const chain = await getOptionChain(
    activeExpiry.query
  );

      console.log("SUPABASE_URL =", SUPABASE_URL);
    console.log(
      "SERVICE KEY EXISTS =",
      !!SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase
      .from("eth_state")
      .select("*");

    console.log("TEST DATA:", data);
    console.log("TEST ERROR:", error);

    return;

  console.log(
    "Contracts:",
    chain.length
  );

  const spot =
    Number(
      chain.find(x => Number(x.spot_price))
        ?.spot_price
    ) || 0;

  console.log("Spot:", spot);

      const strikes = {};

    for (const t of chain) {
      const strike = Number(t.strike_price);

      if (!strike) continue;

      if (!strikes[strike]) {
        strikes[strike] = {
          strike,
          CE: null,
          PE: null
        };
      }

  if (t.contract_type === "call_options") {
    strikes[strike].CE = t;
  }

  if (t.contract_type === "put_options") {
    strikes[strike].PE = t;
  }
}

const rows = Object.values(strikes)
  .sort((a, b) => a.strike - b.strike);

let atmIndex = 0;
let best = Infinity;

rows.forEach((r, i) => {
  const diff = Math.abs(r.strike - spot);

  if (diff < best) {
    best = diff;
    atmIndex = i;
  }
});

const atm = rows[atmIndex].strike;

console.log("ATM:", atm);

const snapshotWindow = rows.slice(
  Math.max(0, atmIndex - SNAPSHOT_STRIKES),
  atmIndex + SNAPSHOT_STRIKES + 1
);

const graphWindow = rows.slice(
  Math.max(0, atmIndex - GRAPH_STRIKES),
  atmIndex + GRAPH_STRIKES + 1
);

console.log(
  "Snapshot strikes:",
  snapshotWindow.length
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
  const { error } = await supabase
    .from("eth_snapshots")
    .insert(payload);

  if (error) throw error;
}
async function insertGraph(payload) {
  const { error } = await supabase
    .from("eth_graph")
    .insert(payload);

  if (error) throw error;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
