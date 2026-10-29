// Shared helpers: formatting, icons, modal, toasts, CSV.

export const TZ = 'Asia/Manila';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const qtyFmt = (n) => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
export const fDate = (v) => v ? new Date(v.length === 10 ? v + 'T00:00:00+08:00' : v).toLocaleDateString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }) : '—';
export const fDT = (v) => v ? new Date(v).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const fTime = (v) => v ? new Date(v).toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '';
export const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in Manila
export const nowLocalInput = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const toLocalInput = (iso) => {
  if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const a = new Date(todayISO() + 'T00:00:00Z'); const b = new Date(dateStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
};

export const pill = (label, tone = 'gray') => `<span class="pill t-${tone}">${esc(label)}</span>`;

const P = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  dashboard: P('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  shipments: P('<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
  dispatch: P('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 13 2 2 4-4"/>'),
  unloading: P('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  receiving: P('<path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-8h10v8"/><path d="M7 17h10"/>'),
  delivery: P('<path d="M2 6h12v10H2z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/>'),
  fleet: P('<path d="M1 5h13v11H1z"/><path d="M14 9h5l4 4v3h-9"/><circle cx="5" cy="18" r="2"/><circle cx="10" cy="18" r="2"/><circle cx="18.5" cy="18" r="2"/>'),
  reports: P('<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  users: P('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 20a6.5 6.5 0 0 0-2.4-5"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  x: P('<path d="M18 6 6 18M6 6l12 12"/>'),
  download: P('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  check: P('<path d="m5 12 5 5 9-10"/>'),
  alert: P('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
  wrench: P('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5Z"/>'),
};

// ---------- toasts ----------
export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

// ---------- modal ----------
let lastFocus = null;
export function openModal({ title, body, foot = '', wide = false, form = null }) {
  lastFocus = document.activeElement;
  const inner = `
    <div class="modal-h"><h2 id="modal-title">${esc(title)}</h2>
      <button type="button" class="iconbtn" data-act="closeModal" aria-label="Close">${ICON.x}</button></div>
    <div class="modal-b">${body}</div>
    ${foot ? `<div class="modal-f">${foot}</div>` : ''}`;
  const shell = form
    ? `<form class="modal${wide ? ' wide' : ''}" data-form="${esc(form.name)}" ${Object.entries(form.data || {}).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')} novalidate>${inner}</form>`
    : `<div class="modal${wide ? ' wide' : ''}">${inner}</div>`;
  $('#modal-root').innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">${shell}</div>`;
  const first = $('#modal-root .modal-b input:not([type=hidden]), #modal-root .modal-b select, #modal-root .modal-b textarea');
  (first || $('#modal-root .iconbtn')).focus();
}
export function closeModal() {
  $('#modal-root').innerHTML = '';
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
export const modalOpen = () => !!$('#modal-root .overlay');

// ---------- CSV ----------
export function downloadCSV(filename, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Two-tap confirmation for destructive buttons (data-confirm="Tap again to …").
export function armed(btn) {
  if (!btn.dataset.confirm) return true;
  if (btn.hasAttribute('data-armed')) return true;
  const label = btn.innerHTML;
  btn.setAttribute('data-armed', '');
  btn.textContent = btn.dataset.confirm;
  setTimeout(() => { if (document.contains(btn)) { btn.removeAttribute('data-armed'); btn.innerHTML = label; } }, 4000);
  return false;
}
