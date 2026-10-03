// All money math. Pure functions; amounts are integer cents.

export const BUCKETS = ['ship', 'cash', 'chips', 'lockbox'];
export const BUCKET_LABEL = { ship: 'Ship account', cash: 'Cash', chips: 'Chips', lockbox: 'Lockbox', card: 'Card charge' };
export const DEFAULT_GAMES = ['Slots', 'Blackjack', 'Craps', 'Roulette', 'Poker', 'Video poker', 'Other'];

export function parseMoney(str) {
  if (str === null || str === undefined) return null;
  const raw = String(str).trim().replace(/^\$/, '');
  // Commas are accepted only as thousands separators, so "12,50" is rejected rather than read as 1,250.
  if (raw.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(raw)) return null;
  const s = raw.replace(/,/g, '');
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatMoney(cents, { sign = false } = {}) {
  const abs = Math.abs(cents);
  const body = '$' + Math.floor(abs / 100).toLocaleString('en-US') + '.' + String(abs % 100).padStart(2, '0');
  if (cents < 0) return '-' + body;
  return sign && cents > 0 ? '+' + body : body;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export const normSlot = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
const displaySlot = name => String(name || '').trim().replace(/\s+/g, ' ');

export const sessionBuyIn = s => s.buyIns.reduce((sum, b) => sum + b.amount, 0);
export const sessionResult = s => (s.cashOut ? s.cashOut.amount - sessionBuyIn(s) : null);
export const sessionMs = s => (s.cashOut && s.durationKnown && s.end ? Math.max(0, s.end - s.ts) : 0);

function addGame(byGame, s) {
  let g = byGame.find(x => x.game === s.game);
  if (!g) { g = { game: s.game, net: 0, sessions: 0, ms: 0 }; if (s.game === 'Slots') g.slots = []; byGame.push(g); }
  const net = sessionResult(s), ms = sessionMs(s);
  g.net += net; g.sessions += 1; g.ms += ms;
  if (g.slots) {
    const key = normSlot(s.slotName);
    let sl = g.slots.find(x => x.key === key);
    if (!sl) { sl = { key, name: key ? displaySlot(s.slotName) : 'Unnamed', net: 0, sessions: 0, ms: 0 }; g.slots.push(sl); }
    sl.net += net; sl.sessions += 1; sl.ms += ms;
  }
}

const sortGames = byGame => {
  byGame.sort((a, b) => b.net - a.net);
  for (const g of byGame) if (g.slots) g.slots.sort((a, b) => b.net - a.net);
  return byGame;
};

export function compute(cruise) {
  const bal = { ship: 0, cash: 0, chips: 0, lockbox: 0 };
  const out = {
    balances: bal, holdings: 0, inPlay: 0, outOfPocket: 0, tripNet: 0, gamblingNet: 0, untracked: 0,
    leakage: { fees: 0, spending: 0, unknown: 0, total: 0 },
    byGame: [], byDay: [], activeSession: null, oopByDay: {}, gaps: [], snapshots: {},
  };
  const oop = (ts, amt) => {
    out.outOfPocket += amt;
    const k = dayKey(ts);
    out.oopByDay[k] = (out.oopByDay[k] || 0) + amt;
  };

  const day = ts => {
    const k = dayKey(ts);
    let d = out.byDay.find(x => x.day === k);
    if (!d) { d = { day: k, net: 0, sessions: 0, ms: 0, untracked: 0, games: [] }; out.byDay.push(d); }
    return d;
  };

  const events = [];
  cruise.entries.forEach((en, i) => {
    if (en.type === 'session') {
      en.buyIns.forEach((b, j) => events.push({ ts: b.ts ?? en.ts, i, j, kind: 'buyin', en, b }));
      if (en.cashOut) events.push({ ts: Math.max(en.end ?? en.ts, en.ts), i, j: 1e6, kind: 'cashout', en });
      else out.activeSession = en;
    } else events.push({ ts: en.ts, i, j: 0, kind: en.type, en });
  });
  events.sort((a, b) => a.ts - b.ts || a.i - b.i || a.j - b.j);

  for (const ev of events) {
    const en = ev.en;
    switch (ev.kind) {
      case 'start_cash': bal.cash += en.amount; oop(ev.ts, en.amount); break;
      case 'atm':
        bal.cash += en.amount; oop(ev.ts, en.amount + (en.fee || 0)); out.leakage.fees += en.fee || 0; break;
      case 'card_charge': bal.ship += en.amount; oop(ev.ts, en.amount); break;
      case 'transfer': bal[en.from] -= en.amount; bal[en.to] += en.amount; break;
      case 'lock': bal.cash -= en.amount; bal.lockbox += en.amount; break;
      case 'buyin':
        if (ev.b.source === 'card') oop(ev.ts, ev.b.amount); else bal[ev.b.source] -= ev.b.amount;
        if (!en.cashOut) out.inPlay += ev.b.amount;
        break;
      case 'cashout':
        bal[en.cashOut.dest] += en.cashOut.amount;
        out.gamblingNet += sessionResult(en);
        addGame(out.byGame, en);
        { // a session counts toward the day it started
          const d = day(en.ts);
          d.net += sessionResult(en); d.sessions += 1; d.ms += sessionMs(en);
          addGame(d.games, en);
        }
        break;
      case 'trueup':
        out.snapshots[en.id] = { ...bal };
        for (const bucket of BUCKETS) {
          const counted = en.counts[bucket];
          if (counted === undefined || counted === null) continue;
          const expected = bal[bucket], gap = counted - expected;
          bal[bucket] = counted;
          if (gap === 0) continue;
          const tag = (en.tags && en.tags[bucket]) || 'unknown';
          out.gaps.push({ entryId: en.id, bucket, expected, counted, gap, tag });
          if (tag === 'win' || tag === 'loss') { out.gamblingNet += gap; out.untracked += gap; const d = day(en.ts); d.net += gap; d.untracked += gap; }
          else if (tag === 'spending') out.leakage.spending -= gap;
          else out.leakage.unknown -= gap;
        }
        break;
    }
  }
  out.leakage.total = out.leakage.fees + out.leakage.spending + out.leakage.unknown;
  out.holdings = bal.ship + bal.cash + bal.chips + bal.lockbox;
  out.tripNet = out.holdings + out.inPlay - out.outOfPocket;
  sortGames(out.byGame);
  out.byDay.sort((a, b) => b.day.localeCompare(a.day));
  for (const d of out.byDay) sortGames(d.games);
  return out;
}

export const invariant = c => c.tripNet === c.gamblingNet - c.leakage.total;

function level(used, limit) {
  if (used >= limit) return 'over';
  return used >= 0.8 * limit ? 'caution' : 'ok';
}
const status = (limit, used) => ({ limit, used, left: limit - used, level: level(used, limit) });

export function budgetStatus(cruise, computed, now) {
  const L = cruise.limits || {};
  return {
    trip: L.trip ? status(L.trip, computed.outOfPocket) : null,
    daily: L.daily ? status(L.daily, computed.oopByDay[dayKey(now)] || 0) : null,
    session: L.session && computed.activeSession ? status(L.session, sessionBuyIn(computed.activeSession)) : null,
  };
}

export function cruiseSummary(cruise) {
  const c = compute(cruise);
  return {
    net: c.tripNet, gamblingNet: c.gamblingNet, outOfPocket: c.outOfPocket,
    ms: c.byGame.reduce((s, g) => s + g.ms, 0),
    sessions: c.byGame.reduce((s, g) => s + g.sessions, 0),
  };
}

export function lifetime(cruises) {
  const L = { gamblingNet: 0, tripNet: 0, outOfPocket: 0, ms: 0, sessions: 0, byGame: [] };
  for (const cr of cruises) {
    const c = compute(cr);
    L.gamblingNet += c.gamblingNet; L.tripNet += c.tripNet; L.outOfPocket += c.outOfPocket;
    for (const g of c.byGame) {
      L.ms += g.ms; L.sessions += g.sessions;
      let t = L.byGame.find(x => x.game === g.game);
      if (!t) { t = { game: g.game, net: 0, sessions: 0, ms: 0 }; if (g.slots) t.slots = []; L.byGame.push(t); }
      t.net += g.net; t.sessions += g.sessions; t.ms += g.ms;
      for (const s of g.slots || []) {
        let ts = t.slots.find(x => x.key === s.key);
        if (!ts) { ts = { key: s.key, name: s.name, net: 0, sessions: 0, ms: 0 }; t.slots.push(ts); }
        ts.net += s.net; ts.sessions += s.sessions; ts.ms += s.ms;
      }
    }
  }
  sortGames(L.byGame);
  return L;
}

export function slotNames(cruises) {
  const seen = new Map();
  const all = cruises.flatMap(c => c.entries).filter(e => e.type === 'session' && normSlot(e.slotName));
  all.sort((a, b) => b.ts - a.ts);
  for (const s of all) if (!seen.has(normSlot(s.slotName))) seen.set(normSlot(s.slotName), displaySlot(s.slotName));
  return [...seen.values()];
}

export function formatDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

// Latest moment anything happened in a cruise.
export function latestTs(cruise) {
  let t = -Infinity;
  for (const e of cruise.entries) {
    t = Math.max(t, e.ts);
    if (e.type === 'session') { for (const b of e.buyIns) t = Math.max(t, b.ts ?? e.ts); if (e.end) t = Math.max(t, e.end); }
  }
  return t;
}

// Timestamp for a new event: now, but never before something already logged
// (protects the order if the phone clock is set back for ship time).
export const stampNow = (cruise, now) => Math.max(now, latestTs(cruise) + 1);

// A session logged after the fact. Money moves at `stamp`; the start time is only for duration and display.
export function playedSession(d, stamp) {
  return {
    type: 'session', ts: d.minutes ? stamp - d.minutes * 60000 : stamp, note: '',
    game: d.game, slotName: d.slotName,
    buyIns: [{ amount: d.amount, source: d.source, ts: stamp }],
    cashOut: d.cashOut, end: stamp, durationKnown: d.minutes != null,
    notes: d.note ? [{ ts: stamp, text: d.note }] : [],
  };
}
