const { createClient } = require("@supabase/supabase-js");
const { rateLimit, getClientIp } = require("./_rateLimit");
const { sanitizeStr } = require("./_sanitize");
const { encrypt } = require("./_crypto");
const { logAudit } = require("./_audit");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLATFORM_URL = process.env.CLIENT_URL || "https://www.lenderbuild.co.uk";
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || "LenderBuild <noreply@lenderbuild.co.uk>";
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL || "lenderbuild.support@gmail.com";

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html }),
  }).catch(() => {});
}

// ── Companies House lookup ────────────────────────────────────────────────────
const https = require("https");
const CH_NUMBER_RE = /^(OC|SC|NI|LP|SL|SO|R0|IP|SP|IC|SI|NP|NL|NC|NF|NO|NR|NV|\d{2})\d{6}$|^\d{8}$/;

function chRequest(path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.company-information.service.gov.uk",
      port: 443,
      path,
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(apiKey + ":").toString("base64"),
        Accept: "application/json",
      },
      timeout: 8000,
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        console.log(`[CH] GET ${path} → ${res.statusCode}`);
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Companies House request timed out after 8s")); });
    req.on("error", (err) => { reject(new Error(`Companies House network error: ${err.message}`)); });
    req.end();
  });
}

async function lookupCompanyOfficers(companyNumber, apiKey) {
  try {
    const { status, body } = await chRequest(
      `/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=50`,
      apiKey
    );
    if (status !== 200) return [];
    const data = JSON.parse(body);
    return (data.items || [])
      .filter(o => !o.resigned_on && (o.officer_role || "").toLowerCase().includes("director"))
      .map(o => ({ name: (o.name || "").replace(/,/g, " ").replace(/\s+/g, " ").trim(), role: o.officer_role || "director" }));
  } catch {
    return [];
  }
}

function nameMatchesDirectors(profileName, directors) {
  if (!directors.length) return null; // no directors to check against
  if (!profileName) return null;      // no profile name to compare
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, " ").trim();
  const words = s => norm(s).split(/\s+/).filter(w => w.length > 2);
  const pWords = words(profileName);
  if (!pWords.length) return null;
  return directors.some(d => {
    const dStr = norm(d.name);
    return pWords.filter(w => dStr.includes(w)).length >= Math.ceil(pWords.length * 0.5);
  });
}

