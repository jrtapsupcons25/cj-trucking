// Supabase connection for CJ Trucking Services.
// Paste the values from Supabase → Project Settings → API (or "Connect").
// The publishable / anon key is meant to be public: every table is protected by
// row level security and staff logins (see supabase/schema.sql).
window.CJ_CONFIG = {
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_URL",          // e.g. https://abcdefghijkl.supabase.co
  SUPABASE_KEY: "PASTE_YOUR_PUBLISHABLE_OR_ANON_KEY" // starts with sb_publishable_ or eyJ...
};
