// Entry forms shown as a sheet. Each form calls done(data) with plain data, or the sheet is cancelled.
import { parseMoney, formatMoney, BUCKET_LABEL } from './ledger.js';
import { esc, TAG_LABEL } from './views.js';

class FormError extends Error {}
const fail = msg => { throw new FormError(msg); };

const plain = c => (c == null ? '' : (c / 100).toFixed(2));
const field = (label, inner, hint = '') => `<label class="field"><span>${label}</span>${inner}${hint ? `<small>${hint}</small>` : ''}</label>`;
const moneyIn = (name, val = '', attrs = '') => `<input name="${name}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(val)}" ${attrs}>`;
const textIn = (name, val = '', attrs = '') => `<input name="${name}" type="text" autocomplete="off" value="${esc(val)}" ${attrs}>`;
const select = (name, opts, val) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const HELD = [['cash', 'Cash'], ['chips', 'Chips'], ['ship', 'Ship account']];
const SOURCES = [...HELD, ['card', 'Card charge']];

function money(fd, name, label, { zero = false, optional = false } = {}) {
  const raw = String(fd.get(name) ?? '').trim();
  if (!raw) { if (optional) return null; fail(`Enter an amount for ${label}.`); }
  const c = parseMoney(raw);
  if (c === null) fail(`${label}: "${raw}" is not a dollar amount. Use numbers like 50 or 50.25.`);
  if (c === 0 && !zero) fail(`${label} must be more than zero.`);
  return c;
}

const pad = n => String(n).padStart(2, '0');
const toLocal = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Keeps the original seconds when the time was not changed, so edits do not reorder entries.
function timeFrom(fd, name, original, label) {
  const raw = String(fd.get(name) || '');
  if (original != null && raw === toLocal(original)) return original;
  const ts = new Date(raw).getTime();
  if (!Number.isFinite(ts)) fail(`Pick a valid ${label}.`);
  if (ts > Date.now() + 60000) fail(`The ${label} cannot be in the future.`);
  return ts;
}
const timeField = (name, ts, label = 'Date and time') => field(label, `<input name="${name}" type="datetime-local" value="${toLocal(ts)}">`);

let closeCurrent = null;
export const closeSheet = () => { if (closeCurrent) closeCurrent(); };

export function openSheet({ title, body, submit = 'Save', onSubmit, onDelete = null, deleteLabel = 'Delete', onOpen = null, cancel = 'Cancel' }) {
  closeSheet();
  const host = document.getElementById('sheet');
  host.innerHTML = `<div class="scrim"></div>
    <form class="sheet" novalidate role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>
      ${body}
      <p class="err" role="alert" hidden></p>
      <div class="btns">
        <button type="button" data-cancel>${esc(cancel)}</button>
        ${onSubmit ? `<button type="submit" class="primary">${esc(submit)}</button>` : ''}
      </div>
      ${onDelete ? `<button type="button" class="danger wide" data-delete>${esc(deleteLabel)}</button>` : ''}
    </form>`;
  host.hidden = false;
  document.body.classList.add('sheet-open');
  const form = host.querySelector('form'), err = host.querySelector('.err');
  const close = () => { host.hidden = true; host.innerHTML = ''; document.body.classList.remove('sheet-open'); closeCurrent = null; };
  closeCurrent = close;
  host.querySelector('[data-cancel]').onclick = close;
  if (onDelete) host.querySelector('[data-delete]').onclick = () => { close(); onDelete(); };
  form.onsubmit = ev => {
    ev.preventDefault();
    if (!onSubmit) return close();
    try { onSubmit(new FormData(form), form); close(); }
    catch (e) {
      if (!(e instanceof FormError)) throw e;
      err.textContent = e.message; err.hidden = false; err.scrollIntoView({ block: 'nearest' });
    }
  };
  if (onOpen) onOpen(form);
  const first = form.querySelector('input:not([type=hidden]):not([type=radio]):not([type=datetime-local]), textarea');
  if (first) first.focus();
}

export function confirmSheet(title, message, label, onYes, danger = true) {
  openSheet({ title, body: `<p>${esc(message)}</p>`, submit: label, onSubmit: () => onYes() });
  if (danger) document.querySelector('#sheet button[type=submit]').classList.add('danger');
}

