/**
 * Migration: adds finder_fee_status and finder_fee_session_id columns to the deals table.
 * Run with: node migrate-finder-fee.js
 *
 * OR paste the SQL below directly into the Supabase SQL Editor:
 *   https://supabase.com/dashboard/project/qvywhdsaeiufdlaewwby/sql/new
 */

require("dotenv").config();
const https = require("https");

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_REF = "qvywhdsaeiufdlaewwby";

const SQL = `
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS finder_fee_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS finder_fee_session_id text;
`;

if (!SERVICE_KEY) {
  console.log("No SUPABASE_SERVICE_KEY found. Paste this SQL into the Supabase SQL Editor:");
  console.log(SQL);
  process.exit(0);
}

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function migrate() {
  console.log("Adding finder_fee columns to deals table…");
  const { status, body } = await post(
    "api.supabase.com",
    `/v1/projects/${PROJECT_REF}/database/query`,
    { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    { query: SQL }
  );
  if (status === 200 || status === 201) {
    console.log("Migration complete.");
    return;
  }
  console.error(`HTTP ${status}:`, JSON.stringify(body, null, 2));
  console.log("\nPaste this SQL into the Supabase SQL Editor:");
  console.log(SQL);
}

migrate().catch(err => { console.error(err.message); });
