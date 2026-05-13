/**
 * Fix: repairs the handle_new_user trigger so new signups don't get a database error.
 *
 * Root cause: the standard Supabase template trigger reads raw_user_meta_data->>'full_name'
 * but LenderBuild passes { name, role } in metadata — so full_name is always NULL.
 * If the profiles.full_name column has a NOT NULL constraint, every signup fails.
 *
 * This script:
 *  1. Creates/replaces handle_new_user to read 'name' (LenderBuild's key), with fallbacks
 *  2. Wraps the insert in an exception handler so a trigger failure never blocks signup
 *  3. Ensures the user_sequential_id_seq sequence exists (used by tr_assign_sequential_id)
 *  4. Re-creates the on_auth_user_created trigger
 *
 * Run with: DB_PASSWORD=yourpassword node backend/fix-signup.js
 */
require("dotenv").config();
const { Client } = require("pg");

const dbPassword = process.env.DB_PASSWORD || process.argv[2];
if (!dbPassword) {
  console.error("Usage: DB_PASSWORD=<password> node backend/fix-signup.js");
  console.error("Find your password in Supabase Dashboard → Settings → Database");
  process.exit(1);
}

const PROJECT_REF = "qvywhdsaeiufdlaewwby";

const client = new Client({
  host: `db.${PROJECT_REF}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: dbPassword,
  ssl: { rejectUnauthorized: false },
});

async function fix() {
  await client.connect();
  console.log("Connected to Supabase Postgres");

  // Ensure the sequence used by tr_assign_sequential_id exists
  await client.query(`CREATE SEQUENCE IF NOT EXISTS user_sequential_id_seq START 2;`);
  console.log("✓ Sequence user_sequential_id_seq ensured");

  // Ensure sequential_id and user_role columns exist (idempotent)
  await client.query(`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sequential_id INTEGER;`);
  await client.query(`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS user_role TEXT;`);
  console.log("✓ Columns sequential_id and user_role ensured");

  // Ensure the auto-assign trigger for sequential_id exists
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
  await client.query(`DROP TRIGGER IF EXISTS tr_assign_sequential_id ON public.profiles;`);
  await client.query(`
    CREATE TRIGGER tr_assign_sequential_id
      BEFORE INSERT ON public.profiles
      FOR EACH ROW
      EXECUTE FUNCTION assign_sequential_id();
  `);
  console.log("✓ tr_assign_sequential_id trigger ensured");

  // Create/replace handle_new_user with correct metadata key ('name' not 'full_name')
  // and exception handler so trigger failure never blocks signup
  await client.query(`
    CREATE OR REPLACE FUNCTION public.handle_new_user()
    RETURNS trigger AS $$
    BEGIN
      INSERT INTO public.profiles (id, full_name, role)
      VALUES (
        NEW.id,
        COALESCE(
          NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
          NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
          SPLIT_PART(NEW.email, '@', 1)
        ),
        COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'role'), ''), 'builder')
      )
      ON CONFLICT (id) DO NOTHING;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      -- Never block signup due to a trigger error
      RAISE WARNING 'handle_new_user: failed to create profile for % — %', NEW.id, SQLERRM;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER;
  `);
  console.log("✓ handle_new_user function created/replaced");

  await client.query(`DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;`);
  await client.query(`
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user();
  `);
  console.log("✓ on_auth_user_created trigger created");

  // Relax full_name NOT NULL constraint if it exists (signup should never hard-fail on this)
  try {
    await client.query(`ALTER TABLE public.profiles ALTER COLUMN full_name DROP NOT NULL;`);
    console.log("✓ full_name NOT NULL constraint removed (was causing signup failures)");
  } catch (e) {
    if (e.message.includes("does not exist") || e.message.includes("already")) {
      console.log("✓ full_name column is already nullable");
    } else {
      console.warn("⚠ Could not alter full_name:", e.message);
    }
  }

  await client.end();
  console.log("\nFix complete. New signups should now work correctly.");
}

fix().catch(err => {
  console.error("Fix failed:", err.message);
  client.end();
  process.exit(1);
});
