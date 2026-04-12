import { render, screen } from '@testing-library/react';
import App from './App';

test('renders learn react link', () => {
  render(<App />);
  const linkElement = screen.getByText(/learn react/i);
  expect(linkElement).toBeInTheDocument();
});
import { useState, useEffect, useRef } from "react";

const COLORS = {
  teal: { bg: "#E1F5EE", text: "#0F6E56", mid: "#1D9E75" },
  blue: { bg: "#E6F1FB", text: "#185FA5", mid: "#378ADD" },
  purple: { bg: "#EEEDFE", text: "#534AB7", mid: "#7F77DD" },
  amber: { bg: "#FAEEDA", text: "#854F0B", mid: "#BA7517" },
  coral: { bg: "#FAECE7", text: "#993C1D", mid: "#D85A30" },
  gray: { bg: "#F1EFE8", text: "#5F5E5A", mid: "#888780" },
};

const fmt = (n) => "£" + n.toLocaleString();

// ─── DATA ────────────────────────────────────────────────────────────────────

const LENDERS = [
  { initials: "SR", color: "blue",   name: "S. Rathore",    type: "Investment firm",  capital: 1240000, deals: 7, rate: 8.2 },
  { initials: "JH", color: "teal",   name: "James H.",      type: "Private lender",   capital: 860000,  deals: 5, rate: 6.5 },
  { initials: "ML", color: "purple", name: "M. Lawson",     type: "Angel investor",   capital: 540000,  deals: 4, rate: null, rateLabel: "18% equity" },
  { initials: "PT", color: "amber",  name: "P. Thornton",   type: "Family office",    capital: 420000,  deals: 3, rate: 7.1 },
  { initials: "CW", color: "coral",  name: "C. Williams",   type: "Private lender",   capital: 310000,  deals: 3, rate: 9.0 },
  { initials: "RB", color: "gray",   name: "R. Bashir",     type: "Syndicate",        capital: 210000,  deals: 2, rate: 7.8 },
  { initials: "NK", color: "teal",   name: "N. Khan",       type: "Private lender",   capital: 120000,  deals: 1, rate: 8.5 },
];

const BUILDERS = [
  { initials: "TO", color: "teal",   name: "T. Okafor",     type: "Developer",    props: 12, value: 980000,  completion: 96 },
  { initials: "KS", color: "blue",   name: "K. Singh",      type: "Contractor",   props: 9,  value: 840000,  completion: 100 },
  { initials: "RA", color: "purple", name: "R. Ahmed",      type: "Renovator",    props: 7,  value: 520000,  completion: 86 },
  { initials: "LM", color: "amber",  name: "L. Martinez",   type: "Developer",    props: 6,  value: 610000,  completion: 100 },
  { initials: "DG", color: "coral",  name: "D. Greenfield", type: "Contractor",   props: 4,  value: 370000,  completion: 75 },
  { initials: "AO", color: "gray",   name: "A. Osei",       type: "Developer",    props: 3,  value: 290000,  completion: 100 },
];

const PAIRS = [
  { rank: 1, a: { i: "SR", c: "blue" },   b: { i: "KS", c: "teal" },   names: "S. Rathore & K. Singh",    meta: "Investment firm · Contractor", deals: 5, value: 840000,  score: 98, communication: 95, reliability: 100, returns: 98 },
  { rank: 2, a: { i: "JH", c: "teal" },   b: { i: "TO", c: "coral" },  names: "James H. & T. Okafor",     meta: "Private lender · Developer",   deals: 4, value: 610000,  score: 94, communication: 92, reliability: 96,  returns: 93 },
  { rank: 3, a: { i: "PT", c: "amber" },  b: { i: "LM", c: "purple" }, names: "P. Thornton & L. Martinez", meta: "Family office · Developer",   deals: 3, value: 420000,  score: 91, communication: 88, reliability: 100, returns: 86 },
  { rank: 4, a: { i: "ML", c: "purple" }, b: { i: "RA", c: "blue" },   names: "M. Lawson & R. Ahmed",     meta: "Angel investor · Renovator",   deals: 3, value: 380000,  score: 85, communication: 82, reliability: 84,  returns: 88 },
  { rank: 5, a: { i: "CW", c: "coral" },  b: { i: "DG", c: "gray" },   names: "C. Williams & D. Greenfield", meta: "Private lender · Contractor", deals: 2, value: 210000, score: 78, communication: 80, reliability: 72,  returns: 82 },
];

