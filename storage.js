// State shape, persistence, backup and spreadsheet export.
import { compute, sessionBuyIn, sessionResult, sessionMs, BUCKET_LABEL, dayKey } from './ledger.js';

const KEY = 'cbt.v1';
const DAMAGED = KEY + '.damaged';
export const SCHEMA = 1;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const newState = () => ({ schema: SCHEMA, cruises: [], activeCruiseId: null, customGames: [], lastBackupAt: null });

export function newCruise({ name, startDate = '', endDate = '', limits = {} } = {}) {
  return {
    id: uid(), name: String(name || '').trim() || 'My cruise', startDate, endDate, status: 'active',
    limits: { trip: limits.trip ?? null, daily: limits.daily ?? null, session: limits.session ?? null },
    entries: [],
  };
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCents = v => Number.isSafeInteger(v) && v >= 0;
const isPos = v => Number.isSafeInteger(v) && v > 0;
const isTs = v => Number.isFinite(v);
const isStr = v => typeof v === 'string';
const HELD = ['cash', 'ship', 'chips'];
const TAGS = ['win', 'loss', 'spending', 'unknown'];

function entryError(e) {
  if (!isObj(e) || !isStr(e.id) || !isTs(e.ts)) return 'an entry is malformed';
  if (e.note !== undefined && !isStr(e.note)) return 'an entry note is malformed';
  switch (e.type) {
    case 'start_cash': case 'card_charge': case 'lock':
      return isPos(e.amount) ? null : 'an amount is invalid';
    case 'atm':
      return isPos(e.amount) && isCents(e.fee ?? 0) ? null : 'an ATM entry is invalid';
    case 'transfer':
      return isPos(e.amount) && HELD.includes(e.from) && HELD.includes(e.to) && e.from !== e.to ? null : 'a transfer is invalid';
    case 'session': {
      if (!isStr(e.game) || !isStr(e.slotName ?? '') || !Array.isArray(e.buyIns) || !e.buyIns.length || !Array.isArray(e.notes)) return 'a session is invalid';
      for (const b of e.buyIns) if (!isObj(b) || !isPos(b.amount) || ![...HELD, 'card'].includes(b.source) || !isTs(b.ts)) return 'a session buy-in is invalid';
      if (e.cashOut !== null && !(isObj(e.cashOut) && isCents(e.cashOut.amount) && HELD.includes(e.cashOut.dest))) return 'a session cash-out is invalid';
      if (e.cashOut && !isTs(e.end)) return 'a session end time is invalid';
      for (const n of e.notes) if (!isObj(n) || !isTs(n.ts) || !isStr(n.text)) return 'a session note is invalid';
      return null;
    }
    case 'trueup': {
      if (!isObj(e.counts) || !isObj(e.tags ?? {})) return 'a true-up is invalid';
      for (const [k, v] of Object.entries(e.counts)) if (![...HELD, 'lockbox'].includes(k) || !Number.isSafeInteger(v)) return 'a true-up count is invalid';
      for (const v of Object.values(e.tags ?? {})) if (!TAGS.includes(v)) return 'a true-up tag is invalid';
      return null;
    }
    default: return 'an entry has an unknown type';
  }
}

export function validateState(obj) {
  const fail = error => ({ ok: false, error });
  if (!isObj(obj)) return fail('This is not a bankroll tracker backup.');
  if (obj.schema !== SCHEMA) return fail('This backup is from a different version of the app.');
  if (!Array.isArray(obj.cruises)) return fail('The backup has no cruise list.');
  const ids = new Set();
  let active = 0, sessionsOpen;
  for (const c of obj.cruises) {
    if (!isObj(c) || !isStr(c.id) || !isStr(c.name) || !Array.isArray(c.entries) || !isObj(c.limits)) return fail('A cruise in the backup is damaged.');
    if (ids.has(c.id)) return fail('The backup lists the same cruise twice.');
    ids.add(c.id);
    if (c.status !== 'active' && c.status !== 'finished') return fail('A cruise has an unknown status.');
    if (c.status === 'active') active++;
    for (const k of ['trip', 'daily', 'session']) if (c.limits[k] != null && !isPos(c.limits[k])) return fail('A budget limit is invalid.');
    sessionsOpen = 0;
    const eids = new Set();
    for (const e of c.entries) {
      const err = entryError(e);
      if (err) return fail('The backup is damaged: ' + err + '.');
      if (eids.has(e.id)) return fail('The backup is damaged: duplicate entry.');
      eids.add(e.id);
      if (e.type === 'session' && !e.cashOut) sessionsOpen++;
    }
    if (sessionsOpen > 1) return fail('The backup is damaged: two sessions are open at once.');
  }
  if (active > 1) return fail('The backup has more than one active cruise.');
  const ac = obj.activeCruiseId ?? null;
  const activeCruise = obj.cruises.find(c => c.status === 'active');
  if ((activeCruise ? activeCruise.id : null) !== ac) return fail('The backup does not say which cruise is active.');
  if (obj.customGames !== undefined && !(Array.isArray(obj.customGames) && obj.customGames.every(isStr))) return fail('The game list is damaged.');
  if (obj.lastBackupAt != null && !isTs(obj.lastBackupAt)) return fail('The backup date is damaged.');
  return { ok: true, state: { schema: SCHEMA, cruises: obj.cruises, activeCruiseId: ac, customGames: obj.customGames || [], lastBackupAt: obj.lastBackupAt ?? null } };
}

export const serialize = state => JSON.stringify(state);

export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, error: 'This file could not be read as a backup.' }; }
  try { return validateState(obj); } catch { return { ok: false, error: 'This file could not be read as a backup.' }; }
}

