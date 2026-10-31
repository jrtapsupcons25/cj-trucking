// Rabara JRCJ Freight Services — operations web app
// Static front end (GitHub Pages) + Supabase (auth, Postgres with row level security, storage, realtime).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import {
  TZ, esc, $, $$, peso, qtyFmt, fDate, fDT, todayISO, nowLocalInput, toLocalInput, daysUntil,
  pill, ICON, logo, toast, openModal, closeModal, modalOpen, downloadCSV, armed,
} from './lib.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STATUS = {
  REG: ['Registered', 'gray'], LOAD: ['Loaded', 'gold'], TRANSIT: ['In transit', 'blue'],
  RELEASED: ['Released en route', 'green'], RECEIVED: ['In warehouse', 'navy'],
  OUT: ['Out for delivery', 'orange'], DELIVERED: ['Delivered', 'green'], PICKUP: ['Picked up', 'green'],
};
const DONE = ['RELEASED', 'DELIVERED', 'PICKUP'];
const TRIP_TONE = { 'Loading': 'gold', 'On the road': 'blue', 'Arrived': 'navy', 'Closed': 'gray' };
const DIRS = ['northbound', 'southbound'];
const UNITS = ['pc', 'box', 'carton', 'sack', 'bag', 'bundle', 'roll', 'pail', 'drum', 'crate', 'pallet', 'set'];
const ROLES = {
  admin: 'Administrator', manager: 'Operations manager', dispatcher: 'Dispatcher',
  receiver: 'Receiver', delivery: 'Delivery', accounting: 'Accounting', viewer: 'Viewer', pending: 'Pending approval',
};
const CAN = {
  register: ['admin', 'manager', 'dispatcher'],
  dispatch: ['admin', 'manager', 'dispatcher'],
  unload: ['admin', 'manager', 'dispatcher', 'receiver'],
  receive: ['admin', 'manager', 'receiver'],
  deliver: ['admin', 'manager', 'receiver', 'delivery'],
  resolve: ['admin', 'manager', 'receiver'],
  fleet: ['admin', 'manager'],
  paid: ['admin', 'manager', 'accounting'],
  crew: ['admin', 'manager', 'dispatcher'],
  settings: ['admin', 'manager'],
  admin: ['admin'],
};
const NAV = [
  { id: 'dashboard', label: 'Dashboard', group: 'Overview' },
  { id: 'shipments', label: 'Shipments', group: 'Freight flow' },
  { id: 'dispatch', label: 'Dispatch & loading', group: 'Freight flow' },
  { id: 'unloading', label: 'En-route releases', group: 'Freight flow' },
  { id: 'receiving', label: 'Receiving', group: 'Freight flow' },
  { id: 'delivery', label: 'Delivery', group: 'Freight flow' },
  { id: 'fleet', label: 'Fleet', group: 'Management' },
  { id: 'reports', label: 'Reports', group: 'Management' },
  { id: 'users', label: 'Users & settings', group: 'Management' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  session: null, me: null,
  profiles: [], trucks: [], crew: [], stops: [], bays: [], vehicles: [],
  trips: [], shipments: [], issues: [], maint: [],
  loaded: false, loading: false, loadError: '',
  ui: { q: '', status: 'active', dir: 'all', period: 'month', lastDir: '' },
  report: { period: null, data: null, loading: false },
};

try { S.ui.lastDir = localStorage.getItem('cj.lastDir') || ''; } catch { /* storage blocked */ }

const cfg = window.CJ_CONFIG || {};
const configured = /^https:\/\/.+/.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_KEY && !/PASTE_/.test(cfg.SUPABASE_KEY);
const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY) : null;

const can = (k) => !!S.me && CAN[k].includes(S.me.role);
const uid = () => S.session?.user?.id || null;
const personName = (id) => { if (!id) return '—'; const p = S.profiles.find((x) => x.id === id); return p ? (p.full_name || p.email || 'Staff') : 'Staff'; };
const truckOf = (id) => S.trucks.find((t) => t.id === id);
const tripOf = (id) => S.trips.find((t) => t.id === id);
const shipOf = (id) => S.shipments.find((s) => s.id === id);
const qtyOf = (s) => (s.shipment_items || []).reduce((a, i) => a + Number(i.qty || 0), 0);
const itemsText = (s) => (s.shipment_items || []).map((i) => `${qtyFmt(i.qty)} ${i.unit} ${i.description}${i.size_package ? ` (${i.size_package})` : ''}`).join(', ');
const statusPill = (code) => pill(...(STATUS[code] || [code, 'gray']));
const manilaDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }) : '';
const monthStart = (offset = 0) => { const [y, m] = todayISO().split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + offset, 1)); return d.toISOString().slice(0, 10); };
// Direction helpers. Route stops are stored in Manila → Vigan order:
// kind 'origin' = Manila, kind 'final' = Vigan. Northbound trips run them in order, southbound in reverse.
const dirOf = (x) => (x && x.direction) || 'northbound';
const terminalKind = (dir, which) => ((dir === 'southbound') === (which === 'start') ? 'final' : 'origin');
const stopByKind = (k) => S.stops.find((x) => x.kind === k)?.name || (k === 'origin' ? 'Manila' : 'Vigan');
const startOf = (dir) => stopByKind(terminalKind(dir, 'start'));
const endOf = (dir) => stopByKind(terminalKind(dir, 'end'));
const routeFor = (dir) => { const n = S.stops.map((x) => x.name); return dir === 'southbound' ? n.reverse() : n; };
const dirLabel = (dir) => `${startOf(dir)} → ${endOf(dir)}`;
const dirTag = (dir) => `<span class="dir${dir === 'southbound' ? ' s' : ''}">${esc(dirLabel(dir))}</span>`;
const destOptions = (dir, cur) => routeFor(dir).slice(1).map((d) => `<option ${d === (cur || endOf(dir)) ? 'selected' : ''}>${esc(d)}</option>`).join('');
const manifest = (tripId) => S.shipments.filter((x) => x.trip_id === tripId);
const reachedIdx = (trip) => {
  const names = routeFor(dirOf(trip));
  if (trip.status === 'Arrived' || trip.status === 'Closed') return names.length - 1;
  let idx = 0;
  (trip.trip_stop_logs || []).forEach((l) => { const i = names.indexOf(l.stop_name); if (i > idx) idx = i; });
  return idx;
};
const lastTrip = (truckId) => S.trips.filter((x) => x.truck_id === truckId).sort((a, b) => (b.created_at > a.created_at ? 1 : -1))[0];
const truckWhere = (t) => {
  const l = lastTrip(t.id);
  if (!l) return 'location not recorded';
  if (l.status === 'Loading') return `loading at ${startOf(dirOf(l))}`;
  if (l.status === 'On the road') return 'on the road';
  return `at ${endOf(dirOf(l))}`;
};
// A truck parked in Vigan most likely loads return cargo for Manila next.
const suggestDir = (t) => { const l = lastTrip(t.id); return l && l.status !== 'Loading' && terminalKind(dirOf(l), 'end') === 'final' ? 'southbound' : 'northbound'; };
const dirSelect = (id, name, cur, extra = '') => `<select id="${id}" name="${name}" ${extra}>${DIRS.map((d) => `<option value="${d}" ${d === cur ? 'selected' : ''}>${esc(dirLabel(d))}</option>`).join('')}</select>`;
const termSelect = (id, cur = 'final') => `<label class="f">Terminal<select id="${id}" name="terminal">${['final', 'origin'].map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(stopByKind(k))}</option>`).join('')}</select></label>`;
const truckLabel = (t) => t ? `${t.code}${t.plate_no ? ' · ' + t.plate_no : ''}` : '—';

function friendly(e) {
  const m = e?.message || String(e);
  if (/row-level security|permission denied|violates row-level/i.test(m)) return 'Your role does not allow this action. Ask an administrator.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Check the internet and try again.';
  return m;
}
async function run(q, ok) {
  const { data, error } = await q;
  if (error) { toast(friendly(error), 'err'); return null; }
  if (ok) toast(ok);
  return data ?? true;
}
const need = (fd, fields) => {
  const missing = fields.filter(([n]) => !String(fd.get(n) || '').trim()).map(([, l]) => l);
  if (missing.length) { toast('Please fill in: ' + missing.join(', '), 'err'); return false; }
  return true;
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadAll() {
  if (!sb || !S.session) return;
  S.loading = true;
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const res = await Promise.all([
    sb.from('profiles').select('*').order('full_name'),
    sb.from('trucks').select('*').order('code'),
    sb.from('crew').select('*').order('full_name'),
    sb.from('route_stops').select('*').order('seq'),
    sb.from('warehouse_bays').select('*').order('name'),
    sb.from('delivery_vehicles').select('*').order('name'),
    sb.from('trips').select('*, trip_stop_logs(*)').or(`status.neq.Closed,closed_at.gte.${since}`).order('created_at', { ascending: false }),
    sb.from('shipments').select('*, shipment_items(*)').or(`status.in.(REG,LOAD,TRANSIT,RECEIVED,OUT),created_at.gte.${since}`).order('created_at', { ascending: false }).limit(3000),
    sb.from('issues').select('*').or(`resolved.eq.false,reported_at.gte.${since}`).order('reported_at', { ascending: false }),
    sb.from('maintenance_logs').select('*').order('log_date', { ascending: false }).limit(400),
  ]);
  S.loading = false;
  const err = res.find((r) => r.error);
  if (err) { S.loadError = friendly(err.error); render(); return; }
  [S.profiles, S.trucks, S.crew, S.stops, S.bays, S.vehicles, S.trips, S.shipments, S.issues, S.maint] = res.map((r) => r.data || []);
  S.me = S.profiles.find((p) => p.id === uid()) || S.me;
  S.loaded = true; S.loadError = '';
  render();
}
let reloadTimer = null;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 500); };
let channel = null;
function subscribeLive() {
  if (channel || !sb) return;
  channel = sb.channel('cj-ops')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trucks' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_stop_logs' }, scheduleReload)
    .subscribe();
}

// ---------------------------------------------------------------------------
// Shell & routing
// ---------------------------------------------------------------------------
const route = () => { const h = location.hash.replace('#', ''); return NAV.some((n) => n.id === h) ? h : 'dashboard'; };

function navCounts() {
  return {
    shipments: S.shipments.filter((s) => s.status === 'REG').length,
    dispatch: S.trips.filter((t) => t.status === 'Loading').length,
    unloading: S.trips.filter((t) => t.status === 'On the road').length,
    receiving: S.trips.filter((t) => t.status === 'Arrived').length + S.issues.filter((i) => !i.resolved).length,
    delivery: S.shipments.filter((s) => s.status === 'RECEIVED' || s.status === 'OUT').length,
    users: can('admin') ? S.profiles.filter((p) => p.role === 'pending').length : 0,
  };
}

function shell() {
  const cur = route(); const counts = navCounts(); let group = '';
  const links = NAV.map((n) => {
    const head = n.group !== group ? `<div class="nav-label">${esc((group = n.group))}</div>` : '';
    const c = counts[n.id] ? `<span class="count">${counts[n.id]}</span>` : '';
    return `${head}<a href="#${n.id}" ${n.id === cur ? 'aria-current="page"' : ''}>${ICON[n.id]}<span>${esc(n.label)}</span>${c}</a>`;
  }).join('');
  return `<div class="app">
    <aside class="side">
      <a class="brand" href="#dashboard">${logo(56)}<span><span class="brand-name">RABARA JRCJ</span><br><span class="brand-sub">Freight Services</span></span></a>
      <div class="livery" aria-hidden="true"></div>
      <nav class="nav" aria-label="Main">${links}</nav>
      <div class="side-foot">
        <div class="managed">Managed by<strong>Emilia Rabara</strong></div>
        <div class="who"><span><strong>${esc(S.me?.full_name || S.session?.user?.email || '')}</strong>${esc(ROLES[S.me?.role] || '')}</span>
          <button class="linkbtn" data-act="signOut">Sign out</button></div>
      </div>
    </aside>
    <main class="main" id="main"><div class="wrap" id="view"></div></main>
  </div>`;
}

let shellMounted = false;
function render() {
  const root = $('#root');
  if (!configured) { shellMounted = false; root.innerHTML = setupView(); return; }
  if (!S.session) { shellMounted = false; root.innerHTML = authView(); return; }
  if (S.recovery) { shellMounted = false; root.innerHTML = recoveryView(); return; }
  if (S.loaded && (!S.me || S.me.role === 'pending' || !S.me.active)) { shellMounted = false; root.innerHTML = pendingView(); return; }
  // keep focus & caret across re-renders (search boxes, filters)
  const a = document.activeElement; const fid = a && a.id && $('#view')?.contains(a) ? a.id : null;
  let caret = null; try { caret = fid ? a.selectionStart : null; } catch { /* not a text field */ }
  root.innerHTML = shell(); shellMounted = true;
  const v = $('#view');
  if (!S.loaded) {
    v.innerHTML = S.loadError ? `<div class="note bad">${esc(S.loadError)} <button class="btn sm" data-act="reload">Try again</button></div>` : '<div class="loading-bar"></div><p class="muted">Loading operations data…</p>';
    return;
  }
  v.innerHTML = (VIEWS[route()] || VIEWS.dashboard)();
  document.title = `${NAV.find((n) => n.id === route())?.label || 'Dashboard'} · Rabara JRCJ Freight Services`;
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch { /* select */ } } }
}

const head = (eyebrow, title, desc, actions = '') => `<header class="pagehead"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</header>`;
const empty = (title, text, action = '') => `<div class="empty"><strong>${esc(title)}</strong><span>${text}</span>${action}</div>`;
const routeBar = (trip) => {
  const idx = reachedIdx(trip); const names = routeFor(dirOf(trip));
  const loading = trip.status === 'Loading';
  return `<div class="route" role="img" aria-label="Route progress: ${esc(loading ? 'loading at ' + names[0] : 'reached ' + names[idx])}">${names.map((n, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'here' : '';
    return `<div class="stop ${cls}"><span class="dot"></span><span>${esc(n)}</span></div>`;
  }).join('')}</div>`;
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const VIEWS = {};

VIEWS.dashboard = () => {
  const m0 = monthStart();
  const month = S.shipments.filter((s) => manilaDate(s.created_at) >= m0);
  const monthN = month.filter((s) => dirOf(s) === 'northbound').length;
  const onRoad = S.trips.filter((t) => t.status === 'On the road');
  const loading = S.trips.filter((t) => t.status === 'Loading');
  const arrived = S.trips.filter((t) => t.status === 'Arrived');
  const out = S.shipments.filter((s) => s.status === 'OUT');
  const inWh = S.shipments.filter((s) => s.status === 'RECEIVED');
  const completed = S.shipments.filter((s) => DONE.includes(s.status) && manilaDate(s.delivered_at || s.released_at) >= m0);
  const toReconcile = S.shipments.filter((s) => s.status === 'TRANSIT' && arrived.some((t) => t.id === s.trip_id)).length;
  const active = S.trips.filter((t) => t.status !== 'Closed');
  const split = (list, which) => DIRS.map((d) => `${esc(stopByKind(terminalKind(d, which)))} ${list.filter((t) => dirOf(t) === d).length}`).join(' · ');

  const kpi = (href, label, val, sub, hl = false) => `<a class="kpi${hl ? ' hl' : ''}" href="#${href}"><span class="k-label">${label}</span><span class="k-val">${val}</span><span class="k-sub">${sub}</span></a>`;
  const kpis = `<section class="kpis" aria-label="Today at a glance">
    ${kpi('shipments', 'Shipments this month', month.length, `${monthN} to ${esc(endOf('northbound'))} · ${month.length - monthN} to ${esc(endOf('southbound'))}<br>${peso(month.reduce((a, s) => a + Number(s.freight_charge), 0))} freight`)}
    ${kpi('fleet', 'Trucks on the road', `${onRoad.length}<small style="font-size:18px;opacity:.7"> / ${S.trucks.length}</small>`, onRoad.map((t) => truckOf(t.truck_id)?.code).join(', ') || 'All trucks parked', true)}
    ${kpi('dispatch', 'Loading', loading.length, `At ${split(loading, 'start')}`)}
    ${kpi('receiving', 'Arrived, unloading', arrived.length, `${split(arrived, 'end')} · ${toReconcile} to reconcile`)}
    ${kpi('delivery', 'Out for delivery', out.length, `${inWh.length} waiting in warehouses`)}
    ${kpi('reports', 'Completed releases', completed.length, `${completed.filter((s) => s.status === 'DELIVERED').length} delivered · ${completed.filter((s) => s.status === 'RELEASED').length} en route · ${completed.filter((s) => s.status === 'PICKUP').length} pickup`)}
  </section>`;

  const lanes = active.length ? active.map((t) => {
    const m = manifest(t.id); const tr = truckOf(t.truck_id);
    return `<div class="lane"><div class="lane-top"><span class="mono">${esc(t.trip_no)}</span><strong>${esc(tr?.code || '')}</strong>${dirTag(dirOf(t))}
      <span class="grow muted small">${esc(t.driver)}${t.pahinante ? ' · ' + esc(t.pahinante) : ''} · ${m.length} shipments · ${qtyFmt(m.reduce((a, s) => a + qtyOf(s), 0))} pcs</span>
      ${pill(t.status, TRIP_TONE[t.status])}</div>${routeBar(t)}</div>`;
  }).join('') : empty('No trucks on a trip right now', 'Start one from Dispatch &amp; loading.', can('dispatch') ? '<a class="btn primary" href="#dispatch">Go to dispatch</a>' : '');

  // attention list
  const alerts = [];
  S.issues.filter((i) => !i.resolved).slice(0, 6).forEach((i) => {
    const s = shipOf(i.shipment_id);
    alerts.push(`<li><a href="#" data-act="openShipment" data-id="${esc(i.shipment_id)}">${pill(i.kind, 'red')}</a> <span class="mono">${esc(s?.tracking_no || '')}</span> ${esc(i.description)}</li>`);
  });
  S.trucks.forEach((t) => {
    const d = daysUntil(t.next_pms_date);
    if (d != null && d <= 7) alerts.push(`<li>${pill(d < 0 ? 'PMS overdue' : 'PMS due', d < 0 ? 'red' : 'orange')} <strong>${esc(t.code)}</strong> ${d < 0 ? `${-d} days overdue` : d === 0 ? 'due today' : `due in ${d} days`} (${fDate(t.next_pms_date)})</li>`);
  });
  const unpaid = S.shipments.filter((s) => s.payment_terms === 'Collect' && !s.paid && DONE.includes(s.status));
  if (unpaid.length) alerts.push(`<li>${pill('Collect', 'gold')} ${unpaid.length} completed shipments with unpaid freight · <strong>${peso(unpaid.reduce((a, s) => a + Number(s.freight_charge), 0))}</strong></li>`);
  const stale = S.shipments.filter((s) => s.status === 'REG' && (Date.now() - new Date(s.created_at)) > 3 * 864e5);
  if (stale.length) alerts.push(`<li>${pill('Waiting', 'gray')} ${stale.length} shipments registered over 3 days ago are not yet loaded</li>`);

  const recent = S.shipments.slice(0, 8);
  return `${head('Operations overview', 'Dashboard', `Live view of freight between ${esc(stopByKind('origin'))} and ${esc(stopByKind('final'))}, both directions. Updated ${fDT(new Date().toISOString())}.`,
    can('register') ? `<button class="btn primary" data-act="newShipment">${ICON.plus} Register cargo</button>` : '')}
    ${kpis}
    <section class="card"><div class="card-h"><div><h2>Trucks and trips</h2><p>Where each active trip is on the route, in either direction</p></div><a class="btn sm" href="#dispatch">Dispatch</a></div>${lanes}</section>
    <div class="grid2">
      <section class="card"><div class="card-h"><h2>Latest shipments</h2><a class="btn sm" href="#shipments">All shipments</a></div>
        ${recent.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking</th><th>Consignee</th><th>Dest.</th><th>Status</th></tr></thead><tbody>
        ${recent.map((s) => `<tr class="click" data-act="openShipment" data-id="${s.id}"><td><span class="mono">${esc(s.tracking_no)}</span><span class="sub">${fDate(s.created_at)}</span></td><td>${esc(s.consignee_name)}</td><td>${esc(s.destination)}</td><td>${statusPill(s.status)}</td></tr>`).join('')}
        </tbody></table></div>` : empty('No shipments yet', 'Registered cargo will appear here.')}
      </section>
      <div style="display:grid;gap:20px">
        <section class="card"><div class="card-h"><h2>Needs attention</h2></div><div class="card-b">
          ${alerts.length ? `<ul style="margin:0;padding-left:0;list-style:none;display:grid;gap:10px">${alerts.join('')}</ul>` : '<p class="muted" style="margin:0">Nothing needs attention. No open shortages, damages or overdue maintenance.</p>'}
        </div></section>
        <section class="card"><div class="card-h"><h2>Fleet status</h2><a class="btn sm" href="#fleet">Fleet</a></div>
          <div class="tbl-wrap"><table class="tbl"><tbody>${S.trucks.map((t) => {
            const tone = { 'Available': 'green', 'Loading': 'gold', 'On trip': 'blue', 'Under maintenance': 'orange' }[t.status] || 'gray';
            return `<tr><td><strong>${esc(t.code)}</strong><span class="sub">${esc(t.plate_no || 'Plate not set')}</span></td><td>${esc(t.default_driver || '—')}</td><td class="num">${pill(t.status, tone)}</td></tr>`;
          }).join('')}</tbody></table></div></section>
      </div>
    </div>`;
};

