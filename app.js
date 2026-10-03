// State, actions and routing.
import { compute, sessionBuyIn, slotNames, DEFAULT_GAMES, dayKey, stampNow, playedSession } from './ledger.js';
import { load, save, newCruise, uid, serialize, parseBackup, toCSV, getDamaged, clearDamaged } from './storage.js';
import * as V from './views.js';
import * as F from './forms.js';

let { state, error: loadError } = load();
let view = 'home';
let viewCruiseId = null; // a finished cruise being looked at, or null for the active one

const $ = id => document.getElementById(id);
const active = () => state.cruises.find(c => c.id === state.activeCruiseId) || null;
const viewed = () => state.cruises.find(c => c.id === viewCruiseId) || active();
const games = () => [...DEFAULT_GAMES.slice(0, -1), ...state.customGames, 'Other'];
const activeSession = () => { const c = active(); return c ? c.entries.find(e => e.type === 'session' && !e.cashOut) || null : null; };

function showError(msg) {
  const el = $('error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function commit() {
  const r = save(state);
  showError(r.ok ? '' : r.error);
  render();
}

function render() {
  const now = Date.now(), cr = active();
  $('title').textContent = cr ? cr.name : 'Bankroll tracker';
  const html = view === 'home' ? V.home(state, now)
    : view === 'history' ? V.history(state, viewed())
    : view === 'games' ? V.games(state, viewed())
    : view === 'cruises' ? V.cruises(state)
    : V.settings(state, games(), !!getDamaged());
  $('main').innerHTML = html;
  if (view === 'settings') offlineStatus();
  document.querySelectorAll('nav [data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
}

function go(v) { view = v; if (v === 'home' || v === 'cruises' || v === 'settings') viewCruiseId = null; render(); window.scrollTo(0, 0); }

// ---------- mutations ----------
const stamp = () => stampNow(active(), Date.now());
const entry = (type, data, ts = stamp()) => ({ id: uid(), type, ts, note: '', ...data });
function addEntry(e) { active().entries.push(e); commit(); }
function patchEntry(id, patch) { Object.assign(active().entries.find(e => e.id === id), patch); commit(); }
function deleteEntry(id) { const c = active(); c.entries = c.entries.filter(e => e.id !== id); commit(); }

// ---------- file helpers ----------
async function shareFile(name, text, type) {
  const tries = [new File([text], name, { type }), new File([text], name + '.txt', { type: 'text/plain' })];
  for (const file of tries) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(tries[0]); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cruise';

// ---------- actions ----------
const actions = {
  'new-cruise': () => {
    if (active()) return;
    F.cruiseForm(null, data => { const c = newCruise(data); state.cruises.push(c); state.activeCruiseId = c.id; view = 'home'; commit(); });
  },
  'edit-cruise': () => { const c = active(); F.cruiseForm(c, data => { Object.assign(c, data); commit(); }); },
  limits: () => { const c = active(); if (c) F.limitsForm(c, limits => { c.limits = limits; commit(); }); },

  move: () => {
    const first = !active().entries.some(e => e.type === 'start_cash');
    F.moveForm(null, first ? 'start_cash' : 'atm', d => addEntry(entry(d.type, d)));
  },
  lock: () => F.lockForm(null, compute(active()).balances.cash, d => addEntry(entry('lock', d))),

  session: () => {
    if (activeSession()) return;
    F.sessionNewForm({ games: games(), slotNames: slotNames(state.cruises) }, d => {
      const now = stamp();
      if (d.mode === 'live') {
        addEntry(entry('session', { game: d.game, slotName: d.slotName, buyIns: [{ amount: d.amount, source: d.source, ts: now }], cashOut: null, end: null, durationKnown: true, notes: [] }, now));
      } else addEntry({ id: uid(), ...playedSession(d, now) });
    });
  },
  buyin: () => { const s = activeSession(); if (s) F.buyInForm(s, d => { s.buyIns.push({ ...d, ts: stamp() }); commit(); }); },
  note: () => { const s = activeSession(); if (s) F.textForm('Add note', 'Note', 'Add', t => { s.notes.push({ ts: Date.now(), text: t }); commit(); }, { multiline: true }); },
  'end-session': () => {
    const s = activeSession();
    if (s) F.sessionEndForm(s, sessionBuyIn(s), d => {
      const now = stamp();
      s.cashOut = d.cashOut; s.end = now;
      if (d.note) s.notes.push({ ts: now, text: d.note });
      commit();
    });
  },

  trueup: () => F.trueupForm({ buckets: ['cash', 'chips', 'ship'], tracked: compute(active()).balances }, d => addEntry(entry('trueup', d))),

  edit: el => {
    const c = active();
    const e = c && c.entries.find(x => x.id === el.dataset.id);
    if (!e || viewed() !== c) return;
    const del = () => F.confirmSheet('Delete this entry?', 'It will be removed and every total will be recalculated.', 'Delete', () => deleteEntry(e.id));
    if (e.type === 'session') {
      F.sessionEditForm(e, { games: games(), slotNames: slotNames(state.cruises) }, d => {
        const { newNote, ...rest } = d;
        if (newNote) rest.notes.push({ ts: Date.now(), text: newNote });
        patchEntry(e.id, rest);
      }, del);
    } else if (e.type === 'trueup') {
      const snap = compute(c).snapshots[e.id];
      const buckets = ['cash', 'chips', 'ship', 'lockbox'].filter(b => b !== 'lockbox' || e.counts.lockbox != null);
      F.trueupForm({ buckets, tracked: snap, entry: e, title: 'Edit true-up' }, d => patchEntry(e.id, d), del);
    } else if (e.type === 'lock') {
      F.lockForm(e, 0, d => patchEntry(e.id, d), del);
    } else {
      F.moveForm(e, e.type, d => { const { type, ...rest } = d; patchEntry(e.id, rest); }, del);
    }
  },

  'end-cruise': () => {
    const c = active();
    if (!c) return;
    if (activeSession()) return F.infoSheet('Session still running', 'End your current session on the Home tab before ending the cruise.');
    F.trueupForm({
      buckets: ['cash', 'chips', 'ship', 'lockbox'], tracked: compute(c).balances, title: 'End cruise', submit: 'End cruise',
      intro: 'One last count, including the lockbox. After this the cruise is finished and read-only.',
    }, d => {
      c.entries.push(entry('trueup', d));
      c.status = 'finished';
      if (!c.endDate) c.endDate = dayKey(Date.now());
      state.activeCruiseId = null;
      commit();
    });
  },
  reopen: el => {
    if (active()) return;
    const c = state.cruises.find(x => x.id === el.dataset.id);
    if (c) { c.status = 'active'; state.activeCruiseId = c.id; commit(); }
  },
  'delete-cruise': el => {
    const c = state.cruises.find(x => x.id === el.dataset.id);
    if (!c || c.status !== 'finished') return;
    F.confirmSheet('Delete this cruise?', `"${c.name}" and its ${c.entries.length} entries will be removed for good. Export a backup first if you might want it later.`, 'Delete cruise',
      () => { state.cruises = state.cruises.filter(x => x.id !== c.id); commit(); });
  },
  'view-cruise': el => { viewCruiseId = el.dataset.id; view = 'history'; render(); window.scrollTo(0, 0); },
  'view-current': () => { viewCruiseId = null; go('cruises'); },

  'add-game': () => F.textForm('Add a game type', 'Name', 'Add', t => {
    if (!games().some(g => g.toLowerCase() === t.toLowerCase())) state.customGames.push(t);
    commit();
  }),

  backup: async () => {
    const at = Date.now();
    const how = await shareFile(`bankroll-backup-${dayKey(at)}.json`, serialize({ ...state, lastBackupAt: at }), 'application/json');
    const mark = () => { state.lastBackupAt = at; commit(); };
    if (how === 'shared') mark();
    // A plain download cannot be confirmed by the app, so ask before turning the reminder off.
    else if (how === 'downloaded') F.confirmSheet('Did the backup save?', 'Check that the backup file is in your Files or Downloads. If it is, tap Yes. If not, try again.', 'Yes, it saved', mark, false);
  },
  'export-damaged': () => { const raw = getDamaged(); if (raw) shareFile('bankroll-unreadable-data.json', raw, 'application/json'); },
  'clear-damaged': () => F.confirmSheet('Clear unreadable data?', 'Only do this after exporting it, or if you are sure you do not need it.', 'Clear it', () => { clearDamaged(); render(); }),
  restore: () => $('restore-file').click(),
  'csv-one': () => { const c = active(); if (c) shareFile(`bankroll-${slug(c.name)}.csv`, toCSV([c]), 'text/csv'); },
  'csv-all': () => shareFile('bankroll-all-cruises.csv', toCSV(state.cruises), 'text/csv'),
};

async function onRestoreFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let text = '';
  try { text = await file.text(); } catch { /* handled below */ }
  const r = parseBackup(text);
  if (!r.ok) return F.infoSheet('Could not restore', r.error + ' Nothing was changed.');
  const count = s => `${s.cruises.length} ${s.cruises.length === 1 ? 'cruise' : 'cruises'} and ${s.cruises.reduce((n, c) => n + c.entries.length, 0)} entries`;
  F.confirmSheet('Replace everything?', `This phone now has ${count(state)}. The backup has ${count(r.state)}. Restoring replaces what is on this phone.`, 'Replace',
    () => { state = r.state; viewCruiseId = null; view = 'home'; commit(); });
}

async function offlineStatus() {
  let ready = false;
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) ready = (await caches.keys()).some(k => k.startsWith('cbt-'));
    else if ('serviceWorker' in navigator) { await navigator.serviceWorker.ready; ready = (await caches.keys()).some(k => k.startsWith('cbt-')); }
  } catch { /* stays false */ }
  const el = $('offline-status');
  if (el) el.textContent = ready ? 'Ready to use offline on this device.' : 'Not ready for offline yet. Open the app once with internet, then check here again.';
}

// ---------- boot ----------
document.addEventListener('click', ev => {
  const nav = ev.target.closest('nav [data-view]');
  if (nav) return go(nav.dataset.view);
  const el = ev.target.closest('[data-act]');
  if (el && !el.disabled && actions[el.dataset.act]) actions[el.dataset.act](el);
});
$('restore-file').addEventListener('change', ev => onRestoreFile(ev.target));

setInterval(() => {
  const el = $('elapsed');
  if (el) el.textContent = V.elapsed(Date.now() - Number(el.dataset.start));
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !document.body.classList.contains('sheet-open')) render(); });

render();
showError(loadError);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

// Exposed for the browser test only.
window.__cbt = { getState: () => state, parseBackup, serialize };
