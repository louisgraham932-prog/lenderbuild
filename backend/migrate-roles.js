/**
 * Migration: adds sequential_id and user_role columns to profiles table.
 * Run with: DB_PASSWORD=yourpassword node migrate-roles.js
 */
require("dotenv").config();
const { Client } = require("pg");

const dbPassword = process.env.DB_PASSWORD || process.argv[2];
if (!dbPassword) {
  console.error("Usage: DB_PASSWORD=<password> node backend/migrate-roles.js");
  process.exit(1);
}

const PROJECT_REF = "qvywhdsaeiufdlaewwby";
const FOUNDER_EMAIL = "louisgraham932@gmail.com";

const client = new Client({
  host: `db.${PROJECT_REF}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: dbPassword,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  await client.connect();
  console.log("Connected to Supabase Postgres");

  // Add columns
  await client.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sequential_id INTEGER;`);
  await client.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS user_role TEXT;`);
  console.log("✓ Columns added");

  // Create sequence starting at 2 (1 reserved for founder)
  await client.query(`CREATE SEQUENCE IF NOT EXISTS user_sequential_id_seq START 2;`);
  console.log("✓ Sequence created");

  // Set founder (#0001)
  const { rowCount } = await client.query(`
    UPDATE profiles
    SET sequential_id = 1, user_role = 'founder'
    WHERE id = (SELECT id FROM auth.users WHERE email = $1 LIMIT 1)
      AND sequential_id IS NULL;
  `, [FOUNDER_EMAIL]);
  console.log(rowCount > 0 ? "✓ Founder set to #0001" : "⚠ Founder profile not found (complete profile setup first)");

  // Backfill all other profiles
  const { rowCount: backfilled } = await client.query(`
    UPDATE profiles
    SET sequential_id = nextval('user_sequential_id_seq')
    WHERE sequential_id IS NULL;
  `);
  console.log(`✓ Backfilled ${backfilled} other profile(s)`);

  // Trigger to auto-assign on new INSERT
  await client.query(`
    CREATE OR REPLACE FUNCTION assign_sequential_id()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.sequential_id IS NULL THEN
        NEW.sequential_id := nextval('user_sequential_id_seq');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.query(`DROP TRIGGER IF EXISTS tr_assign_sequential_id ON profiles;`);
  await client.query(`
    CREATE TRIGGER tr_assign_sequential_id
      BEFORE INSERT ON profiles
      FOR EACH ROW
      EXECUTE FUNCTION assign_sequential_id();
  `);
  console.log("✓ Trigger created");

  // Unique constraint (only add if no duplicates exist)
  try {
    await client.query(`
      ALTER TABLE profiles
        ADD CONSTRAINT profiles_sequential_id_unique UNIQUE (sequential_id);
    `);
    console.log("✓ Unique constraint added");
  } catch (e) {
    if (e.message.includes("already exists")) {
      console.log("✓ Unique constraint already exists");
    } else {
      console.warn("⚠ Could not add unique constraint:", e.message);
    }
  }

  await client.end();
  console.log("\nMigration complete.");
}

migrate().catch(err => {
  console.error("Migration failed:", err.message);
  client.end();
  process.exit(1);
});