const LENDER_CARDS = [
  { initials: "JH", color: "teal",   name: "James H.",   type: "Private lender",   budget: "£200,000", returnType: "Rental split", builderShare: "60%", lenderShare: "40%", project: "Residential" },
  { initials: "SR", color: "blue",   name: "S. Rathore", type: "Investment firm",  budget: "£500,000", returnType: "Fixed interest", rate: "8% p.a.", term: "12–36 months", project: "Any", featured: true },
  { initials: "ML", color: "purple", name: "M. Lawson",  type: "Angel investor",   budget: "£100,000", returnType: "Equity stake", equity: "15–25%", exit: "2–5 years", project: "Renovation" },
];

const RECENT_DEALS = [
  { icon: "🏠", title: "3-bed residential build, Manchester",  meta: "Builder: T. Okafor · Lender: James H.", amount: 185000, returnType: "60/40 rental split", status: "Active",  statusColor: "teal" },
  { icon: "🏢", title: "Mixed-use commercial unit, Leeds",     meta: "Builder: K. Singh · Lender: S. Rathore", amount: 420000, returnType: "8% fixed interest", status: "Closed",  statusColor: "gray" },
  { icon: "🔨", title: "Victorian terrace renovation, Birmingham", meta: "Builder: R. Ahmed · Lender: M. Lawson", amount: 95000, returnType: "20% equity stake", status: "Pending", statusColor: "amber" },
];

// ─── SHARED COMPONENTS ───────────────────────────────────────────────────────

function Avatar({ initials, color, size = 40 }) {
  const c = COLORS[color] || COLORS.gray;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: c.bg, color: c.text,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.33, fontWeight: 500, flexShrink: 0,
    }}>
      {initials}
    </div>
  );
}

function Badge({ children, color = "teal" }) {
  const c = COLORS[color] || COLORS.teal;
  return (
    <span style={{
      display: "inline-block", background: c.bg, color: c.text,
      fontSize: 11, fontWeight: 500, padding: "3px 9px",
      borderRadius: 20,
    }}>
      {children}
    </span>
  );
}

function MetricCard({ label, value }) {
  return (
    <div style={{
      background: "var(--color-bg-secondary, #f5f5f3)",
      borderRadius: 8, padding: "1rem",
    }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function CompatBar({ label, value, color }) {
  const barColor = color === "teal" ? "#1D9E75" : color === "blue" ? "#378ADD" : "#7F77DD";
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 3 }}>
        <span>{label}</span><span>{value}%</span>
      </div>
      <div style={{ height: 5, background: "#eee", borderRadius: 3 }}>
        <div style={{ height: 5, borderRadius: 3, background: barColor, width: `${value}%` }} />
      </div>
    </div>
  );
}

// ─── NAVBAR ──────────────────────────────────────────────────────────────────

function Navbar({ page, setPage }) {
  return (
    <nav style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 2rem", height: 56,
      borderBottom: "0.5px solid #e0e0e0",
      background: "#fff", position: "sticky", top: 0, zIndex: 100,
    }}>
      <div
        style={{ fontFamily: "'Georgia', serif", fontSize: 17, fontWeight: 700, cursor: "pointer", letterSpacing: -0.5 }}
        onClick={() => setPage("home")}
      >
        Money Has Been Given Out
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {["home", "search", "leaderboard"].map(p => (
          <button
            key={p}
            onClick={() => setPage(p)}
            style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500,
              border: page === p ? "none" : "0.5px solid #ddd",
              background: page === p ? "#1D9E75" : "transparent",
              color: page === p ? "#fff" : "#555",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {p === "home" ? "Home" : p === "search" ? "Find a lender" : "Leaderboard"}
          </button>
        ))}
      </div>
    </nav>
  );
}

