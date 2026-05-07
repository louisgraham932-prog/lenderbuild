const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify the caller's JWT and confirm they are a lender
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
  if (user.user_metadata?.role !== "lender") {
    return res.status(403).json({ error: "Forbidden: lenders only" });
  }

  const lenderName = user.user_metadata?.name;
  if (!lenderName) return res.status(400).json({ error: "Lender name not set" });

  // Scan every user's metadata for connections that target this lender
  const requests = [];
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) return res.status(500).json({ error: error.message });

    for (const u of data.users) {
      const connections = u.user_metadata?.connections || [];
      for (const conn of connections) {
        if (conn.lender_name === lenderName) {
          requests.push({
            builder_id:   u.id,
            builder_name: u.user_metadata?.name || u.email,
            builder_email: u.email,
            lender_name:  conn.lender_name,
            lender_type:  conn.lender_type,
            status:       conn.status,
            created_at:   conn.created_at,
            responded_at: conn.responded_at || null,
          });
        }
      }
    }

    // listUsers returns all users; stop when we get fewer than perPage
    if (data.users.length < perPage) break;
    page++;
  }

  // Newest first
  requests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return res.status(200).json({ requests });
};