export function infoSheet(title, message) {
  openSheet({ title, body: `<p>${esc(message)}</p>`, cancel: 'OK', onSubmit: null });
}

// ---------- cruise ----------
export function cruiseForm(cr, done) {
  const L = cr ? cr.limits : {};
  openSheet({
    title: cr ? 'Cruise details' : 'Start a cruise', submit: cr ? 'Save' : 'Start',
    body: field('Name', textIn('name', cr ? cr.name : '', 'placeholder="Alaska, May 2027" maxlength="60"'))
      + `<div class="two">${field('Start date', `<input name="startDate" type="date" value="${esc(cr ? cr.startDate : '')}">`)}${field('End date', `<input name="endDate" type="date" value="${esc(cr ? cr.endDate : '')}">`)}</div>`
      + limitFields(L),
    onSubmit: fd => {
      const name = String(fd.get('name') || '').trim();
      if (!name) fail('Give the cruise a name.');
      done({ name, startDate: String(fd.get('startDate') || ''), endDate: String(fd.get('endDate') || ''), limits: readLimits(fd) });
    },
  });
}

const limitFields = L => `<p class="small">Budget limits are optional. Leave blank for none.</p>
  ${field('Trip limit', moneyIn('trip', plain(L.trip)), 'Most you want to take out of pocket all trip')}
  ${field('Daily limit', moneyIn('daily', plain(L.daily)), 'Most out of pocket in one day')}
  ${field('Per-session limit', moneyIn('session', plain(L.session)), 'Most to buy in for at one sitting')}`;
const readLimits = fd => ({
  trip: money(fd, 'trip', 'Trip limit', { optional: true, zero: true }) || null,
  daily: money(fd, 'daily', 'Daily limit', { optional: true, zero: true }) || null,
  session: money(fd, 'session', 'Per-session limit', { optional: true, zero: true }) || null,
});

export function limitsForm(cr, done) {
  openSheet({ title: 'Budget limits', body: limitFields(cr.limits), onSubmit: fd => done(readLimits(fd)) });
}

export function textForm(title, label, submit, done, { multiline = false, value = '' } = {}) {
  openSheet({
    title, submit,
    body: field(label, multiline ? `<textarea name="text" rows="3" maxlength="500">${esc(value)}</textarea>` : textIn('text', value, 'maxlength="40"')),
    onSubmit: fd => { const t = String(fd.get('text') || '').trim(); if (!t) fail('Type something first.'); done(t); },
  });
}

// ---------- money movement ----------
const MOVE_KINDS = [['start_cash', 'Starting cash'], ['atm', 'ATM'], ['card_charge', 'Card charge'], ['transfer', 'Transfer']];
const MOVE_HELP = {
  start_cash: 'Cash you brought from home.',
  atm: 'Cash withdrawn from an ATM.',
  card_charge: 'Money added to your ship account and billed to your card.',
  transfer: 'Move money between cash, chips and your ship account.',
};

