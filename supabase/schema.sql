-- =====================================================================
-- CJ TRUCKING SERVICES — database setup
-- Run this whole file ONCE in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it uses "if not exists" / "create or replace" where it can.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Staff profiles and roles
-- ---------------------------------------------------------------------
-- Roles
--   admin       full access, manages staff accounts and settings
--   manager     full operational access, fleet, reports
--   dispatcher  Manila: registers cargo, builds trips, loading sign-off
--   receiver    Vigan: arrival, reconciliation, intermediate releases
--   delivery    Vigan: delivery assignment and proof of delivery
--   accounting  read everything, marks freight as paid
--   viewer      read-only
--   pending     newly signed up, waiting for an admin to assign a role
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        text not null default 'pending'
              check (role in ('admin','manager','dispatcher','receiver','delivery','accounting','viewer','pending')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select case when p.active then p.role else 'inactive' end
  from public.profiles p where p.id = auth.uid()
$$;

create or replace function public.has_role(variadic roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = any(roles), false)
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() not in ('pending','inactive'), false)
$$;

-- New sign-ups get a profile. The very first account becomes admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email,
    case when exists (select 1 from public.profiles) then 'pending' else 'admin' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only admins change roles or deactivate accounts; the last admin can't be removed.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;  -- SQL editor / service context
  if (new.role is distinct from old.role or new.active is distinct from old.active) then
    if not public.has_role('admin') then
      raise exception 'Only an administrator can change roles or account status.';
    end if;
    if old.role = 'admin' and (new.role <> 'admin' or not new.active)
       and (select count(*) from public.profiles where role = 'admin' and active) <= 1 then
      raise exception 'Keep at least one active administrator.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------------------------------------------------------------------
-- 2. Settings: route stops, warehouse bays, delivery vehicles, crew
-- ---------------------------------------------------------------------
create table if not exists public.route_stops (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  seq        int  not null,
  kind       text not null default 'stop' check (kind in ('origin','stop','final')),
  created_at timestamptz not null default now()
);

