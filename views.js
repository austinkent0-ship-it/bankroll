// Screens. Each function returns an HTML string; all user text goes through esc().
import {
  compute, budgetStatus, lifetime, cruiseSummary, formatMoney, formatDuration,
  sessionBuyIn, sessionResult, sessionMs, BUCKET_LABEL, dayKey,
} from './ledger.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const TAG_LABEL = { win: 'Untracked win', loss: 'Untracked loss', spending: 'Tips / spending', unknown: 'Unknown' };

const tone = c => (c > 0 ? 'up' : c < 0 ? 'down' : 'flat');
const signed = c => `<span class="num ${tone(c)}">${formatMoney(c, { sign: true })}</span>`;
const clock = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayLabel = ts => new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const elapsed = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const gameTitle = s => esc(s.game) + (s.game === 'Slots' && s.slotName ? ' · ' + esc(s.slotName) : '');

const activeCruise = state => state.cruises.find(c => c.id === state.activeCruiseId) || null;

function budgetBar(label, b) {
  if (!b) return '';
  const pct = Math.min(100, Math.round((b.used / b.limit) * 100));
  const msg = b.left >= 0 ? formatMoney(b.left) + ' left' : formatMoney(-b.left) + ' over';
  const word = b.level === 'over' ? 'Limit reached' : b.level === 'caution' ? 'Getting close' : '';
  return `<div class="budget ${b.level}">
    <div class="row"><span>${label}</span><span class="num">${formatMoney(b.used)} of ${formatMoney(b.limit)}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="row small"><span class="flag">${word}</span><span class="num">${msg}</span></div>
  </div>`;
}

function sessionCard(s, budget, now) {
  const notes = s.notes.length
    ? `<ul class="notes">${s.notes.map(n => `<li><time>${clock(n.ts)}</time> ${esc(n.text)}</li>`).join('')}</ul>` : '';
  return `<section class="card live" aria-label="Session in progress">
    <div class="row"><span class="eyebrow">Playing now</span><span class="num timer" id="elapsed" data-start="${s.ts}">${elapsed(now - s.ts)}</span></div>
    <h2>${gameTitle(s)}</h2>
    <div class="row"><span>Bought in</span><span class="num">${formatMoney(sessionBuyIn(s))}</span></div>
    ${budgetBar('Session limit', budget.session)}
    ${notes}
    <div class="btns">
      <button data-act="note">Add note</button>
      <button data-act="buyin">Add buy-in</button>
      <button class="primary span" data-act="end-session">End session</button>
    </div>
  </section>`;
}

export function home(state, now) {
  const cr = activeCruise(state);
  if (!cr) {
    const any = state.cruises.length > 0;
    return `<section class="empty">
      <h1>${any ? 'No cruise in progress' : 'Bankroll tracker'}</h1>
      <p>${any ? 'Start a new cruise to begin tracking again. Your past cruises are under Cruises.' : 'Track your casino money on the ship: what you took out, where it is now, and how each game went.'}</p>
      ${any ? '' : '<p class="small">Before you sail: open this from the home-screen icon once with internet, then try it in airplane mode.</p>'}
      <button class="primary big" data-act="new-cruise">Start a cruise</button>
    </section>`;
  }
  const c = compute(cr), b = budgetStatus(cr, c, now);
  const bucket = (key, extra = '') => {
    const v = c.balances[key];
    return `<div class="tile ${v < 0 ? 'neg' : ''}">
      <span class="label">${BUCKET_LABEL[key]}</span>
      <span class="num amount">${formatMoney(v)}</span>
      <span class="small">${v < 0 ? 'Below zero. Do a true-up.' : extra}</span>
    </div>`;
  };
  const other = c.leakage.total;
  const stale = cr.entries.length && (!state.lastBackupAt || (now - state.lastBackupAt > 24 * 3600 * 1000 && cr.entries.some(e => e.ts > state.lastBackupAt)));
  return `
    <section class="hero">
      <span class="eyebrow">Trip net</span>
      <div class="num net ${tone(c.tripNet)}" id="trip-net">${formatMoney(c.tripNet, { sign: true })}</div>
      <div class="small">Gambling ${signed(c.gamblingNet)}${other ? ` · Fees and other <span class="num">${formatMoney(-other, { sign: true })}</span>` : ''}</div>
    </section>
    ${c.activeSession ? sessionCard(c.activeSession, b, now) : ''}
    <div class="btns grid">
      ${c.activeSession ? '' : '<button class="primary" data-act="session">Session</button>'}
      <button data-act="move">Move money</button>
      <button data-act="trueup">True-up</button>
      <button data-act="lock">Lock away</button>
    </div>
    <section class="card">
      <h2>Where the money is</h2>
      <div class="tiles">
        ${bucket('cash')}${bucket('chips')}${bucket('ship')}${bucket('lockbox', 'Out of play')}
      </div>
      ${c.inPlay ? `<div class="row"><span>In play right now</span><span class="num">${formatMoney(c.inPlay)}</span></div>` : ''}
      <div class="row total"><span>Total</span><span class="num" id="holdings">${formatMoney(c.holdings + c.inPlay)}</span></div>
    </section>
    <section class="card">
      <h2>Out of pocket</h2>
      <div class="row"><span>From ATM, card and starting cash</span><span class="num" id="oop">${formatMoney(c.outOfPocket)}</span></div>
      ${budgetBar('Trip limit', b.trip)}${budgetBar('Today', b.daily)}
      ${!cr.limits.trip && !cr.limits.daily && !cr.limits.session ? '<button class="link" data-act="limits">Set a budget</button>' : ''}
    </section>
    ${stale ? `<section class="card warn"><div class="row"><span>${state.lastBackupAt ? 'No backup in over a day.' : 'No backup yet.'}</span><button data-act="backup">Back up now</button></div></section>` : ''}`;
}

