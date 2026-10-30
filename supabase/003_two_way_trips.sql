-- =====================================================================
-- CJ TRUCKING SERVICES — update 003: two-way trips (Manila ⇄ Vigan)
-- Run ONCE in Supabase → SQL Editor (after 002). Safe to re-run.
--
-- Trips and shipments now have a direction:
--   northbound = Manila → Vigan (all existing records)
--   southbound = Vigan → Manila (return / backload cargo)
-- A trip runs the route stops in order (northbound) or in reverse (southbound).
-- Warehouse bays and delivery vehicles now belong to a terminal.
-- =====================================================================

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