create table if not exists public.warehouse_bays (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.delivery_vehicles (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  kind       text not null default 'Elf truck',
  plate_no   text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Drivers, pahinante and delivery crew (they don't need app logins)
create table if not exists public.crew (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null,
  role       text not null check (role in ('Driver','Pahinante','Delivery crew','Checker')),
  phone      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Fleet
-- ---------------------------------------------------------------------
create table if not exists public.trucks (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,           -- e.g. CJ-01
  plate_no       text,
  model          text not null default '10-wheeler',
  default_driver text,
  status         text not null default 'Available'
                 check (status in ('Available','Loading','On trip','Under maintenance')),
  odometer_km    int,
  next_pms_date  date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.maintenance_logs (
  id          uuid primary key default gen_random_uuid(),
  truck_id    uuid not null references public.trucks(id) on delete cascade,
  log_date    date not null default (now() at time zone 'Asia/Manila')::date,
  kind        text not null check (kind in ('PMS','Repair','Tires','Inspection','Other')),
  description text not null,
  cost        numeric(12,2) not null default 0,
  shop        text,
  odometer_km int,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists maintenance_logs_truck_idx on public.maintenance_logs(truck_id, log_date desc);

-- ---------------------------------------------------------------------
-- 4. Trips (one 10-wheeler run Manila → Vigan)
-- ---------------------------------------------------------------------
create sequence if not exists public.trip_no_seq;
create sequence if not exists public.shipment_no_seq;

create or replace function public.next_trip_no() returns text
language sql volatile security definer set search_path = public as $$
  select 'T-' || to_char(now() at time zone 'Asia/Manila', 'YYMMDD') || '-' ||
         lpad(nextval('public.trip_no_seq')::text, 3, '0')
$$;

create or replace function public.next_tracking_no() returns text
language sql volatile security definer set search_path = public as $$
  select 'CJ-' || to_char(now() at time zone 'Asia/Manila', 'YYMMDD') || '-' ||
         lpad(nextval('public.shipment_no_seq')::text, 5, '0')
$$;

create table if not exists public.trips (
  id                     uuid primary key default gen_random_uuid(),
  trip_no                text not null unique default public.next_trip_no(),
  truck_id               uuid not null references public.trucks(id),
  driver                 text not null,
  pahinante              text,
  pahinante2             text,
  planned_departure      timestamptz,
  status                 text not null default 'Loading'
                         check (status in ('Loading','On the road','At Vigan','Closed')),
  driver_confirmed_at    timestamptz,
  driver_confirmed_by    uuid references public.profiles(id),
  pahinante_confirmed_at timestamptz,
  pahinante_confirmed_by uuid references public.profiles(id),
  checker_confirmed_at   timestamptz,
  checker_confirmed_by   uuid references public.profiles(id),
  departed_at            timestamptz,
  departed_by            uuid references public.profiles(id),
  arrived_vigan_at       timestamptz,
  closed_at              timestamptz,
  notes                  text,
  created_by             uuid references public.profiles(id) default auth.uid(),
  created_at             timestamptz not null default now()
);
create index if not exists trips_status_idx on public.trips(status);

create table if not exists public.trip_stop_logs (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  stop_name   text not null,
  arrived_at  timestamptz not null default now(),
  recorded_by uuid references public.profiles(id) default auth.uid()
);
create index if not exists trip_stop_logs_trip_idx on public.trip_stop_logs(trip_id);

-- ---------------------------------------------------------------------
-- 5. Shipments (one consignment = one tracking number)
-- ---------------------------------------------------------------------
-- Status codes
--   REG       Registered at Manila, not yet loaded
--   LOAD      On a trip manifest, truck still loading
--   TRANSIT   Truck departed
--   RELEASED  Released at an intermediate stop before Vigan
--   RECEIVED  Received and reconciled at the Vigan warehouse
--   OUT       Out for delivery (Elf truck / korong-korong)
--   DELIVERED Delivered with proof of delivery
--   PICKUP    Claimed by consignee at the Vigan warehouse
create table if not exists public.shipments (
  id                  uuid primary key default gen_random_uuid(),
  tracking_no         text not null unique default public.next_tracking_no(),
  shipper_name        text not null,
  shipper_contact     text,
  consignee_name      text not null,
  consignee_contact   text,
  consignee_address   text,
  destination         text not null,
  payment_terms       text not null default 'Prepaid' check (payment_terms in ('Prepaid','Collect')),
  freight_charge      numeric(12,2) not null default 0,
  declared_value      numeric(12,2),
  paid                boolean not null default false,
  paid_at             timestamptz,
  status              text not null default 'REG'
                      check (status in ('REG','LOAD','TRANSIT','RELEASED','RECEIVED','OUT','DELIVERED','PICKUP')),
  trip_id             uuid references public.trips(id) on delete set null,
  notes               text,
  -- intermediate release
  release_qty         numeric(12,2),
  release_received_by text,
  release_id_ref      text,
  release_condition   text,
  release_note        text,
  released_at         timestamptz,
  released_by         uuid references public.profiles(id),
  -- Vigan receiving
  received_qty        numeric(12,2),
  received_condition  text,
  warehouse_bay       text,
  receiving_note      text,
  received_at         timestamptz,
  received_by         uuid references public.profiles(id),
  -- delivery
  delivery_vehicle    text,
  delivery_crew       text,
  assigned_at         timestamptz,
  assigned_by         uuid references public.profiles(id),
  pod_received_by     text,
  pod_id_ref          text,
  pod_condition       text,
  pod_note            text,
  pod_photo_path      text,
  delivered_at        timestamptz,
  delivered_by        uuid references public.profiles(id),
  created_by          uuid references public.profiles(id) default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists shipments_status_idx  on public.shipments(status);
create index if not exists shipments_trip_idx    on public.shipments(trip_id);
create index if not exists shipments_created_idx on public.shipments(created_at desc);

create table if not exists public.shipment_items (
  id          uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  description text not null,
  qty         numeric(12,2) not null check (qty > 0),
  unit        text not null default 'pc'
);
create index if not exists shipment_items_shipment_idx on public.shipment_items(shipment_id);

-- Audit trail. Status changes are logged automatically by a trigger.
create table if not exists public.shipment_events (
  id          uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status      text,
  note        text,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists shipment_events_shipment_idx on public.shipment_events(shipment_id, created_at);

create or replace function public.log_shipment_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.shipment_events (shipment_id, status, created_by)
    values (new.id, new.status, auth.uid());
  end if;
  if tg_op = 'UPDATE' and new.paid and not old.paid then
    insert into public.shipment_events (shipment_id, note, created_by)
    values (new.id, 'Freight marked as paid', auth.uid());
  end if;
  return new;
end $$;

drop trigger if exists shipments_status_log on public.shipments;
create trigger shipments_status_log after insert or update on public.shipments
  for each row execute function public.log_shipment_status();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists shipments_touch on public.shipments;
create trigger shipments_touch before update on public.shipments
  for each row execute function public.touch_updated_at();
drop trigger if exists trucks_touch on public.trucks;
create trigger trucks_touch before update on public.trucks
  for each row execute function public.touch_updated_at();

-- Shortage / damage reports
create table if not exists public.issues (
  id           uuid primary key default gen_random_uuid(),
  shipment_id  uuid references public.shipments(id) on delete cascade,
  trip_id      uuid references public.trips(id) on delete set null,
  kind         text not null check (kind in ('Shortage','Damage','Overcarried','Other')),
  qty_affected numeric(12,2),
  description  text not null,
  stage        text,                       -- where it was found
  reported_by  uuid references public.profiles(id) default auth.uid(),
  reported_at  timestamptz not null default now(),
  resolved     boolean not null default false,
  resolution   text,
  resolved_by  uuid references public.profiles(id),
  resolved_at  timestamptz
);
create index if not exists issues_open_idx on public.issues(resolved, reported_at desc);

-- ---------------------------------------------------------------------
-- 6. Trip actions (run as the signed-in user, so permissions still apply)
-- ---------------------------------------------------------------------
create or replace function public.depart_trip(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare t public.trips;
begin
  select * into t from public.trips where id = p_trip for update;
  if not found then raise exception 'Trip not found.'; end if;
  if t.status <> 'Loading' then raise exception 'Trip % has already departed.', t.trip_no; end if;
  if t.driver_confirmed_at is null or t.pahinante_confirmed_at is null or t.checker_confirmed_at is null then
    raise exception 'Driver, pahinante and checker must all confirm the manifest first.';
  end if;
  if not exists (select 1 from public.shipments where trip_id = p_trip and status = 'LOAD') then
    raise exception 'The manifest is empty. Load cargo before departure.';
  end if;
  update public.trips set status = 'On the road', departed_at = now(), departed_by = auth.uid() where id = p_trip;
  update public.shipments set status = 'TRANSIT' where trip_id = p_trip and status = 'LOAD';
  update public.trucks set status = 'On trip' where id = t.truck_id;
  insert into public.trip_stop_logs (trip_id, stop_name)
    select p_trip, name from public.route_stops where kind = 'origin' limit 1;
end $$;

create or replace function public.arrive_vigan(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.trips set status = 'At Vigan', arrived_vigan_at = now()
   where id = p_trip and status = 'On the road';
  if not found then raise exception 'Only a trip on the road can be marked as arrived.'; end if;
  insert into public.trip_stop_logs (trip_id, stop_name)
    select p_trip, name from public.route_stops where kind = 'final' limit 1;
end $$;

create or replace function public.close_trip(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v_truck uuid;
begin
  if exists (select 1 from public.shipments where trip_id = p_trip and status in ('LOAD','TRANSIT')) then
    raise exception 'Some cargo on this trip is not yet released or received.';
  end if;
  update public.trips set status = 'Closed', closed_at = now()
   where id = p_trip and status = 'At Vigan' returning truck_id into v_truck;
  if v_truck is null then raise exception 'Only a trip that has arrived in Vigan can be closed.'; end if;
  update public.trucks set status = 'Available' where id = v_truck and status = 'On trip';
end $$;

create or replace function public.cancel_trip(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v_truck uuid;
begin
  select truck_id into v_truck from public.trips where id = p_trip and status = 'Loading';
  if v_truck is null then raise exception 'Only a trip that is still loading can be cancelled.'; end if;
  update public.shipments set status = 'REG', trip_id = null where trip_id = p_trip;
  delete from public.trips where id = p_trip;
  update public.trucks set status = 'Available' where id = v_truck and status = 'Loading';
end $$;

-- ---------------------------------------------------------------------
-- 7. Row level security
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.route_stops       enable row level security;
alter table public.warehouse_bays    enable row level security;
alter table public.delivery_vehicles enable row level security;
alter table public.crew              enable row level security;
alter table public.trucks            enable row level security;
alter table public.maintenance_logs  enable row level security;
alter table public.trips             enable row level security;
alter table public.trip_stop_logs    enable row level security;
alter table public.shipments         enable row level security;
alter table public.shipment_items    enable row level security;
alter table public.shipment_events   enable row level security;
alter table public.issues            enable row level security;

-- helper: drop then create, so this file can be re-run
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles: everyone signed in sees their own row; staff see everyone
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.has_role('admin'))
  with check (id = auth.uid() or public.has_role('admin'));

-- read access for all active staff
create policy read_staff on public.route_stops       for select to authenticated using (public.is_staff());
create policy read_staff on public.warehouse_bays    for select to authenticated using (public.is_staff());
create policy read_staff on public.delivery_vehicles for select to authenticated using (public.is_staff());
create policy read_staff on public.crew              for select to authenticated using (public.is_staff());
create policy read_staff on public.trucks            for select to authenticated using (public.is_staff());
create policy read_staff on public.maintenance_logs  for select to authenticated using (public.is_staff());
create policy read_staff on public.trips             for select to authenticated using (public.is_staff());
create policy read_staff on public.trip_stop_logs    for select to authenticated using (public.is_staff());
create policy read_staff on public.shipments         for select to authenticated using (public.is_staff());
create policy read_staff on public.shipment_items    for select to authenticated using (public.is_staff());
create policy read_staff on public.shipment_events   for select to authenticated using (public.is_staff());
create policy read_staff on public.issues            for select to authenticated using (public.is_staff());

-- settings, crew, fleet: admin + manager
create policy write_mgmt on public.route_stops       for all to authenticated using (public.has_role('admin','manager')) with check (public.has_role('admin','manager'));
create policy write_mgmt on public.warehouse_bays    for all to authenticated using (public.has_role('admin','manager')) with check (public.has_role('admin','manager'));
create policy write_mgmt on public.delivery_vehicles for all to authenticated using (public.has_role('admin','manager')) with check (public.has_role('admin','manager'));
create policy write_mgmt on public.crew              for all to authenticated using (public.has_role('admin','manager','dispatcher')) with check (public.has_role('admin','manager','dispatcher'));
create policy write_mgmt on public.maintenance_logs  for all to authenticated using (public.has_role('admin','manager')) with check (public.has_role('admin','manager'));
create policy insert_mgmt on public.trucks for insert to authenticated with check (public.has_role('admin','manager'));
create policy delete_mgmt on public.trucks for delete to authenticated using (public.has_role('admin','manager'));
-- trucks: dispatch/receiving change status during trips
create policy update_ops on public.trucks for update to authenticated
  using (public.has_role('admin','manager','dispatcher','receiver'))
  with check (public.has_role('admin','manager','dispatcher','receiver'));

-- trips
create policy insert_trips on public.trips for insert to authenticated with check (public.has_role('admin','manager','dispatcher'));
create policy update_trips on public.trips for update to authenticated
  using (public.has_role('admin','manager','dispatcher','receiver'))
  with check (public.has_role('admin','manager','dispatcher','receiver'));
create policy delete_trips on public.trips for delete to authenticated using (public.has_role('admin','manager','dispatcher'));
create policy insert_stops on public.trip_stop_logs for insert to authenticated with check (public.has_role('admin','manager','dispatcher','receiver'));

-- shipments
create policy insert_shipments on public.shipments for insert to authenticated with check (public.has_role('admin','manager','dispatcher'));
create policy update_shipments on public.shipments for update to authenticated
  using (public.has_role('admin','manager','dispatcher','receiver','delivery','accounting'))
  with check (public.has_role('admin','manager','dispatcher','receiver','delivery','accounting'));
create policy delete_shipments on public.shipments for delete to authenticated using (public.has_role('admin','manager','dispatcher') and status = 'REG');
create policy write_items on public.shipment_items for all to authenticated
  using (public.has_role('admin','manager','dispatcher'))
  with check (public.has_role('admin','manager','dispatcher'));
create policy insert_events on public.shipment_events for insert to authenticated
  with check (public.is_staff() and public.app_role() <> 'viewer' and created_by = auth.uid());

-- issues
create policy insert_issues on public.issues for insert to authenticated
  with check (public.has_role('admin','manager','dispatcher','receiver','delivery'));
create policy update_issues on public.issues for update to authenticated
  using (public.has_role('admin','manager','receiver'))
  with check (public.has_role('admin','manager','receiver'));

-- ---------------------------------------------------------------------
-- 8. Proof-of-delivery photos (private storage bucket)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('pod-photos', 'pod-photos', false)
on conflict (id) do nothing;

drop policy if exists pod_read   on storage.objects;
drop policy if exists pod_insert on storage.objects;
create policy pod_read on storage.objects for select to authenticated
  using (bucket_id = 'pod-photos' and public.is_staff());
create policy pod_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'pod-photos' and public.has_role('admin','manager','receiver','delivery'));

-- ---------------------------------------------------------------------
-- 9. Live updates
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['shipments','trips','trucks','issues','trip_stop_logs'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 10. Starting data
-- ---------------------------------------------------------------------
insert into public.trucks (code, model) values
  ('CJ-01','10-wheeler'), ('CJ-02','10-wheeler'), ('CJ-03','10-wheeler'),
  ('CJ-04','10-wheeler'), ('CJ-05','10-wheeler')
on conflict (code) do nothing;

insert into public.route_stops (name, seq, kind) values
  ('Manila', 0, 'origin'),
  ('Vigan', 100, 'final')
on conflict (name) do nothing;

insert into public.delivery_vehicles (name, kind) values
  ('Elf Truck', 'Elf truck'),
  ('Korong-korong', 'Korong-korong')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- 11. Per-item freight (same as supabase/002_item_rates.sql)
-- ---------------------------------------------------------------------
alter table public.shipment_items add column if not exists size_package text;
alter table public.shipment_items add column if not exists rate numeric(12,2) not null default 0 check (rate >= 0);
alter table public.shipment_items add column if not exists amount numeric(12,2)
  generated always as (round(qty * rate, 2)) stored;

alter table public.shipments add column if not exists other_charges numeric(12,2) not null default 0 check (other_charges >= 0);
alter table public.shipments add column if not exists other_charges_note text;

-- Shipments registered before this update keep their old total:
-- their whole freight becomes "other charges" until someone edits them.
update public.shipments s
   set other_charges = s.freight_charge
 where s.other_charges = 0
   and s.freight_charge > 0
   and not exists (select 1 from public.shipment_items i where i.shipment_id = s.id and i.rate > 0);

create or replace function public.recompute_freight(p_shipment uuid) returns void
language sql security definer set search_path = public as $$
  update public.shipments s
     set freight_charge = coalesce((select sum(i.amount) from public.shipment_items i where i.shipment_id = s.id), 0) + s.other_charges
   where s.id = p_shipment
$$;

create or replace function public.items_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') then perform public.recompute_freight(old.shipment_id); end if;
  if tg_op in ('INSERT','UPDATE') then perform public.recompute_freight(new.shipment_id); end if;
  return null;
end $$;

drop trigger if exists shipment_items_freight on public.shipment_items;
create trigger shipment_items_freight after insert or update or delete on public.shipment_items
  for each row execute function public.items_changed();

create or replace function public.shipment_freight_total() returns trigger
language plpgsql as $$
begin
  new.freight_charge := coalesce((select sum(i.amount) from public.shipment_items i where i.shipment_id = new.id), 0) + new.other_charges;
  return new;
end $$;

drop trigger if exists shipments_freight_total on public.shipments;
create trigger shipments_freight_total before insert or update of other_charges, freight_charge on public.shipments
  for each row execute function public.shipment_freight_total();

-- ---------------------------------------------------------------------
-- 12. Two-way trips (same as supabase/003_two_way_trips.sql)
-- ---------------------------------------------------------------------
-- 1. Direction on trips and shipments
alter table public.trips add column if not exists direction text not null default 'northbound'
  check (direction in ('northbound','southbound'));
alter table public.shipments add column if not exists direction text not null default 'northbound'
  check (direction in ('northbound','southbound'));
create index if not exists shipments_direction_idx on public.shipments(direction, status);

-- 2. "At Vigan" becomes "Arrived" (at whichever end terminal the trip runs to)
alter table public.trips drop constraint if exists trips_status_check;
update public.trips set status = 'Arrived' where status = 'At Vigan';
alter table public.trips add constraint trips_status_check
  check (status in ('Loading','On the road','Arrived','Closed'));

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'trips' and column_name = 'arrived_vigan_at') then
    alter table public.trips rename column arrived_vigan_at to arrived_at;
  end if;
end $$;

-- 3. Bays and delivery vehicles belong to a terminal
--    'origin' = the route's origin stop (Manila), 'final' = the final stop (Vigan)
alter table public.warehouse_bays add column if not exists terminal text not null default 'final'
  check (terminal in ('origin','final'));
alter table public.warehouse_bays drop constraint if exists warehouse_bays_name_key;
create unique index if not exists warehouse_bays_terminal_name on public.warehouse_bays(terminal, name);

alter table public.delivery_vehicles add column if not exists terminal text not null default 'final'
  check (terminal in ('origin','final'));

-- 4. Cargo can only go on a trip running the same direction
create or replace function public.check_trip_direction() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.trip_id is not null
     and exists (select 1 from public.trips t where t.id = new.trip_id and t.direction <> new.direction) then
    raise exception 'Shipment % runs the other direction from this trip.', new.tracking_no;
  end if;
  return new;
end $$;

drop trigger if exists shipments_trip_direction on public.shipments;
create trigger shipments_trip_direction before insert or update of trip_id, direction on public.shipments
  for each row execute function public.check_trip_direction();

-- 5. Trip actions for both directions
create or replace function public.trip_terminal(p_direction text, p_which text) returns text
language sql stable security definer set search_path = public as $$
  select name from public.route_stops
   where kind = case when (p_direction = 'southbound') = (p_which = 'start') then 'final' else 'origin' end
   limit 1
$$;

create or replace function public.depart_trip(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare t public.trips;
begin
  select * into t from public.trips where id = p_trip for update;
  if not found then raise exception 'Trip not found.'; end if;
  if t.status <> 'Loading' then raise exception 'Trip % has already departed.', t.trip_no; end if;
  if t.driver_confirmed_at is null or t.pahinante_confirmed_at is null or t.checker_confirmed_at is null then
    raise exception 'Driver, pahinante and checker must all confirm the manifest first.';
  end if;
  if not exists (select 1 from public.shipments where trip_id = p_trip and status = 'LOAD') then
    raise exception 'The manifest is empty. Load cargo before departure.';
  end if;
  update public.trips set status = 'On the road', departed_at = now(), departed_by = auth.uid() where id = p_trip;
  update public.shipments set status = 'TRANSIT' where trip_id = p_trip and status = 'LOAD';
  update public.trucks set status = 'On trip' where id = t.truck_id;
  insert into public.trip_stop_logs (trip_id, stop_name)
    values (p_trip, public.trip_terminal(t.direction, 'start'));
end $$;

drop function if exists public.arrive_vigan(uuid);
create or replace function public.arrive_terminal(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v_dir text;
begin
  update public.trips set status = 'Arrived', arrived_at = now()
   where id = p_trip and status = 'On the road'
   returning direction into v_dir;
  if v_dir is null then raise exception 'Only a trip on the road can be marked as arrived.'; end if;
  insert into public.trip_stop_logs (trip_id, stop_name)
    values (p_trip, public.trip_terminal(v_dir, 'end'));
end $$;

create or replace function public.close_trip(p_trip uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v_truck uuid;
begin
  if exists (select 1 from public.shipments where trip_id = p_trip and status in ('LOAD','TRANSIT')) then
    raise exception 'Some cargo on this trip is not yet released or received.';
  end if;
  update public.trips set status = 'Closed', closed_at = now()
   where id = p_trip and status = 'Arrived' returning truck_id into v_truck;
  if v_truck is null then raise exception 'Only a trip that has arrived can be closed.'; end if;
  update public.trucks set status = 'Available' where id = v_truck and status = 'On trip';
end $$;