function entryRow(e, c, readOnly) {
  let title = '', amount = '', detail = '';
  const L = BUCKET_LABEL;
  if (e.type === 'start_cash') { title = 'Starting cash'; amount = formatMoney(e.amount); }
  else if (e.type === 'atm') { title = 'ATM withdrawal'; amount = formatMoney(e.amount); if (e.fee) detail = 'Fee ' + formatMoney(e.fee); }
  else if (e.type === 'card_charge') { title = 'Card charge to ship account'; amount = formatMoney(e.amount); }
  else if (e.type === 'transfer') { title = `${L[e.from]} to ${L[e.to]}`; amount = formatMoney(e.amount); }
  else if (e.type === 'lock') { title = 'Locked away'; amount = formatMoney(e.amount); }
  else if (e.type === 'session') {
    title = gameTitle(e);
    if (e.cashOut) {
      amount = signed(sessionResult(e));
      detail = `In ${formatMoney(sessionBuyIn(e))} · Out ${formatMoney(e.cashOut.amount)}` + (e.durationKnown ? ' · ' + formatDuration(sessionMs(e)) : '');
    } else { amount = '<span class="pill">Playing</span>'; detail = `In ${formatMoney(sessionBuyIn(e))}`; }
    if (e.notes.length) detail += `<ul class="notes">${e.notes.map(n => `<li><time>${clock(n.ts)}</time> ${esc(n.text)}</li>`).join('')}</ul>`;
  } else if (e.type === 'trueup') {
    title = 'True-up';
    const gaps = c.gaps.filter(g => g.entryId === e.id);
    detail = gaps.length
      ? gaps.map(g => `${L[g.bucket]}: ${formatMoney(Math.abs(g.gap))} ${g.gap < 0 ? 'short' : 'over'} · ${TAG_LABEL[g.tag]}`).join('<br>')
      : 'Everything matched';
  }
  const note = e.note ? `<div class="small">${esc(e.note)}</div>` : '';
  const tag = readOnly ? 'div' : 'button';
  return `<${tag} class="entry" ${readOnly ? '' : `data-act="edit" data-id="${esc(e.id)}"`}>
    <span class="when">${clock(e.ts)}</span>
    <span class="what"><strong>${title}</strong>${detail ? `<span class="small">${detail}</span>` : ''}${note}</span>
    <span class="num amt">${amount}</span>
  </${tag}>`;
}

const viewBanner = (state, cr) => (cr && cr.id !== state.activeCruiseId
  ? `<div class="banner">Viewing ${esc(cr.name)} (finished, read-only) <button class="link" data-act="view-current">Close</button></div>` : '');

export function history(state, cr) {
  if (!cr) return '<section class="empty"><p>No cruise to show yet.</p></section>';
  const c = compute(cr), readOnly = cr.status === 'finished';
  const entries = [...cr.entries].sort((a, b) => b.ts - a.ts);
  if (!entries.length) return viewBanner(state, cr) + '<section class="empty"><h1>History</h1><p>Nothing logged yet. Start with Move money on the Home tab to add your starting cash.</p></section>';
  let html = viewBanner(state, cr) + `<h1 class="page">History</h1><p class="small pad" id="entry-count">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${readOnly ? '' : ' · tap one to edit'}</p>`, day = '';
  for (const e of entries) {
    const k = dayKey(e.ts);
    if (k !== day) { if (day) html += '</section>'; day = k; html += `<section class="card list"><h2>${dayLabel(e.ts)}</h2>`; }
    html += entryRow(e, c, readOnly);
  }
  return html + '</section>';
}

function gamesTable(byGame) {
  if (!byGame.length) return '<p class="small">No finished sessions yet.</p>';
  const row = (name, g, cls = '') => `<tr class="${cls}"><td>${name}</td><td class="num">${g.sessions}</td><td class="num">${g.ms ? formatDuration(g.ms) : '–'}</td><td class="num">${signed(g.net)}</td></tr>`;
  return `<table><thead><tr><th>Game</th><th class="num">Sessions</th><th class="num">Time</th><th class="num">Net</th></tr></thead><tbody>
    ${byGame.map(g => row(esc(g.game), g) + (g.slots || []).map(s => row(esc(s.name), s, 'sub')).join('')).join('')}
  </tbody></table>`;
}

