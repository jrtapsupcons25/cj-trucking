# Rabara JRCJ Freight Services — Operations System

Web app for Rabara JRCJ Freight Services' Manila ⇄ Vigan freight operations, in both directions. Managed by Emilia Rabara.

**Modules:** Dashboard · Shipments / freight · Dispatch & loading · En-route releases (intermediate unloading) · Vigan receiving · Delivery (Elf truck / korong-korong, proof of delivery) · Fleet (5 ten-wheelers, schedule, maintenance & repair history) · Reports (CSV export) · Users & settings (staff roles, crew, route stops, warehouse bays, delivery vehicles).

**Stack:** static HTML/CSS/JS hosted on GitHub Pages, with [Supabase](https://supabase.com) for logins, the Postgres database (row level security per role), live updates and proof-of-delivery photo storage. No build step.

## Setup (one time)

1. **Create the database.** In your Supabase project open **SQL Editor → New query**, paste everything in [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It creates the tables, roles and permissions, and loads the 5 trucks (CJ-01 … CJ-05), the Manila and Vigan stops, and the Elf Truck and Korong-korong delivery vehicles.
2. **Connect the app.** In Supabase open **Project Settings → API** and copy the **Project URL** and the **publishable / anon key**. Put them in [`js/config.js`](js/config.js) and commit. (These two values are safe to publish; the data is protected by logins and row level security.)
3. **Allow the website to log in.** In Supabase open **Authentication → URL Configuration** and set **Site URL** to the GitHub Pages address, e.g. `https://<your-github-name>.github.io/cj-trucking/`.
4. **Create the administrator.** Open the website and use **New staff account**. The very first account automatically becomes the administrator.
5. **Add staff.** Each staff member creates an account on the sign-in page, then the administrator assigns a role under **Users & settings**.

**Database updates.** If your database was set up before an update, run the matching file once in the SQL Editor:

- [`supabase/002_item_rates.sql`](supabase/002_item_rates.sql) — freight charged per item / per box (size or package and rate on each item line).
- [`supabase/003_two_way_trips.sql`](supabase/003_two_way_trips.sql) — trips and cargo in both directions (Manila → Vigan and Vigan → Manila); bays and delivery vehicles per terminal.

Optional: to skip email confirmation for new accounts, turn off **Authentication → Providers → Email → Confirm email** in Supabase.

## Roles

| Role | Can do |
|---|---|
| Administrator | Everything, including staff accounts and roles |
| Operations manager | All operations, fleet & maintenance, settings |
| Dispatcher | Register cargo, build trips, loading sign-off, departure, en-route releases, crew list |
| Receiver | Arrival at either terminal, en-route releases, reconciliation, shortage/damage, delivery |
| Delivery | Assign Elf truck / korong-korong, proof of delivery |
| Accounting | View everything, mark collect freight as paid |
| Viewer | View only |

## How freight moves

Every trip and shipment has a direction: **Manila → Vigan** or **Vigan → Manila**. Route stops are kept in Manila → Vigan order; return trips run them in reverse. Cargo can only be loaded on a trip going its way.


`Registered` → `Loaded` (on a trip manifest) → `In transit` (after driver, pahinante and checker sign-off and departure) → `Released en route` (drop-off before Vigan) **or** `In warehouse` at the end terminal (reconciled, bay assigned) → `Out for delivery` → `Delivered` / `Picked up`.

Every status change is logged with who did it and when. Shortages, damage and overcarried cargo found during release, receiving or delivery create reports that stay open until resolved.

## Files

```
index.html          app shell
css/app.css         design (JRCJ badge purple and peach, truck-livery stripe; light and dark mode)
js/config.js        Supabase URL and publishable key
js/app.js           screens, workflow and data access
js/lib.js           formatting, icons, dialogs, CSV export
supabase/schema.sql database: tables, roles, security policies, trip actions, starting data
```
