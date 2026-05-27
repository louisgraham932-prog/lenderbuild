/**
 * Append a row to deal_audit_log. Fire-and-forget — never throws.
 *
 * @param {object} supabase  - Supabase client (service key)
 * @param {object} entry
 * @param {string|null}  entry.deal_id
 * @param {string}       entry.user_id
 * @param {string}       entry.user_name
 * @param {string}       entry.user_role     - "lender" | "builder" | "admin"
 * @param {string}       entry.action        - snake_case event name
 * @param {object|null}  entry.details       - free-form JSONB
 * @param {string|null}  entry.ip_address
 */
async function logAudit(supabase, { deal_id = null, user_id, user_name, user_role, action, details = null, ip_address = null }) {
  try {
    await supabase.from("deal_audit_log").insert({
      deal_id,
      user_id,
      user_name: user_name || null,
      user_role: user_role || null,
      action,
      details: details || null,
      ip_address: ip_address || null,
    });
  } catch (_) {}
}

module.exports = { logAudit };