export function games(state, cr) {
  if (!cr) return '<section class="empty"><p>No cruise to show yet.</p></section>';
  const c = compute(cr);
  return `${viewBanner(state, cr)}<h1 class="page">By game</h1>
    <section class="card" id="games-card">${gamesTable(c.byGame)}
      ${c.untracked ? `<div class="row total"><span>Untracked, from true-ups</span>${signed(c.untracked)}</div>` : ''}
      <div class="row total"><span>Gambling net</span>${signed(c.gamblingNet)}</div>
    </section>`;
}

export function cruises(state) {
  const active = activeCruise(state);
  const finished = state.cruises.filter(c => c.status === 'finished').sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));
  const dates = c => [c.startDate, c.endDate].filter(Boolean).join(' to ');
  const card = (c, body) => {
    const s = cruiseSummary(c);
    return `<section class="card">
      <div class="row"><h2>${esc(c.name)}</h2>${signed(s.net)}</div>
      <p class="small">${esc(dates(c))}${dates(c) ? ' · ' : ''}Out of pocket ${formatMoney(s.outOfPocket)} · ${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'}${s.ms ? ' · ' + formatDuration(s.ms) : ''}</p>
      ${body}
    </section>`;
  };
  const L = lifetime(state.cruises);
  return `<h1 class="page">Cruises</h1>
    ${active ? card(active, `<div class="btns"><button data-act="edit-cruise">Edit details</button><button data-act="end-cruise">End cruise</button></div>`)
      : '<button class="primary big" data-act="new-cruise">Start a new cruise</button>'}
    ${finished.length ? '<h2 class="section">Finished</h2>' : ''}
    ${finished.map(c => card(c, `<div class="btns three">
        <button data-act="view-cruise" data-id="${esc(c.id)}">View</button>
        <button data-act="reopen" data-id="${esc(c.id)}" ${active ? 'disabled title="End the current cruise first"' : ''}>Reopen</button>
        <button class="danger" data-act="delete-cruise" data-id="${esc(c.id)}">Delete</button>
      </div>`)).join('')}
    ${state.cruises.length ? `<h2 class="section">Lifetime</h2>
    <section class="card" id="lifetime">
      <div class="row"><span>Trip net, all cruises</span>${signed(L.tripNet)}</div>
      <div class="row"><span>Gambling net</span>${signed(L.gamblingNet)}</div>
      <div class="row"><span>Out of pocket</span><span class="num">${formatMoney(L.outOfPocket)}</span></div>
      <div class="row"><span>Time played</span><span class="num">${L.ms ? formatDuration(L.ms) : '–'}</span></div>
      ${gamesTable(L.byGame)}
    </section>` : ''}`;
}

export function settings(state, games, damaged = false) {
  const cr = activeCruise(state);
  const lim = k => (cr && cr.limits[k] ? formatMoney(cr.limits[k]) : 'None');
  return `<h1 class="page">Settings</h1>
    <section class="card">
      <h2>Budget</h2>
      ${cr ? `<div class="row"><span>Trip limit</span><span class="num">${lim('trip')}</span></div>
      <div class="row"><span>Daily limit</span><span class="num">${lim('daily')}</span></div>
      <div class="row"><span>Per-session limit</span><span class="num">${lim('session')}</span></div>
      <div class="btns"><button data-act="limits">Change limits</button></div>` : '<p class="small">Start a cruise to set limits.</p>'}
    </section>
    <section class="card">
      <h2>Game types</h2>
      <p class="chips">${games.map(g => `<span class="pill">${esc(g)}</span>`).join(' ')}</p>
      <div class="btns"><button data-act="add-game">Add a game type</button></div>
    </section>
    <section class="card">
      <h2>Backup</h2>
      <p class="small">Your data lives only on this phone. Export a backup about once a day on the ship.
      ${state.lastBackupAt ? 'Last backup: ' + dayLabel(state.lastBackupAt) + ', ' + clock(state.lastBackupAt) + '.' : 'No backup yet.'}</p>
      <div class="btns"><button class="primary" data-act="backup">Export backup</button><button data-act="restore">Restore backup</button></div>
      ${damaged ? `<p class="err">Older saved data could not be read. Export it so it is not lost, then you can clear it.</p>
      <div class="btns"><button data-act="export-damaged">Export unreadable data</button><button class="danger" data-act="clear-damaged">Clear it</button></div>` : ''}
    </section>
    <section class="card">
      <h2>Offline</h2>
      <p id="offline-status" class="small">Checking…</p>
    </section>
    <section class="card">
      <h2>Spreadsheet</h2>
      <p class="small">A CSV file you can open in Excel or Numbers.</p>
      <div class="btns"><button data-act="csv-one" ${cr ? '' : 'disabled'}>This cruise</button><button data-act="csv-all" ${state.cruises.length ? '' : 'disabled'}>All cruises</button></div>
    </section>`;
}