// ---- CSV ----
const q = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const money = c => (c === '' || c == null ? '' : (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + '.' + String(Math.abs(c) % 100).padStart(2, '0'));
const hhmm = ts => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const clock = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const HEAD = ['cruise', 'date', 'time', 'type', 'game', 'slot', 'from', 'to', 'amount', 'buy_in', 'cash_out', 'result', 'duration_min', 'fee', 'gap_tag', 'notes'];

export function toCSV(cruises) {
  const rows = [HEAD.join(',')];
  for (const c of cruises) {
    const gaps = compute(c).gaps;
    const row = (e, o) => rows.push(HEAD.map(h => {
      if (h === 'cruise') return q(c.name);
      if (h === 'date') return dayKey(e.ts);
      if (h === 'time') return hhmm(e.ts);
      return q(o[h] ?? '');
    }).join(','));
    for (const e of [...c.entries].sort((a, b) => a.ts - b.ts)) {
      const L = BUCKET_LABEL;
      if (e.type === 'start_cash') row(e, { type: 'Starting cash', from: 'Outside', to: L.cash, amount: money(e.amount), notes: e.note });
      else if (e.type === 'atm') row(e, { type: 'ATM withdrawal', from: 'Outside', to: L.cash, amount: money(e.amount), fee: e.fee ? money(e.fee) : '', notes: e.note });
      else if (e.type === 'card_charge') row(e, { type: 'Card charge', from: 'Outside', to: L.ship, amount: money(e.amount), notes: e.note });
      else if (e.type === 'transfer') row(e, { type: 'Transfer', from: L[e.from], to: L[e.to], amount: money(e.amount), notes: e.note });
      else if (e.type === 'lock') row(e, { type: 'Lock away', from: L.cash, to: L.lockbox, amount: money(e.amount), notes: e.note });
      else if (e.type === 'session') {
        const notes = [...e.notes.map(n => clock(n.ts) + ' ' + n.text), e.note].filter(Boolean).join('; ');
        row(e, {
          type: 'Session', game: e.game, slot: e.slotName,
          from: [...new Set(e.buyIns.map(b => L[b.source]))].join(' / '),
          to: e.cashOut ? L[e.cashOut.dest] : '',
          buy_in: money(sessionBuyIn(e)),
          cash_out: e.cashOut ? money(e.cashOut.amount) : '',
          result: e.cashOut ? money(sessionResult(e)) : '',
          duration_min: e.cashOut && e.durationKnown ? Math.round(sessionMs(e) / 60000) : '',
          notes,
        });
      } else if (e.type === 'trueup') {
        const mine = gaps.filter(g => g.entryId === e.id);
        if (!mine.length) row(e, { type: 'True-up', notes: e.note });
        for (const g of mine) row(e, { type: 'True-up', to: L[g.bucket], amount: money(g.gap), gap_tag: g.tag, notes: e.note });
      }
    }
  }
  return rows.join('\r\n');
}

// ---- localStorage ----
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { state: newState(), error: null };
    const r = parseBackup(raw);
    if (r.ok) return { state: r.state, error: null };
    // Keep the unreadable data so it is not overwritten silently.
    try { if (!localStorage.getItem(DAMAGED)) localStorage.setItem(DAMAGED, raw); } catch { /* ignore */ }
    return { state: newState(), error: 'Saved data could not be read. A copy was kept: go to Settings to export it or restore a backup.' };
  } catch {
    return { state: newState(), error: 'This browser is blocking storage, so nothing can be saved.' };
  }
}

export function save(state) {
  try { localStorage.setItem(KEY, serialize(state)); return { ok: true, error: null }; }
  catch { return { ok: false, error: 'Could not save. Storage may be full or blocked. Export a backup now.' }; }
}

export function getDamaged() { try { return localStorage.getItem(DAMAGED); } catch { return null; } }
export function clearDamaged() { try { localStorage.removeItem(DAMAGED); } catch { /* ignore */ } }
