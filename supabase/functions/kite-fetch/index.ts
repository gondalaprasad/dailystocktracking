import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL      = "https://dlldfbvdtclkjkeyedfr.supabase.co";
const SERVICE_ROLE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRsbGRmYnZkdGNsa2prZXllZGZyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU1NDU3MiwiZXhwIjoyMDk2MTMwNTcyfQ.4kxK3zNGhoJGbrrszQmzkI8QrVuIzwTJp3mqcDuH_sI"; // ← paste your service_role key here
const PW_HASH           = "c6921db35433b952fc0aaf3c5be362be013a294cf24d4633adcdcf7c91e4c4c9";
const KITE_BASE         = "https://api.kite.trade";
const RATE_DELAY_MS     = 400; // 2.5 req/sec — safely under Kite's 3/sec limit
const TABLE             = "bhav_data";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function sha256(str: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // CORS headers — allow your GitHub Pages domain
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
  }

  const { password, api_key, access_token, from_date, to_date, tickers: batchTickers } = body;

  // ── 1. Verify password ──────────────────────────────────────────────────────
  if (!password) {
    return new Response(JSON.stringify({ error: "Password required" }), { status: 401, headers });
  }
  const hash = await sha256(password);
  if (hash !== PW_HASH) {
    return new Response(JSON.stringify({ error: "Incorrect password" }), { status: 403, headers });
  }

  // ── 2. Validate inputs ──────────────────────────────────────────────────────
  if (!api_key || !access_token) {
    return new Response(JSON.stringify({ error: "api_key and access_token required" }), { status: 400, headers });
  }

  const today     = fmtDate(new Date());
  const fromDate  = from_date || today;
  const toDate    = to_date   || today;

  const authHeader = `token ${api_key}:${access_token}`;

  // ── 3. Download Kite instrument master → build symbol→token map ─────────────
  let instrumentMap: Record<string, number> = {};
  try {
    const instRes = await fetch(`${KITE_BASE}/instruments/NSE`, {
      headers: { "X-Kite-Version": "3", "Authorization": authHeader }
    });
    if (!instRes.ok) {
      const err = await instRes.text();
      return new Response(JSON.stringify({ error: `Instrument fetch failed: ${err}` }), { status: 502, headers });
    }
    const csv = await instRes.text();
    const lines = csv.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length < 12) continue;
      const token  = parseInt(cols[0]);
      const symbol = cols[2]?.trim();
      const segment = cols[10]?.trim();
      if (symbol && segment === "NSE" && !isNaN(token)) {
        instrumentMap[symbol] = token;
      }
    }
  } catch (e: any) {
    return new Response(JSON.stringify({ error: `Instrument error: ${e.message}` }), { status: 502, headers });
  }

  const totalSymbols = Object.keys(instrumentMap).length;
  if (totalSymbols === 0) {
    return new Response(JSON.stringify({ error: "No instruments found" }), { status: 502, headers });
  }

  // ── 4. Init Supabase client with service role ───────────────────────────────
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── 5. Determine which symbols to fetch ────────────────────────────────────
  // If client sent a `tickers` array, use that (batch mode).
  // Otherwise fall back to MTF list from DB (legacy mode).
  let symbolsToFetch: string[];
  if (Array.isArray(batchTickers) && batchTickers.length > 0) {
    symbolsToFetch = batchTickers.filter((s: string) => instrumentMap[s]);
  } else {
    const { data: mtfRows } = await sb.from("mtf_tickers").select("ticker").limit(2000);
    symbolsToFetch = mtfRows && mtfRows.length > 0
      ? mtfRows.map((r: any) => r.ticker).filter((s: string) => instrumentMap[s])
      : Object.keys(instrumentMap);
  }

  // ── 6. Fetch historical data per symbol and upsert ─────────────────────────
  let inserted = 0, skipped = 0, errors = 0;
  const errorList: string[] = [];

  for (let i = 0; i < symbolsToFetch.length; i++) {
    const symbol = symbolsToFetch[i];
    const token  = instrumentMap[symbol];
    if (!token) { skipped++; continue; }

    try {
      const url = `${KITE_BASE}/instruments/historical/${token}/day` +
        `?from=${fromDate}+00:00:00&to=${toDate}+23:59:59&continuous=0&oi=0`;

      const res = await fetch(url, {
        headers: { "X-Kite-Version": "3", "Authorization": authHeader }
      });

      if (res.status === 429) {
        await delay(2000);
        i--;
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        errors++;
        errorList.push(`${symbol}: HTTP ${res.status} - ${errBody.substring(0, 120)}`);
        continue;
      }

      const json = await res.json();
      const candles: any[] = json?.data?.candles || [];
      if (!candles.length) {
        // Check if Kite returned an error message instead of candles
        if (json?.message || json?.error_type) {
          errors++;
          errorList.push(`${symbol}: ${json.message || json.error_type}`);
        } else {
          skipped++; // No data for this date range — normal for some stocks
        }
        await delay(RATE_DELAY_MS);
        continue;
      }

      const rows = candles.map((c: any[], idx: number) => {
        const tradeDate = c[0].slice(0, 10);
        const prevClose = idx > 0 ? candles[idx - 1][4] : null;
        const close     = c[4];
        return {
          trade_date: tradeDate,
          ticker:     symbol,
          series:     "EQ",
          open:       c[1],
          high:       c[2],
          low:        c[3],
          close:      close,
          prev_close: prevClose,
          volume:     c[5],
          // change_pct is a generated column - don't insert, let DB compute it
        };
      });

      const { error: upsertErr } = await sb.from(TABLE).upsert(rows, {
        onConflict: "trade_date,ticker,series",
        ignoreDuplicates: true,
      });

      if (upsertErr) {
        errors++;
        errorList.push(`${symbol}: ${upsertErr.message}`);
      } else {
        inserted += rows.length;
      }

    } catch (e: any) {
      errors++;
      errorList.push(`${symbol}: ${e.message}`);
    }

    await delay(RATE_DELAY_MS);
  }

  // ── 7. Return summary ───────────────────────────────────────────────────────
  return new Response(JSON.stringify({
    success: true,
    summary: {
      symbols_attempted: symbolsToFetch.length,
      rows_inserted:     inserted,
      symbols_skipped:   skipped,
      errors:            errors,
      error_samples:     errorList.slice(0, 10),
      from_date:         fromDate,
      to_date:           toDate,
    }
  }), { status: 200, headers });
});