-- =====================================================================
-- CJ TRUCKING SERVICES — update 002: freight charged per item / per box
-- Run ONCE in Supabase → SQL Editor (after schema.sql). Safe to re-run.
--
-- Each item line now has its own size/package and rate:
--   line amount = qty × rate
--   shipment freight = sum of line amounts + other charges
-- The database keeps the shipment total in step automatically.
-- =====================================================================

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