// ─── HOME PAGE ───────────────────────────────────────────────────────────────

function HomePage({ setPage }) {
  return (
    <div>
      {/* Hero */}
      <div style={{ textAlign: "center", padding: "4rem 2rem 3rem" }}>
        <div style={{
          display: "inline-block", background: "#E1F5EE", color: "#0F6E56",
          fontSize: 12, fontWeight: 500, padding: "4px 14px", borderRadius: 20, marginBottom: "1.25rem"
        }}>
          Property investment, simplified
        </div>
        <h1 style={{
          fontSize: 38, fontWeight: 500, lineHeight: 1.2, margin: "0 0 1rem",
          fontFamily: "'Georgia', serif",
        }}>
          Where <span style={{ color: "#1D9E75" }}>builders</span> meet<br />
          the right <span style={{ color: "#1D9E75" }}>lenders</span>
        </h1>
        <p style={{ fontSize: 16, color: "#666", maxWidth: 540, margin: "0 auto 2rem", lineHeight: 1.7 }}>
          Search lenders by budget, agree on returns, connect instantly. We match you — you build together.
        </p>
        <button
          onClick={() => setPage("search")}
          style={{ background: "#1D9E75", color: "#fff", border: "none", padding: "12px 28px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", marginRight: 10 }}
        >
          Find a lender
        </button>
        <button
          style={{ background: "transparent", color: "#333", border: "0.5px solid #ccc", padding: "12px 28px", borderRadius: 8, fontSize: 15, cursor: "pointer" }}
        >
          List as lender
        </button>
      </div>

      {/* Stats */}
      <div style={{
        display: "flex", justifyContent: "center", gap: "2.5rem", padding: "2rem",
        borderTop: "0.5px solid #eee", borderBottom: "0.5px solid #eee", marginBottom: "3rem", flexWrap: "wrap",
      }}>
        {[["£4.2M", "Capital matched"], ["312", "Active lenders"], ["89", "Deals closed"], ["1%", "Finder's fee"]].map(([v, l]) => (
          <div key={l} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 24, fontWeight: 500 }}>{v}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Lender cards preview */}
      <div style={{ padding: "0 2rem 3rem", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: "#1D9E75", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Featured lenders</div>
        <h2 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Ready to fund your project</h2>
        <p style={{ fontSize: 14, color: "#888", marginBottom: "1.5rem" }}>A sample of lenders active on the platform</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: "2.5rem" }}>
          {LENDER_CARDS.map((lc) => (
            <LenderCard key={lc.name} lc={lc} />
          ))}
        </div>

        {/* How it works */}
        <div style={{ background: "#f9f9f7", borderRadius: 12, padding: "2rem", marginBottom: "2rem" }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: "#1D9E75", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>How it works</div>
          <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: "1.5rem" }}>From search to deal in four steps</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1.5rem" }}>
            {[
              ["1", "Post your project", "Builders list their project scope, location, and funding needed."],
              ["2", "Browse lenders", "Search lenders by budget, return type, and project preference."],
              ["3", "Request a match", "Send a connect request. The lender reviews and accepts or declines."],
              ["4", "Funds released", "Lender sends funds. A 1% finder's fee is collected at completion."],
            ].map(([n, title, desc]) => (
              <div key={n}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#1D9E75", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 500, marginBottom: 10 }}>{n}</div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{title}</div>
                <div style={{ fontSize: 13, color: "#888", lineHeight: 1.5 }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Fee strip */}
        <div style={{ background: "#fff", border: "0.5px solid #e0e0e0", borderRadius: 12, padding: "1.5rem 2rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem", marginBottom: "2rem" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>Transparent finder's fee</div>
            <div style={{ fontSize: 13, color: "#888" }}>We only earn when a deal completes — 1% of the total transaction value.</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 500, color: "#1D9E75" }}>£2,000</div>
            <div style={{ fontSize: 12, color: "#888" }}>fee on a £200,000 deal</div>
          </div>
        </div>

        {/* Recent deals */}
        <div style={{ marginBottom: "3rem" }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: "#1D9E75", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Recent deals</div>
          <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: "1rem" }}>Matches made on the platform</h2>
          {RECENT_DEALS.map((d) => {
            const c = COLORS[d.statusColor];
            return (
              <div key={d.title} style={{ background: "#fff", border: "0.5px solid #e0e0e0", borderRadius: 12, padding: "1.25rem", display: "flex", alignItems: "center", gap: "1rem", marginBottom: 10, flexWrap: "wrap" }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, background: "#E1F5EE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{d.icon}</div>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{d.title}</div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{d.meta}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 16, fontWeight: 500 }}>{fmt(d.amount)}</div>
                  <div style={{ fontSize: 12, color: "#1D9E75" }}>{d.returnType}</div>
                </div>
                <span style={{ background: c.bg, color: c.text, fontSize: 11, padding: "3px 9px", borderRadius: 20, fontWeight: 500 }}>{d.status}</span>
              </div>
            );
          })}
        </div>

        {/* Footer CTA */}
        <div style={{ textAlign: "center", padding: "2rem", borderTop: "0.5px solid #eee" }}>
          <h2 style={{ fontSize: 24, fontWeight: 500, marginBottom: 8, fontFamily: "'Georgia', serif" }}>Ready to build something?</h2>
          <p style={{ fontSize: 14, color: "#888", marginBottom: "1.5rem" }}>Join builders and lenders already using Money Has Been Given Out to make deals happen.</p>
          <button
            onClick={() => setPage("search")}
            style={{ background: "#1D9E75", color: "#fff", border: "none", padding: "12px 28px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer" }}
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

function LenderCard({ lc }) {
  const c = COLORS[lc.color];
  return (
    <div style={{
      background: "#fff",
      border: lc.featured ? "2px solid #5DCAA5" : "0.5px solid #e0e0e0",
      borderRadius: 12, padding: "1.25rem",
    }}>
      {lc.featured && (
        <div style={{ marginBottom: 8 }}>
          <span style={{ background: "#E1F5EE", color: "#0F6E56", fontSize: 11, padding: "3px 10px", borderRadius: 20, fontWeight: 500 }}>Most active</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Avatar initials={lc.initials} color={lc.color} size={40} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 500 }}>{lc.name}</div>
          <div style={{ fontSize: 12, color: "#888" }}>{lc.type}</div>
        </div>
      </div>
      <div style={{ display: "inline-block", background: "#E1F5EE", color: "#0F6E56", fontSize: 13, fontWeight: 500, padding: "4px 10px", borderRadius: 8, marginBottom: 10 }}>
        Up to {lc.budget}
      </div>
      <div style={{ fontSize: 13 }}>
        {[
          ["Return type", lc.returnType],
          lc.builderShare ? ["Builder share", lc.builderShare] : null,
          lc.lenderShare ? ["Lender share", lc.lenderShare] : null,
          lc.rate ? ["Rate", lc.rate] : null,
          lc.term ? ["Term", lc.term] : null,
          lc.equity ? ["Equity ask", lc.equity] : null,
          lc.exit ? ["Exit timeline", lc.exit] : null,
          ["Project pref.", lc.project],
        ].filter(Boolean).map(([label, val]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "#666" }}>
            <span>{label}</span>
            <span style={{ fontWeight: 500, color: "#222" }}>{val}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, borderTop: "0.5px solid #eee", paddingTop: 12, display: "flex", gap: 8 }}>
        <button style={{ flex: 1, background: "#1D9E75", color: "#fff", border: "none", padding: 8, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>Connect</button>
        <button style={{ flex: 1, background: "transparent", color: "#333", border: "0.5px solid #ccc", padding: 8, borderRadius: 8, fontSize: 13, cursor: "pointer" }}>View profile</button>
      </div>
    </div>
  );
}

// ─── SEARCH PAGE ─────────────────────────────────────────────────────────────

function SearchPage() {
  const [budget, setBudget] = useState("any");
  const [returnType, setReturnType] = useState("any");
  const [project, setProject] = useState("any");

  return (
    <div style={{ padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: "#1D9E75", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Find a lender</div>
      <h2 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Search available lenders</h2>
      <p style={{ fontSize: 14, color: "#888", marginBottom: "1.5rem" }}>Filter by budget, return type, and project preference</p>

      <div style={{ display: "flex", gap: 10, marginBottom: "1.5rem", flexWrap: "wrap" }}>
        {[
          ["budget", budget, setBudget, ["any", "£50k–£100k", "£100k–£200k", "£200k–£500k", "£500k+"]],
          ["returnType", returnType, setReturnType, ["any", "Revenue share", "Fixed interest", "Rental split", "Equity stake"]],
          ["project", project, setProject, ["any", "Residential", "Commercial", "Mixed use", "Renovation"]],
        ].map(([key, val, setter, opts]) => (
          <select
            key={key}
            value={val}
            onChange={e => setter(e.target.value)}
            style={{ flex: 1, minWidth: 130, height: 38, border: "0.5px solid #ccc", borderRadius: 8, padding: "0 12px", fontSize: 14, background: "#fff" }}
          >
            {opts.map(o => <option key={o} value={o}>{o === "any" ? `Any ${key === "budget" ? "budget" : key === "returnType" ? "return type" : "project type"}` : o}</option>)}
          </select>
        ))}
        <button style={{ background: "#1D9E75", color: "#fff", border: "none", padding: "0 20px", borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Search</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {LENDER_CARDS.map(lc => <LenderCard key={lc.name} lc={lc} />)}
      </div>
    </div>
  );
}

// ─── LEADERBOARD PAGE ────────────────────────────────────────────────────────

function LeaderboardPage() {
  const [tab, setTab] = useState("lenders");
  const [lenderSort, setLenderSort] = useState("capital");
  const [builderSort, setBuilderSort] = useState("properties");

  const sortedLenders = [...LENDERS].sort((a, b) => {
    if (lenderSort === "capital") return b.capital - a.capital;
    if (lenderSort === "deals") return b.deals - a.deals;
    return (b.rate || 0) - (a.rate || 0);
  });

  const sortedBuilders = [...BUILDERS].sort((a, b) => {
    if (builderSort === "properties") return b.props - a.props;
    if (builderSort === "value") return b.value - a.value;
    return b.completion - a.completion;
  });

  const maxCapital = Math.max(...LENDERS.map(l => l.capital));
  const maxProps = Math.max(...BUILDERS.map(b => b.props));

  const tabs = ["lenders", "builders", "pairs"];

  return (
    <div style={{ padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      {/* Tab row */}
      <div style={{ display: "flex", gap: 0, borderBottom: "0.5px solid #e0e0e0", marginBottom: "1.75rem" }}>
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "10px 20px", fontSize: 14, fontWeight: 500, cursor: "pointer",
              border: "none", background: "transparent",
              color: tab === t ? "#1D9E75" : "#888",
              borderBottom: tab === t ? "2px solid #1D9E75" : "2px solid transparent",
              marginBottom: -1, textTransform: "capitalize",
            }}
          >
            {t === "lenders" ? "Top lenders" : t === "builders" ? "Top builders" : "Best connections"}
          </button>
        ))}
      </div>

      {/* LENDERS tab */}
      {tab === "lenders" && (
        <div>
          <div style={{ marginBottom: "1.25rem" }}>
            <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 3 }}>Top lenders</h2>
            <p style={{ fontSize: 13, color: "#888" }}>Ranked by total capital deployed across all matched deals</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: "1.75rem" }}>
            <MetricCard label="Total lent" value="£4.2M" />
            <MetricCard label="Active lenders" value="312" />
            <MetricCard label="Avg deal size" value="£186k" />
            <MetricCard label="Repeat lenders" value="68%" />
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: "1.25rem", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#888" }}>Sort by</span>
            <select
              value={lenderSort}
              onChange={e => setLenderSort(e.target.value)}
              style={{ height: 34, border: "0.5px solid #ccc", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#fff" }}
            >
              <option value="capital">Total capital lent</option>
              <option value="deals">Number of deals</option>
              <option value="rate">Avg return rate</option>
            </select>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["#", "Lender", "Total lent", "Deals", "Avg return", "Activity"].map((h, i) => (
                  <th key={h} style={{ fontSize: 12, fontWeight: 500, color: "#888", textAlign: i >= 2 && i <= 4 ? "right" : "left", padding: "0 12px 10px", borderBottom: "0.5px solid #eee" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedLenders.map((l, i) => {
                const pct = Math.round((l.capital / maxCapital) * 100);
                const rankColor = i === 0 ? "#BA7517" : i === 1 ? "#888780" : i === 2 ? "#993C1D" : "#aaa";
                return (
                  <tr key={l.name} style={{ borderBottom: "0.5px solid #f0f0f0" }}>
                    <td style={{ padding: "13px 12px", fontSize: 14, fontWeight: 500, color: rankColor, width: 36 }}>{i + 1}</td>
                    <td style={{ padding: "13px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar initials={l.initials} color={l.color} size={34} />
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{l.name}</div>
                          <div style={{ fontSize: 12, color: "#888" }}>{l.type}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "13px 12px", textAlign: "right", fontSize: 14, fontWeight: 500 }}>{fmt(l.capital)}</td>
                    <td style={{ padding: "13px 12px", textAlign: "right", fontSize: 14, fontWeight: 500 }}>{l.deals}</td>
                    <td style={{ padding: "13px 12px", textAlign: "right", fontSize: 14, fontWeight: 500 }}>{l.rateLabel || `${l.rate}%`}</td>
                    <td style={{ padding: "13px 12px", minWidth: 120 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 6, background: "#eee", borderRadius: 3 }}>
                          <div style={{ height: 6, borderRadius: 3, background: "#1D9E75", width: `${pct}%` }} />
                        </div>
                        <span style={{ fontSize: 12, color: "#888", minWidth: 30 }}>{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* BUILDERS tab */}
      {tab === "builders" && (
        <div>
          <div style={{ marginBottom: "1.25rem" }}>
            <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 3 }}>Top builders</h2>
            <p style={{ fontSize: 13, color: "#888" }}>Ranked by properties completed and total investment secured</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: "1.75rem" }}>
            <MetricCard label="Properties built" value="247" />
            <MetricCard label="Active builders" value="189" />
            <MetricCard label="Avg project value" value="£215k" />
            <MetricCard label="Completion rate" value="91%" />
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: "1.25rem", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#888" }}>Sort by</span>
            <select
              value={builderSort}
              onChange={e => setBuilderSort(e.target.value)}
              style={{ height: 34, border: "0.5px solid #ccc", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#fff" }}
            >
              <option value="properties">Properties built</option>
              <option value="value">Total value secured</option>
              <option value="rate">Completion rate</option>
            </select>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["#", "Builder", "Properties", "Value secured", "Completion", "Activity"].map((h, i) => (
                  <th key={h} style={{ fontSize: 12, fontWeight: 500, color: "#888", textAlign: i >= 2 && i <= 4 ? "right" : "left", padding: "0 12px 10px", borderBottom: "0.5px solid #eee" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedBuilders.map((b, i) => {
                const pct = Math.round((b.props / maxProps) * 100);
                const rankColor = i === 0 ? "#BA7517" : i === 1 ? "#888780" : i === 2 ? "#993C1D" : "#aaa";
                return (
                  <tr key={b.name} style={{ borderBottom: "0.5px solid #f0f0f0" }}>
                    <td style={{ padding: "13px 12px", fontSize: 14, fontWeight: 500, color: rankColor, width: 36 }}>{i + 1}</td>
                    <td style={{ padding: "13px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar initials={b.initials} color={b.color} size={34} />
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{b.name}</div>
                          <div style={{ fontSize: 12, color: "#888" }}>{b.type}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "13px 12px", textAlign: "right", fontSize: 14, fontWeight: 500 }}>{b.props}</td>
                    <td style={{ padding: "13px 12px", textAlign: "right", fontSize: 14, fontWeight: 500 }}>{fmt(b.value)}</td>
                    <td style={{ padding: "13px 12px", textAlign: "right", fontSize: 14, fontWeight: 500 }}>{b.completion}%</td>
                    <td style={{ padding: "13px 12px", minWidth: 120 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 6, background: "#eee", borderRadius: 3 }}>
                          <div style={{ height: 6, borderRadius: 3, background: "#378ADD", width: `${pct}%` }} />
                        </div>
                        <span style={{ fontSize: 12, color: "#888", minWidth: 20 }}>{b.props}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* PAIRS tab */}
      {tab === "pairs" && (
        <div>
          <div style={{ marginBottom: "1.25rem" }}>
            <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 3 }}>Best connections</h2>
            <p style={{ fontSize: 13, color: "#888" }}>Pairs scored on deals completed, returns delivered, and ongoing collaboration</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: "1.75rem" }}>
            <MetricCard label="Active pairs" value="89" />
            <MetricCard label="Repeat matches" value="54" />
            <MetricCard label="Highest score" value="98" />
            <MetricCard label="Avg pair value" value="£310k" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {PAIRS.map(p => {
              const rankColor = p.rank === 1 ? "#BA7517" : p.rank === 2 ? "#888780" : p.rank === 3 ? "#993C1D" : "#aaa";
              return (
                <div key={p.rank} style={{ background: "#fff", border: "0.5px solid #e0e0e0", borderRadius: 12, padding: "1.25rem", display: "flex", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 22, fontWeight: 500, color: rankColor, minWidth: 32, textAlign: "center", paddingTop: 4 }}>{p.rank}</div>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <Avatar initials={p.a.i} color={p.a.c} size={36} />
                    <div style={{ marginLeft: -8, border: "2px solid #fff", borderRadius: "50%" }}>
                      <Avatar initials={p.b.i} color={p.b.c} size={36} />
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3 }}>{p.names}</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{p.meta}</div>
                    <CompatBar label="Communication" value={p.communication} color="teal" />
                    <CompatBar label="Reliability" value={p.reliability} color="blue" />
                    <CompatBar label="Returns delivered" value={p.returns} color="purple" />
                  </div>
                  <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", paddingTop: 4 }}>
                    {[["Deals", p.deals], ["Total value", fmt(p.value)], ["Match score", p.score]].map(([label, val]) => (
                      <div key={label} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 16, fontWeight: 500, color: label === "Match score" ? "#1D9E75" : undefined }}>{val}</div>
                        <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState("home");

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#fff", color: "#1a1a1a" }}>
      <Navbar page={page} setPage={setPage} />
      {page === "home" && <HomePage setPage={setPage} />}
      {page === "search" && <SearchPage />}
      {page === "leaderboard" && <LeaderboardPage />}
    </div>
  );
}
