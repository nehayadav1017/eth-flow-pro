const SUPABASE_URL =
  "YOUR_SUPABASE_URL";

const SUPABASE_ANON_KEY =
  "YOUR_SUPABASE_ANON_KEY";

const supabase =
  window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

async function loadDashboard() {

  const { data, error } = await supabase
    .from("eth_state")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) {
    console.error(error);
    return;
  }

  const ai = data.ai_context || {};

  document.getElementById("price").innerText =
    data.price;

  document.getElementById("bias").innerText =
    ai.marketBias || "-";

  document.getElementById("signal").innerText =
    ai.signal || "-";

  document.getElementById("nextMove").innerText =
    ai.nextMove || "-";

  document.getElementById("confidence").innerText =
    (ai.confidence || 0) + "%";

  document.getElementById("atmPressure").innerText =
    ai.atmPressure || "-";

  document.getElementById("netFlow").innerText =
    data.net_flow;

  document.getElementById("velocity").innerText =
    data.flow_velocity;

  document.getElementById("warning").innerText =
    ai.warning || "NONE";

  document.getElementById("updatedAt").innerText =
    data.updated_at;

  const biasEl =
    document.getElementById("bias");

  biasEl.className = "";

  if (ai.marketBias === "BULLISH")
    biasEl.classList.add("bull");

  else if (ai.marketBias === "BEARISH")
    biasEl.classList.add("bear");

  else
    biasEl.classList.add("neutral");
}

loadDashboard();

setInterval(loadDashboard, 30000);