export function moveForm(entry, defaultKind, done, onDelete) {
  const kind0 = entry ? entry.type : defaultKind;
  openSheet({
    title: entry ? 'Edit entry' : 'Move money',
    onDelete, deleteLabel: 'Delete this entry',
    body: (entry ? `<input type="hidden" name="kind" value="${kind0}">` : `<div class="seg" role="radiogroup">${MOVE_KINDS.map(([v, l]) => `<label><input type="radio" name="kind" value="${v}" ${v === kind0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`)
      + '<p class="small" data-help></p>'
      + `<div data-only="transfer" class="two">${field('From', select('from', HELD, entry?.from || 'cash'))}${field('To', select('to', HELD, entry?.to || 'chips'))}</div>`
      + field('Amount', moneyIn('amount', plain(entry?.amount)))
      + `<div data-only="atm">${field('ATM fee', moneyIn('fee', entry?.fee ? plain(entry.fee) : ''), 'Optional')}</div>`
      + (entry ? timeField('ts', entry.ts) : '')
      + field('Note', textIn('note', entry?.note || '', 'maxlength="200"'), 'Optional'),
    onOpen: form => {
      const sync = () => {
        const k = new FormData(form).get('kind');
        form.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== k; });
        form.querySelector('[data-help]').textContent = MOVE_HELP[k];
      };
      form.addEventListener('change', sync); sync();
    },
    onSubmit: fd => {
      const type = fd.get('kind'), out = { type, amount: money(fd, 'amount', 'Amount'), note: String(fd.get('note') || '').trim() };
      if (type === 'atm') out.fee = money(fd, 'fee', 'ATM fee', { optional: true, zero: true }) || 0;
      if (type === 'transfer') {
        out.from = fd.get('from'); out.to = fd.get('to');
        if (out.from === out.to) fail('Pick two different places for From and To.');
      }
      if (entry) out.ts = timeFrom(fd, 'ts', entry.ts, 'date and time');
      done(out);
    },
  });
}

export function lockForm(entry, cash, done, onDelete) {
  openSheet({
    title: entry ? 'Edit lock away' : 'Lock away', submit: entry ? 'Save' : 'Lock it away',
    onDelete, deleteLabel: 'Delete this entry',
    body: `<p class="small">Moves cash into the lockbox. It stays there until the cruise ends.${entry ? '' : ` You have ${formatMoney(cash)} in cash.`}</p>`
      + field('Amount', moneyIn('amount', plain(entry?.amount)))
      + (entry ? timeField('ts', entry.ts) : '')
      + field('Note', textIn('note', entry?.note || '', 'maxlength="200"'), 'Optional'),
    onSubmit: fd => {
      const out = { amount: money(fd, 'amount', 'Amount'), note: String(fd.get('note') || '').trim() };
      if (entry) out.ts = timeFrom(fd, 'ts', entry.ts, 'date and time');
      done(out);
    },
  });
}

// ---------- sessions ----------
const gameFields = (games, slotNames, game, slotName) =>
  field('Game', select('game', games.map(g => [g, g]), game))
  + `<div data-only-game="Slots">${field('Slot name', textIn('slotName', slotName || '', 'list="slot-names" maxlength="60" placeholder="Buffalo Gold"'), 'Optional')}
     <datalist id="slot-names">${slotNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>`;
const syncGame = form => {
  const g = form.elements.game.value;
  form.querySelectorAll('[data-only-game]').forEach(el => { el.hidden = el.dataset.onlyGame !== g; });
};
const readGame = fd => ({ game: String(fd.get('game')), slotName: fd.get('game') === 'Slots' ? String(fd.get('slotName') || '').trim().replace(/\s+/g, ' ') : '' });

export function sessionNewForm({ games, slotNames }, done) {
  openSheet({
    title: 'Session', submit: 'Start',
    body: `<div class="seg" role="radiogroup">
        <label><input type="radio" name="mode" value="live" checked><span>Start now</span></label>
        <label><input type="radio" name="mode" value="done"><span>Already played</span></label></div>`
      + gameFields(games, slotNames, games[0], '')
      + `<div class="two">${field('Buy-in', moneyIn('amount'))}${field('From', select('source', SOURCES, 'ship'))}</div>`
      + `<div data-only-mode="done">
          <div class="two">${field('Walked away with', moneyIn('out'))}${field('Went to', select('dest', HELD, 'ship'))}</div>
          ${field('Minutes played', '<input name="minutes" inputmode="numeric" autocomplete="off">', 'Optional')}
          ${field('Note', textIn('note', '', 'maxlength="200"'), 'Optional')}
        </div>`,
    onOpen: form => {
      const sync = ev => {
        syncGame(form);
        const mode = form.elements.mode.value;
        form.querySelectorAll('[data-only-mode]').forEach(el => { el.hidden = el.dataset.onlyMode !== mode; });
        form.querySelector('button[type=submit]').textContent = mode === 'live' ? 'Start' : 'Save';
        if (!ev || ev.target.name === 'game') {
          const slots = ['Slots', 'Video poker'].includes(form.elements.game.value);
          form.elements.source.value = slots ? 'ship' : 'cash';
          form.elements.dest.value = slots ? 'ship' : 'chips';
        }
      };
      form.addEventListener('change', sync); sync();
    },
    onSubmit: fd => {
      const out = { mode: fd.get('mode'), ...readGame(fd), amount: money(fd, 'amount', 'Buy-in'), source: fd.get('source') };
      if (out.mode === 'done') {
        out.cashOut = { amount: money(fd, 'out', 'Walked away with', { zero: true }), dest: fd.get('dest') };
        const mins = String(fd.get('minutes') || '').trim();
        if (mins && !/^\d{1,4}$/.test(mins)) fail('Minutes played should be a whole number.');
        out.minutes = mins ? Number(mins) : null;
        out.note = String(fd.get('note') || '').trim();
      }
      done(out);
    },
  });
}

export function buyInForm(session, done) {
  const last = session.buyIns[session.buyIns.length - 1];
  openSheet({
    title: 'Add buy-in', submit: 'Add',
    body: `<div class="two">${field('Amount', moneyIn('amount'))}${field('From', select('source', SOURCES, last ? last.source : 'cash'))}</div>`,
    onSubmit: fd => done({ amount: money(fd, 'amount', 'Amount'), source: fd.get('source') }),
  });
}

export function sessionEndForm(session, buyIn, done) {
  const slots = ['Slots', 'Video poker'].includes(session.game);
  openSheet({
    title: 'End session', submit: 'End session',
    body: `<p class="small">You bought in for ${formatMoney(buyIn)}. Enter 0 if you walked away with nothing.</p>`
      + `<div class="two">${field('Walked away with', moneyIn('out'))}${field('Went to', select('dest', HELD, slots ? 'ship' : 'chips'))}</div>`
      + field('Final note', textIn('note', '', 'maxlength="200"'), 'Optional'),
    onSubmit: fd => done({ cashOut: { amount: money(fd, 'out', 'Walked away with', { zero: true }), dest: fd.get('dest') }, note: String(fd.get('note') || '').trim() }),
  });
}

export function sessionEditForm(s, { games, slotNames }, done, onDelete) {
  const gameList = games.includes(s.game) ? games : [...games, s.game];
  const buyRow = (b, i) => `<div class="rowedit" data-row>
      <input type="hidden" name="bi_ts" value="${b.ts ?? ''}">
      ${moneyIn('bi_amount', plain(b.amount), 'aria-label="Buy-in amount"')}
      ${select('bi_source', SOURCES, b.source)}
      <button type="button" class="x" data-remove aria-label="Remove buy-in">×</button></div>`;
  const noteRow = n => `<div class="rowedit" data-row>
      <input type="hidden" name="n_ts" value="${n.ts}">
      ${textIn('n_text', n.text, 'maxlength="500" aria-label="Note"')}
      <button type="button" class="x" data-remove aria-label="Remove note">×</button></div>`;
  openSheet({
    title: 'Edit session', onDelete, deleteLabel: 'Delete this session',
    body: gameFields(gameList, slotNames, s.game, s.slotName)
      + `<fieldset><legend>Buy-ins</legend><div data-buyins>${s.buyIns.map(buyRow).join('')}</div>
         <button type="button" class="link" data-add-buyin>Add another buy-in</button></fieldset>`
      + (s.cashOut ? `<div class="two">${field('Walked away with', moneyIn('out', plain(s.cashOut.amount)))}${field('Went to', select('dest', HELD, s.cashOut.dest))}</div>` : '')
      + timeField('ts', s.ts, 'Started')
      + (s.cashOut ? timeField('end', s.end, 'Ended') + `<label class="check"><input type="checkbox" name="durationKnown" ${s.durationKnown ? 'checked' : ''}> Count the time played</label>` : '')
      + (s.notes.length ? `<fieldset><legend>Notes</legend>${s.notes.map(noteRow).join('')}</fieldset>` : '')
      + field('Add a note', textIn('newNote', '', 'maxlength="500"'), 'Optional'),
    onOpen: form => {
      syncGame(form);
      form.addEventListener('change', () => syncGame(form));
      form.addEventListener('click', ev => {
        if (ev.target.matches('[data-remove]')) ev.target.closest('[data-row]').remove();
        if (ev.target.matches('[data-add-buyin]')) form.querySelector('[data-buyins]').insertAdjacentHTML('beforeend', buyRow({ amount: null, source: 'cash', ts: '' }, 0));
      });
    },
    onSubmit: (fd, form) => {
      const ts = timeFrom(fd, 'ts', s.ts, 'start time');
      const amounts = fd.getAll('bi_amount'), sources = fd.getAll('bi_source'), tss = fd.getAll('bi_ts');
      if (!amounts.length) fail('A session needs at least one buy-in.');
      const buyIns = amounts.map((a, i) => {
        const c = parseMoney(a);
        if (!c) fail('Each buy-in needs an amount more than zero.');
        // A buy-in logged at the old start time moves with the start time.
        const old = Number(tss[i]);
        return { amount: c, source: sources[i], ts: tss[i] === '' || old === s.ts ? ts : Math.max(old, ts) };
      });
      const nts = fd.getAll('n_ts'), ntext = fd.getAll('n_text');
      const notes = ntext.map((t, i) => ({ ts: Number(nts[i]), text: String(t).trim() })).filter(n => n.text);
      const extra = String(fd.get('newNote') || '').trim();
      const out = { ...readGame(fd), ts, buyIns, notes, newNote: extra };
      if (s.cashOut) {
        out.cashOut = { amount: money(fd, 'out', 'Walked away with', { zero: true }), dest: fd.get('dest') };
        out.end = timeFrom(fd, 'end', s.end, 'end time');
        if (out.end < ts) fail('The end time is before the start time.');
        out.durationKnown = form.elements.durationKnown.checked;
      }
      done(out);
    },
  });
}

// ---------- true-up ----------
// buckets: which to ask for; tracked: balances the app expects; entry: existing true-up when editing.
export function trueupForm({ buckets, tracked, entry = null, title = 'True-up', submit = 'Save', intro }, done, onDelete) {
  const row = b => `<div class="tu" data-bucket="${b}" data-tracked="${tracked[b]}">
      ${field(BUCKET_LABEL[b], moneyIn('count_' + b, entry && entry.counts[b] != null ? plain(entry.counts[b]) : ''), `App shows ${formatMoney(tracked[b])}`)}
      <div class="gap" hidden><p data-gapmsg></p>
        <div class="seg wrap" role="radiogroup">${['loss', 'win', 'spending', 'unknown'].map(t => `<label data-tag="${t}"><input type="radio" name="tag_${b}" value="${t}" ${entry?.tags?.[b] === t ? 'checked' : ''}><span>${TAG_LABEL[t]}</span></label>`).join('')}</div>
      </div></div>`;
  openSheet({
    title, submit, onDelete, deleteLabel: 'Delete this true-up',
    body: `<p class="small">${esc(intro || 'Count what you actually have. Leave a box blank to skip it.')}</p>` + buckets.map(row).join('') + (entry ? timeField('ts', entry.ts) : '') + field('Note', textIn('note', entry?.note || '', 'maxlength="200"'), 'Optional'),
    onOpen: form => {
      const sync = () => form.querySelectorAll('.tu').forEach(el => {
        const raw = el.querySelector('input').value.trim(), c = parseMoney(raw), gapEl = el.querySelector('.gap');
        const gap = c === null ? 0 : c - Number(el.dataset.tracked);
        gapEl.hidden = gap === 0;
        if (gap === 0) return;
        el.querySelector('[data-gapmsg]').textContent = `${formatMoney(Math.abs(gap))} ${gap < 0 ? 'short' : 'over'}. What was it?`;
        const allowed = gap < 0 ? ['loss', 'spending', 'unknown'] : ['win', 'unknown'];
        el.querySelectorAll('[data-tag]').forEach(l => {
          const ok = allowed.includes(l.dataset.tag);
          l.hidden = !ok;
          if (!ok) l.querySelector('input').checked = false;
        });
      });
      form.addEventListener('input', sync); sync();
    },
    onSubmit: fd => {
      const counts = {}, tags = {};
      for (const b of buckets) {
        const c = money(fd, 'count_' + b, BUCKET_LABEL[b], { optional: true, zero: true });
        if (c === null) continue;
        counts[b] = c;
        if (c !== tracked[b]) {
          const t = fd.get('tag_' + b);
          if (!t) fail(`${BUCKET_LABEL[b]} is off by ${formatMoney(Math.abs(c - tracked[b]))}. Pick what the difference was.`);
          tags[b] = t;
        }
      }
      if (!Object.keys(counts).length) fail('Enter at least one count.');
      const out = { counts, tags, note: String(fd.get('note') || '').trim() };
      if (entry) out.ts = timeFrom(fd, 'ts', entry.ts, 'date and time');
      done(out);
    },
  });
}