VIEWS.shipments = () => {
  const q = S.ui.q.trim().toLowerCase(); const f = S.ui.status;
  let list = S.shipments;
  if (f === 'active') list = list.filter((s) => !DONE.includes(s.status));
  else if (f === 'done') list = list.filter((s) => DONE.includes(s.status));
  else if (f === 'unpaid') list = list.filter((s) => s.payment_terms === 'Collect' && !s.paid);
  else if (f !== 'all') list = list.filter((s) => s.status === f);
  if (S.ui.dir !== 'all') list = list.filter((s) => dirOf(s) === S.ui.dir);
  if (q) list = list.filter((s) => [s.tracking_no, s.shipper_name, s.consignee_name, s.destination, s.consignee_contact, itemsText(s)].join(' ').toLowerCase().includes(q));
  const opts = [['active', 'Active (not yet completed)'], ['all', 'All statuses'], ...Object.entries(STATUS).map(([k, v]) => [k, v[0]]), ['done', 'Completed'], ['unpaid', 'Collect – unpaid']];
  return `${head('Freight', 'Shipments', 'Every consignment gets a tracking number when it is registered at the Manila or Vigan terminal.',
    can('register') ? `<button class="btn primary" data-act="newShipment">${ICON.plus} Register cargo</button>` : '')}
    <section class="card"><div class="card-h" style="border:0"><div class="toolbar" style="flex:1">
      <input type="search" id="q-ship" data-filter="q" placeholder="Search tracking no., shipper, consignee, item…" value="${esc(S.ui.q)}" aria-label="Search shipments">
      <select id="f-status" data-chg="fstatus" aria-label="Filter by status">${opts.map(([v, l]) => `<option value="${v}" ${v === f ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select id="f-dir" data-chg="fdir" aria-label="Filter by direction"><option value="all">Both directions</option>${DIRS.map((d) => `<option value="${d}" ${d === S.ui.dir ? 'selected' : ''}>${esc(dirLabel(d))}</option>`).join('')}</select>
    </div></div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Shipper → Consignee</th><th>Destination</th><th class="num">Qty</th><th class="num">Freight</th><th>Status</th></tr></thead><tbody>
      ${list.slice(0, 300).map((s) => `<tr class="click" data-act="openShipment" data-id="${s.id}">
        <td><span class="mono">${esc(s.tracking_no)}</span><span class="sub">${fDate(s.created_at)}</span></td>
        <td>${esc(s.shipper_name)} → <strong>${esc(s.consignee_name)}</strong><span class="sub">${esc(itemsText(s).slice(0, 90))}</span></td>
        <td>${esc(s.destination)}<span class="sub">${esc(dirLabel(dirOf(s)))}</span></td>
        <td class="num">${qtyFmt(qtyOf(s))}</td>
        <td class="num">${peso(s.freight_charge)}<span class="sub">${s.payment_terms}${s.payment_terms === 'Collect' ? (s.paid ? ' · paid' : ' · unpaid') : ''}</span></td>
        <td>${statusPill(s.status)}</td></tr>`).join('')}
    </tbody></table></div>${list.length > 300 ? '<p class="muted small" style="padding:0 16px">Showing the first 300. Narrow the search to see more.</p>' : ''}`
    : empty(S.shipments.length ? 'No shipments match' : 'No shipments yet', S.shipments.length ? 'Try another search or status.' : 'Register the first cargo received at the Manila terminal.', !S.shipments.length && can('register') ? `<button class="btn primary" data-act="newShipment">${ICON.plus} Register cargo</button>` : '')}
    </section>
    <p class="muted small">Showing active shipments plus everything from the last 120 days. Older records are in Reports.</p>`;
};

VIEWS.dispatch = () => {
  const loading = S.trips.filter((t) => t.status === 'Loading');
  const waiting = S.shipments.filter((s) => s.status === 'REG');
  const tripCard = (t) => {
    const m = manifest(t.id); const tr = truckOf(t.truck_id); const dir = dirOf(t);
    const conf = (key, label) => {
      const at = t[`${key}_confirmed_at`]; const by = t[`${key}_confirmed_by`];
      return `<label class="check"><input type="checkbox" id="c-${key}-${t.id}" data-chg="confirm" data-trip="${t.id}" data-role="${key}" ${at ? 'checked' : ''} ${can('dispatch') ? '' : 'disabled'}>
        <span>${label}${at ? `<span class="sub muted small">Confirmed ${fDT(at)} · recorded by ${esc(personName(by))}</span>` : ''}</span></label>`;
    };
    const ready = m.length && t.driver_confirmed_at && t.pahinante_confirmed_at && t.checker_confirmed_at;
    return `<section class="card">
      <div class="card-h"><div><h2><span class="mono" style="font-size:15px">${esc(t.trip_no)}</span> · ${esc(truckLabel(tr))} ${dirTag(dir)}</h2>
        <p>Loading at ${esc(startOf(dir))} · Driver ${esc(t.driver)}${t.pahinante ? ` · Pahinante ${esc(t.pahinante)}${t.pahinante2 ? ', ' + esc(t.pahinante2) : ''}` : ''} · Planned departure ${fDT(t.planned_departure)}</p></div>
        ${can('dispatch') ? `<div class="actions"><button class="btn sm" data-act="addCargo" data-id="${t.id}">${ICON.plus} Load cargo</button>
          <button class="btn sm danger" data-act="cancelTrip" data-id="${t.id}" data-confirm="Tap again to cancel trip">Cancel trip</button></div>` : ''}</div>
      ${m.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Consignee</th><th>Drop-off</th><th>Items</th><th class="num">Qty</th>${can('dispatch') ? '<th></th>' : ''}</tr></thead><tbody>
        ${m.map((s) => `<tr><td class="mono">${esc(s.tracking_no)}</td><td>${esc(s.consignee_name)}</td><td>${esc(s.destination)}</td><td>${esc(itemsText(s))}</td><td class="num">${qtyFmt(qtyOf(s))}</td>
          ${can('dispatch') ? `<td class="num"><button class="iconbtn" data-act="unloadCargo" data-id="${s.id}" aria-label="Remove ${esc(s.tracking_no)} from manifest">${ICON.x}</button></td>` : ''}</tr>`).join('')}
        <tr><td colspan="4"><strong>Manifest total</strong> · ${m.length} shipments</td><td class="num"><strong>${qtyFmt(m.reduce((a, s) => a + qtyOf(s), 0))}</strong></td>${can('dispatch') ? '<td></td>' : ''}</tr>
      </tbody></table></div>` : empty('Manifest is empty', `Load registered cargo going ${esc(dirLabel(dir))} onto this truck.`)}
      <div class="card-b" style="border-top:1px solid var(--line);display:grid;gap:4px">
        <h3>Sign-off before departure</h3>
        <p class="muted small" style="margin:0 0 4px">Each person counts the cargo against the manifest. Changing the manifest clears the sign-offs.</p>
        ${conf('driver', `Driver <strong>${esc(t.driver)}</strong> counted and accepts the cargo`)}
        ${conf('pahinante', `Pahinante <strong>${esc(t.pahinante || '—')}</strong> counted and accepts the cargo`)}
        ${conf('checker', 'Checker confirms the manifest matches the truck')}
        ${can('dispatch') ? `<div class="actions" style="margin-top:8px"><button class="btn primary" data-act="depart" data-id="${t.id}" ${ready ? '' : 'disabled'}>${ICON.check} Confirm departure</button>
          ${ready ? '' : '<span class="muted small">Needs cargo and all three sign-offs.</span>'}</div>` : ''}
      </div></section>`;
  };
  const waitBlocks = DIRS.map((dir) => {
    const list = waiting.filter((s) => dirOf(s) === dir); if (!list.length) return '';
    const byDest = {}; list.forEach((s) => { (byDest[s.destination] ||= []).push(s); });
    return `<div class="lane"><div class="lane-top"><span class="grow">${dirTag(dir)} <span class="muted small">at ${esc(startOf(dir))} terminal</span></span><span class="muted small">${list.length} shipments · ${qtyFmt(list.reduce((a, s) => a + qtyOf(s), 0))} pcs</span></div>
      ${Object.entries(byDest).map(([d, l]) => `<div class="small"><strong>${esc(d)}</strong> · ${l.slice(0, 6).map((s) => `<a href="#" data-act="openShipment" data-id="${s.id}" class="mono">${esc(s.tracking_no)}</a>`).join(' · ')}${l.length > 6 ? ` · +${l.length - 6} more` : ''}</div>`).join('')}</div>`;
  }).join('');
  const recent = S.trips.filter((t) => t.status !== 'Loading').slice(0, 6);
  return `${head(`${stopByKind('origin')} & ${stopByKind('final')} terminals`, 'Dispatch & loading', 'Build each truck\'s manifest at the loading terminal, get driver and pahinante sign-off, then release the truck.',
    can('dispatch') ? `<button class="btn primary" data-act="newTrip">${ICON.plus} New trip</button>` : '')}
    ${loading.length ? loading.map(tripCard).join('') : `<section class="card">${empty('No truck is loading', 'Create a trip to start a manifest.', can('dispatch') ? `<button class="btn primary" data-act="newTrip">${ICON.plus} New trip</button>` : '')}</section>`}
    <div class="grid2">
      <section class="card"><div class="card-h"><div><h2>Waiting to be loaded</h2><p>${waiting.length} registered shipments · ${qtyFmt(waiting.reduce((a, s) => a + qtyOf(s), 0))} pcs</p></div></div>
        ${waiting.length ? waitBlocks : empty('Nothing waiting', 'All registered cargo is on a manifest.')}
      </section>
      <section class="card"><div class="card-h"><h2>Recent trips</h2></div>
        ${recent.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Trip</th><th>Truck</th><th>Departed</th><th>Status</th></tr></thead><tbody>
        ${recent.map((t) => `<tr><td><span class="mono">${esc(t.trip_no)}</span><span class="sub">${esc(dirLabel(dirOf(t)))}</span></td><td>${esc(truckOf(t.truck_id)?.code || '')}<span class="sub">${esc(t.driver)}</span></td><td>${fDT(t.departed_at)}</td><td>${pill(t.status, TRIP_TONE[t.status])}</td></tr>`).join('')}
        </tbody></table></div>` : empty('No trips yet', 'Departed trips show here.')}
      </section>
    </div>`;
};

VIEWS.unloading = () => {
  const trips = S.trips.filter((t) => t.status === 'On the road');
  const inter = S.stops.filter((s) => s.kind === 'stop');
  const card = (t) => {
    const tr = truckOf(t.truck_id); const dir = dirOf(t); const names = routeFor(dir); const idx = reachedIdx(t); const end = endOf(dir);
    const next = names[idx + 1]; const nextIsInter = next && next !== end;
    const m = manifest(t.id); const drops = m.filter((s) => s.destination !== end);
    const onward = m.filter((s) => s.destination === end).length;
    return `<section class="card"><div class="card-h"><div><h2><span class="mono" style="font-size:15px">${esc(t.trip_no)}</span> · ${esc(truckLabel(tr))} ${dirTag(dir)}</h2>
      <p>Departed ${esc(startOf(dir))} ${fDT(t.departed_at)} · Driver ${esc(t.driver)}</p></div>
      ${nextIsInter && can('unload') ? `<button class="btn sm dark" data-act="arriveStop" data-id="${t.id}" data-stop="${esc(next)}">${ICON.unloading} Arrived at ${esc(next)}</button>` : ''}</div>
      <div class="card-b">${routeBar(t)}</div>
      ${drops.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Consignee</th><th>Drop-off</th><th class="num">Manifest qty</th><th>Status</th><th></th></tr></thead><tbody>
        ${drops.map((s) => `<tr><td class="mono">${esc(s.tracking_no)}</td><td>${esc(s.consignee_name)}<span class="sub">${esc(s.consignee_contact || '')}</span></td><td>${esc(s.destination)}</td><td class="num">${qtyFmt(qtyOf(s))}</td>
          <td>${statusPill(s.status)}${s.status === 'RELEASED' ? `<span class="sub">${qtyFmt(s.release_qty)} to ${esc(s.release_received_by)} · ${fDT(s.released_at)}</span>` : ''}</td>
          <td class="num">${s.status === 'TRANSIT' && can('unload') ? `<button class="btn sm primary" data-act="release" data-id="${s.id}">Record release</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card-b muted">No drop-offs before ${esc(end)} on this trip.</div>`}
      <div class="card-b muted small" style="border-top:1px solid var(--line)">${onward} shipments continue to ${esc(end)}.</div></section>`;
  };
  return `${head('On the road', 'En-route releases', 'Record every partial unloading before the truck reaches its end terminal: who received the cargo, how many pieces, and in what condition.')}
    ${!inter.length ? `<div class="note">No drop-off stops are set up yet. Add them in <a href="#users">Users &amp; settings</a>. The same stops are used in both directions.</div>` : ''}
    ${trips.length ? trips.map(card).join('') : `<section class="card">${empty('No truck on the road', 'Trips appear here after departure from Dispatch.')}</section>`}`;
};

VIEWS.receiving = () => {
  const coming = S.trips.filter((t) => t.status === 'On the road');
  const here = S.trips.filter((t) => t.status === 'Arrived');
  const wh = S.shipments.filter((s) => s.status === 'RECEIVED');
  const issues = S.issues.slice().sort((a, b) => (a.resolved - b.resolved) || (b.reported_at > a.reported_at ? 1 : -1));
  const hereCard = (t) => {
    const dir = dirOf(t); const m = manifest(t.id); const pending = m.filter((s) => s.status === 'TRANSIT');
    return `<section class="card"><div class="card-h"><div><h2><span class="mono" style="font-size:15px">${esc(t.trip_no)}</span> · ${esc(truckLabel(truckOf(t.truck_id)))} ${dirTag(dir)}</h2>
      <p>Arrived in ${esc(endOf(dir))} ${fDT(t.arrived_at)} · ${pending.length} of ${m.length} shipments still to reconcile</p></div>
      ${can('receive') ? `<div class="actions">${pending.length ? `<button class="btn sm primary" data-act="reconcile" data-id="${t.id}">Reconcile cargo</button>` : ''}
        <button class="btn sm dark" data-act="closeTrip" data-id="${t.id}" ${pending.length ? 'disabled' : ''}>Close trip</button></div>` : ''}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Consignee</th><th class="num">Manifest</th><th class="num">Received</th><th>Bay</th><th>Status</th></tr></thead><tbody>
        ${m.map((s) => `<tr><td class="mono">${esc(s.tracking_no)}</td><td>${esc(s.consignee_name)}</td><td class="num">${qtyFmt(qtyOf(s))}</td>
          <td class="num">${s.received_qty != null ? qtyFmt(s.received_qty) : s.release_qty != null ? qtyFmt(s.release_qty) : '—'}</td><td>${esc(s.warehouse_bay || '')}</td>
          <td>${statusPill(s.status)}${s.received_condition && s.received_condition !== 'Good' ? ' ' + pill(s.received_condition, 'red') : ''}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  };
  const whBlocks = ['final', 'origin'].map((k) => {
    const list = wh.filter((s) => terminalKind(dirOf(s), 'end') === k); if (!list.length) return '';
    const bays = {}; list.forEach((s) => { const b = s.warehouse_bay || 'Unassigned'; (bays[b] ||= []).push(s); });
    return `<div class="lane"><div class="lane-top"><strong class="grow">${esc(stopByKind(k))} warehouse</strong><span class="muted small">${list.length} shipments</span></div>
      ${Object.entries(bays).map(([b, l]) => `<div class="small"><strong>${esc(b)}</strong> · ${qtyFmt(l.reduce((a, s) => a + Number(s.received_qty ?? qtyOf(s)), 0))} pcs: ${l.map((s) => `<a href="#" data-act="openShipment" data-id="${s.id}" class="mono">${esc(s.tracking_no)}</a> ${esc(s.consignee_name)}`).join(' · ')}</div>`).join('')}</div>`;
  }).join('');
  return `${head('Terminals', 'Receiving', `When a truck arrives in ${esc(stopByKind('final'))} or ${esc(stopByKind('origin'))}, check every piece against the manifest, report shortages and damage, and assign a warehouse bay.`)}
    ${coming.length ? `<section class="card"><div class="card-h"><h2>Trucks on the way</h2></div>
      <div class="tbl-wrap"><table class="tbl"><tbody>${coming.map((t) => { const dir = dirOf(t); return `<tr><td><span class="mono">${esc(t.trip_no)}</span><span class="sub">${esc(truckLabel(truckOf(t.truck_id)))} · ${esc(t.driver)}</span></td>
        <td>${dirTag(dir)}<span class="sub">Departed ${fDT(t.departed_at)} · last stop ${esc(routeFor(dir)[reachedIdx(t)] || startOf(dir))}</span></td>
        <td class="num">${can('receive') ? `<button class="btn sm dark" data-act="arriveTerminal" data-id="${t.id}" data-end="${esc(endOf(dir))}">Mark arrived in ${esc(endOf(dir))}</button>` : pill('On the road', 'blue')}</td></tr>`; }).join('')}</tbody></table></div></section>` : ''}
    ${here.length ? here.map(hereCard).join('') : `<section class="card">${empty('No truck unloading', 'When a truck arrives at its end terminal, mark it here to start reconciliation.')}</section>`}
    <div class="grid2">
      <section class="card"><div class="card-h"><div><h2>Warehouses</h2><p>${wh.length} shipments waiting for delivery or pickup</p></div><a class="btn sm" href="#delivery">Delivery</a></div>
        ${wh.length ? whBlocks : empty('Warehouses are clear', 'Received cargo appears here by terminal and bay.')}
      </section>
      <section class="card"><div class="card-h"><div><h2>Shortage &amp; damage reports</h2><p>${S.issues.filter((i) => !i.resolved).length} open</p></div></div>
        ${issues.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${issues.slice(0, 30).map((i) => {
          const s = shipOf(i.shipment_id);
          return `<tr><td>${pill(i.kind, i.resolved ? 'gray' : 'red')}<span class="sub">${fDT(i.reported_at)}</span></td>
            <td><a href="#" data-act="openShipment" data-id="${esc(i.shipment_id)}" class="mono">${esc(s?.tracking_no || '')}</a> ${esc(i.description)}${i.qty_affected ? ` · ${qtyFmt(i.qty_affected)} pcs` : ''}<span class="sub">${esc(i.stage || '')} · reported by ${esc(personName(i.reported_by))}${i.resolved ? ` · Resolved: ${esc(i.resolution || '')}` : ''}</span></td>
            <td class="num">${!i.resolved && can('resolve') ? `<button class="btn sm" data-act="resolveIssue" data-id="${i.id}">Resolve</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : empty('No reports', 'Shortages and damage found during release, receiving or delivery are logged here.')}
      </section>
    </div>`;
};

VIEWS.delivery = () => {
  const wh = S.shipments.filter((s) => s.status === 'RECEIVED');
  const out = S.shipments.filter((s) => s.status === 'OUT');
  const done = S.shipments.filter((s) => s.status === 'DELIVERED' || s.status === 'PICKUP').sort((a, b) => (b.delivered_at || '') > (a.delivered_at || '') ? 1 : -1).slice(0, 25);
  const vehicles = [...new Set([...S.vehicles.filter((v) => v.active).map((v) => v.name), ...out.map((s) => s.delivery_vehicle)])];
  const vterm = (name) => stopByKind(S.vehicles.find((v) => v.name === name)?.terminal || 'final');
  return `${head('Last mile', 'Delivery', `Assign warehouse cargo to a delivery vehicle, such as the Elf truck or korong-korong in ${esc(stopByKind('final'))}, then record proof of delivery.`)}
    <section class="card"><div class="card-h"><div><h2>In warehouse</h2><p>${wh.length} shipments ready</p></div></div>
      ${wh.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Consignee</th><th>Warehouse</th><th class="num">Qty</th><th>Payment</th><th></th></tr></thead><tbody>
      ${wh.map((s) => `<tr><td><a href="#" class="mono" data-act="openShipment" data-id="${s.id}">${esc(s.tracking_no)}</a><span class="sub">Received ${fDT(s.received_at)}</span></td>
        <td><strong>${esc(s.consignee_name)}</strong><span class="sub">${esc(s.consignee_address || '')} ${esc(s.consignee_contact || '')}</span></td><td>${esc(stopByKind(terminalKind(dirOf(s), 'end')))}<span class="sub">${esc(s.warehouse_bay || 'No bay')}</span></td>
        <td class="num">${qtyFmt(s.received_qty ?? qtyOf(s))}</td><td>${s.payment_terms === 'Collect' && !s.paid ? pill('Collect ' + peso(s.freight_charge), 'gold') : pill('Paid', 'green')}</td>
        <td class="num">${can('deliver') ? `<div class="actions" style="justify-content:flex-end"><button class="btn sm primary" data-act="assign" data-id="${s.id}">Assign vehicle</button><button class="btn sm" data-act="pod" data-mode="pickup" data-id="${s.id}">Pickup</button></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty('Nothing waiting in the warehouses', 'Cargo appears here after receiving.')}
    </section>
    <div class="grid3">${vehicles.map((v) => {
      const list = out.filter((s) => s.delivery_vehicle === v);
      return `<section class="card"><div class="card-h"><div><h2>${esc(v)}</h2><p>${esc(vterm(v))} · ${list.length} out for delivery</p></div>${ICON.delivery.replace('<svg', '<svg style="width:26px;height:26px;color:var(--accent-ink)"')}</div>
        ${list.length ? list.map((s) => `<div class="lane"><div class="lane-top"><span class="grow"><span class="mono">${esc(s.tracking_no)}</span> <strong>${esc(s.consignee_name)}</strong><span class="sub muted small">${esc(s.consignee_address || '')} · ${qtyFmt(s.received_qty ?? qtyOf(s))} pcs · crew ${esc(s.delivery_crew || '—')}</span></span></div>
          ${can('deliver') ? `<div class="actions"><button class="btn sm primary" data-act="pod" data-mode="deliver" data-id="${s.id}">Record delivery</button><button class="btn sm" data-act="backToWh" data-id="${s.id}" data-confirm="Tap again to return">Return to warehouse</button></div>` : ''}</div>`).join('')
        : '<div class="card-b muted">No deliveries assigned.</div>'}</section>`;
    }).join('')}</div>
    <section class="card"><div class="card-h"><h2>Proof of delivery</h2><p>Latest 25</p></div>
      ${done.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Consignee</th><th>Received by</th><th>When</th><th>How</th><th></th></tr></thead><tbody>
      ${done.map((s) => `<tr><td class="mono">${esc(s.tracking_no)}</td><td>${esc(s.consignee_name)}</td><td>${esc(s.pod_received_by)}<span class="sub">${esc(s.pod_id_ref || '')}</span></td><td>${fDT(s.delivered_at)}</td>
        <td>${s.status === 'PICKUP' ? 'Warehouse pickup' : esc(s.delivery_vehicle || '')}${s.pod_condition && s.pod_condition !== 'Good' ? ' ' + pill(s.pod_condition, 'red') : ''}</td>
        <td class="num">${s.pod_photo_path ? `<button class="btn sm" data-act="photo" data-path="${esc(s.pod_photo_path)}">Photo</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No deliveries yet', 'Completed deliveries and pickups are listed here with who received them.')}
    </section>`;
};

VIEWS.fleet = () => {
  const yr = todayISO().slice(0, 4) + '-01-01';
  const costYear = S.maint.filter((m) => m.log_date >= yr).reduce((a, m) => a + Number(m.cost), 0);
  const tone = { 'Available': 'green', 'Loading': 'gold', 'On trip': 'blue', 'Under maintenance': 'orange' };
  const cards = S.trucks.map((t) => {
    const d = daysUntil(t.next_pms_date);
    const pms = t.next_pms_date ? (d < 0 ? pill(`PMS overdue ${-d}d`, 'red') : d <= 7 ? pill(`PMS in ${d}d`, 'orange') : pill(`PMS ${fDate(t.next_pms_date)}`, 'gray')) : pill('PMS date not set', 'gray');
    const trip = S.trips.find((x) => x.truck_id === t.id && x.status !== 'Closed');
    const last = S.maint.find((m) => m.truck_id === t.id);
    const tCost = S.maint.filter((m) => m.truck_id === t.id && m.log_date >= yr).reduce((a, m) => a + Number(m.cost), 0);
    return `<section class="card truck"><div class="truck-top"><span class="truck-badge">${ICON.fleet}</span><div style="flex:1;min-width:0"><h3>${esc(t.code)}</h3><div class="muted small">${esc(t.plate_no || 'Plate no. not set')} · ${esc(t.model)}</div></div>${pill(t.status, tone[t.status])}</div>
      <dl class="dl"><div><dt>Driver</dt><dd>${esc(t.default_driver || '—')}</dd></div><div><dt>Odometer</dt><dd>${t.odometer_km != null ? qtyFmt(t.odometer_km) + ' km' : '—'}</dd></div>
        <div><dt>Trip / location</dt><dd>${trip ? `<span class="mono">${esc(trip.trip_no)}</span> · ${esc(trip.status === 'Arrived' ? `Arrived in ${endOf(dirOf(trip))}` : trip.status === 'Loading' ? `Loading at ${startOf(dirOf(trip))}` : `${dirLabel(dirOf(trip))}`)}` : esc(truckWhere(t).replace(/^at /, 'Parked at ').replace(/^location/, 'Location'))}</dd></div><div><dt>Maintenance ${yr.slice(0, 4)}</dt><dd>${peso(tCost)}</dd></div></dl>
      <div>${pms}</div>
      <div class="muted small">Last work: ${last ? `${fDate(last.log_date)} · ${esc(last.kind)} · ${esc(last.description)}` : 'none recorded'}</div>
      ${can('fleet') ? `<div class="actions"><button class="btn sm" data-act="editTruck" data-id="${t.id}">Edit truck</button><button class="btn sm" data-act="logMaint" data-id="${t.id}">${ICON.wrench} Log maintenance</button></div>` : ''}
    </section>`;
  }).join('');
  const trips = S.trips.slice(0, 30);
  return `${head('Fleet management', `${S.trucks.length} trucks`, 'Ten-wheeler line-haul trucks: status, schedule, preventive maintenance and repair history.',
    can('fleet') ? `<button class="btn" data-act="logMaint">${ICON.wrench} Log maintenance</button><button class="btn primary" data-act="editTruck">${ICON.plus} Add truck</button>` : '')}
    <div class="grid3">${cards || empty('No trucks', 'Add your trucks to start.')}</div>
    <section class="card"><div class="card-h"><div><h2>Trip schedule</h2><p>Active trips and the last 120 days</p></div></div>
      ${trips.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Trip</th><th>Direction</th><th>Truck</th><th>Crew</th><th>Planned</th><th>Departed</th><th>Arrived</th><th>Status</th></tr></thead><tbody>
      ${trips.map((t) => `<tr><td class="mono">${esc(t.trip_no)}</td><td>${dirTag(dirOf(t))}</td><td>${esc(truckOf(t.truck_id)?.code || '')}</td><td>${esc(t.driver)}<span class="sub">${esc([t.pahinante, t.pahinante2].filter(Boolean).join(', '))}</span></td>
        <td>${fDT(t.planned_departure)}</td><td>${fDT(t.departed_at)}</td><td>${fDT(t.arrived_at)}</td><td>${pill(t.status, TRIP_TONE[t.status])}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No trips yet', 'Trips created in Dispatch show here.')}
    </section>
    <section class="card"><div class="card-h"><div><h2>Maintenance &amp; repair history</h2><p>${peso(costYear)} spent in ${yr.slice(0, 4)}</p></div></div>
      ${S.maint.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Truck</th><th>Type</th><th>Work done</th><th>Shop</th><th class="num">Odometer</th><th class="num">Cost</th></tr></thead><tbody>
      ${S.maint.slice(0, 60).map((m) => `<tr><td>${fDate(m.log_date)}</td><td>${esc(truckOf(m.truck_id)?.code || '')}</td><td>${pill(m.kind, m.kind === 'Repair' ? 'orange' : 'navy')}</td><td>${esc(m.description)}</td><td>${esc(m.shop || '')}</td>
        <td class="num">${m.odometer_km != null ? qtyFmt(m.odometer_km) : ''}</td><td class="num">${peso(m.cost)}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No maintenance recorded', 'Log PMS, repairs and tire changes to build each truck\'s history.')}
    </section>`;
};

VIEWS.reports = () => {
  const P = S.ui.period;
  if (S.report.period !== P && !S.report.loading) loadReport(P);
  const r = S.report.data;
  const periods = [['month', 'This month'], ['last', 'Last month'], ['q', 'Last 3 months'], ['year', 'This year']];
  const top = `${head('Accountability', 'Reports', 'Volumes, freight income, issues and fleet cost for the period. Export any table to CSV for Excel or Google Sheets.')}
    <div class="toolbar"><select id="f-period" data-chg="period" aria-label="Report period" style="flex:0 1 220px">${periods.map(([v, l]) => `<option value="${v}" ${v === P ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${r ? `<span class="muted small">${fDate(r.from)} – ${fDate(r.to)}</span>` : ''}</div>`;
  if (!r || S.report.period !== P) return top + '<div class="loading-bar"></div>';
  const ships = r.shipments; const freight = ships.reduce((a, s) => a + Number(s.freight_charge), 0);
  const collected = ships.filter((s) => s.paid || s.payment_terms === 'Prepaid').reduce((a, s) => a + Number(s.freight_charge), 0);
  const outstanding = ships.filter((s) => s.payment_terms === 'Collect' && !s.paid);
  const maintCost = r.maint.reduce((a, m) => a + Number(m.cost), 0);
  const byDest = {}; ships.forEach((s) => { const d = (byDest[`${dirLabel(dirOf(s))}|${s.destination}`] ||= { n: 0, q: 0, f: 0 }); d.n++; d.q += qtyOf(s); d.f += Number(s.freight_charge); });
  const byTruck = S.trucks.map((t) => ({
    t, trips: r.trips.filter((x) => x.truck_id === t.id).length,
    ships: ships.filter((s) => r.trips.some((x) => x.id === s.trip_id && x.truck_id === t.id)).length,
    cost: r.maint.filter((m) => m.truck_id === t.id).reduce((a, m) => a + Number(m.cost), 0),
  }));
  const k = (l, v, s = '') => `<div class="kpi"><span class="k-label">${l}</span><span class="k-val">${v}</span><span class="k-sub">${s}</span></div>`;
  return `${top}
    <section class="kpis">
      ${k('Shipments', ships.length, `${qtyFmt(ships.reduce((a, s) => a + qtyOf(s), 0))} pcs`)}
      ${k('Freight billed', peso(freight).replace(/\.\d\d$/, ''), `${peso(collected).replace(/\.\d\d$/, '')} collected`)}
      ${k('Uncollected', peso(outstanding.reduce((a, s) => a + Number(s.freight_charge), 0)).replace(/\.\d\d$/, ''), `${outstanding.length} collect shipments`)}
      ${k('Trips', r.trips.length, `${r.trips.filter((t) => t.status === 'Closed').length} closed`)}
      ${k('Shortage / damage', r.issues.length, `${r.issues.filter((i) => !i.resolved).length} still open`)}
      ${k('Maintenance cost', peso(maintCost).replace(/\.\d\d$/, ''), `${r.maint.length} work orders`)}
    </section>
    <div class="actions">
      <button class="btn" data-act="csv" data-kind="shipments">${ICON.download} Shipments CSV</button>
      <button class="btn" data-act="csv" data-kind="trips">${ICON.download} Trips CSV</button>
      <button class="btn" data-act="csv" data-kind="issues">${ICON.download} Issues CSV</button>
      <button class="btn" data-act="csv" data-kind="maint">${ICON.download} Maintenance CSV</button>
    </div>
    <div class="grid2">
      <section class="card"><div class="card-h"><h2>By direction and destination</h2></div>
        ${Object.keys(byDest).length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Direction</th><th>Destination</th><th class="num">Shipments</th><th class="num">Pieces</th><th class="num">Freight</th></tr></thead><tbody>
        ${Object.entries(byDest).sort((a, b) => b[1].f - a[1].f).map(([d, v]) => `<tr><td>${esc(d.split('|')[0])}</td><td>${esc(d.split('|')[1])}</td><td class="num">${v.n}</td><td class="num">${qtyFmt(v.q)}</td><td class="num">${peso(v.f)}</td></tr>`).join('')}
        </tbody></table></div>` : empty('No shipments in this period', '')}
      </section>
      <section class="card"><div class="card-h"><h2>By truck</h2></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Truck</th><th class="num">Trips</th><th class="num">Shipments</th><th class="num">Maintenance</th></tr></thead><tbody>
        ${byTruck.map((x) => `<tr><td>${esc(x.t.code)}</td><td class="num">${x.trips}</td><td class="num">${x.ships}</td><td class="num">${peso(x.cost)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>
    </div>
    <section class="card"><div class="card-h"><div><h2>Uncollected freight</h2><p>Collect-on-delivery shipments not yet marked paid</p></div></div>
      ${outstanding.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tracking no.</th><th>Consignee</th><th>Status</th><th class="num">Freight</th><th></th></tr></thead><tbody>
      ${outstanding.map((s) => `<tr><td class="mono">${esc(s.tracking_no)}</td><td>${esc(s.consignee_name)}<span class="sub">${esc(s.consignee_contact || '')}</span></td><td>${statusPill(s.status)}</td><td class="num">${peso(s.freight_charge)}</td>
        <td class="num">${can('paid') ? `<button class="btn sm" data-act="markPaid" data-id="${s.id}">Mark paid</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty('All freight collected', 'No unpaid collect shipments in this period.')}
    </section>`;
};

VIEWS.users = () => {
  const pending = S.profiles.filter((p) => p.role === 'pending');
  const staffRows = S.profiles.map((p) => `<tr>
    <td><strong>${esc(p.full_name || '(no name)')}</strong><span class="sub">${esc(p.email || '')}</span></td>
    <td>${can('admin') ? `<select id="role-${p.id}" data-chg="role" data-id="${p.id}" aria-label="Role for ${esc(p.full_name || p.email)}">${Object.entries(ROLES).map(([v, l]) => `<option value="${v}" ${v === p.role ? 'selected' : ''}>${l}</option>`).join('')}</select>` : esc(ROLES[p.role])}</td>
    <td>${can('admin') ? `<label class="check"><input type="checkbox" id="act-${p.id}" data-chg="active" data-id="${p.id}" ${p.active ? 'checked' : ''}> Active</label>` : (p.active ? pill('Active', 'green') : pill('Disabled', 'gray'))}</td>
    <td>${fDate(p.created_at)}</td></tr>`).join('');
  const crewRows = S.crew.map((c) => `<tr><td><strong>${esc(c.full_name)}</strong><span class="sub">${esc(c.phone || '')}</span></td><td>${esc(c.role)}</td><td>${c.active ? pill('Active', 'green') : pill('Inactive', 'gray')}</td>
    <td class="num">${can('crew') ? `<button class="btn sm" data-act="editCrew" data-id="${c.id}">Edit</button>` : ''}</td></tr>`).join('');
  const matrix = [
    ['Register cargo', 'register'], ['Dispatch & loading sign-off', 'dispatch'], ['En-route releases', 'unload'], ['Receiving', 'receive'],
    ['Delivery & proof of delivery', 'deliver'], ['Resolve shortage / damage', 'resolve'], ['Mark freight paid', 'paid'], ['Fleet & maintenance', 'fleet'],
    ['Crew list', 'crew'], ['Route & warehouse settings', 'settings'], ['Staff accounts & roles', 'admin'],
  ];
  const roleKeys = Object.keys(ROLES).filter((r) => r !== 'pending');
  return `${head('People & setup', 'Users & settings', 'Staff accounts and roles, truck crew, and the route the trucks run.')}
    <section class="card"><div class="card-h"><div><h2>Your account</h2><p>${esc(S.session.user.email)} · ${esc(ROLES[S.me.role])}</p></div></div>
      <form class="card-b toolbar" data-form="myName"><label class="f" style="flex:1 1 260px">Your full name<input id="my-name" name="full_name" value="${esc(S.me.full_name)}" autocomplete="name"></label><button class="btn" style="align-self:end">Save name</button></form></section>
    <section class="card"><div class="card-h"><div><h2>Staff accounts</h2><p>New staff create an account on the sign-in page. They can use the app after an administrator assigns a role.</p></div></div>
      ${pending.length && can('admin') ? `<div class="card-b" style="padding-bottom:0"><div class="note warn">${pending.length} account${pending.length > 1 ? 's are' : ' is'} waiting for a role.</div></div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead><tbody>${staffRows}</tbody></table></div></section>
    <section class="card"><div class="card-h"><div><h2>Truck crew</h2><p>Drivers, pahinante and delivery crew. They don't need app logins; dispatch picks them from this list.</p></div>
      ${can('crew') ? `<button class="btn sm primary" data-act="editCrew">${ICON.plus} Add crew</button>` : ''}</div>
      ${S.crew.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${crewRows}</tbody></table></div>` : empty('No crew yet', 'Add drivers and pahinante so dispatch can assign them.')}</section>
    <div class="grid3">
      <section class="card"><div class="card-h"><div><h2>Route</h2><p>In ${esc(dirLabel('northbound'))} order. Return trips run in reverse.</p></div>${can('settings') ? `<button class="btn sm" data-act="addStop">${ICON.plus} Add stop</button>` : ''}</div>
        <div class="tbl-wrap"><table class="tbl"><tbody>${S.stops.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.kind === 'origin' ? pill('Origin', 'navy') : s.kind === 'final' ? pill('Final', 'navy') : pill('Drop-off', 'gray')}</td>
          <td class="num">${s.kind === 'stop' && can('settings') ? `<button class="iconbtn" data-act="delStop" data-id="${s.id}" data-confirm="Remove?" aria-label="Remove ${esc(s.name)}">${ICON.x}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-h"><div><h2>Warehouse bays</h2><p>${esc(stopByKind('final'))} and ${esc(stopByKind('origin'))} warehouses</p></div>${can('settings') ? `<button class="btn sm" data-act="addBay">${ICON.plus} Add bay</button>` : ''}</div>
        ${S.bays.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${S.bays.slice().sort((a, b) => ((a.terminal || 'final') + a.name > (b.terminal || 'final') + b.name ? 1 : -1)).map((b) => `<tr><td>${esc(b.name)}<span class="sub">${esc(stopByKind(b.terminal || 'final'))}</span></td><td class="num">${can('settings') ? `<button class="iconbtn" data-act="delBay" data-id="${b.id}" data-confirm="Remove?" aria-label="Remove ${esc(b.name)}">${ICON.x}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No bays yet', 'Add the bays or sections of the warehouse.')}</section>
      <section class="card"><div class="card-h"><div><h2>Delivery vehicles</h2><p>Last mile at each terminal</p></div>${can('settings') ? `<button class="btn sm" data-act="addVehicle">${ICON.plus} Add</button>` : ''}</div>
        <div class="tbl-wrap"><table class="tbl"><tbody>${S.vehicles.map((v) => `<tr><td>${esc(v.name)}<span class="sub">${esc(stopByKind(v.terminal || 'final'))} · ${esc(v.kind)}${v.plate_no ? ' · ' + esc(v.plate_no) : ''}</span></td>
          <td class="num">${can('settings') ? `<label class="check" style="justify-content:flex-end"><input type="checkbox" id="veh-${v.id}" data-chg="vehActive" data-id="${v.id}" ${v.active ? 'checked' : ''}> In use</label>` : (v.active ? pill('In use', 'green') : pill('Off', 'gray'))}</td></tr>`).join('')}</tbody></table></div></section>
    </div>
    <section class="card"><div class="card-h"><div><h2>Roles and access</h2><p>What each role can do. Everyone with a role can view all records.</p></div></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Task</th>${roleKeys.map((r) => `<th style="text-align:center">${esc(ROLES[r].split(' (')[0])}</th>`).join('')}</tr></thead><tbody>
      ${matrix.map(([l, key]) => `<tr><td>${l}</td>${roleKeys.map((r) => `<td style="text-align:center">${CAN[key].includes(r) ? `<span style="color:var(--green)" aria-label="Yes">${ICON.check.replace('<svg', '<svg style="width:18px;height:18px"')}</span>` : '<span class="muted" aria-label="No">–</span>'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div></section>`;
};

// ---------------------------------------------------------------------------
// Reports data
// ---------------------------------------------------------------------------
function periodRange(p) {
  const t = todayISO();
  if (p === 'last') return [monthStart(-1), monthStart(0)];
  if (p === 'q') return [monthStart(-2), null];
  if (p === 'year') return [t.slice(0, 4) + '-01-01', null];
  return [monthStart(0), null];
}
async function loadReport(p) {
  S.report.loading = true;
  const [from, to] = periodRange(p);
  const fromTs = from + 'T00:00:00+08:00'; const toTs = to ? to + 'T00:00:00+08:00' : null;
  const lim = (q, col) => (toTs ? q.lt(col, toTs) : q);
  const [sh, tr, is, mt] = await Promise.all([
    lim(sb.from('shipments').select('*, shipment_items(*)').gte('created_at', fromTs), 'created_at').order('created_at').limit(10000),
    lim(sb.from('trips').select('*').gte('created_at', fromTs), 'created_at').order('created_at'),
    lim(sb.from('issues').select('*').gte('reported_at', fromTs), 'reported_at').order('reported_at'),
    (to ? sb.from('maintenance_logs').select('*').gte('log_date', from).lt('log_date', to) : sb.from('maintenance_logs').select('*').gte('log_date', from)).order('log_date'),
  ]);
  S.report.loading = false;
  const err = [sh, tr, is, mt].find((x) => x.error);
  if (err) { toast(friendly(err.error), 'err'); return; }
  const toDisp = to ? new Date(new Date(to + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10) : todayISO();
  S.report = { period: p, loading: false, data: { from, to: toDisp, shipments: sh.data, trips: tr.data, issues: is.data, maint: mt.data } };
  if (route() === 'reports') render();
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
const crewList = (id, role) => `<datalist id="${id}">${S.crew.filter((c) => c.active && (!role || c.role === role)).map((c) => `<option value="${esc(c.full_name)}"></option>`).join('')}</datalist>`;
const cancelBtn = '<button type="button" class="btn" data-act="closeModal">Cancel</button>';

function itemRow(i = {}) {
  const amt = Number(i.qty || 0) * Number(i.rate || 0);
  return `<div class="irow"><input class="i-desc" name="idesc" placeholder="Item description" value="${esc(i.description || '')}" aria-label="Item description">
    <input class="i-size" name="isize" placeholder="Size / package" value="${esc(i.size_package || '')}" aria-label="Size or package">
    <input class="i-qty" name="iqty" type="number" min="0.01" step="any" placeholder="Qty" value="${esc(i.qty ?? '')}" aria-label="Quantity">
    <select class="i-unit" name="iunit" aria-label="Unit">${UNITS.map((u) => `<option ${u === (i.unit || 'pc') ? 'selected' : ''}>${u}</option>`).join('')}</select>
    <input class="i-rate" name="irate" type="number" min="0" step="0.01" placeholder="Rate ₱" value="${esc(i.rate ?? '')}" aria-label="Rate per unit in pesos">
    <output class="i-amt" aria-label="Line amount">${peso(amt)}</output>
    <button type="button" class="iconbtn i-rm" data-act="rmItem" aria-label="Remove item">${ICON.x}</button></div>`;
}
// live totals in the cargo form
function recalcFreight() {
  const form = $('form[data-form="shipment"]'); if (!form) return;
  let sum = 0;
  $$('#items .irow', form).forEach((r) => {
    const a = Number($('.i-qty', r).value || 0) * Number($('.i-rate', r).value || 0);
    sum += a; $('.i-amt', r).textContent = peso(a);
  });
  const other = Number($('#sh-other', form)?.value || 0);
  $('#frt-items').textContent = peso(sum);
  $('#frt-total').textContent = peso(sum + other);
}

function shipmentForm(s) {
  const dir = s ? dirOf(s) : (DIRS.includes(S.ui.lastDir) ? S.ui.lastDir : 'northbound');
  openModal({
    title: s ? `Edit ${s.tracking_no}` : 'Register cargo', wide: true,
    form: { name: 'shipment', data: { id: s?.id || '' } },
    body: `<div class="grid2" style="gap:14px">
      <fieldset><legend>Shipper</legend>
        <label class="f">Name / company <span class="req">*</span><input id="sh-shipper" name="shipper_name" value="${esc(s?.shipper_name || '')}" required></label>
        <label class="f">Contact no.<input id="sh-shipper-c" name="shipper_contact" value="${esc(s?.shipper_contact || '')}" inputmode="tel"></label></fieldset>
      <fieldset><legend>Consignee</legend>
        <label class="f">Name / company <span class="req">*</span><input id="sh-cons" name="consignee_name" value="${esc(s?.consignee_name || '')}" required></label>
        <label class="f">Contact no.<input id="sh-cons-c" name="consignee_contact" value="${esc(s?.consignee_contact || '')}" inputmode="tel"></label>
        <label class="f">Delivery address<input id="sh-cons-a" name="consignee_address" value="${esc(s?.consignee_address || '')}"></label></fieldset>
    </div>
    <div class="fgrid">
      <label class="f">Direction <span class="req">*</span>${dirSelect('sh-dir', 'direction', dir, 'data-chg="shipDir"')}</label>
      <label class="f">Destination <span class="req">*</span><select id="sh-dest" name="destination">${destOptions(dir, s?.destination)}</select></label>
      <label class="f">Payment<select id="sh-pay" name="payment_terms">${['Prepaid', 'Collect'].map((p) => `<option value="${p}" ${p === (s?.payment_terms || 'Prepaid') ? 'selected' : ''}>${p === 'Collect' ? 'Collect on delivery' : 'Prepaid at Manila'}</option>`).join('')}</select></label>
      <label class="f">Declared value (₱)<input id="sh-decl" name="declared_value" type="number" min="0" step="0.01" value="${esc(s?.declared_value ?? '')}"></label>
    </div>
    <div style="display:grid;gap:8px"><div><h3>Items and freight</h3><p class="muted small" style="margin:2px 0 0">Charge each line by its own size or package: amount = qty × rate.</p></div>
      <div class="irow ihead" aria-hidden="true"><span>Item</span><span>Size / package</span><span class="num">Qty</span><span>Unit</span><span class="num">Rate (₱)</span><span class="num">Amount</span><span></span></div>
      <div id="items" style="display:grid;gap:8px">${(s?.shipment_items?.length ? s.shipment_items : [{}]).map(itemRow).join('')}</div>
      <div><button type="button" class="btn sm" data-act="addItem">${ICON.plus} Add item</button></div>
      <div class="freight-box">
        <div class="fgrid">
          <label class="f">Other charges (₱)<input id="sh-other" name="other_charges" type="number" min="0" step="0.01" value="${esc(s?.other_charges || '')}" placeholder="0.00"></label>
          <label class="f">What for<input id="sh-other-note" name="other_charges_note" value="${esc(s?.other_charges_note || '')}" placeholder="e.g. handling, delivery fee"></label>
        </div>
        <dl class="totals"><div><dt>Items</dt><dd id="frt-items">₱0.00</dd></div><div class="grand"><dt>Total freight</dt><dd id="frt-total">₱0.00</dd></div></dl>
      </div></div>
    <label class="f">Notes<textarea id="sh-notes" name="notes" placeholder="Handling instructions, fragile, etc.">${esc(s?.notes || '')}</textarea></label>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">${s ? 'Save changes' : 'Register shipment'}</button>`,
  });
  recalcFreight();
}

async function openShipment(id) {
  const s = shipOf(id);
  if (!s) { toast('That shipment is older than 120 days. Find it in Reports.', 'err'); return; }
  const trip = tripOf(s.trip_id);
  const issues = S.issues.filter((i) => i.shipment_id === id);
  const sec = (title, rows) => `<div style="display:grid;gap:8px"><h3>${title}</h3><dl class="dl">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></div>`;
  const foot = [
    s.status === 'REG' && can('register') ? `<button type="button" class="btn danger" data-act="delShipment" data-id="${s.id}" data-confirm="Tap again to delete">Delete</button>` : '',
    s.status === 'REG' && can('register') ? `<button type="button" class="btn" data-act="editShipment" data-id="${s.id}">Edit</button>` : '',
    s.payment_terms === 'Collect' && !s.paid && can('paid') ? `<button type="button" class="btn primary" data-act="markPaid" data-id="${s.id}">Mark freight paid</button>` : '',
    '<button type="button" class="btn" data-act="closeModal">Close</button>',
  ].join('');
  openModal({
    title: s.tracking_no, wide: true, foot,
    body: `<div class="actions">${statusPill(s.status)} ${issues.filter((i) => !i.resolved).map((i) => pill(i.kind, 'red')).join(' ')}</div>
      ${sec('Consignment', [
        ['Shipper', `${esc(s.shipper_name)}<br><span class="muted small">${esc(s.shipper_contact || '')}</span>`],
        ['Consignee', `${esc(s.consignee_name)}<br><span class="muted small">${esc(s.consignee_contact || '')} ${esc(s.consignee_address || '')}</span>`],
        ['Destination', `${esc(s.destination)}<br><span class="muted small">${esc(dirLabel(dirOf(s)))}</span>`],
        ['Freight', `${peso(s.freight_charge)}<br><span class="muted small">${s.payment_terms}${s.payment_terms === 'Collect' ? (s.paid ? ` · paid ${fDT(s.paid_at)}` : ' · not yet paid') : ''}</span>`],
        s.declared_value != null && ['Declared value', peso(s.declared_value)],
        ['Registered', `${fDT(s.created_at)}<br><span class="muted small">by ${esc(personName(s.created_by))}</span>`],
        trip && ['Trip', `<span class="mono">${esc(trip.trip_no)}</span> · ${esc(truckOf(trip.truck_id)?.code || '')}<br><span class="muted small">${esc(trip.driver)}</span>`],
      ])}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Size / package</th><th class="num">Qty</th><th>Unit</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
        ${(s.shipment_items || []).map((i) => `<tr><td>${esc(i.description)}</td><td>${esc(i.size_package || '')}</td><td class="num">${qtyFmt(i.qty)}</td><td>${esc(i.unit)}</td><td class="num">${peso(i.rate)}</td><td class="num">${peso(i.amount ?? i.qty * i.rate)}</td></tr>`).join('')}
        ${Number(s.other_charges) ? `<tr><td colspan="5">Other charges${s.other_charges_note ? ` · ${esc(s.other_charges_note)}` : ''}</td><td class="num">${peso(s.other_charges)}</td></tr>` : ''}
        <tr><td colspan="2"><strong>Total</strong></td><td class="num"><strong>${qtyFmt(qtyOf(s))}</strong></td><td></td><td></td><td class="num"><strong>${peso(s.freight_charge)}</strong></td></tr></tbody></table></div>
      ${s.notes ? `<p style="margin:0"><strong>Notes:</strong> ${esc(s.notes)}</p>` : ''}
      ${s.released_at ? sec('Released en route', [['Stop', esc(s.destination)], ['Qty released', qtyFmt(s.release_qty)], ['Received by', `${esc(s.release_received_by)}<br><span class="muted small">${esc(s.release_id_ref || '')}</span>`], ['Condition', esc(s.release_condition)], ['When', `${fDT(s.released_at)}<br><span class="muted small">by ${esc(personName(s.released_by))}</span>`], s.release_note && ['Note', esc(s.release_note)]]) : ''}
      ${s.received_at ? sec(`Received in ${esc(endOf(dirOf(s)))}`, [['Qty received', qtyFmt(s.received_qty)], ['Condition', esc(s.received_condition)], ['Bay', esc(s.warehouse_bay || '—')], ['When', `${fDT(s.received_at)}<br><span class="muted small">by ${esc(personName(s.received_by))}</span>`], s.receiving_note && ['Note', esc(s.receiving_note)]]) : ''}
      ${s.assigned_at ? sec('Delivery', [['Vehicle', esc(s.delivery_vehicle)], ['Crew', esc(s.delivery_crew || '—')], ['Assigned', fDT(s.assigned_at)]]) : ''}
      ${s.delivered_at ? sec(s.status === 'PICKUP' ? 'Picked up' : 'Proof of delivery', [['Received by', `${esc(s.pod_received_by)}<br><span class="muted small">${esc(s.pod_id_ref || '')}</span>`], ['When', fDT(s.delivered_at)], ['Condition', esc(s.pod_condition)], s.pod_note && ['Note', esc(s.pod_note)], s.pod_photo_path && ['Photo', `<button type="button" class="btn sm" data-act="photo" data-path="${esc(s.pod_photo_path)}">View photo</button>`]]) : ''}
      ${issues.length ? `<div style="display:grid;gap:8px"><h3>Shortage &amp; damage</h3>${issues.map((i) => `<div class="note ${i.resolved ? '' : 'bad'}"><strong>${esc(i.kind)}</strong> · ${esc(i.description)} · ${fDT(i.reported_at)}${i.resolved ? ` · Resolved: ${esc(i.resolution || '')}` : ''}</div>`).join('')}</div>` : ''}
      <div style="display:grid;gap:8px"><h3>History</h3><ol class="tl" id="hist"><li><span class="muted">Loading…</span></li></ol></div>`,
  });
  const { data, error } = await sb.from('shipment_events').select('*').eq('shipment_id', id).order('created_at');
  const el = $('#hist'); if (!el) return;
  if (error) { el.innerHTML = `<li><span class="muted">${esc(friendly(error))}</span></li>`; return; }
  el.innerHTML = (data || []).map((e) => `<li><div><strong>${e.status ? esc(STATUS[e.status]?.[0] || e.status) : esc(e.note || '')}</strong><span class="muted small"> · ${fDT(e.created_at)} · ${esc(personName(e.created_by))}</span>${e.status && e.note ? `<div class="small">${esc(e.note)}</div>` : ''}</div></li>`).join('') || '<li><span class="muted">No history yet.</span></li>';
}

function tripForm() {
  const avail = S.trucks.filter((t) => t.status === 'Available');
  if (!avail.length) { toast('No truck is available. Close a trip or finish maintenance first.', 'err'); return; }
  openModal({
    title: 'New trip', form: { name: 'trip' },
    body: `<div class="fgrid">
      <label class="f">Truck <span class="req">*</span><select id="tr-truck" name="truck_id" data-chg="tripTruck">${avail.map((t) => `<option value="${t.id}" data-driver="${esc(t.default_driver || '')}" data-dir="${suggestDir(t)}">${esc(truckLabel(t))} · ${esc(truckWhere(t))}</option>`).join('')}</select></label>
      <label class="f">Direction <span class="req">*</span>${dirSelect('tr-dir', 'direction', suggestDir(avail[0]))}</label>
      <label class="f">Driver <span class="req">*</span><input id="tr-driver" name="driver" list="dl-driver" value="${esc(avail[0].default_driver || '')}" autocomplete="off"></label>
      <label class="f">Pahinante <span class="req">*</span><input id="tr-pah" name="pahinante" list="dl-pah" autocomplete="off"></label>
      <label class="f">Second pahinante<input id="tr-pah2" name="pahinante2" list="dl-pah" autocomplete="off"></label>
      <label class="f">Planned departure<input id="tr-dep" name="planned_departure" type="datetime-local" value="${nowLocalInput()}"></label>
      <label class="f span">Notes<textarea id="tr-notes" name="notes"></textarea></label></div>
      ${crewList('dl-driver', 'Driver')}${crewList('dl-pah', 'Pahinante')}
      <p class="muted small" style="margin:0">Direction is suggested from where the truck last ended a trip. A truck parked in ${esc(stopByKind('final'))} usually loads return cargo for ${esc(stopByKind('origin'))}.</p>
      ${!S.crew.length ? '<p class="muted small" style="margin:0">Tip: add drivers and pahinante in Users &amp; settings to pick them from a list.</p>' : ''}`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Create trip</button>`,
  });
}

function addCargoForm(tripId) {
  const trip = tripOf(tripId); const dir = dirOf(trip);
  const waiting = S.shipments.filter((s) => s.status === 'REG' && dirOf(s) === dir);
  if (!waiting.length) { toast(`No registered cargo going ${dirLabel(dir)} is waiting. Register cargo first.`, 'err'); return; }
  const names = routeFor(dir);
  waiting.sort((a, b) => names.indexOf(b.destination) - names.indexOf(a.destination));
  openModal({
    title: `Load cargo onto ${trip.trip_no}`, wide: true, form: { name: 'addCargo', data: { trip: tripId } },
    body: `<p class="muted" style="margin:0">${esc(dirLabel(dir))} cargo, farthest drop-off first, so cargo for ${esc(endOf(dir))} goes in deepest.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th><label class="check" style="min-height:0"><input type="checkbox" data-chg="checkAll" aria-label="Select all"></label></th><th>Tracking no.</th><th>Consignee</th><th>Drop-off</th><th>Items</th><th class="num">Qty</th></tr></thead><tbody>
      ${waiting.map((s) => `<tr><td><input type="checkbox" name="sid" value="${s.id}" id="ld-${s.id}" style="width:20px;height:20px;min-height:0" aria-label="Load ${esc(s.tracking_no)}"></td>
        <td class="mono"><label for="ld-${s.id}">${esc(s.tracking_no)}</label></td><td>${esc(s.consignee_name)}</td><td>${esc(s.destination)}</td><td>${esc(itemsText(s))}</td><td class="num">${qtyFmt(qtyOf(s))}</td></tr>`).join('')}
      </tbody></table></div>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Add to manifest</button>`,
  });
}

function releaseForm(id) {
  const s = shipOf(id);
  openModal({
    title: `Release ${s.tracking_no} at ${s.destination}`, form: { name: 'release', data: { id } },
    body: `<p style="margin:0">${esc(s.consignee_name)} · ${esc(itemsText(s))} · <strong>${qtyFmt(qtyOf(s))} on manifest</strong></p>
      <div class="fgrid">
        <label class="f">Qty released <span class="req">*</span><input id="rl-qty" name="qty" type="number" min="0" step="any" value="${qtyOf(s)}"></label>
        <label class="f">Condition<select id="rl-cond" name="condition"><option>Good</option><option>Short</option><option>Damaged</option></select></label>
        <label class="f">Received by <span class="req">*</span><input id="rl-by" name="received_by" value="${esc(s.consignee_name)}"></label>
        <label class="f">ID / OR no. / relationship<input id="rl-ref" name="id_ref"></label>
        <label class="f span">Note<textarea id="rl-note" name="note" placeholder="Required if short or damaged"></textarea></label></div>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Record release</button>`,
  });
}

function reconcileForm(tripId) {
  const t = tripOf(tripId); const dir = dirOf(t); const end = endOf(dir); const k = terminalKind(dir, 'end');
  const list = manifest(tripId).filter((s) => s.status === 'TRANSIT');
  const bays = S.bays.filter((b) => (b.terminal || 'final') === k);
  const bayOpts = (name) => `<select name="${name}" aria-label="Warehouse bay"><option value="">Unassigned</option>${bays.map((b) => `<option>${esc(b.name)}</option>`).join('')}</select>`;
  openModal({
    title: `Reconcile ${t.trip_no} in ${end}`, wide: true, form: { name: 'reconcile', data: { trip: tripId } },
    body: `<p class="muted" style="margin:0">Count each consignment. Any difference or damage is logged automatically as a report.${bays.length ? '' : ` No bays are set up for the ${esc(end)} warehouse yet; add them in Users &amp; settings.`}</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Shipment</th><th class="num">Manifest</th><th>Received</th><th>Condition</th><th>Bay</th><th>Note</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td><span class="mono">${esc(s.tracking_no)}</span><span class="sub">${esc(s.consignee_name)} · ${esc(itemsText(s).slice(0, 60))}</span>${s.destination !== end ? pill(`Was for ${s.destination}`, 'orange') : ''}</td>
        <td class="num">${qtyFmt(qtyOf(s))}</td>
        <td><input name="rq_${s.id}" type="number" min="0" step="any" value="${qtyOf(s)}" style="width:96px" aria-label="Received qty"></td>
        <td><select name="rc_${s.id}" aria-label="Condition"><option>Good</option><option>Short</option><option>Damaged</option></select></td>
        <td>${bayOpts('rb_' + s.id)}</td>
        <td><input name="rn_${s.id}" placeholder="Optional" aria-label="Note"></td></tr>`).join('')}
      </tbody></table></div>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Save reconciliation</button>`,
  });
}

function assignForm(id) {
  const s = shipOf(id); const k = terminalKind(dirOf(s), 'end');
  let veh = S.vehicles.filter((v) => v.active && (v.terminal || 'final') === k);
  const none = !veh.length; if (none) veh = S.vehicles.filter((v) => v.active);
  if (!veh.length) { toast('Add a delivery vehicle in Users & settings first.', 'err'); return; }
  openModal({
    title: `Assign ${s.tracking_no} for delivery`, form: { name: 'assign', data: { id } },
    body: `<p style="margin:0"><strong>${esc(s.consignee_name)}</strong> · ${esc(s.consignee_address || 'no address on file')} · ${qtyFmt(s.received_qty ?? qtyOf(s))} pcs · ${esc(stopByKind(k))} warehouse</p>
      ${none ? `<div class="note warn">No delivery vehicle is set up for ${esc(stopByKind(k))} yet, so all vehicles are listed. Add one in Users &amp; settings.</div>` : ''}
      <div class="fgrid"><label class="f">Vehicle <span class="req">*</span><select id="as-veh" name="vehicle">${veh.map((v) => `<option>${esc(v.name)}</option>`).join('')}</select></label>
      <label class="f">Driver / crew<input id="as-crew" name="crew" list="dl-dcrew" autocomplete="off"></label></div>${crewList('dl-dcrew')}`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Assign</button>`,
  });
}

function podForm(id, mode) {
  const s = shipOf(id);
  openModal({
    title: mode === 'pickup' ? `Release ${s.tracking_no} for pickup` : `Proof of delivery · ${s.tracking_no}`, form: { name: 'pod', data: { id, mode } },
    body: `<p style="margin:0"><strong>${esc(s.consignee_name)}</strong> · ${qtyFmt(s.received_qty ?? qtyOf(s))} pcs${s.payment_terms === 'Collect' && !s.paid ? ` · <strong>Collect ${peso(s.freight_charge)}</strong>` : ''}</p>
      <div class="fgrid">
        <label class="f">Received by <span class="req">*</span><input id="pod-by" name="received_by" value="${esc(s.consignee_name)}"></label>
        <label class="f">ID / relationship<input id="pod-ref" name="id_ref" placeholder="e.g. Driver's license, owner"></label>
        <label class="f">Date &amp; time<input id="pod-at" name="at" type="datetime-local" value="${nowLocalInput()}"></label>
        <label class="f">Condition<select id="pod-cond" name="condition"><option>Good</option><option>Damaged</option><option>Short</option></select></label>
        ${s.payment_terms === 'Collect' && !s.paid ? '<label class="check span"><input type="checkbox" id="pod-paid" name="paid"> Freight collected on delivery</label>' : ''}
        <label class="f span">Photo of signed receipt or cargo<input id="pod-photo" name="photo" type="file" accept="image/*" capture="environment"></label>
        <label class="f span">Note<textarea id="pod-note" name="note"></textarea></label></div>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">${mode === 'pickup' ? 'Confirm pickup' : 'Confirm delivery'}</button>`,
  });
}

function truckForm(id) {
  const t = id ? truckOf(id) : null; const busy = t && (t.status === 'Loading' || t.status === 'On trip');
  openModal({
    title: t ? `Edit ${t.code}` : 'Add truck', form: { name: 'truck', data: { id: id || '' } },
    body: `<div class="fgrid">
      <label class="f">Truck code <span class="req">*</span><input id="tk-code" name="code" value="${esc(t?.code || '')}" placeholder="CJ-06"></label>
      <label class="f">Plate no.<input id="tk-plate" name="plate_no" value="${esc(t?.plate_no || '')}"></label>
      <label class="f">Model<input id="tk-model" name="model" value="${esc(t?.model || '10-wheeler')}"></label>
      <label class="f">Regular driver<input id="tk-driver" name="default_driver" list="dl-driver" value="${esc(t?.default_driver || '')}" autocomplete="off"></label>
      <label class="f">Status<select id="tk-status" name="status" ${busy ? 'disabled' : ''}>${(busy ? [t.status] : ['Available', 'Under maintenance']).map((x) => `<option ${x === t?.status ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="f">Odometer (km)<input id="tk-odo" name="odometer_km" type="number" min="0" value="${esc(t?.odometer_km ?? '')}"></label>
      <label class="f">Next PMS date<input id="tk-pms" name="next_pms_date" type="date" value="${esc(t?.next_pms_date || '')}"></label>
      <label class="f span">Notes<textarea id="tk-notes" name="notes">${esc(t?.notes || '')}</textarea></label></div>${crewList('dl-driver', 'Driver')}`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">${t ? 'Save truck' : 'Add truck'}</button>`,
  });
}

function maintForm(truckId) {
  openModal({
    title: 'Log maintenance', form: { name: 'maint' },
    body: `<div class="fgrid">
      <label class="f">Truck <span class="req">*</span><select id="mt-truck" name="truck_id">${S.trucks.map((t) => `<option value="${t.id}" ${t.id === truckId ? 'selected' : ''}>${esc(truckLabel(t))}</option>`).join('')}</select></label>
      <label class="f">Date<input id="mt-date" name="log_date" type="date" value="${todayISO()}"></label>
      <label class="f">Type<select id="mt-kind" name="kind">${['PMS', 'Repair', 'Tires', 'Inspection', 'Other'].map((k) => `<option>${k}</option>`).join('')}</select></label>
      <label class="f">Cost (₱)<input id="mt-cost" name="cost" type="number" min="0" step="0.01"></label>
      <label class="f span">Work done <span class="req">*</span><textarea id="mt-desc" name="description" placeholder="e.g. Change oil and filters, replace brake lining"></textarea></label>
      <label class="f">Shop / mechanic<input id="mt-shop" name="shop"></label>
      <label class="f">Odometer (km)<input id="mt-odo" name="odometer_km" type="number" min="0"></label>
      <label class="f">Set next PMS date<input id="mt-next" name="next_pms_date" type="date"></label></div>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Save</button>`,
  });
}

function crewForm(id) {
  const c = id ? S.crew.find((x) => x.id === id) : null;
  openModal({
    title: c ? `Edit ${c.full_name}` : 'Add crew member', form: { name: 'crew', data: { id: id || '' } },
    body: `<div class="fgrid"><label class="f">Full name <span class="req">*</span><input id="cr-name" name="full_name" value="${esc(c?.full_name || '')}"></label>
      <label class="f">Role<select id="cr-role" name="role">${['Driver', 'Pahinante', 'Delivery crew', 'Checker'].map((r) => `<option ${r === c?.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="f">Phone<input id="cr-phone" name="phone" value="${esc(c?.phone || '')}" inputmode="tel"></label>
      <label class="check"><input type="checkbox" id="cr-active" name="active" ${c?.active === false ? '' : 'checked'}> Active</label></div>`,
    foot: `${cancelBtn}<button class="btn primary" type="submit">Save</button>`,
  });
}

const simpleForm = (title, name, fields, submit) => openModal({
  title, form: { name },
  body: `<div class="fgrid">${fields}</div>`,
  foot: `${cancelBtn}<button class="btn primary" type="submit">${submit}</button>`,
});

// ---------------------------------------------------------------------------
// Actions (clicks) and forms (submits)
// ---------------------------------------------------------------------------
const resetConfirm = { driver_confirmed_at: null, driver_confirmed_by: null, pahinante_confirmed_at: null, pahinante_confirmed_by: null, checker_confirmed_at: null, checker_confirmed_by: null };
const after = async (ok) => { if (ok) { closeModal(); await loadAll(); } return ok; };

const ACT = {
  closeModal, reload: loadAll,
  signOut: async () => { await sb.auth.signOut(); },
  newShipment: () => shipmentForm(null),
  editShipment: (d) => shipmentForm(shipOf(d.id)),
  openShipment: (d) => openShipment(d.id),
  addItem: () => { $('#items').insertAdjacentHTML('beforeend', itemRow()); $$('#items .i-desc').pop()?.focus(); },
  rmItem: (d, b) => { if ($$('#items .irow').length > 1) { b.closest('.irow').remove(); recalcFreight(); } },
  delShipment: async (d) => after(await run(sb.from('shipments').delete().eq('id', d.id), 'Shipment deleted')),
  markPaid: async (d) => { if (await after(await run(sb.from('shipments').update({ paid: true, paid_at: new Date().toISOString() }).eq('id', d.id), 'Marked as paid'))) S.report.period = null; },
  newTrip: tripForm,
  addCargo: (d) => addCargoForm(d.id),
  unloadCargo: async (d) => {
    const s = shipOf(d.id);
    if (await run(sb.from('shipments').update({ status: 'REG', trip_id: null }).eq('id', d.id).eq('status', 'LOAD'))) {
      await run(sb.from('trips').update(resetConfirm).eq('id', s.trip_id), `${s.tracking_no} removed. Sign-offs cleared.`); loadAll();
    }
  },
  cancelTrip: async (d) => after(await run(sb.rpc('cancel_trip', { p_trip: d.id }), 'Trip cancelled. Cargo returned to the waiting list.')),
  depart: async (d, b) => { b.disabled = true; await after(await run(sb.rpc('depart_trip', { p_trip: d.id }), 'Truck departed. Shipments are now in transit.')); },
  arriveStop: async (d) => after(await run(sb.from('trip_stop_logs').insert({ trip_id: d.id, stop_name: d.stop }), `Arrival at ${d.stop} recorded`)),
  release: (d) => releaseForm(d.id),
  arriveTerminal: async (d) => after(await run(sb.rpc('arrive_terminal', { p_trip: d.id }), `Truck arrived in ${d.end}. Start reconciliation.`)),
  reconcile: (d) => reconcileForm(d.id),
  closeTrip: async (d) => after(await run(sb.rpc('close_trip', { p_trip: d.id }), 'Trip closed. Truck is available again.')),
  resolveIssue: (d) => simpleForm('Resolve report', 'resolve', `<input type="hidden" name="id" value="${esc(d.id)}"><label class="f span">How was it resolved? <span class="req">*</span><textarea id="rs-text" name="resolution" placeholder="e.g. Shipper confirmed short-loaded; freight adjusted"></textarea></label>`, 'Mark resolved'),
  assign: (d) => assignForm(d.id),
  pod: (d) => podForm(d.id, d.mode),
  backToWh: async (d) => after(await run(sb.from('shipments').update({ status: 'RECEIVED', delivery_vehicle: null, delivery_crew: null, assigned_at: null, assigned_by: null }).eq('id', d.id), 'Returned to warehouse')),
  photo: async (d) => {
    const { data, error } = await sb.storage.from('pod-photos').createSignedUrl(d.path, 600);
    if (error) { toast(friendly(error), 'err'); return; }
    openModal({ title: 'Delivery photo', body: `<img class="photo" src="${esc(data.signedUrl)}" alt="Proof of delivery photo">`, foot: '<button type="button" class="btn" data-act="closeModal">Close</button>' });
  },
  editTruck: (d) => truckForm(d.id),
  logMaint: (d) => maintForm(d.id),
  editCrew: (d) => crewForm(d.id),
  addStop: () => {
    const opts = S.stops.slice(0, -1).map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
    simpleForm('Add drop-off stop', 'stop', `<label class="f">Stop name <span class="req">*</span><input id="st-name" name="name" placeholder="e.g. San Fernando, La Union"></label>
      <label class="f">Comes after<select id="st-after" name="after">${opts}</select></label>`, 'Add stop');
    const sel = $('#st-after'); if (sel) sel.value = String(S.stops.length - 2);
  },
  delStop: async (d) => after(await run(sb.from('route_stops').delete().eq('id', d.id), 'Stop removed')),
  addBay: () => simpleForm('Add warehouse bay', 'bay', `${termSelect('bay-term')}<label class="f">Bay name <span class="req">*</span><input id="bay-name" name="name" placeholder="e.g. Bay A"></label>`, 'Add bay'),
  delBay: async (d) => after(await run(sb.from('warehouse_bays').delete().eq('id', d.id), 'Bay removed')),
  addVehicle: () => simpleForm('Add delivery vehicle', 'vehicle', `${termSelect('vh-term')}<label class="f">Name <span class="req">*</span><input id="vh-name" name="name" placeholder="e.g. Elf Truck 2"></label>
    <label class="f">Type<select id="vh-kind" name="kind"><option>Elf truck</option><option>Korong-korong</option><option>Other</option></select></label><label class="f">Plate no.<input id="vh-plate" name="plate_no"></label>`, 'Add vehicle'),
  csv: (d) => exportCSV(d.kind),
};

const CHG = {
  fstatus: (el) => { S.ui.status = el.value; render(); },
  fdir: (el) => { S.ui.dir = el.value; render(); },
  shipDir: (el) => { const d = $('#sh-dest'); if (d) d.innerHTML = destOptions(el.value); },
  period: (el) => { S.ui.period = el.value; render(); },
  confirm: async (el) => {
    const k = el.dataset.role; const on = el.checked;
    await run(sb.from('trips').update({ [`${k}_confirmed_at`]: on ? new Date().toISOString() : null, [`${k}_confirmed_by`]: on ? uid() : null }).eq('id', el.dataset.trip));
    loadAll();
  },
  tripTruck: (el) => { const o = el.selectedOptions[0]; if (o?.dataset.driver) $('#tr-driver').value = o.dataset.driver; if (o?.dataset.dir) $('#tr-dir').value = o.dataset.dir; },
  checkAll: (el) => $$('input[name="sid"]', el.closest('form')).forEach((c) => { c.checked = el.checked; }),
  role: async (el) => { if (!await run(sb.from('profiles').update({ role: el.value }).eq('id', el.dataset.id), 'Role updated')) render(); else loadAll(); },
  active: async (el) => { if (!await run(sb.from('profiles').update({ active: el.checked }).eq('id', el.dataset.id), el.checked ? 'Account enabled' : 'Account disabled')) render(); else loadAll(); },
  vehActive: async (el) => { await run(sb.from('delivery_vehicles').update({ active: el.checked }).eq('id', el.dataset.id)); loadAll(); },
};

const now = () => new Date().toISOString();
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
const txt = (fd, k) => String(fd.get(k) || '').trim() || null;

const FORMS = {
  shipment: async (f, fd) => {
    if (!need(fd, [['shipper_name', 'shipper'], ['consignee_name', 'consignee']])) return;
    const dir = fd.get('direction');
    if (!routeFor(dir).slice(1).includes(fd.get('destination'))) { toast(`${fd.get('destination')} is not a stop going ${dirLabel(dir)}.`, 'err'); return; }
    S.ui.lastDir = dir; try { localStorage.setItem('cj.lastDir', dir); } catch { /* storage blocked */ }
    const descs = fd.getAll('idesc'); const qtys = fd.getAll('iqty'); const units = fd.getAll('iunit'); const sizes = fd.getAll('isize'); const rates = fd.getAll('irate');
    const items = descs.map((d, i) => ({ description: d.trim(), size_package: sizes[i].trim() || null, qty: Number(qtys[i]), unit: units[i], rate: Number(rates[i] || 0) })).filter((i) => i.description || i.qty);
    if (!items.length || items.some((i) => !i.description || !(i.qty > 0))) { toast('Each item needs a description and a quantity above zero.', 'err'); return; }
    if (items.some((i) => !(i.rate >= 0))) { toast('Rates cannot be negative.', 'err'); return; }
    const other = Number(fd.get('other_charges') || 0);
    if (!items.some((i) => i.rate > 0) && !(other > 0)) { toast('Enter a rate for at least one item, or other charges.', 'err'); return; }
    const row = {
      shipper_name: txt(fd, 'shipper_name'), shipper_contact: txt(fd, 'shipper_contact'),
      consignee_name: txt(fd, 'consignee_name'), consignee_contact: txt(fd, 'consignee_contact'), consignee_address: txt(fd, 'consignee_address'),
      direction: dir, destination: fd.get('destination'), other_charges: other, other_charges_note: txt(fd, 'other_charges_note'), declared_value: numOrNull(fd.get('declared_value')),
      payment_terms: fd.get('payment_terms'), paid: fd.get('payment_terms') === 'Prepaid', notes: txt(fd, 'notes'),
    };
    let id = f.dataset.id;
    if (id) {
      if (!await run(sb.from('shipments').update(row).eq('id', id))) return;
      if (!await run(sb.from('shipment_items').delete().eq('shipment_id', id))) return;
    } else {
      const created = await run(sb.from('shipments').insert(row).select('id, tracking_no').single());
      if (!created) return; id = created.id; row.tracking_no = created.tracking_no;
    }
    if (!await run(sb.from('shipment_items').insert(items.map((i) => ({ ...i, shipment_id: id }))))) return;
    toast(f.dataset.id ? 'Shipment updated' : `Registered ${row.tracking_no}. Write this number on the cargo.`);
    await after(true);
  },
  trip: async (f, fd) => {
    if (!need(fd, [['driver', 'driver'], ['pahinante', 'pahinante']])) return;
    const dep = fd.get('planned_departure');
    const trip = await run(sb.from('trips').insert({
      truck_id: fd.get('truck_id'), direction: fd.get('direction'), driver: txt(fd, 'driver'), pahinante: txt(fd, 'pahinante'), pahinante2: txt(fd, 'pahinante2'),
      planned_departure: dep ? new Date(dep).toISOString() : null, notes: txt(fd, 'notes'),
    }).select('trip_no').single());
    if (!trip) return;
    await run(sb.from('trucks').update({ status: 'Loading' }).eq('id', fd.get('truck_id')));
    toast(`Trip ${trip.trip_no} created (${dirLabel(fd.get('direction'))}). Load cargo next.`);
    await after(true);
  },
  addCargo: async (f, fd) => {
    const ids = fd.getAll('sid');
    if (!ids.length) { toast('Tick at least one shipment.', 'err'); return; }
    if (!await run(sb.from('shipments').update({ status: 'LOAD', trip_id: f.dataset.trip }).in('id', ids).eq('status', 'REG'))) return;
    await run(sb.from('trips').update(resetConfirm).eq('id', f.dataset.trip));
    toast(`${ids.length} shipment${ids.length > 1 ? 's' : ''} added to the manifest`);
    await after(true);
  },
  release: async (f, fd) => {
    const s = shipOf(f.dataset.id); const man = qtyOf(s); const qty = Number(fd.get('qty')); const cond = fd.get('condition');
    if (!need(fd, [['received_by', 'received by']])) return;
    if (!(qty >= 0)) { toast('Enter the quantity released.', 'err'); return; }
    if ((qty < man || cond !== 'Good') && !txt(fd, 'note')) { toast('Add a note explaining the shortage or damage.', 'err'); return; }
    const ok = await run(sb.from('shipments').update({
      status: 'RELEASED', release_qty: qty, release_received_by: txt(fd, 'received_by'), release_id_ref: txt(fd, 'id_ref'),
      release_condition: cond, release_note: txt(fd, 'note'), released_at: now(), released_by: uid(),
    }).eq('id', s.id));
    if (!ok) return;
    const trip = tripOf(s.trip_id);
    if (trip && !(trip.trip_stop_logs || []).some((l) => l.stop_name === s.destination)) await run(sb.from('trip_stop_logs').insert({ trip_id: trip.id, stop_name: s.destination }));
    if (qty < man) await run(sb.from('issues').insert({ shipment_id: s.id, trip_id: s.trip_id, kind: 'Shortage', qty_affected: man - qty, description: txt(fd, 'note'), stage: `Release at ${s.destination}` }));
    if (cond === 'Damaged') await run(sb.from('issues').insert({ shipment_id: s.id, trip_id: s.trip_id, kind: 'Damage', description: txt(fd, 'note'), stage: `Release at ${s.destination}` }));
    toast(`${s.tracking_no} released to ${txt(fd, 'received_by')}`);
    await after(true);
  },
  reconcile: async (f, fd) => {
    const trip = tripOf(f.dataset.trip); const end = endOf(dirOf(trip));
    const list = manifest(f.dataset.trip).filter((s) => s.status === 'TRANSIT');
    let issues = 0;
    for (const s of list) {
      const man = qtyOf(s); const q = Number(fd.get('rq_' + s.id)); const c = fd.get('rc_' + s.id); const note = txt(fd, 'rn_' + s.id);
      if (!(q >= 0)) { toast(`Enter the received qty for ${s.tracking_no}.`, 'err'); return; }
      const ok = await run(sb.from('shipments').update({ status: 'RECEIVED', received_qty: q, received_condition: q < man && c === 'Good' ? 'Short' : c, warehouse_bay: fd.get('rb_' + s.id) || null, receiving_note: note, received_at: now(), received_by: uid() }).eq('id', s.id));
      if (!ok) return;
      const base = { shipment_id: s.id, trip_id: s.trip_id, stage: `${end} receiving` };
      if (q < man) { issues++; await run(sb.from('issues').insert({ ...base, kind: 'Shortage', qty_affected: man - q, description: note || `Received ${qtyFmt(q)} of ${qtyFmt(man)}` })); }
      if (q > man) { issues++; await run(sb.from('issues').insert({ ...base, kind: 'Other', qty_affected: q - man, description: note || `Over by ${qtyFmt(q - man)} pcs` })); }
      if (c === 'Damaged') { issues++; await run(sb.from('issues').insert({ ...base, kind: 'Damage', description: note || 'Damaged on arrival' })); }
      if (s.destination !== end) { issues++; await run(sb.from('issues').insert({ ...base, kind: 'Overcarried', description: `Meant for ${s.destination}, unloaded in ${end}` })); }
    }
    toast(`${list.length} shipments received in ${end}${issues ? ` · ${issues} report${issues > 1 ? 's' : ''} logged` : ''}`);
    await after(true);
  },
  assign: async (f, fd) => {
    await after(await run(sb.from('shipments').update({ status: 'OUT', delivery_vehicle: fd.get('vehicle'), delivery_crew: txt(fd, 'crew'), assigned_at: now(), assigned_by: uid() }).eq('id', f.dataset.id), 'Assigned for delivery'));
  },
  pod: async (f, fd) => {
    if (!need(fd, [['received_by', 'received by']])) return;
    const s = shipOf(f.dataset.id); const file = fd.get('photo'); let path = null;
    if (file && file.size) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      path = `${s.id}/${Date.now()}.${ext}`;
      const { error } = await sb.storage.from('pod-photos').upload(path, file, { contentType: file.type || 'image/jpeg' });
      if (error) { toast('Photo upload failed: ' + friendly(error), 'err'); return; }
    }
    const at = fd.get('at'); const cond = fd.get('condition');
    const upd = { status: f.dataset.mode === 'pickup' ? 'PICKUP' : 'DELIVERED', pod_received_by: txt(fd, 'received_by'), pod_id_ref: txt(fd, 'id_ref'), pod_condition: cond, pod_note: txt(fd, 'note'), pod_photo_path: path, delivered_at: at ? new Date(at).toISOString() : now(), delivered_by: uid() };
    if (fd.get('paid')) { upd.paid = true; upd.paid_at = now(); }
    if (!await run(sb.from('shipments').update(upd).eq('id', s.id))) return;
    if (cond !== 'Good') await run(sb.from('issues').insert({ shipment_id: s.id, trip_id: s.trip_id, kind: cond === 'Short' ? 'Shortage' : 'Damage', description: txt(fd, 'note') || `${cond} at delivery`, stage: 'Delivery' }));
    toast(`${s.tracking_no} ${f.dataset.mode === 'pickup' ? 'picked up' : 'delivered'}`);
    await after(true);
  },
  resolve: async (f, fd) => {
    if (!need(fd, [['resolution', 'resolution']])) return;
    await after(await run(sb.from('issues').update({ resolved: true, resolution: txt(fd, 'resolution'), resolved_by: uid(), resolved_at: now() }).eq('id', fd.get('id')), 'Report resolved'));
  },
  truck: async (f, fd) => {
    if (!need(fd, [['code', 'truck code']])) return;
    const row = { code: txt(fd, 'code'), plate_no: txt(fd, 'plate_no'), model: txt(fd, 'model') || '10-wheeler', default_driver: txt(fd, 'default_driver'), odometer_km: numOrNull(fd.get('odometer_km')), next_pms_date: fd.get('next_pms_date') || null, notes: txt(fd, 'notes') };
    if (fd.get('status')) row.status = fd.get('status');
    const q = f.dataset.id ? sb.from('trucks').update(row).eq('id', f.dataset.id) : sb.from('trucks').insert(row);
    await after(await run(q, f.dataset.id ? 'Truck saved' : 'Truck added'));
  },
  maint: async (f, fd) => {
    if (!need(fd, [['description', 'work done']])) return;
    const tid = fd.get('truck_id'); const odo = numOrNull(fd.get('odometer_km'));
    if (!await run(sb.from('maintenance_logs').insert({ truck_id: tid, log_date: fd.get('log_date') || todayISO(), kind: fd.get('kind'), description: txt(fd, 'description'), cost: Number(fd.get('cost') || 0), shop: txt(fd, 'shop'), odometer_km: odo }))) return;
    const t = truckOf(tid); const upd = {};
    if (fd.get('next_pms_date')) upd.next_pms_date = fd.get('next_pms_date');
    if (odo != null && (t.odometer_km == null || odo > t.odometer_km)) upd.odometer_km = odo;
    if (Object.keys(upd).length) await run(sb.from('trucks').update(upd).eq('id', tid));
    toast('Maintenance logged'); S.report.period = null;
    await after(true);
  },
  crew: async (f, fd) => {
    if (!need(fd, [['full_name', 'name']])) return;
    const row = { full_name: txt(fd, 'full_name'), role: fd.get('role'), phone: txt(fd, 'phone'), active: !!fd.get('active') };
    await after(await run(f.dataset.id ? sb.from('crew').update(row).eq('id', f.dataset.id) : sb.from('crew').insert(row), 'Crew saved'));
  },
  stop: async (f, fd) => {
    if (!need(fd, [['name', 'stop name']])) return;
    const i = Number(fd.get('after')); const a = S.stops[i]; const b = S.stops[i + 1];
    const seq = b ? Math.floor((a.seq + b.seq) / 2) : a.seq + 10;
    if (b && (seq === a.seq || seq === b.seq)) { toast('No room between those stops. Remove and re-add stops in order.', 'err'); return; }
    await after(await run(sb.from('route_stops').insert({ name: txt(fd, 'name'), seq, kind: 'stop' }), 'Stop added'));
  },
  bay: async (f, fd) => { if (need(fd, [['name', 'bay name']])) await after(await run(sb.from('warehouse_bays').insert({ name: txt(fd, 'name'), terminal: fd.get('terminal') }), 'Bay added')); },
  vehicle: async (f, fd) => { if (need(fd, [['name', 'name']])) await after(await run(sb.from('delivery_vehicles').insert({ name: txt(fd, 'name'), kind: fd.get('kind'), plate_no: txt(fd, 'plate_no'), terminal: fd.get('terminal') }), 'Vehicle added')); },
  myName: async (f, fd) => { await run(sb.from('profiles').update({ full_name: txt(fd, 'full_name') || '' }).eq('id', uid()), 'Name saved'); loadAll(); },
  // ---- auth ----
  signIn: async (f, fd) => {
    const { error } = await sb.auth.signInWithPassword({ email: txt(fd, 'email'), password: fd.get('password') });
    if (error) toast(/Invalid login/i.test(error.message) ? 'Wrong email or password.' : friendly(error), 'err');
  },
  signUp: async (f, fd) => {
    if (!need(fd, [['full_name', 'full name'], ['email', 'email'], ['password', 'password']])) return;
    if (String(fd.get('password')).length < 8) { toast('Use a password of at least 8 characters.', 'err'); return; }
    const { data, error } = await sb.auth.signUp({ email: txt(fd, 'email'), password: fd.get('password'), options: { data: { full_name: txt(fd, 'full_name') }, emailRedirectTo: location.origin + location.pathname } });
    if (error) { toast(friendly(error), 'err'); return; }
    if (!data.session) { S.authMsg = 'Account created. Open the confirmation email we sent, then sign in.'; S.authTab = 'in'; render(); }
  },
  forgot: async (f, fd) => {
    if (!need(fd, [['email', 'email']])) return;
    const { error } = await sb.auth.resetPasswordForEmail(txt(fd, 'email'), { redirectTo: location.origin + location.pathname });
    if (error) { toast(friendly(error), 'err'); return; }
    S.authMsg = 'If that email has an account, a reset link is on its way.'; S.authTab = 'in'; render();
  },
  newPassword: async (f, fd) => {
    if (String(fd.get('password')).length < 8) { toast('Use a password of at least 8 characters.', 'err'); return; }
    const { error } = await sb.auth.updateUser({ password: fd.get('password') });
    if (error) { toast(friendly(error), 'err'); return; }
    S.recovery = false; toast('Password changed'); render(); loadAll();
  },
};

function exportCSV(kind) {
  const r = S.report.data; if (!r) return;
  const tag = `${r.from}_to_${r.to}`;
  const tn = (id) => truckOf(id)?.code || '';
  if (kind === 'shipments') downloadCSV(`cj-shipments_${tag}.csv`, [
    ['Tracking no', 'Registered', 'Shipper', 'Shipper contact', 'Consignee', 'Consignee contact', 'Address', 'Direction', 'Destination', 'Items', 'Total qty', 'Total freight', 'Payment', 'Paid', 'Status', 'Trip', 'Received qty', 'Received by (POD)', 'Delivered/released'],
    ...r.shipments.map((s) => [s.tracking_no, fDT(s.created_at), s.shipper_name, s.shipper_contact, s.consignee_name, s.consignee_contact, s.consignee_address, dirLabel(dirOf(s)), s.destination, itemsText(s), qtyOf(s), s.freight_charge, s.payment_terms, s.paid ? 'Yes' : 'No', STATUS[s.status]?.[0], tripOf(s.trip_id)?.trip_no || '', s.received_qty ?? s.release_qty ?? '', s.pod_received_by || s.release_received_by || '', fDT(s.delivered_at || s.released_at)]),
  ]);
  if (kind === 'trips') downloadCSV(`cj-trips_${tag}.csv`, [
    ['Trip no', 'Direction', 'Truck', 'Driver', 'Pahinante', 'Planned departure', 'Departed', 'Arrived', 'Closed', 'Status'],
    ...r.trips.map((t) => [t.trip_no, dirLabel(dirOf(t)), tn(t.truck_id), t.driver, [t.pahinante, t.pahinante2].filter(Boolean).join(' / '), fDT(t.planned_departure), fDT(t.departed_at), fDT(t.arrived_at), fDT(t.closed_at), t.status]),
  ]);
  if (kind === 'issues') downloadCSV(`cj-issues_${tag}.csv`, [
    ['Reported', 'Type', 'Tracking no', 'Qty', 'Description', 'Stage', 'Resolved', 'Resolution'],
    ...r.issues.map((i) => [fDT(i.reported_at), i.kind, r.shipments.find((s) => s.id === i.shipment_id)?.tracking_no || shipOf(i.shipment_id)?.tracking_no || '', i.qty_affected ?? '', i.description, i.stage, i.resolved ? 'Yes' : 'No', i.resolution || '']),
  ]);
  if (kind === 'maint') downloadCSV(`cj-maintenance_${tag}.csv`, [
    ['Date', 'Truck', 'Type', 'Work done', 'Shop', 'Odometer km', 'Cost'],
    ...r.maint.map((m) => [m.log_date, tn(m.truck_id), m.kind, m.description, m.shop || '', m.odometer_km ?? '', m.cost]),
  ]);
}

// ---------------------------------------------------------------------------
// Auth & setup screens
// ---------------------------------------------------------------------------
function authArt() {
  return `<div class="auth-art"><div class="livery" aria-hidden="true"></div>
    <div class="auth-badge">${logo(132)}<div><span class="brand-name">RABARA JRCJ</span><br><span class="brand-sub">Freight Services · Managed by Emilia Rabara</span></div></div>
    <div style="display:grid;gap:18px"><div class="auth-route"><span>Manila</span><i></i><span>Vigan</span></div>
      <h1>Every shipment, every truck, from loading to proof of delivery.</h1>
      <p>Register cargo, sign off manifests, record releases on the road, reconcile at the terminal and track the fleet. One record for the whole team, in both directions.</p></div>
    <p class="small" style="margin:0">Staff access only.</p></div>`;
}
function authView() {
  const tab = S.authTab || 'in';
  const tabs = `<div class="tabs" role="tablist"><button type="button" role="tab" aria-selected="${tab === 'in'}" data-act="authTab" data-tab="in">Sign in</button><button type="button" role="tab" aria-selected="${tab === 'up'}" data-act="authTab" data-tab="up">New staff account</button></div>`;
  const msg = S.authMsg ? `<div class="note">${esc(S.authMsg)}</div>` : '';
  let form;
  if (tab === 'up') form = `<form data-form="signUp" novalidate>${tabs}<h2>Create your staff account</h2>${msg}
    <label class="f">Full name<input id="su-name" name="full_name" autocomplete="name"></label>
    <label class="f">Email<input id="su-email" name="email" type="email" autocomplete="email"></label>
    <label class="f">Password<input id="su-pass" name="password" type="password" autocomplete="new-password" minlength="8"></label>
    <button class="btn primary" type="submit">Create account</button>
    <p class="muted small" style="margin:0">An administrator approves new accounts and assigns your role. The very first account becomes the administrator.</p></form>`;
  else if (tab === 'forgot') form = `<form data-form="forgot" novalidate>${tabs}<h2>Reset password</h2>${msg}
    <label class="f">Email<input id="fp-email" name="email" type="email" autocomplete="email"></label>
    <button class="btn primary" type="submit">Send reset link</button><button type="button" class="linkbtn" style="color:var(--blue)" data-act="authTab" data-tab="in">Back to sign in</button></form>`;
  else form = `<form data-form="signIn" novalidate>${tabs}<h2>Sign in</h2>${msg}
    <label class="f">Email<input id="si-email" name="email" type="email" autocomplete="email"></label>
    <label class="f">Password<input id="si-pass" name="password" type="password" autocomplete="current-password"></label>
    <button class="btn primary" type="submit">Sign in</button>
    <button type="button" class="linkbtn" style="color:var(--blue);justify-self:start" data-act="authTab" data-tab="forgot">Forgot password?</button></form>`;
  return `<div class="auth">${authArt()}<div class="auth-form">${form}</div></div>`;
}
ACT.authTab = (d) => { S.authTab = d.tab; S.authMsg = ''; render(); };

function recoveryView() {
  return `<div class="auth">${authArt()}<div class="auth-form"><form data-form="newPassword" novalidate><h2>Set a new password</h2>
    <label class="f">New password<input id="np-pass" name="password" type="password" autocomplete="new-password" minlength="8"></label>
    <button class="btn primary" type="submit">Save password</button></form></div></div>`;
}
function pendingView() {
  const inactive = S.me && !S.me.active;
  return `<div class="auth">${authArt()}<div class="auth-form"><div style="width:min(380px,100%);display:grid;gap:14px">
    <h2>${inactive ? 'Account disabled' : 'Waiting for approval'}</h2>
    <p>${inactive ? 'This account has been disabled. Contact the administrator if you need access again.' : `You're signed in as <strong>${esc(S.session.user.email)}</strong>. An administrator needs to assign your role before you can use the system.`}</p>
    <div class="actions"><button class="btn" data-act="reload">Check again</button><button class="btn" data-act="signOut">Sign out</button></div></div></div></div>`;
}
function setupView() {
  return `<div class="setup"><div class="brand" style="color:var(--ink)">${logo(64)}<span><span class="brand-name" style="color:var(--ink)">RABARA JRCJ FREIGHT SERVICES</span></span></div>
    <h1>Connect the database</h1>
    <p>This copy of the app isn't connected to Supabase yet.</p>
    <ol><li>In Supabase, open <strong>SQL Editor</strong>, paste the contents of <code>supabase/schema.sql</code> and run it.</li>
      <li>Open <strong>Project Settings → API</strong> and copy the Project URL and the publishable (anon) key.</li>
      <li>Put both into <code>js/config.js</code> in the GitHub repo and commit. GitHub Pages updates in about a minute.</li></ol></div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.tagName === 'A' || b.tagName === 'TR') e.preventDefault();
  if (b.disabled) return;
  if (!armed(b)) return;
  const fn = ACT[b.dataset.act]; if (fn) fn(b.dataset, b, e);
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('[type="submit"]') || f.querySelector('button:not([type="button"])');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await FORMS[f.dataset.form]?.(f, new FormData(f)); }
  catch (err) { toast(friendly(err), 'err'); }
  finally { if (btn && document.contains(btn)) btn.disabled = false; }
});
document.addEventListener('change', (e) => { const el = e.target.closest('[data-chg]'); if (el) CHG[el.dataset.chg]?.(el); });
document.addEventListener('input', (e) => {
  if (e.target.closest('form[data-form="shipment"]')) { recalcFreight(); return; }
  const el = e.target.closest('[data-filter]'); if (el) { S.ui[el.dataset.filter] = el.value; render(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen()) closeModal(); });
$('#modal-root').addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) closeModal(); });
window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!sb) { render(); return; }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') S.recovery = true;
    const wasIn = !!S.session; S.session = session;
    if (!session) { S.loaded = false; S.me = null; if (channel) { sb.removeChannel(channel); channel = null; } render(); return; }
    if (!wasIn || event === 'SIGNED_IN') { render(); loadAll(); subscribeLive(); }
  });
  render();
  if (S.session) { await loadAll(); subscribeLive(); }
}
boot();