async function lookupCompaniesHouse(companyNumber) {
  const num = companyNumber.trim().toUpperCase().replace(/\s/g, "");
  const apiKey = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();

  if (!apiKey) {
    return { _pending: true, _validFormat: CH_NUMBER_RE.test(num) };
  }

  const { status, body } = await chRequest(`/company/${encodeURIComponent(num)}`, apiKey);

  if (status === 404) return { _notFound: true };
  if (status === 401) throw new Error("Companies House API key rejected (401 Unauthorized) — check COMPANIES_HOUSE_API_KEY");
  if (status === 403) throw new Error("Companies House API key not authorised (403 Forbidden)");
  if (status !== 200) throw new Error(`Companies House returned unexpected status ${status}: ${body.slice(0, 200)}`);

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Companies House returned non-JSON response: ${body.slice(0, 200)}`);
  }
}

// ── OFSI sanctions check (async, fire-and-forget) ────────────────────────────
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com","guerrillamail.com","tempmail.com","throwaway.email",
  "yopmail.com","sharklasers.com","guerrillamailblock.com","grr.la",
  "guerrillamail.info","guerrillamail.biz","guerrillamail.de","guerrillamail.net",
  "guerrillamail.org","spam4.me","trashmail.com","trashmail.me","trashmail.net",
  "dispostable.com","mailnull.com","spamgourmet.com","trashmail.io",
  "emailondeck.com","10minutemail.com","tempinbox.com","maildrop.cc",
  "discard.email","filzmail.com","spambox.us","fakeinbox.com","mailnesia.com",
]);

async function runKycBackground(userId, userName, userEmail, ipCountry) {
  try {
    let sanctionsHit = false;
    let sanctionsDetails = [];

    // Download and check OFSI sanctions list
    try {
      const csvRes = await fetch("https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv");
      if (csvRes.ok) {
        const text = await csvRes.text();
        const lines = text.split("\n").slice(1); // skip header
        const nameLower = (userName || "").toLowerCase().trim();
        if (nameLower.length > 3) {
          for (const line of lines) {
            const cols = line.split(",");
            // Name columns are typically cols 0-2 (Name 1, Name 2, Name 3)
            const fullName = cols.slice(0, 3).join(" ").toLowerCase().replace(/"/g, "").trim();
            if (fullName && nameLower.split(" ").every(word => word.length > 2 && fullName.includes(word))) {
              sanctionsHit = true;
              sanctionsDetails.push(cols[0]?.replace(/"/g, "").trim());
              break;
            }
          }
        }
      }
    } catch (_) {}

    const emailDomain = (userEmail || "").split("@")[1]?.toLowerCase() || "";
    const disposableEmail = DISPOSABLE_DOMAINS.has(emailDomain);
    const ipOutsideUk = !!ipCountry && ipCountry !== "GB";
    const result = sanctionsHit ? "flagged_sanctions" : disposableEmail ? "warn_disposable" : "pass";

    await supabase.from("kyc_checks").insert({
      user_id: userId,
      sanctions_hit: sanctionsHit,
      disposable_email: disposableEmail,
      ip_country: ipCountry || null,
      ip_outside_uk: ipOutsideUk,
      result,
      details: { sanctions_matches: sanctionsDetails, email_domain: emailDomain },
    });

    if (sanctionsHit) {
      await supabase.from("profiles").update({ kyc_flagged: true, kyc_checked_at: new Date().toISOString() }).eq("id", userId);
      sendEmail(ADMIN_EMAIL, `⚠️ KYC: Sanctions hit for user ${userName}`,
        `<p>User <strong>${userName}</strong> (${userEmail}) matched the OFSI sanctions list. Account flagged for review.</p><p>Matches: ${sanctionsDetails.join(", ")}</p><p><a href="${PLATFORM_URL}">Review in admin panel</a></p>`
      );
    } else {
      await supabase.from("profiles").update({ kyc_checked_at: new Date().toISOString() }).eq("id", userId);
    }
  } catch (_) {}
}

// ── Smart matching (async, fire-and-forget) ───────────────────────────────────
const SPEC_TO_PROJECTS = {
  "Developer": ["Residential", "Commercial", "Mixed use"],
  "Residential developer": ["Residential"],
  "Commercial developer": ["Commercial", "Mixed use"],
  "Renovation specialist": ["Renovation", "Residential"],
  "Mixed use developer": ["Mixed use", "Residential", "Commercial"],
  "HMO specialist": ["Residential", "Renovation"],
  "Contractor": ["Residential", "Commercial"],
  "Renovator": ["Renovation", "Residential"],
};

function computeBackendMatchScore(lender, builder, lenderProfile, builderProfile) {
  let score = 0;

  // Budget fit (30 pts)
  const projects = builder.projects_completed || 0;
  const totalVal = builder.total_value || 0;
  const avgProject = projects > 0 ? totalVal / projects : 100000;
  const budget = lender.budget_max || 0;
  if (budget >= avgProject * 0.8) score += 30;
  else if (budget >= avgProject * 0.4) score += 18;
  else if (budget > 0) score += 8;

  // Project type match (25 pts)
  const builderTypes = SPEC_TO_PROJECTS[builder.specialization] || [];
  const lenderPrefs = lender.preferred_projects || [];
  if (builderTypes.length > 0 && lenderPrefs.length > 0) {
    const overlap = builderTypes.filter(t => lenderPrefs.includes(t)).length;
    score += Math.round((overlap / Math.max(builderTypes.length, 1)) * 25);
  } else {
    score += 10; // no preference = neutral
  }

  // Location match (20 pts)
  const bl = (builderProfile?.location || "").toLowerCase();
  const ll = (lenderProfile?.location || "").toLowerCase();
  const bWords = bl.split(/[\s,]+/).filter(w => w.length > 4);
  const lWords = ll.split(/[\s,]+/).filter(w => w.length > 4);
  if (bWords.length > 0 && lWords.length > 0 && bWords.some(w => lWords.includes(w))) score += 20;
  else if (bl && ll) score += 5;

  // Builder credibility (15 pts)
  const completion = builder.completion_rate || 100;
  if (projects >= 10 && completion >= 90) score += 15;
  else if (projects >= 5 && completion >= 80) score += 10;
  else if (projects >= 1) score += 5;

  // Activity (10 pts) — base points for having a complete profile
  score += 10;

  return Math.min(score, 100);
}

async function runMatchingBackground(userId, role) {
  try {
    if (role !== "lender" && role !== "builder") return;

    const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const usersMap = {};
    (allUsers || []).forEach(u => { usersMap[u.id] = u; });

    const { data: allProfiles } = await supabase.from("profiles").select("id, full_name, location");
    const profileMap = {};
    (allProfiles || []).forEach(p => { profileMap[p.id] = p; });

    let myProfile, myRoleProfile, oppositeData;

    if (role === "builder") {
      const { data: bp } = await supabase.from("builder_profiles").select("*").eq("user_id", userId).maybeSingle();
      if (!bp) return;
      myRoleProfile = bp;
      myProfile = profileMap[userId];
      const { data: lenders } = await supabase.from("lender_profiles").select("*").eq("is_active", true);
      oppositeData = (lenders || []).filter(l => l.user_id !== userId);
    } else {
      const { data: lp } = await supabase.from("lender_profiles").select("*").eq("user_id", userId).maybeSingle();
      if (!lp) return;
      myRoleProfile = lp;
      myProfile = profileMap[userId];
      const { data: builders } = await supabase.from("builder_profiles").select("*").eq("is_active", true);
      oppositeData = (builders || []).filter(b => b.user_id !== userId);
    }

    // Score all matches
    const scored = oppositeData.map(other => {
      const score = role === "builder"
        ? computeBackendMatchScore(other, myRoleProfile, profileMap[other.user_id], myProfile)
        : computeBackendMatchScore(myRoleProfile, other, myProfile, profileMap[other.user_id]);
      return { user_id: other.user_id, score };
    }).filter(m => m.score >= 55).sort((a, b) => b.score - a.score).slice(0, 5);

    if (scored.length === 0) return;

    // Get existing notified matches to avoid re-notifying
    const otherIds = scored.map(m => m.user_id);
    const { data: existing } = await supabase.from("matches_cache")
      .select("matched_user_id, notified")
      .eq("user_id", userId)
      .in("matched_user_id", otherIds);
    const alreadyNotified = new Set((existing || []).filter(e => e.notified).map(e => e.matched_user_id));

    const myUser = usersMap[userId];
    const myName = myUser?.user_metadata?.name || "A match";

    for (const match of scored) {
      // Upsert match record
      await supabase.from("matches_cache").upsert(
        { user_id: userId, matched_user_id: match.user_id, score: match.score, match_type: "lender_builder", updated_at: new Date().toISOString() },
        { onConflict: "user_id,matched_user_id" }
      );

      if (!alreadyNotified.has(match.user_id)) {
        const matchedUser = usersMap[match.user_id];
        if (matchedUser?.email) {
          sendEmail(matchedUser.email,
            `We found a great match for you — ${match.score}% compatibility`,
            `<p>Hi ${matchedUser.user_metadata?.name || ""},</p>
<p>LenderBuild found a <strong>${match.score}% compatible</strong> ${role === "builder" ? "lender" : "builder"} for you: <strong>${myName}</strong>.</p>
<p>Log in to view their profile and start a conversation.</p>
<p><a href="${PLATFORM_URL}" style="background:#3B82F6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">View match on LenderBuild</a></p>`
          );
          // Mark as notified
          await supabase.from("matches_cache").update({ notified: true })
            .eq("user_id", userId).eq("matched_user_id", match.user_id);
          // Also store reverse match so the other user sees it on their dashboard
          await supabase.from("matches_cache").upsert(
            { user_id: match.user_id, matched_user_id: userId, score: match.score, match_type: "lender_builder", notified: true, updated_at: new Date().toISOString() },
            { onConflict: "user_id,matched_user_id" }
          );
        }
      }
    }
  } catch (_) {}
}

/**
 * GET  /api/save-profile  — get saved searches for the current user
 * POST /api/save-profile  — save profile, verify company, create identity session, manage saved searches
 */
module.exports = async function handler(req, res) {
  // ── GET: list saved searches ───────────────────────────────────────────────
  if (req.method === "GET") {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorised" });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });
    const { data } = await supabase.from("saved_searches").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    return res.status(200).json({ searches: data || [] });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limiting
  const ip = getClientIp(req);
  if (!rateLimit(`save-profile:ip:${ip}`, 30, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  if (!rateLimit(`api:${user.id}`, 100, 60_000).allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const role = user.user_metadata?.role;
  const raw  = req.body || {};
  const { action } = raw;

  // ── Action: save-search ────────────────────────────────────────────────────
  if (action === "save-search") {
    const { name, role_type, filters, frequency } = raw;
    if (!name) return res.status(400).json({ error: "name required" });
    const { data, error: insErr } = await supabase.from("saved_searches").insert({
      user_id: user.id,
      name: sanitizeStr(name, 100),
      role_type: role_type || "builder",
      filters: filters || {},
      frequency: frequency || "instant",
    }).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });
    return res.status(200).json({ ok: true, search: data });
  }

  // ── Action: delete-search ──────────────────────────────────────────────────
  if (action === "delete-search") {
    const { search_id } = raw;
    if (!search_id) return res.status(400).json({ error: "search_id required" });
    const { error: delErr } = await supabase.from("saved_searches").delete().eq("id", search_id).eq("user_id", user.id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ ok: true });
  }

  // ── Action: verify-company (Companies House) ───────────────────────────────
  if (action === "verify-company") {
    if (role !== "builder" && role !== "lender") return res.status(403).json({ error: "Not allowed" });
    const { company_number } = raw;
    if (!company_number?.trim()) return res.status(400).json({ error: "company_number required" });

    let chData;
    try {
      chData = await lookupCompaniesHouse(company_number);
    } catch (e) {
      console.error("[CH] lookup failed:", e.message);
      return res.status(502).json({ error: `Companies House lookup failed: ${e.message}` });
    }

    // No API key configured — return pending status
    if (chData._pending) {
      if (!chData._validFormat) {
        return res.status(200).json({ found: false, message: "Invalid company number format. UK numbers are 8 digits (e.g. 12345678)." });
      }
      // Save the number so it's not lost, but don't mark verified
      const table = role === "builder" ? "builder_profiles" : "lender_profiles";
      await supabase.from(table).update({ company_number: company_number.trim().toUpperCase() }).eq("user_id", user.id);
      return res.status(200).json({ found: false, pending: true, company_number: company_number.trim().toUpperCase() });
    }

    // Company genuinely not found
    if (chData._notFound) {
      return res.status(200).json({ found: false, message: "No company found with that registration number. Please double-check it." });
    }

    const companyName   = chData.company_name || "";
    const companyStatus = chData.company_status || "unknown";
    const companyIncorp = chData.date_of_creation || null;
    const isActive      = companyStatus.toLowerCase() === "active";

    const chApiKey = (process.env.COMPANIES_HOUSE_API_KEY || "").trim();
    let directors = [];
    if (isActive) {
      directors = await lookupCompanyOfficers(company_number.trim().toUpperCase(), chApiKey);
    }
    const profileName = user.user_metadata?.name || "";
    const name_match = nameMatchesDirectors(profileName, directors);

    const table = role === "builder" ? "builder_profiles" : "lender_profiles";
    const updateData = role === "builder"
      ? { company_number: company_number.trim().toUpperCase(), company_name: sanitizeStr(companyName, 200), company_status: companyStatus, company_incorporated: companyIncorp, company_verified: isActive }
      : { company_number: company_number.trim().toUpperCase(), company_verified: isActive };

    const { error: upErr } = await supabase.from(table).update(updateData).eq("user_id", user.id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({
      found: true,
      active: isActive,
      company_name: companyName,
      company_status: companyStatus,
      company_incorporated: companyIncorp,
      company_number: company_number.trim().toUpperCase(),
      directors,
      name_match,
    });
  }

  // ── Action: create-identity-session (Stripe Identity) ─────────────────────
  if (action === "create-identity-session") {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Payment processing not configured" });
    const Stripe = require("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    try {
      const session = await stripe.identity.verificationSessions.create({
        type: "document",
        options: { document: { allowed_types: ["driving_license", "passport", "id_card"], require_id_number: false, require_live_capture: true, require_matching_selfie: true } },
        metadata: { user_id: user.id, user_email: user.email },
        return_url: `${PLATFORM_URL}?identity_verified=1`,
      });
      return res.status(200).json({ url: session.url });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Action: accept-risk-warning ───────────────────────────────────────────
  if (action === "accept-risk-warning") {
    const ip = getClientIp(req);
    await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        risk_warning_accepted: true,
        risk_warning_accepted_at: new Date().toISOString(),
        risk_warning_ip: ip || null,
      },
    });
    logAudit(supabase, {
      user_id: user.id, user_name: user.user_metadata?.name || user.email,
      user_role: role, action: "risk_warning_accepted",
      details: { accepted_at: new Date().toISOString() }, ip_address: ip,
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── Action: save-bank-details (builders only) ─────────────────────────────
  if (action === "save-bank-details") {
    if (role !== "builder") return res.status(403).json({ error: "Builders only" });
    const { bank_account_name, bank_sort_code, bank_account_number } = raw;
    const sc = (bank_sort_code || "").replace(/\D/g, "");
    const an = (bank_account_number || "").replace(/\D/g, "");
    if (!bank_account_name?.trim()) return res.status(400).json({ error: "Account holder name required" });
    if (sc.length !== 6) return res.status(400).json({ error: "Sort code must be 6 digits" });
    if (an.length !== 8) return res.status(400).json({ error: "Account number must be 8 digits" });
    const { data: existing } = await supabase.from("builder_profiles").select("id").eq("user_id", user.id).maybeSingle();
    const patch = {
      bank_account_name: bank_account_name.trim(),
      bank_sort_code: encrypt(sc),
      bank_account_number: encrypt(an),
      bank_details_provided: true,
    };
    const { error: bpErr } = existing
      ? await supabase.from("builder_profiles").update(patch).eq("user_id", user.id)
      : await supabase.from("builder_profiles").insert({ user_id: user.id, is_active: true, ...patch });
    if (bpErr) return res.status(500).json({ error: bpErr.message });
    const clientIp = getClientIp(req);
    logAudit(supabase, {
      user_id: user.id, user_name: user.user_metadata?.name || user.email,
      user_role: "builder", action: "bank_details_saved",
      details: { account_name: bank_account_name.trim() }, ip_address: clientIp,
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── Main profile save ─────────────────────────────────────────────────────
  const {
    location = "",
    bio = "",
    // lender fields
    budget_max, return_type, interest_rate, builder_split, lender_split, equity_stake, preferred_projects,
    // builder fields
    specialization, projects_completed, total_value, completion_rate, company_number,
  } = raw;

  const cleanLocation = sanitizeStr(location, 150);
  const cleanBio      = sanitizeStr(bio, 600);

  const { error: profileErr } = await supabase
    .from("profiles")
    .upsert(
      { id: user.id, full_name: sanitizeStr(user.user_metadata?.name || "", 100), location: cleanLocation, bio: cleanBio, role: role || "builder" },
      { onConflict: "id" }
    );
  if (profileErr) return res.status(500).json({ error: profileErr.message });

  if (role === "lender") {
    const lenderData = {
      user_id:            user.id,
      budget_max:         budget_max ? Number(budget_max) : null,
      return_type:        return_type || null,
      interest_rate:      interest_rate || null,
      builder_split:      builder_split || null,
      lender_split:       lender_split || null,
      equity_stake:       equity_stake || null,
      preferred_projects: preferred_projects || [],
      is_active:          true,
    };
    const { data: existing } = await supabase.from("lender_profiles").select("id").eq("user_id", user.id).maybeSingle();
    const { error: lpErr } = existing
      ? await supabase.from("lender_profiles").update(lenderData).eq("user_id", user.id)
      : await supabase.from("lender_profiles").insert(lenderData);
    if (lpErr) return res.status(500).json({ error: lpErr.message });

  } else if (role === "builder") {
    const builderData = {
      user_id:            user.id,
      specialization:     specialization || null,
      projects_completed: projects_completed != null ? Number(projects_completed) : 0,
      total_value:        total_value != null ? Number(total_value) : 0,
      completion_rate:    completion_rate != null ? Number(completion_rate) : 100,
      is_active:          true,
    };
    // Only update company_number if provided (don't clobber verified status)
    if (company_number?.trim()) {
      builderData.company_number = company_number.trim().toUpperCase();
    }
    const { data: existing } = await supabase.from("builder_profiles").select("id").eq("user_id", user.id).maybeSingle();
    const { error: bpErr } = existing
      ? await supabase.from("builder_profiles").update(builderData).eq("user_id", user.id)
      : await supabase.from("builder_profiles").insert(builderData);
    if (bpErr) return res.status(500).json({ error: bpErr.message });
  }

  const avatarUrlUpdate = raw.avatar_url !== undefined ? { avatar_url: raw.avatar_url } : {};
  await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: { ...user.user_metadata, profile_complete: true, ...avatarUrlUpdate },
  });

  // Fire async tasks (non-blocking)
  const ipCountry = req.headers["x-vercel-ip-country"] || req.headers["cf-ipcountry"] || null;
  runKycBackground(user.id, user.user_metadata?.name || "", user.email || "", ipCountry).catch(() => {});
  runMatchingBackground(user.id, role).catch(() => {});

  // Alert matching saved searches
  try {
    const profileRoleType = role === "lender" ? "lender" : "builder";
    const { data: matchingSearches } = await supabase
      .from("saved_searches")
      .select("*, user_id")
      .eq("role_type", profileRoleType)
      .eq("frequency", "instant")
      .neq("user_id", user.id);

    if (matchingSearches && matchingSearches.length > 0) {
      const profileName = user.user_metadata?.name || user.email;
      for (const search of matchingSearches) {
        const { data: searchOwner } = await supabase.auth.admin.getUserById(search.user_id);
        if (searchOwner?.user?.email) {
          sendEmail(
            searchOwner.user.email,
            `New ${profileRoleType} profile matches your saved search: ${search.name}`,
            `<p>Hi ${searchOwner.user.user_metadata?.name || ""},</p>
<p>A new ${profileRoleType} profile from <strong>${profileName}</strong> matches your saved search "<strong>${search.name}</strong>".</p>
<p><a href="${PLATFORM_URL}">View on LenderBuild</a></p>`
          );
        }
      }
    }
  } catch (_) {}

  return res.status(200).json({ ok: true });
};
