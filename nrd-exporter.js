/*
 * NRD Exporter — pulls firm + registered-individual data from the CSA National
 * Registration Search (info.securities-administrators.ca) and exports CSV.
 *
 * Runs inside your own browser tab on the NRD site (as a bookmarklet or pasted
 * into the DevTools console). It uses the same JSON endpoints the site's own
 * pages call, one request at a time at roughly one per second, and backs off
 * when the site says to slow down (HTTP 429). If the site asks for a reCAPTCHA,
 * you solve it on the search page — this tool never tries to get around it.
 *
 * Progress is saved in this browser (IndexedDB), so a stopped or interrupted
 * run can be resumed.
 */
(() => {
  const HOST = 'info.securities-administrators.ca';
  const BASE = 'https://' + HOST + '/nrsmobile/';
  if (location.hostname !== HOST) {
    if (confirm('NRD Exporter must run on the NRD site. Open the National Registration Search now?\n\n(Click the bookmarklet again once it loads.)'))
      location.href = BASE + 'nrssearch.aspx';
    return;
  }
  if (window.__nrdx) { window.__nrdx.show(); return; }

  const JURIS = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NF: 'Newfoundland and Labrador',
    NT: 'Northwest Territories', NS: 'Nova Scotia', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Québec',
    SK: 'Saskatchewan', YT: 'Yukon' };
  const JURIS_BY_NAME = Object.fromEntries(Object.entries(JURIS).map(([k, v]) => [v.toLowerCase(), k]));
  const jcode = name => JURIS_BY_NAME[name.toLowerCase()] || name;

  // ---------- state ----------
  // run: everything that is saved and resumed. S: live, per-tab status.
  const newRun = settings => ({ v: 1, settings, savedAt: 0, listDone: false, firms: [], reps: new Map(), tasksDone: new Set(), indiv: new Map(), finished: false });
  let R = null;
  const S = { running: false, stop: false, done: 0, total: 0, errors: 0, log: [] };

  // ---------- storage ----------
  const DB = {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('nrd-exporter', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }),
    async op(mode, fn) {
      const db = await DB.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); res(q.result); }; tx.onerror = () => { db.close(); rej(tx.error); };
      });
    },
    get: k => DB.op('readonly', s => s.get(k)),
    set: (k, v) => DB.op('readwrite', s => s.put(v, k)),
    del: k => DB.op('readwrite', s => s.delete(k)),
  };
  let lastSave = 0;
  async function save(force) {
    if (!R || (!force && Date.now() - lastSave < 10000)) return;
    lastSave = Date.now(); R.savedAt = lastSave;
    try { await DB.set('run', R); } catch (e) { log('Could not save progress: ' + e.message); }
  }

  // ---------- UI ----------
  const css = `
  #nrdx{position:fixed;top:16px;right:16px;z-index:2147483647;width:380px;max-height:calc(100vh - 32px);overflow:auto;
    background:#fff;color:#1b2430;border:1px solid #c9d2dc;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);
    font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  #nrdx *{box-sizing:border-box}
  #nrdx header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#24405a;color:#fff;border-radius:10px 10px 0 0}
  #nrdx header b{font-size:14px}
  #nrdx header button{background:none;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1}
  #nrdx .bd{padding:12px 14px}
  #nrdx label{display:block;margin:0 0 8px}
  #nrdx .lbl{font-weight:600;display:block;margin-bottom:3px}
  #nrdx select,#nrdx input[type=text],#nrdx input[type=number]{width:100%;padding:5px 7px;border:1px solid #b8c3cf;border-radius:6px;font:inherit;background:#fff;color:#1b2430}
  #nrdx .chk{display:flex;gap:7px;align-items:flex-start;font-weight:400}
  #nrdx .chk input{margin-top:3px}
  #nrdx .jur{display:grid;grid-template-columns:repeat(5,1fr);gap:2px 6px;font-size:12px}
  #nrdx .jur label{margin:0;display:flex;gap:4px;align-items:center}
  #nrdx .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
  #nrdx .row .btn.sec{flex:1 1 40%}
  #nrdx .btn{flex:1;padding:7px 10px;border-radius:6px;border:1px solid #24405a;background:#24405a;color:#fff;font:inherit;font-weight:600;cursor:pointer}
  #nrdx .btn.sec{background:#fff;color:#24405a}
  #nrdx .btn:disabled{opacity:.45;cursor:default}
  #nrdx .bar{height:8px;background:#e6ebf0;border-radius:4px;overflow:hidden;margin:10px 0 4px}
  #nrdx .bar i{display:block;height:100%;width:0;background:#2e7d5b;transition:width .2s}
  #nrdx .st{font-size:12px;color:#4a5866;min-height:18px}
  #nrdx .note{font-size:11.5px;color:#5c6b7a;margin-top:8px}
  #nrdx .box{background:#eef4fa;border:1px solid #c5d7e8;padding:7px 9px;border-radius:6px;font-size:12px;margin-top:8px;display:none}
  #nrdx .warn{background:#fff4e0;border-color:#f0c77a}
  #nrdx details{margin-top:8px;font-size:11.5px;color:#5c6b7a}
  #nrdx #nrdx-bandtbl table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  #nrdx #nrdx-bandtbl td{padding:2px 6px;border-top:1px solid #e1e6ec}
  #nrdx #nrdx-bandtbl td+td{text-align:right}
  #nrdx pre{white-space:pre-wrap;max-height:120px;overflow:auto;margin:4px 0 0;font-size:11px}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const box = document.createElement('div'); box.id = 'nrdx';
  box.innerHTML = `
  <header><b>NRD Exporter</b><button title="Hide" data-a="hide">×</button></header>
  <div class="bd">
    <div class="box" style="display:block;margin:0 0 10px">
      <b>Quick start</b> <span style="color:#5c6b7a">(uses the category, name, province and max-firm settings below)</span>
      <div class="row"><button class="btn" data-a="sizescan">Firm size bands</button></div>
      <div class="note" style="margin-top:4px">How many dealing reps each firm has, grouped into the bands below. About 25 minutes.</div>
      <label style="margin:8px 0 0"><span class="lbl">Size bands (dealing reps)</span><input type="text" id="nrdx-bands"></label>
      <div class="note" id="nrdx-bandmsg" style="color:#b3261e;margin:0"></div>
      <div id="nrdx-bandtbl"></div>
      <div class="row"><button class="btn" data-a="leadscan">UDP, CCO &amp; firm size</button></div>
      <div class="note" style="margin-top:4px">Every firm's UDP and CCO, plus firm sizes and bands. For all EMDs, roughly 2 hours (resumable).</div>
      <div class="row"><button class="btn" data-a="tcscan">Full scan: dealing reps &amp; terms &amp; conditions</button></div>
      <div class="note" style="margin-top:4px">Everything above plus exact dealing-rep counts and every condition. Reads everyone's record: roughly 4 hours for all EMDs (resumable).</div>
    </div>
    <label><span class="lbl">Firm category</span><select id="nrdx-cat"><option>Exempt Market Dealer</option></select></label>
    <label><span class="lbl">Firm name contains (optional)</span><input type="text" id="nrdx-name" placeholder="e.g. Capital"></label>
    <div class="lbl">Jurisdictions (none = all)</div>
    <div class="jur">${Object.keys(JURIS).map(k => `<label title="${JURIS[k]}"><input type="checkbox" value="${k}">${k}</label>`).join('')}</div>
    <label style="margin-top:8px"><span class="lbl">Max firms (0 = all — use a small number to test)</span><input type="number" id="nrdx-max" value="0" min="0"></label>
    <div class="lbl" style="margin-top:4px">What to collect</div>
    <label class="chk"><input type="checkbox" id="nrdx-fd" checked><span>Firm details (head office, phone, categories by province)</span></label>
    <label class="chk"><input type="checkbox" id="nrdx-ri" checked><span>Registered individuals at each firm</span></label>
    <label class="chk"><input type="checkbox" id="nrdx-id" checked><span>Individual categories (needed to identify <b>Dealing Representatives</b>; slowest step)</span></label>
    <label class="chk"><input type="checkbox" id="nrdx-ld" checked><span>UDP and CCO at each firm</span></label>
    <label class="chk"><input type="checkbox" id="nrdx-sz" checked><span>Dealing-rep count for every firm (fast count, about 25 minutes)</span></label>
    <label class="chk"><input type="checkbox" id="nrdx-oj" checked><span>Only provinces where the firm holds the selected category</span></label>
    <div class="box" id="nrdx-saved"></div>
    <div class="row">
      <button class="btn" data-a="start">Start new run</button>
      <button class="btn" data-a="resume" style="display:none">Resume</button>
      <button class="btn sec" data-a="stop" disabled>Stop</button>
    </div>
    <div class="bar"><i></i></div>
    <div class="st" id="nrdx-st">Ready.</div>
    <div class="box warn" id="nrdx-warn"></div>
    <div class="row"><button class="btn" data-a="xlsx" disabled>Download Excel (all tabs)</button></div>
    <div class="row"><button class="btn sec" data-a="report" disabled>Open T&amp;C report</button><button class="btn sec" data-a="savereport" disabled>Save T&amp;C report</button></div>
    <div class="row">
      <button class="btn sec" data-a="firms" disabled>Firms CSV</button>
      <button class="btn sec" data-a="reps" disabled>Individuals CSV</button>
      <button class="btn sec" data-a="drs" disabled>Dealing reps CSV</button>
      <button class="btn sec" data-a="terms" disabled>Terms CSV</button>
    </div>
    <div class="note">Goes at the pace the NRD site allows (about one request per second), so a full run takes hours. Progress is saved in this browser: if you stop, reload or close the tab, click the bookmarklet again and choose <b>Resume</b>. CSVs can be downloaded at any point.</div>
    <details><summary>Log</summary><pre id="nrdx-log"></pre></details>
  </div>`;
  document.body.appendChild(box);
  const $ = sel => box.querySelector(sel);
  const btn = a => box.querySelector(`[data-a="${a}"]`);

  function log(msg) { S.log.push(new Date().toLocaleTimeString() + '  ' + msg); if (S.log.length > 300) S.log.shift(); $('#nrdx-log').textContent = S.log.slice().reverse().join('\n'); }
  function status(msg) { $('#nrdx-st').textContent = msg; }
  function warn(msg) { const w = $('#nrdx-warn'); w.style.display = msg ? 'block' : 'none'; w.innerHTML = msg || ''; }
  function progress() { $('.bar i').style.width = (S.total ? Math.min(100, 100 * S.done / S.total) : 0) + '%'; }
  const resumable = () => R && !R.finished && R.savedAt;
  function refreshButtons() {
    btn('start').disabled = S.running; btn('stop').disabled = !S.running;
    btn('resume').style.display = resumable() && !S.running ? '' : 'none';
    btn('firms').disabled = !(R && R.firms.length); btn('reps').disabled = !(R && R.reps.size);
    btn('drs').disabled = btn('terms').disabled = !(R && R.indiv.size);
    btn('xlsx').disabled = !(R && R.firms.length);
    btn('report').disabled = btn('savereport').disabled = !(R && R.firms.some(f => f.parsed));
  }
  function describe(run) {
    const s = run.settings;
    return `${s.cat}${s.name ? ' matching "' + s.name + '"' : ''}${s.jurs.length ? ' in ' + s.jurs.join(', ') : ''}${s.max ? ', first ' + s.max + ' firms' : ''}`;
  }
  function showSaved() {
    const el = $('#nrdx-saved');
    if (!resumable() || S.running) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `<b>Unfinished run saved</b> ${new Date(R.savedAt).toLocaleString()}<br>${describe(R)}<br>
      ${R.firms.filter(f => f.parsed).length} / ${R.firms.length} firms, ${R.reps.size} firm/person records, ${R.indiv.size} individuals checked.`;
  }
  function applySettings(s) {
    $('#nrdx-cat').value = s.cat; $('#nrdx-name').value = s.name; $('#nrdx-max').value = s.max;
    box.querySelectorAll('.jur input').forEach(i => { i.checked = s.jurs.includes(i.value); });
    $('#nrdx-fd').checked = s.wantFD; $('#nrdx-ri').checked = s.wantRI; $('#nrdx-id').checked = s.wantID; $('#nrdx-oj').checked = s.onlyCatJur;
    $('#nrdx-ld').checked = !!s.wantLead; $('#nrdx-sz').checked = !!s.wantSize;
  }
  function readSettings() {
    return {
      cat: $('#nrdx-cat').value, name: $('#nrdx-name').value.trim(),
      jurs: [...box.querySelectorAll('.jur input:checked')].map(i => i.value),
      max: parseInt($('#nrdx-max').value, 10) || 0,
      wantFD: $('#nrdx-fd').checked, wantRI: $('#nrdx-ri').checked,
      wantID: $('#nrdx-id').checked && $('#nrdx-ri').checked, onlyCatJur: $('#nrdx-oj').checked, wantLead: $('#nrdx-ld').checked, wantSize: $('#nrdx-sz').checked,
    };
  }

  // ---------- network ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // One shared schedule for every request: starts are spaced `gap` ms apart. A 429 from the site
  // pauses everything and widens the gap; a long run of successes narrows it again, never below MIN_GAP.
  const MIN_GAP = 900, MAX_GAP = 4000;
  const RL = { gap: 1000, next: 0, ok: 0 };
  async function slot() {
    const now = Date.now(), at = Math.max(now, RL.next);
    RL.next = at + RL.gap;
    // Wait in short steps so Stop takes effect even during a long back-off pause.
    while (Date.now() < at) { if (S.stop) throw new Error('stopped'); await sleep(Math.min(500, at - Date.now())); }
  }
  function slowDown(attempt) {
    const pause = Math.min(120000, 20000 * attempt);
    RL.gap = Math.min(MAX_GAP, Math.round(RL.gap * 1.3)); RL.ok = 0;
    RL.next = Math.max(RL.next, Date.now() + pause);
    return pause;
  }
  function spedUp() { if (++RL.ok >= 100) { RL.ok = 0; RL.gap = Math.max(MIN_GAP, Math.round(RL.gap * 0.9)); } }

  async function req(url, opts = {}) {
    for (let attempt = 1, limited = 0; ; attempt++) {
      if (S.stop) throw new Error('stopped');
      await slot();
      let r;
      try { r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...opts }); }
      catch (e) { if (attempt >= 4) throw e; log(`Network error, retrying: ${e.message}`); await sleep(3000 * attempt); continue; }
      if (r.status === 429) {
        if (++limited > 8) throw new Error('HTTP 429 (site kept rate-limiting)');
        const pause = slowDown(limited);
        log(`Site asked us to slow down (429). Pausing ${pause / 1000}s, then 1 request per ${(RL.gap / 1000).toFixed(1)}s.`);
        status(`Paused ${pause / 1000}s — the site asked us to slow down.`);
        continue;
      }
      if (r.status === 403) throw Object.assign(new Error('HTTP 403'), { fatal: true });
      if (r.status >= 500) { if (attempt >= 4) throw new Error('HTTP ' + r.status); await sleep(3000 * attempt); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      spedUp();
      return r;
    }
  }
  const postJSON = (path, body) => req(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body }).then(r => r.json());
  const getDoc = path => req(BASE + path).then(r => r.text()).then(h => new DOMParser().parseFromString(h, 'text/html'));

  // Two workers so one response's latency overlaps the next; the shared schedule sets the pace.
  async function pool(items, label, fn) {
    let i = 0; S.done = 0; S.total = items.length; progress();
    const t0 = Date.now();
    const worker = async () => {
      while (i < items.length && !S.stop) {
        const it = items[i++];
        try { await fn(it); }
        catch (e) {
          if (S.stop && e.message === 'stopped') break;
          S.errors++; log(`Error (${label}): ${e.message}`);
          if (e.fatal) { S.stop = true; warn('The site refused a request (HTTP 403). Reload the NRD page, click the bookmarklet and choose <b>Resume</b>.'); }
        }
        S.done++; progress();
        const left = S.total - S.done, rate = S.done / Math.max(1, (Date.now() - t0) / 1000);
        status(`${label}: ${S.done} / ${S.total}` + (left > 0 && S.done > 5 ? ` — about ${fmtDur(left / rate)} left` : ''));
        save();
      }
    };
    await Promise.all([worker(), worker()]);
  }
  const fmtDur = s => s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';

  // ---------- firm search ----------
  const col = d => ({ data: d, name: '', searchable: true, orderable: false, search: { value: '', regex: false } });
  async function searchFirms({ cat, name, jurs, max }) {
    const PAGE = 100, out = [];
    const jurStr = jurs.length ? jurs.join(',') + ',' : '';
    for (let start = 0, draw = 1; ; start += PAGE, draw++) {
      if (S.stop) throw new Error('stopped');
      let qs = `?searchBy=F&firmNm=${encodeURIComponent(name)}&isDet=true&ctgry=${encodeURIComponent(cat)}`;
      if (jurs.length) qs += '&jurisd=' + encodeURIComponent(jurStr);
      qs += `&pgStart=${start}&pgLen=${PAGE}`;
      const model = { draw, columns: ['FirmName', 'NRDNumber', 'Jurisdictions'].map(col), order: [{ column: 0, dir: 'asc' }], start, length: PAGE, search: { value: '', regex: false } };
      const captchaEl = document.getElementById('hdfReCaptchaVerificationResponse');
      const nrs = { SearchType: 'F', SearchUrl: qs, IndivName: '', FirmName: name, IsDetailedSearch: true,
        RecaptchaResponse: captchaEl ? captchaEl.value : '', IsShowHistory: false, RelatedFirmName: '',
        SelectedJurisdictions: jurStr, SelectedCategories: cat + '|',
        // Same as the site's own pager: only page 2+ of a search skips the CAPTCHA check.
        IsRecaptchaByPass: start > 0 };
      const j = await postJSON('NrsSearch.aspx/DoFirmSearch', "{ 'model':" + JSON.stringify(model) + ",'nrsModel':" + JSON.stringify(nrs) + '}');
      const d = j.d || {};
      if (d.errorCode === 'RECAPTCHA_FAILED') { const e = new Error('CAPTCHA required'); e.captcha = true; throw e; }
      out.push(...(d.data || []));
      status(`Firm list: ${out.length} / ${d.recordsTotal}`);
      if (max && out.length >= max) return out.slice(0, max);
      if (!d.data || d.data.length < PAGE || out.length >= d.recordsTotal) break;
    }
    return out;
  }

  // Every person nationwide in one individual category (e.g. every UDP), via the site's detailed search.
  // With onPage, rows are handed over page by page instead of collected, and startAt resumes an
  // interrupted search: the first page is always fetched as a real search, then it skips ahead.
  async function searchIndivCategory(cat, { startAt = 0, onPage } = {}) {
    const PAGE = 100, out = [];
    for (let start = 0, draw = 1; ; draw++) {
      if (S.stop) throw new Error('stopped');
      const model = { draw, columns: ['IndivName', 'FirmName'].map(col), order: [{ column: 0, dir: 'asc' }], start, length: PAGE, search: { value: '', regex: false } };
      const captchaEl = document.getElementById('hdfReCaptchaVerificationResponse');
      const nrs = { SearchType: 'I', SearchUrl: `?searchBy=I&indivNm=&isDet=true&ctgry=${encodeURIComponent(cat)}&pgStart=${start}&pgLen=${PAGE}`,
        IndivName: '', FirmName: '', IsDetailedSearch: true, RecaptchaResponse: captchaEl ? captchaEl.value : '', IsShowHistory: false,
        RelatedFirmName: '', SelectedJurisdictions: '', SelectedCategories: cat + '|',
        // Same as the site's own pager: only page 2+ of a search skips the CAPTCHA check.
        IsRecaptchaByPass: start > 0 };
      const d = (await postJSON('NrsSearch.aspx/DoIndivSearch', "{ 'model':" + JSON.stringify(model) + ",'nrsModel':" + JSON.stringify(nrs) + '}')).d || {};
      if (d.errorCode === 'RECAPTCHA_FAILED') { const e = new Error('CAPTCHA required'); e.captcha = true; throw e; }
      const rows = d.data || [], skip = start === 0 && startAt > 0, total = d.recordsTotal || 0;
      const next = skip ? startAt : start + PAGE;
      if (onPage) await onPage(skip ? [] : rows, next, total); else out.push(...rows);
      status(`Searching every ${cat}: ${Math.min(next, total).toLocaleString()} / ${total.toLocaleString()}`);
      if (!rows.length || (!skip && rows.length < PAGE) || next >= total) break;
      start = next;
    }
    return out;
  }

  // ---------- parsing ----------
  const clean = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  // "<li>Exempt Market Dealer<div>From: April 14, 2022</div></li>" (dates only appear with isDet=true)
  const parseCat = li => {
    const t = clean(li.textContent); const m = t.match(/^(.*?)\s*From:\s*(.+)$/);
    return m ? { cat: m[1], from: m[2] } : { cat: t, from: '' };
  };
  // Categories are the panel's <ul>; terms & conditions are an <ol> whose items link to
  // OpenTermsAndConditions('Name','Province','Terms & Conditions related to: Type','Full text', ...).
  // A summary line such as "This individual's activities are restricted to certain securities..." sits in the
  // category list; it is a condition, not a category.
  const isSummary = li => /^This (individual|firm|dealer|adviser|portfolio manager)/i.test(clean(li.textContent));
  const panelCats = panel => [...panel.querySelectorAll('ul > li')].filter(li => !isSummary(li)).map(parseCat);
  const unjs = s => s.replace(/\\(.)/g, '$1');
  const plain = s => clean(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' '));
  function panelTerms(panel) {
    const out = [];
    for (const a of panel.querySelectorAll('[onclick*="OpenTermsAndConditions"]')) {
      const m = a.getAttribute('onclick').match(/OpenTermsAndConditions\('((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)'/);
      if (!m) continue;
      const type = plain(unjs(m[3])).replace(/^Terms & Conditions related to:\s*/i, '');
      out.push({ type, text: plain(unjs(m[4])) });
    }
    // Conditions with no detail link still show as list items.
    if (!out.length) for (const li of panel.querySelectorAll('ol > li, ul > li')) {
      if (li.closest('ul') && !isSummary(li)) continue;
      out.push({ type: '', text: clean(li.textContent).replace(/\s*\(Click for Details\)$/i, '') });
    }
    return out;
  }
  // These blocks are always in the HTML; the server only un-hides them when they apply.
  function pageFlags(doc) {
    const shown = id => { const el = doc.getElementById(id); return !!el && !/display\s*:\s*none/i.test(el.getAttribute('style') || ''); };
    const disciplined = shown('bodyContent_divDPL'), a = doc.getElementById('hlSedarPlusLink');
    return { disciplined, disciplinedLink: disciplined && a ? a.getAttribute('href') || '' : '', noLongerRegistered: shown('divNoLongerRegistered') };
  }
  function parseFirm(doc, firm) {
    const ho = [...doc.querySelectorAll('span.col-form-label')].find(l => /Head Office/i.test(l.textContent));
    if (ho) {
      const p = ho.parentElement.querySelector('p');
      const lines = p ? p.innerHTML.split(/<br\s*\/?>/i).map(x => clean(x.replace(/<[^>]+>/g, ''))).filter(Boolean) : [];
      const ph = lines.findIndex(l => /^Phone:/i.test(l));
      firm.phone = ph >= 0 ? lines.splice(ph, 1)[0].replace(/^Phone:\s*/i, '') : '';
      firm.headOffice = lines.join(', ');
      // Last address line looks like "Saskatoon SK S7K2E1 CAN".
      const m = (lines[lines.length - 1] || '').match(/^(.*?)\s+([A-Z]{2})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{5}(?:-\d{4})?)?\s*([A-Z]{3})$/);
      firm.addr = m ? { street: lines.slice(0, -1).join(', '), city: m[1], prov: m[2], postal: (m[3] || '').replace(/^(...)(...)$/, '$1 $2'), country: m[4] }
        : { street: lines.join(', '), city: '', prov: '', postal: '', country: '' };
    }
    Object.assign(firm, pageFlags(doc));
    firm.otherNames = [...doc.querySelectorAll('#ulOtherNames li')].map(li => clean(li.textContent)).filter(Boolean);
    firm.juris = [];
    for (const panel of doc.querySelectorAll('.panel')) {
      const h = panel.querySelector('h6'); if (!h) continue;
      const jName = clean(h.textContent);
      const a = panel.querySelector('[onclick*="OpenRegisteredPermittedIndividuals"]');
      // The site's own call uses the ids from this link, e.g. ("38260","Firm name","ON   "," Ontario").
      let hexId = firm.FirmId, code = jcode(jName);
      if (a) {
        const m = a.getAttribute('onclick').match(/OpenRegisteredPermittedIndividuals\("([^"]*)",.*,"([^"]*)","([^"]*)"\)/);
        if (m) { hexId = m[1]; code = m[2]; }
      }
      firm.juris.push({ name: jName, code, cats: panelCats(panel), terms: panelTerms(panel), hasIndivLink: !!a, hexId });
    }
    firm.parsed = true;
  }
  function parseIndiv(doc) {
    // Walk the current-registration section in document order: a firm link starts a block,
    // and each following jurisdiction panel belongs to that firm.
    const out = []; let cur = null;
    for (const n of doc.querySelectorAll('a[href*="NRSFirmRegistrationRecord.aspx"], .panel')) {
      if (n.matches('a')) {
        const m = n.getAttribute('href').match(/firmId=([^&]+)/);
        const firmId = m ? m[1] : '';
        cur = out.find(r => r.firmId === firmId);
        if (!cur) { cur = { firmId, firmName: clean(n.textContent), juris: {}, terms: {} }; out.push(cur); }
      } else if (cur) {
        const h = n.querySelector('h6'); if (!h) continue;
        const j = clean(h.textContent);
        cur.juris[j] = panelCats(n);
        const t = panelTerms(n); if (t.length) cur.terms[j] = t;
      }
    }
    return { regs: out, ...pageFlags(doc) };
  }

  // ---------- run ----------
  async function run(resume) {
    if (!resume) {
      if (resumable() && !confirm('Discard the saved unfinished run and start a new one?')) return;
      R = newRun(readSettings());
      await DB.del('run').catch(() => {});
    } else applySettings(R.settings);
    const st = R.settings;
    Object.assign(S, { running: true, stop: false, errors: 0, done: 0, total: 0 });
    warn(''); showSaved(); refreshButtons(); progress();
    const t0 = Date.now();
    try {
      if (!R.listDone) {
        log(`Searching firms: ${describe(R)}`);
        R.firms = (await searchFirms(st)).map(f => ({ ...f, headOffice: '', phone: '', juris: [], parsed: false }));
        R.listDone = true; await save(true);
        log(`Found ${R.firms.length} firms`);
      }
      refreshButtons();

      // Fast firm size: count every dealing representative in Canada by firm (about 1,200 pages of the
      // site's own search). Firms that are also mutual fund or investment dealers get flagged, because
      // their count includes those reps too.
      if (st.wantSize && !S.stop && !(R.size && R.size.done)) {
        R.size = R.size || { counts: {}, next: 0, total: 0, otherDealers: null, done: false };
        if (!R.size.otherDealers) {
          log('Listing mutual fund and investment dealers, to flag counts that include their reps');
          const other = {};
          for (const c of OTHER_DEALER_CATS)
            for (const f of await searchFirms({ cat: c, name: '', jurs: [], max: 0 })) (other[normName(f.FirmName)] = other[normName(f.FirmName)] || []).push(c);
          R.size.otherDealers = other; await save(true);
        }
        log(`Counting dealing representatives at every firm${R.size.next ? ' (resuming)' : ''}`);
        await searchIndivCategory('Dealing Representative', { startAt: R.size.next, onPage: (rows, next, total) => {
          for (const p of rows) for (const n of String(p.FirmName || '').split('|')) {
            const k = normName(n); if (k) R.size.counts[k] = (R.size.counts[k] || 0) + 1;
          }
          R.size.next = next; R.size.total = total; save();
        } });
        R.size.done = true; await save(true);
        log('Firm sizes counted'); refreshButtons(); renderBands();
      }

      if ((st.wantFD || st.wantRI) && !S.stop) {
        const todo = R.firms.filter(f => !f.parsed);
        if (todo.length) log(`Reading ${todo.length} firm pages`);
        await pool(todo, 'Firm pages', async f => {
          parseFirm(await getDoc(`NRSFirmRegistrationRecord.aspx?firmId=${encodeURIComponent(f.FirmId)}&isDet=true`), f);
        });
        refreshButtons();
      }

      if (st.wantRI && !S.stop) {
        const tasks = [];
        for (const f of R.firms) for (const j of f.juris) {
          const key = f.FirmId + '|' + j.code.trim();
          if (!j.hasIndivLink || R.tasksDone.has(key)) continue;
          if (st.jurs.length && !st.jurs.includes(j.code.trim())) continue;
          if (st.onlyCatJur && !j.cats.some(c => c.cat.toLowerCase() === st.cat.toLowerCase())) continue;
          tasks.push({ f, j, key });
        }
        if (tasks.length) log(`Listing individuals for ${tasks.length} firm/province pairs`);
        await pool(tasks, 'Individuals at firms', async ({ f, j, key }) => {
          const r = await postJSON('NRSFirmRegistrationRecord.aspx/GetIndividualsInFirmByJurisdiction',
            `{'firmId':'${j.hexId}','juriCode':'${j.code}'}`);
          for (const p of r.d || []) {
            const k = p.individualId + '|' + f.FirmId;
            const rec = R.reps.get(k) || { individualId: p.individualId, name: p.individualName, firm: f, juris: [] };
            if (!rec.juris.includes(j.code.trim())) rec.juris.push(j.code.trim());
            R.reps.set(k, rec);
          }
          R.tasksDone.add(key);
        });
        refreshButtons();
      }

      if (st.wantID && !S.stop) {
        const ids = [...new Set([...R.reps.values()].map(r => r.individualId))].filter(id => !R.indiv.has(id));
        if (ids.length) log(`Reading ${ids.length} individual pages`);
        await pool(ids, 'Individual pages', async id => {
          R.indiv.set(id, parseIndiv(await getDoc(`NRSIndivRegistrationRecord.aspx?indivId=${encodeURIComponent(id)}&isDet=true`)));
          if (S.done % 25 === 0) refreshButtons();
        });
      }

      // UDP and CCO without reading everyone's record: two nationwide category searches, then only
      // those people's records at these firms (a full scan reads everyone, so it needs neither).
      if (st.wantLead && !st.wantID && !S.stop) {
        if (!R.leadSearch) {
          log('Searching the NRD for every UDP and CCO');
          const udp = await searchIndivCategory('Ultimate Designated Person');
          const cco = await searchIndivCategory('Chief Compliance Officer');
          R.leadSearch = { udp, cco }; await save(true);
        }
        const norm = s => clean(s).toLowerCase();
        const names = new Set(R.firms.map(f => norm(f.FirmName)));
        const ids = new Set();
        for (const p of [...R.leadSearch.udp, ...R.leadSearch.cco])
          if (String(p.FirmName || '').split('|').some(n => names.has(norm(n)))) ids.add(p.IndivId);
        const todo = [...ids].filter(id => !R.indiv.has(id));
        if (todo.length) log(`Reading ${todo.length} UDP and CCO records at these firms`);
        await pool(todo, 'UDP and CCO records', async id => {
          R.indiv.set(id, parseIndiv(await getDoc(`NRSIndivRegistrationRecord.aspx?indivId=${encodeURIComponent(id)}&isDet=true`)));
        });
        refreshButtons();
      }

      R.finished = !S.stop && S.errors === 0;
      await save(true);
      const took = fmtDur((Date.now() - t0) / 1000);
      const summary = `${R.firms.length} firms, ${R.reps.size} firm/person records` + (st.wantID && R.indiv.size ? `, ${indivRows(true).length - 1} dealing-rep rows` : '') +
        (st.wantLead ? `, UDP/CCO found for ${leadership().size} firms` : '') + (R.size && R.size.done ? ', firm sizes counted' : '');
      if (S.stop) status(`Stopped after ${took} — ${summary}. Click Resume to continue.`);
      else if (S.errors) status(`Finished in ${took} with ${S.errors} failed lookups (see log) — ${summary}. Click Resume to retry them.`);
      else status(`Done in ${took} — ${summary}.`);
      log('Finished');
    } catch (e) {
      if (e.captcha) {
        warn(`The site is asking for a CAPTCHA (it does this after ~15 searches in a session).<br>
          On the <a href="${BASE}nrssearch.aspx">search page</a>, tick <b>"I'm not a robot"</b> in the search panel, then click the bookmarklet and <b>Start</b> again.`);
        if (typeof window.showCaptcha === 'function') window.showCaptcha();
        status('Waiting for CAPTCHA.');
        R = null;
      } else if (e.message === 'stopped') status('Stopped. Click Resume to continue.');
      else { status('Error: ' + e.message); log('Fatal: ' + (e.stack || e.message)); }
      await save(true);
    } finally {
      S.running = false; refreshButtons(); showSaved(); progress();
    }
  }

  // ---------- export: rows ----------
  // Each tab is built once as rows of cells, then written as CSV or as a sheet in the Excel file.
  // Cell values: string | number | { date: 'YYYY-MM-DD' } | { link: url }.
  const stamp = () => new Date().toISOString().slice(0, 10);
  const slug = () => R.settings.cat.replace(/\W+/g, '-').toLowerCase();
  const firmUrl = id => `${BASE}NRSFirmRegistrationRecord.aspx?firmId=${id}`;
  const indUrl = id => `${BASE}NRSIndivRegistrationRecord.aspx?indivId=${id}`;
  const fmtCats = cats => cats.map(c => c.cat + (c.from ? ' (from ' + c.from + ')' : '')).join(', ');
  const num = v => /^\d+$/.test(String(v)) ? Number(v) : v;
  const isoDate = s => { const t = Date.parse(String(s || '').replace(/\*/g, '')); return isNaN(t) ? '' : new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const level = t => /strict supervision/i.test(t) ? 'Strict' : /close supervision/i.test(t) ? 'Close' : '';
  // Plain-word categories for a term & condition, derived from its NRD label and wording. One condition
  // can touch several (e.g. financial reporting and a compliance monitor). The NRD label is always kept too.
  const TC_CATEGORIES = [
    { name: 'Strict supervision', re: /strict supervision/i },
    { name: 'Close supervision', re: /close supervision/i },
    { name: 'Restricted clients (institutional, accredited or permitted only)', re: /institutional client|accredited investor|permitted client|only (deal|trade|advise)s? (only )?with/i },
    { name: 'Restricted products, activities or category', re: /restricted to|activities are restricted|only with respect to|only (act|deal|trade) .{0,40}in respect of|shall not (handle|hold|collect|accept|trade|sell|act|advise)|may act as .{0,60} only|sector only/i },
    { name: 'Client relationship manager (advising rep limits)', re: /client relationship manag/i },
    { name: 'Conflicts, related or connected issuers', re: /conflict of interest|conflicts of interest|related issuer|connected issuer|specified issuer|independent of the issuer|relationship with the issuer/i },
    { name: 'Compliance remediation, consultant or monitor', re: /remediat|compliance deficienc|compliance (review|examination) report|consultant|monitor/i },
    { name: 'Know your client or suitability', re: /know your client|\bKYC\b|suitability|online advice/i },
    { name: 'Capital, financial reporting or insurance', re: /capital|financial statement|financial report|working capital|bonding|insurance|financial reporting/i },
    { name: 'Product due diligence (know your product)', re: /due diligence|know.your.product|assess the security|on its merits/i },
    { name: 'Proficiency (requirements or exemptions)', re: /proficiency|completed? the .{0,60}(course|exam)|must (complete|pass|write) |Canadian Securities Course|Exempt Market Products|Conduct and Practices Handbook/i },
    { name: 'Crypto assets', re: /crypto/i },
    { name: 'Limited partnership: general partner activities', re: /general partner|commandit/i },
    { name: 'Dual platform (investment dealer or mutual fund dealer and EMD)', re: /dual registration|ID Line of Business|categories of investment dealer, mutual fund dealer/i },
    { name: 'Non-resident or foreign firm', re: /foreign (dealer|adviser)|extra-provincial|outside (of )?canada|non-resident|attorn|submits? to the jurisdiction|books and records/i },
    { name: 'Reporting or notice to the regulator', re: /(notify|inform|provide|file|deliver|submit|report)\w* .{0,120}(director|executive director|commission|superintendent|regulator)/i },
    { name: 'Standard provincial order, ruling or policy', re: /general ruling|ruling dated|section 83 ruling|policy statement|blanket order/i },
    { name: 'Custom terms (details not published)', re: /custom terms and conditions that address a unique situation/i },
  ];
  const TC_OTHER = 'Other (read the text)';
  TC_CATEGORIES.push({ name: TC_OTHER, re: null });
  // When the wording matches nothing, fall back on the NRD label.
  const TC_LABEL_FALLBACK = { 'category restriction': 'Restricted products, activities or category', 'financial reporting': 'Capital, financial reporting or insurance',
    'foreign dealer': 'Non-resident or foreign firm', 'foreign adviser': 'Non-resident or foreign firm', 'extra-provincial dealer': 'Non-resident or foreign firm',
    'supervision/reporting': 'Reporting or notice to the regulator', 'management reporting': 'Reporting or notice to the regulator',
    'supervision': 'Reporting or notice to the regulator', 'dual registration': 'Dual platform (investment dealer or mutual fund dealer and EMD)' };
  const tcCategories = t => {
    const s = (t.type || '') + ' ' + t.text;
    const hits = TC_CATEGORIES.filter(c => c.re && c.re.test(s)).map(c => c.name);
    return hits.length ? hits : [TC_LABEL_FALLBACK[(t.type || '').toLowerCase()] || TC_OTHER];
  };
  const jc = j => j.code.trim() || jcode(j.name);

  // Everything about one person at one firm, from their individual page (if it has been read).
  function repInfo(rec) {
    const info = R.indiv.get(rec.individualId);
    const reg = info && info.regs.find(r => r.firmId === String(rec.firm.FirmId));
    const cat = R.settings.cat.toLowerCase();
    const x = { info, reg, dr: [], since: '', otherDR: {}, roles: new Set(), terms: [] };
    if (!reg) return x;
    const dates = [];
    for (const [j, cats] of Object.entries(reg.juris)) {
      for (const k of cats) {
        const m = k.cat.match(/^Dealing Representative \((.+)\)$/i);
        if (m && m[1].toLowerCase() === cat) {
          if (!x.dr.includes(jcode(j))) x.dr.push(jcode(j));
          const t = Date.parse(k.from); if (!isNaN(t)) dates.push(t);
        } else if (m) (x.otherDR[m[1]] = x.otherDR[m[1]] || []).push(jcode(j));
        else x.roles.add(k.cat);
      }
    }
    if (dates.length) x.since = isoDate(new Date(Math.min(...dates)).toString());
    for (const [j, ts] of Object.entries(reg.terms || {})) for (const t of ts) x.terms.push({ prov: jcode(j), ...t });
    return x;
  }

  function firmRows() {
    const cat = R.settings.cat, lc = cat.toLowerCase();
    const people = new Map(), drs = new Map();
    for (const rec of R.reps.values()) {
      const id = rec.firm.FirmId;
      people.set(id, (people.get(id) || 0) + 1);
      if (R.indiv.has(rec.individualId) && repInfo(rec).dr.length) drs.set(id, (drs.get(id) || 0) + 1);
    }
    const rows = [['NRD #', 'Firm name', 'Other / previous names', `${cat} provinces`, `${cat} since (earliest)`, 'All provinces registered',
      'Other categories', 'Head office street', 'City', 'Province', 'Postal code', 'Country', 'Phone',
      'On Disciplined List', 'Disciplined List details', 'No longer registered', 'Firm terms & conditions',
      'Registered individuals', `${cat} dealing reps`, 'Categories by province', 'NRD record']];
    for (const f of R.firms) {
      const p = f.parsed, a = f.addr || {}, yn = b => p ? (b ? 'Yes' : 'No') : '';
      const has = j => j.cats.some(c => c.cat.toLowerCase() === lc);
      const other = [...new Set(f.juris.flatMap(j => j.cats.map(c => c.cat)))].filter(c => c.toLowerCase() !== lc);
      const since = f.juris.flatMap(j => j.cats.filter(c => c.cat.toLowerCase() === lc).map(c => isoDate(c.from))).filter(Boolean).sort()[0];
      const nTerms = f.juris.reduce((n, j) => n + (j.terms || []).length, 0);
      rows.push([num(f.NRDNumber), f.FirmName, (f.otherNames || []).join('; '),
        p ? f.juris.filter(has).map(jc).join('; ') : '', since ? { date: since } : '',
        p ? f.juris.map(jc).join('; ') : clean(f.Jurisdictions), other.join('; '),
        a.street || '', a.city || '', a.prov || '', a.postal || '', a.country || '', f.phone || '',
        yn(f.disciplined), f.disciplinedLink ? { link: f.disciplinedLink, label: 'SEDAR+' } : '', yn(f.noLongerRegistered),
        !p ? '' : nTerms ? `${nTerms} (see Terms & Conditions)` : 'None',
        R.settings.wantRI ? people.get(f.FirmId) || 0 : '', R.indiv.size ? drs.get(f.FirmId) || 0 : '',
        f.juris.map(j => `${jc(j)}: ${fmtCats(j.cats)}`).join(' | '), { link: firmUrl(f.FirmId) }]);
    }
    return rows;
  }

  // One row per firm, province and category: the most filterable view of the registrations.
  function firmRegRows() {
    const rows = [['NRD #', 'Firm name', 'Province', 'Category', 'Registered since', 'Date note', 'Terms & conditions in this province', 'NRD record']];
    for (const f of R.firms) for (const j of f.juris) for (const c of j.cats) {
      const d = isoDate(c.from);
      rows.push([num(f.NRDNumber), f.FirmName, jc(j), c.cat, d ? { date: d } : c.from,
        /\*\s*$/.test(c.from) ? 'NRD records start Sep 28, 2009 – may be registered earlier' : '',
        (j.terms || []).length ? `${j.terms.length} (see Terms & Conditions)` : 'None', { link: firmUrl(f.FirmId) }]);
    }
    return rows;
  }

  function indivRows(onlyDR) {
    const cat = R.settings.cat;
    const rows = [['Individual ID', 'Name', 'Firm NRD #', 'Firm name', 'Listed under firm in', `Dealing Rep (${cat})`, 'Dealing Rep provinces',
      'Dealing Rep since', 'Other dealing rep registrations', 'Officer / manager roles', 'Terms & conditions (e.g. supervision)',
      'On Disciplined List', 'Disciplined List details', 'Registered with other firms', 'No longer registered', 'Categories by province', 'NRD record']];
    const recs = [...R.reps.values()].sort((a, b) => a.firm.FirmName.localeCompare(b.firm.FirmName) || a.name.localeCompare(b.name));
    for (const rec of recs) {
      const x = repInfo(rec), known = !!x.info, yn = b => known ? (b ? 'Yes' : 'No') : '';
      if (onlyDR && !x.dr.length) continue;
      const levels = [...new Set(x.terms.map(t => level(t.text)).filter(Boolean))];
      rows.push([num(rec.individualId), rec.name, num(rec.firm.NRDNumber), rec.firm.FirmName, rec.juris.join('; '),
        yn(x.dr.length), x.dr.join('; '), x.since ? { date: x.since } : '',
        Object.entries(x.otherDR).map(([c, p]) => `${c} (${p.join('; ')})`).join(' | '), [...x.roles].join('; '),
        known ? (x.terms.length ? 'Yes' + (levels.length ? ' – ' + levels.join('/') + ' supervision' : '') : 'No') : '',
        yn(x.info && x.info.disciplined), x.info && x.info.disciplinedLink ? { link: x.info.disciplinedLink, label: 'SEDAR+' } : '', yn(x.info && x.info.regs.length > 1), yn(x.info && x.info.noLongerRegistered),
        x.reg ? Object.entries(x.reg.juris).map(([j, c]) => `${jcode(j)}: ${fmtCats(c)}`).join(' | ') : '', { link: indUrl(rec.individualId) }]);
    }
    return rows;
  }

  const TERMS_HEAD = ['Applies to', 'Name', 'Individual ID', 'Dealing rep', 'Firm NRD #', 'Firm name', 'Province', 'Categories',
    'NRD label', 'Supervision level', 'Full text', 'NRD record'];
  // Every condition, one row per province: firms first, then people.
  function allConds() {
    const out = [];
    for (const f of R.firms) for (const j of f.juris) for (const t of j.terms || [])
      out.push({ w: 'Firm', name: f.FirmName, id: '', dr: '', f, prov: jc(j), t, link: firmUrl(f.FirmId) });
    const recs = [...R.reps.values()].sort((a, b) => a.firm.FirmName.localeCompare(b.firm.FirmName) || a.name.localeCompare(b.name));
    for (const rec of recs) { const x = repInfo(rec);
      for (const t of x.terms) out.push({ w: 'Individual', name: rec.name, id: num(rec.individualId), dr: x.dr.length ? 'Yes' : 'No', f: rec.firm, prov: t.prov, t, link: indUrl(rec.individualId) }); }
    return out;
  }
  function termsRows() {
    return [TERMS_HEAD, ...allConds().map(c => [c.w, c.name, c.id, c.dr, num(c.f.NRDNumber), c.f.FirmName, c.prov, tcCategories(c.t).join('; '),
      c.t.type, level(c.t.text), c.t.text, { link: c.link }])];
  }
  // One row per firm (or person at a firm) per category, with the provinces it applies in.
  function groupedRows(kind) {
    const m = new Map();
    for (const c of allConds()) {
      if (kind === 'F' ? c.w !== 'Firm' : c.w !== 'Individual') continue;
      for (const cat of tcCategories(c.t)) {
        const k = cat + '|' + c.w + c.id + '|' + c.f.FirmId;
        const g = m.get(k) || { c, cat, provs: [], labels: new Set(), texts: new Set(), levels: new Set() };
        if (!g.provs.includes(c.prov)) g.provs.push(c.prov);
        if (c.t.type) g.labels.add(c.t.type); g.texts.add(c.t.text); if (level(c.t.text)) g.levels.add(level(c.t.text));
        m.set(k, g);
      }
    }
    const order = TC_CATEGORIES.map(c => c.name), gs = [...m.values()].sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.c.name.localeCompare(b.c.name));
    const text = g => [...g.texts].join(' | ');
    if (kind === 'F') return [['Category', 'NRD #', 'Firm name', 'Provinces', 'NRD label(s)', 'Condition text', 'NRD record'],
      ...gs.map(g => [g.cat, num(g.c.f.NRDNumber), g.c.f.FirmName, g.provs.join('; '), [...g.labels].join('; '), text(g), { link: g.c.link }])];
    return [['Category', 'Individual ID', 'Name', 'Dealing rep', 'Firm name', 'Firm NRD #', 'Provinces', 'Supervision level', 'NRD label(s)', 'Condition text', 'NRD record'],
      ...gs.map(g => [g.cat, g.c.id, g.c.name, g.c.dr, g.c.f.FirmName, num(g.c.f.NRDNumber), g.provs.join('; '), [...g.levels].join('/'), [...g.labels].join('; '), text(g), { link: g.c.link }])];
  }
  // Counts per category and province: firms, then dealing reps, then all registrants.
  function tcSummaryRows() {
    const conds = allConds(), provs = Object.keys(JURIS).filter(p => conds.some(c => c.prov === p));
    const rows = [['Category', ...provs, 'All provinces']];
    const block = (title, pick) => {
      rows.push([title]);
      const sel = conds.filter(pick), key = c => c.w + c.id + '|' + c.f.FirmId;
      const n = (cat, p) => new Set(sel.filter(c => (!cat || tcCategories(c.t).includes(cat)) && (!p || c.prov === p)).map(key)).size;
      for (const cat of TC_CATEGORIES.map(c => c.name)) if (n(cat)) rows.push([cat, ...provs.map(p => n(cat, p) || ''), n(cat)]);
      rows.push(['Any condition', ...provs.map(p => n(null, p) || ''), n(null)], ['']);
    };
    block(`Firms with conditions (of ${R.firms.filter(f => f.parsed).length} firms checked)`, c => c.w === 'Firm');
    const checked = [...R.reps.values()].filter(r => R.indiv.has(r.individualId)), drs = checked.filter(r => repInfo(r).dr.length);
    if (R.settings.wantID) {
      block(`Dealing reps with conditions (of ${drs.length} dealing reps checked)`, c => c.w === 'Individual' && c.dr === 'Yes');
      block(`All registrants with conditions (of ${checked.length} people checked)`, c => c.w === 'Individual');
    } else rows.push(['Run the full scan to see conditions on dealing reps and other registrants.'], ['']);
    rows.push(['One firm or person can appear under several categories, so category rows do not add up to "Any condition".']);
    return rows;
  }

  // ---------- firm size bands ----------
  const OTHER_DEALER_CATS = ['Investment Dealer', 'Mutual Fund Dealer', 'Scholarship Plan Dealer', 'Restricted Dealer'];
  const normName = s => clean(s).toLowerCase();
  const DEFAULT_BANDS = '0, 1-3, 4-6, 7-12, 13-25, 26-50, 51-100, 101+';
  // "0, 1-3, 101+" -> [{label, lo, hi}], sorted and checked for overlaps.
  function parseBands(text) {
    const out = [];
    for (const t of text.split(',').map(x => x.trim()).filter(Boolean)) {
      let m;
      if ((m = t.match(/^(\d+)$/))) out.push({ label: m[1], lo: +m[1], hi: +m[1] });
      else if ((m = t.match(/^(\d+)\s*-\s*(\d+)$/)) && +m[1] <= +m[2]) out.push({ label: `${m[1]}-${m[2]}`, lo: +m[1], hi: +m[2] });
      else if ((m = t.match(/^(\d+)\s*\+$/))) out.push({ label: `${m[1]}+`, lo: +m[1], hi: Infinity });
      else throw new Error(`"${t}" isn't a band. Use forms like 0, 1-3 or 101+.`);
    }
    if (!out.length) throw new Error('Enter at least one band.');
    out.sort((a, b) => a.lo - b.lo);
    for (let i = 1; i < out.length; i++) if (out[i].lo <= out[i - 1].hi) throw new Error(`Bands ${out[i - 1].label} and ${out[i].label} overlap.`);
    return out;
  }
  function bands() { try { return parseBands($('#nrdx-bands').value); } catch { return parseBands(DEFAULT_BANDS); } }
  const bandOf = (n, bs) => (bs.find(b => n >= b.lo && n <= b.hi) || { label: 'Not in any band' }).label;
  // Dealing reps per firm: the exact EMD count from a full scan where available, otherwise the fast count.
  function sizeTable() {
    const out = new Map(), exact = R.settings.wantID ? firmSize() : new Map(), cat = R.settings.cat;
    for (const f of R.firms) {
      const s = exact.get(f.FirmId), other = R.size && R.size.otherDealers ? R.size.otherDealers[normName(f.FirmName)] || [] : [];
      if (s && s.read === s.people) out.set(f.FirmId, { n: s.dr, how: `Exact ${cat} dealing reps (full scan)`, other });
      else if (R.size && R.size.done) out.set(f.FirmId, { n: R.size.counts[normName(f.FirmName)] || 0,
        how: other.length ? 'All dealer types (fast count), includes ' + other.join(' / ') + ' reps' : 'Fast count', other });
    }
    return out;
  }
  function sizeBandRows() {
    const bs = bands(), t = sizeTable(), counts = new Map(bs.map(b => [b.label, { n: 0, other: 0 }]));
    for (const f of R.firms) { const s = t.get(f.FirmId); if (!s) continue;
      const c = counts.get(bandOf(s.n, bs)) || counts.set(bandOf(s.n, bs), { n: 0, other: 0 }).get(bandOf(s.n, bs));
      c.n++; if (s.other.length) c.other++; }
    const total = [...counts.values()].reduce((a, c) => a + c.n, 0);
    return [['Size band (dealing reps)', `${R.settings.cat}s`, '% of firms', 'Of which also a mutual fund / investment dealer'],
      ...[...counts].map(([label, c]) => [label, c.n, total ? Math.round(1000 * c.n / total) / 10 + '%' : '', c.other]),
      ['Total', total, total ? '100%' : '', [...counts.values()].reduce((a, c) => a + c.other, 0)], [''],
      ['Counts for firms that are also mutual fund or investment dealers include those reps. A full scan gives their exact EMD-only count.']];
  }
  function firmSizeRows() {
    const bs = bands(), t = sizeTable();
    const rows = R.firms.filter(f => t.has(f.FirmId)).map(f => { const s = t.get(f.FirmId);
      return [num(f.NRDNumber), f.FirmName, s.n, bandOf(s.n, bs), s.how, s.other.join('; '), clean(f.Jurisdictions), { link: firmUrl(f.FirmId) }]; });
    rows.sort((a, b) => b[2] - a[2] || a[1].localeCompare(b[1]));
    return [['NRD #', 'Firm name', 'Dealing reps', 'Size band', 'How counted', 'Also registered as', 'Provinces registered', 'NRD record'], ...rows];
  }
  // Small band table in the panel; redrawn when the bands change.
  function renderBands() {
    const el = $('#nrdx-bandtbl'), msg = $('#nrdx-bandmsg');
    try { parseBands($('#nrdx-bands').value); msg.textContent = ''; } catch (e) { msg.textContent = e.message; }
    if (!R || !sizeTable().size) { el.innerHTML = ''; return; }
    const rows = sizeBandRows().slice(1, -2);
    el.innerHTML = '<table>' + rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('') + '</table>';
  }

  // ---------- leadership & firm size ----------
  // Per firm: UDP(s), CCO(s) for the selected category, CCOs for the firm's other categories, and
  // firm size, all from the individual records read so far.
  function leadership() {
    const cat = R.settings.cat.toLowerCase(), names = new Map(), out = new Map();
    for (const p of [...((R.leadSearch || {}).udp || []), ...((R.leadSearch || {}).cco || [])]) names.set(p.IndivId, p.IndivName);
    for (const r of R.reps.values()) names.set(r.individualId, r.name);
    const firmIds = new Set(R.firms.map(f => String(f.FirmId)));
    for (const [id, info] of R.indiv) for (const reg of info.regs) {
      if (!firmIds.has(String(reg.firmId))) continue;
      const L = out.get(String(reg.firmId)) || { udp: new Map(), cco: new Map(), ccoOther: new Map() };
      for (const [j, cats] of Object.entries(reg.juris)) for (const k of cats) {
        const m = k.cat.match(/^Chief Compliance Officer(?: \((.+)\))?$/i);
        const role = /^Ultimate Designated Person/i.test(k.cat) ? 'udp' : m ? (!m[1] || m[1].toLowerCase() === cat ? 'cco' : 'ccoOther') : null;
        if (!role) continue;
        const p = L[role].get(id) || { id, name: names.get(id) || '', provs: [], dates: [], label: m && m[1] ? m[1] : '' };
        if (!p.provs.includes(jcode(j))) p.provs.push(jcode(j));
        const d = isoDate(k.from); if (d) p.dates.push(d);
        L[role].set(id, p);
      }
      out.set(String(reg.firmId), L);
    }
    return out;
  }
  const leadKnown = () => !!R.leadSearch || (R.settings.wantID && R.indiv.size > 0);
  function firmSize() {
    const size = new Map();
    for (const rec of R.reps.values()) {
      const s = size.get(rec.firm.FirmId) || { people: 0, read: 0, dr: 0 };
      s.people++;
      if (R.indiv.has(rec.individualId)) { s.read++; if (repInfo(rec).dr.length) s.dr++; }
      size.set(rec.firm.FirmId, s);
    }
    return size;
  }
  const since = p => p.dates.slice().sort()[0];
  function leadershipRows() {
    const cat = R.settings.cat, lc = cat.toLowerCase(), L = leadership(), size = firmSize(), known = leadKnown(), st = sizeTable(), bs = bands();
    const people = m => [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    const rows = [['NRD #', 'Firm name', `${cat} provinces`, 'Head office city', 'Head office province', 'Registered individuals',
      'Dealing reps', 'Size band', 'How counted', 'Ultimate Designated Person', 'UDP provinces', 'UDP since', 'UDP NRD record',
      `Chief Compliance Officer (${cat})`, 'CCO provinces', 'CCO since', 'CCO NRD record', 'UDP is also CCO',
      'CCO for other categories', 'Firm terms & conditions', 'On Disciplined List', 'NRD record']];
    for (const f of R.firms) {
      const l = L.get(String(f.FirmId)) || { udp: new Map(), cco: new Map(), ccoOther: new Map() };
      const u = people(l.udp), c = people(l.cco), s = size.get(f.FirmId), a = f.addr || {};
      const none = known ? 'None listed' : '';
      const nTerms = f.juris.reduce((n, j) => n + (j.terms || []).length, 0);
      rows.push([num(f.NRDNumber), f.FirmName,
        f.parsed ? f.juris.filter(j => j.cats.some(k => k.cat.toLowerCase() === lc)).map(jc).join('; ') : '',
        a.city || '', a.prov || '',
        s ? s.people : (R.settings.wantRI ? 0 : ''),
        // Exact (full scan) where available, otherwise the fast count.
        st.has(f.FirmId) ? st.get(f.FirmId).n : '', st.has(f.FirmId) ? bandOf(st.get(f.FirmId).n, bs) : '', st.has(f.FirmId) ? st.get(f.FirmId).how : '',
        u.length ? u.map(p => p.name).join('; ') : none, u.map(p => p.provs.join(', ')).join(' | '),
        u.length && since(u[0]) ? { date: since(u[0]) } : '', u.length ? { link: indUrl(u[0].id) } : '',
        c.length ? c.map(p => p.name).join('; ') : none, c.map(p => p.provs.join(', ')).join(' | '),
        c.length && since(c[0]) ? { date: since(c[0]) } : '', c.length ? { link: indUrl(c[0].id) } : '',
        u.length && c.length ? (u.some(p => l.cco.has(p.id)) ? 'Yes' : 'No') : '',
        people(l.ccoOther).map(p => `${p.name} (${p.label})`).join('; '),
        !f.parsed ? '' : nTerms ? `${nTerms} (see Terms & Conditions)` : 'None',
        f.parsed ? (f.disciplined ? 'Yes' : 'No') : '', { link: firmUrl(f.FirmId) }]);
    }
    return rows;
  }
  // One row per firm, role and person, with a link for every person.
  function leadershipPeopleRows() {
    const cat = R.settings.cat, L = leadership();
    const rows = [['Firm NRD #', 'Firm name', 'Role', 'Name', 'Individual ID', 'Provinces', 'Since', `Also ${cat} dealing rep`, 'NRD record']];
    for (const f of R.firms) {
      const l = L.get(String(f.FirmId)); if (!l) continue;
      const add = (role, p) => {
        const reg = (R.indiv.get(p.id) || { regs: [] }).regs.find(r => String(r.firmId) === String(f.FirmId));
        const dr = reg ? Object.values(reg.juris).some(cs => cs.some(k => k.cat.toLowerCase() === `dealing representative (${cat.toLowerCase()})`)) : false;
        rows.push([num(f.NRDNumber), f.FirmName, role, p.name, num(p.id), p.provs.join('; '), since(p) ? { date: since(p) } : '', dr ? 'Yes' : 'No', { link: indUrl(p.id) }]);
      };
      for (const p of l.udp.values()) add('Ultimate Designated Person', p);
      for (const p of l.cco.values()) add(`Chief Compliance Officer (${cat})`, p);
      for (const p of l.ccoOther.values()) add(`Chief Compliance Officer (${p.label})`, p);
    }
    return rows;
  }

  function aboutRows() {
    const s = R.settings;
    return [['NRD export', ''], ['Source', 'CSA National Registration Search (info.securities-administrators.ca)'],
      ['Downloaded', new Date().toLocaleString()], ['Search', describe(R)],
      ['Status', R.finished ? 'Complete' : 'Partial – run not finished'],
      ['Firms', R.firms.length], ['Firm/person records', R.reps.size], ['Individuals checked', R.indiv.size],
      ['Collected', [s.wantFD && 'firm details', s.wantRI && 'registered individuals', s.wantID && 'individual categories & terms', s.wantLead && 'UDP and CCO'].filter(Boolean).join(', ')],
      ['Size bands', bands().map(b => b.label).join(', ')],
      ['Firm size', '"Registered individuals" counts everyone listed at the firm in the provinces scanned. The dealing-rep count is filled in once every person at the firm has been read (full scan).'],
      ['Dates', 'NRD registration history starts Sep 28, 2009. A "*" date (flagged in Firm Registrations) means registered on or before that date.'],
      ['Note', 'The CSA presents registration information as a plain language summary of publicly available documents. Check the NRD record before relying on it.']];
  }

  // ---------- export: CSV ----------
  function save_(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const csvCell = v => {
    v = v == null ? '' : typeof v === 'object' ? (v.link || v.date || '') : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const csv = (rows, name) => save_(`nrd-${slug()}-${name}-${stamp()}.csv`,
    new Blob(['\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));

  // ---------- export: Excel (.xlsx) ----------
  // An .xlsx file is a zip of XML parts. Built here so the bookmarklet needs no outside library.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function deflate(data) {
    if (typeof CompressionStream === 'undefined') return null;
    try { return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }
    catch { return null; }
  }
  async function zip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const packed = await deflate(data), body = packed || data, method = packed ? 8 : 0;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, method, true); h.setUint16(12, 33, true);
      h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, body);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, method, true); c.setUint16(14, 33, true);
      c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + body.length;
    }
    const size = central.reduce((n, p) => n + p.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xesc = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const serial = d => { const [y, m, dd] = d.split('-').map(Number); return (Date.UTC(y, m - 1, dd) - Date.UTC(1899, 11, 30)) / 86400000; };
  function sheetXml(rows, noFilter) {
    const ncol = rows[0].length, last = colName(ncol - 1) + rows.length;
    const width = i => Math.max(9, Math.min(60, 2 + Math.max(...rows.slice(0, 300).map(r => {
      const v = r[i]; return v == null ? 0 : typeof v === 'object' ? (v.link ? 6 : 11) : String(v).length; }))));
    const cols = Array.from({ length: ncol }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${width(i)}" customWidth="1"/>`).join('');
    const body = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (v == null || v === '') return '';
      if (ri === 0) return `<c r="${ref}" s="1" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      if (typeof v === 'object' && v.date) return `<c r="${ref}" s="3"><v>${serial(v.date)}</v></c>`;
      if (typeof v === 'object' && v.link) return `<c r="${ref}" s="2" t="str"><f>HYPERLINK("${xesc(v.link)}","${xesc(v.label || 'Open')}")</f><v>${xesc(v.label || 'Open')}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(String(v).slice(0, 32000))}</t></is></c>`;
    }).join('') + '</row>').join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${body}</sheetData>` +
      (rows.length > 1 && !noFilter ? `<autoFilter ref="A1:${last}"/>` : '') + `</worksheet>`;
  }
  async function xlsx(sheets) {
    const NS = 'http://schemas.openxmlformats.org/', head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const files = [
      { name: '[Content_Types].xml', text: head + `<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + `</Types>` },
      { name: '_rels/.rels', text: head + `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', text: head + `<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><sheets>` +
        sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets><definedNames>` +
        sheets.map((s, i) => s.rows.length > 1 && !s.noFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xesc(s.name)}'!$A$1:$${colName(s.rows[0].length - 1)}$${s.rows.length}</definedName>` : '').join('') +
        `</definedNames></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', text: head + `<Relationships xmlns="${NS}package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${NS}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: head + `<styleSheet xmlns="${NS}spreadsheetml/2006/main">` +
        `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>` +
        `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF24405A"/><bgColor indexed="64"/></patternFill></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
        `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows, s.noFilter) })),
    ];
    return zip(files);
  }
  async function excel() {
    status('Building Excel file…');
    const sheets = [];
    if (sizeTable().size) sheets.push({ name: 'Size Bands', rows: sizeBandRows(), noFilter: true }, { name: 'Firm Sizes', rows: firmSizeRows() });
    if (leadKnown() || R.reps.size) sheets.push({ name: 'Leadership & Size', rows: leadershipRows() });
    if (leadership().size) sheets.push({ name: 'Leadership People', rows: leadershipPeopleRows() });
    sheets.push({ name: 'Firms', rows: firmRows() });
    if (R.firms.some(f => f.parsed)) sheets.push({ name: 'Firm Registrations', rows: firmRegRows() });
    if (R.reps.size) sheets.push({ name: 'Individuals', rows: indivRows(false) });
    // Dealing-rep and people-level condition sheets are only complete after a full scan.
    const full = R.settings.wantID && R.indiv.size;
    if (full) sheets.push({ name: 'Dealing Reps', rows: indivRows(true) });
    if (R.firms.some(f => f.parsed)) sheets.push({ name: 'T&C Summary', rows: tcSummaryRows(), noFilter: true }, { name: 'Firms with T&C', rows: groupedRows('F') });
    if (full) sheets.push({ name: 'People with T&C', rows: groupedRows('I') });
    if (R.firms.some(f => f.parsed)) sheets.push({ name: 'Terms & Conditions', rows: termsRows() });
    sheets.push({ name: 'About', rows: aboutRows() });
    save_(`nrd-${slug()}-${stamp()}.xlsx`, await xlsx(sheets));
    status(`Excel file downloaded: ${sheets.map(s => `${s.name} (${s.rows.length - 1})`).join(', ')}.`);
  }

  // ---------- terms & conditions report ----------
  // A self-contained page (opened in a new tab, or saved as .html) that groups every condition
  // by category and province, for firms, dealing reps or all registrants.
  function reportData() {
    const firms = R.firms.filter(f => f.parsed).map(f => ({ nrd: num(f.NRDNumber), name: f.FirmName, link: firmUrl(f.FirmId) }));
    const conds = [];
    for (const f of R.firms) for (const j of f.juris) for (const t of j.terms || [])
      conds.push({ w: 'F', name: f.FirmName, firm: f.FirmName, nrd: num(f.NRDNumber), prov: jc(j), label: t.type || '', cats: tcCategories(t), text: t.text, disc: !!f.disciplined, link: firmUrl(f.FirmId) });
    let checked = 0, drChecked = 0;
    for (const rec of R.reps.values()) {
      const x = repInfo(rec); if (!x.info) continue;
      checked++; if (x.dr.length) drChecked++;
      for (const t of x.terms)
        conds.push({ w: 'I', name: rec.name, id: num(rec.individualId), firm: rec.firm.FirmName, nrd: num(rec.firm.NRDNumber), prov: t.prov,
          label: t.type || '', cats: tcCategories(t), text: t.text, dr: x.dr.length > 0, disc: !!x.info.disciplined, link: indUrl(rec.individualId) });
    }
    return { title: describe(R), made: new Date().toLocaleString(), complete: !!R.finished, firms, checked, drChecked, cats: TC_CATEGORIES.map(c => c.name), conds };
  }
  async function openReport(download) {
    const html = reportHtml(reportData());
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    if (download) return save_(`nrd-${slug()}-terms-report-${stamp()}.html`, blob);
    const w = window.open(URL.createObjectURL(blob), '_blank');
    if (!w) status('The browser blocked the report tab. Allow pop-ups for this site, or use "Save report".');
  }
  function reportHtml(data) {
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NRD Terms Report</title><style>
:root{--bg:#f4f6f9;--card:#fff;--ink:#1b2430;--mut:#5f6d7b;--line:#dde3ea;--acc:#24405a;--chip:#eef2f6;--on:#24405a;--onInk:#fff;--hi:#fff4de;--hiInk:#8a5a00;--red:#b3261e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#11161c;--card:#19212a;--ink:#e3e9ef;--mut:#9aa8b6;--line:#2c3844;--acc:#8fb3d9;--chip:#222c37;--on:#8fb3d9;--onInk:#0f1720;--hi:#3a2e14;--hiInk:#f2c46b;--red:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 60px}h1{font-size:22px;margin:0}.sub{color:var(--mut);margin:2px 0 18px}
.bar{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:grid;gap:10px}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.row>b{min-width:92px;font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.chip{border:1px solid var(--line);background:var(--chip);color:var(--ink);border-radius:16px;padding:3px 11px;font:inherit;font-size:13px;cursor:pointer}
.chip.on{background:var(--on);color:var(--onInk);border-color:var(--on)}input[type=search]{flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:24px}.kpi span{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}.card h2{font-size:16px;margin:0 0 8px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 8px;border-top:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left;white-space:normal}th{color:var(--mut);font-weight:600;border-top:0}td.c{cursor:pointer}td.c:hover{background:var(--hi);color:var(--hiInk)}td.z{color:var(--line)}
details.g{border-top:1px solid var(--line);padding:8px 0}details.g>summary{cursor:pointer;font-weight:600}details.g>summary span{color:var(--mut);font-weight:400}
.ent{padding:8px 0 8px 14px;border-top:1px dashed var(--line)}.ent:first-of-type{border-top:0}.ent a{color:var(--acc);font-size:12px;margin-left:6px}
.mut{color:var(--mut);font-size:12px}.tx{font-size:12.5px;margin:3px 0 0}.pill{display:inline-block;padding:0 7px;border-radius:9px;background:var(--hi);color:var(--hiInk);font-size:11px;font-weight:600;margin-left:4px}.pill.red{background:transparent;border:1px solid var(--red);color:var(--red)}
.btn{border:1px solid var(--acc);background:none;color:var(--acc);border-radius:7px;padding:5px 12px;font:inherit;font-weight:600;cursor:pointer}.warn{background:var(--hi);color:var(--hiInk);border-radius:8px;padding:8px 12px;margin-bottom:14px;font-size:13px}
</style></head><body><main>
<h1>Terms &amp; conditions report</h1><p class="sub" id="sub"></p><div id="partial"></div>
<div class="bar">
<div class="row"><b>Show</b><button class="chip" data-scope="F">Firms</button><button class="chip" data-scope="D">Dealing reps</button><button class="chip" data-scope="A">All registrants</button></div>
<div class="row"><b>Province</b><span id="provs"></span></div>
<div class="row"><b>Category</b><span id="cats"></span></div>
<div class="row"><b>Search</b><input type="search" id="q" placeholder="Firm or person name, or words in the condition"><button class="btn" id="csv">Download this view (CSV)</button></div>
</div>
<div class="kpis" id="kpis"></div>
<div class="card"><h2>By category and province</h2><p class="mut">Count of <span id="unit"></span> with at least one condition in each category. One condition can touch several categories, so rows don't add up to the total. Click a number to filter.</p><div class="wrap"><table id="mx"></table></div></div>
<div class="card"><h2>Grouped by category</h2><div id="groups"></div></div>
<p class="mut">Source: CSA National Registration Search. Categories in plain words are derived from the condition text; the NRD's own label is shown beside each condition. The CSA presents this information as a plain language summary of public documents. Check the NRD record before relying on it.</p>
</main><script>
const D=${json};
const P=["AB","BC","MB","NB","NF","NS","NT","NU","ON","PE","QC","SK","YT"];
const st={scope:"F",provs:new Set(),cats:new Set(),q:""};
const h=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
document.getElementById("sub").textContent=D.title+" · made "+D.made;
if(!D.complete)document.getElementById("partial").innerHTML='<div class="warn">This report comes from a scan that has not finished, so counts are partial.</div>';
const provsIn=[...new Set(D.conds.map(c=>c.prov))].sort((a,b)=>P.indexOf(a)-P.indexOf(b));
const chips=(id,vals,set)=>{document.getElementById(id).innerHTML=vals.map(v=>'<button class="chip" data-v="'+h(v)+'">'+h(v)+'</button>').join("");
document.getElementById(id).onclick=e=>{const b=e.target.closest(".chip");if(!b)return;const v=b.dataset.v;set.has(v)?set.delete(v):set.add(v);draw()}};
chips("provs",provsIn,st.provs);chips("cats",D.cats.filter(c=>D.conds.some(x=>x.cats.includes(c))),st.cats);
document.querySelectorAll("[data-scope]").forEach(b=>b.onclick=()=>{st.scope=b.dataset.scope;draw()});
document.getElementById("q").oninput=e=>{st.q=e.target.value.toLowerCase();draw()};
const inScope=c=>st.scope==="F"?c.w==="F":st.scope==="D"?c.w==="I"&&c.dr:c.w==="I";
const key=c=>c.w==="F"?"F"+c.nrd:"I"+c.id+"|"+c.nrd;
function rows(skipProv,skipCat){return D.conds.filter(c=>inScope(c)&&(skipProv||!st.provs.size||st.provs.has(c.prov))&&(skipCat||!st.cats.size||c.cats.some(k=>st.cats.has(k)))&&
(!st.q||(c.name+" "+c.firm+" "+c.text+" "+c.label).toLowerCase().includes(st.q)))}
function draw(){
document.querySelectorAll("[data-scope]").forEach(b=>b.classList.toggle("on",b.dataset.scope===st.scope));
document.querySelectorAll("#provs .chip").forEach(b=>b.classList.toggle("on",st.provs.has(b.dataset.v)));
document.querySelectorAll("#cats .chip").forEach(b=>b.classList.toggle("on",st.cats.has(b.dataset.v)));
const r=rows(),ents=new Set(r.map(key));
const unit=st.scope==="F"?"firms":st.scope==="D"?"dealing reps":"registrants",one={firms:"firm","dealing reps":"dealing rep",registrants:"registrant"};document.getElementById("unit").textContent=unit;
const denom=st.scope==="F"?D.firms.length:st.scope==="D"?D.drChecked:D.checked;
document.getElementById("kpis").innerHTML='<div class="kpi"><b>'+ents.size+'</b><span>'+unit+' with conditions in this view</span></div>'+
'<div class="kpi"><b>'+denom+'</b><span>'+unit+' checked in the scan</span></div><div class="kpi"><b>'+r.length+'</b><span>conditions (one per province)</span></div>';
const mr=rows(true,true),cols=provsIn.filter(p=>!st.provs.size||st.provs.has(p)),cats=D.cats.filter(c=>mr.some(x=>x.cats.includes(c))&&(!st.cats.size||st.cats.has(c)));
const cnt=(cat,p)=>new Set(mr.filter(x=>(!cat||x.cats.includes(cat))&&(!p||x.prov===p)&&(!st.provs.size||st.provs.has(x.prov))).map(key)).size;
let t="<tr><th>Category</th>"+cols.map(p=>"<th>"+p+"</th>").join("")+"<th>All</th></tr>";
for(const c of cats)t+="<tr><td>"+h(c)+"</td>"+cols.map(p=>{const n=cnt(c,p);return n?'<td class="c" data-c="'+h(c)+'" data-p="'+p+'">'+n+"</td>":'<td class="z">0</td>'}).join("")+'<td class="c" data-c="'+h(c)+'"><b>'+cnt(c)+"</b></td></tr>";
t+="<tr><td><b>Any category</b></td>"+cols.map(p=>"<td><b>"+cnt(null,p)+"</b></td>").join("")+"<td><b>"+cnt(null)+"</b></td></tr>";
const mx=document.getElementById("mx");mx.innerHTML=t;mx.onclick=e=>{const td=e.target.closest("td.c");if(!td)return;st.cats=new Set([td.dataset.c]);st.provs=td.dataset.p?new Set([td.dataset.p]):new Set();draw()};
const byCat=new Map();for(const c of r)for(const cat of c.cats){if(st.cats.size&&!st.cats.has(cat))continue;if(!byCat.has(cat))byCat.set(cat,new Map());const m=byCat.get(cat),k=key(c);if(!m.has(k))m.set(k,[]);m.get(k).push(c)}
let g="";for(const cat of D.cats){const m=byCat.get(cat);if(!m)continue;
g+='<details class="g"'+(byCat.size<=2?" open":"")+"><summary>"+h(cat)+" <span>· "+m.size+" "+(m.size===1?one[unit]:unit)+"</span></summary>";
for(const list of [...m.values()].sort((a,b)=>a[0].name.localeCompare(b[0].name))){const c0=list[0];
g+='<div class="ent"><b>'+h(c0.name)+"</b>"+(c0.w==="I"?' <span class="mut">'+h(c0.firm)+"</span>":' <span class="mut">NRD '+h(c0.nrd)+"</span>")+(c0.w==="I"&&!c0.dr?'<span class="pill">not a dealing rep</span>':"")+(c0.disc?'<span class="pill red">Disciplined List</span>':"")+'<a href="'+h(c0.link)+'" target="_blank" rel="noopener">NRD record ↗</a>';
const byText=new Map();for(const c of list){const k=c.label+"|"+c.text;if(!byText.has(k))byText.set(k,{c,p:[]});byText.get(k).p.push(c.prov)}
for(const {c,p} of byText.values())g+='<div class="tx"><b>'+h(p.join(", "))+"</b> · "+h(c.label||"Condition")+" — "+h(c.text)+"</div>";g+="</div>"}g+="</details>"}
document.getElementById("groups").innerHTML=g||'<p class="mut">No conditions match this view.</p>'}
document.getElementById("csv").onclick=()=>{const esc=v=>{v=String(v==null?"":v);return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
const out=[["Applies to","Name","Individual ID","Dealing rep","Firm","Firm NRD #","Province","Category","NRD label","Text","NRD record"]].concat(rows().map(c=>[c.w==="F"?"Firm":"Individual",c.name,c.id||"",c.w==="I"?(c.dr?"Yes":"No"):"",c.firm,c.nrd,c.prov,c.cats.join("; "),c.label,c.text,c.link]));
const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\\ufeff"+out.map(r=>r.map(esc).join(",")).join("\\r\\n")],{type:"text/csv"}));a.download="nrd-terms-view.csv";a.click()};
draw();
</script></body></html>`;
  }

  // ---------- wiring ----------
  box.addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    ({ hide: () => { box.style.display = 'none'; }, start: () => run(false), resume: () => run(true),
      stop: () => { S.stop = true; status('Stopping…'); },
      tcscan: () => { ['#nrdx-fd', '#nrdx-ri', '#nrdx-id', '#nrdx-ld', '#nrdx-oj'].forEach(id => { $(id).checked = true; $(id).disabled = false; });
        $('#nrdx-sz').checked = false; run(false); },
      leadscan: () => { ['#nrdx-fd', '#nrdx-ri', '#nrdx-ld', '#nrdx-oj', '#nrdx-sz'].forEach(id => { $(id).checked = true; }); $('#nrdx-id').checked = false; run(false); },
      sizescan: () => { ['#nrdx-fd', '#nrdx-ri', '#nrdx-id', '#nrdx-ld'].forEach(id => { $(id).checked = false; }); $('#nrdx-sz').checked = true; run(false); },
      report: () => openReport(false), savereport: () => openReport(true),
      xlsx: () => excel().catch(err => { status('Excel export failed: ' + err.message); log(err.stack || err.message); }),
      firms: () => csv(firmRows(), 'firms'), reps: () => csv(indivRows(false), 'individuals'),
      drs: () => csv(indivRows(true), 'dealing-reps'), terms: () => csv(termsRows(), 'terms-and-conditions') })[a.dataset.a]();
  });
  $('#nrdx-ri').addEventListener('change', e => { $('#nrdx-id').disabled = !e.target.checked; });

  // Size bands: remembered in this browser; the panel table re-groups as you type.
  try { $('#nrdx-bands').value = localStorage.getItem('nrdx-bands') || DEFAULT_BANDS; } catch { $('#nrdx-bands').value = DEFAULT_BANDS; }
  $('#nrdx-bands').addEventListener('input', () => {
    try { parseBands($('#nrdx-bands').value); localStorage.setItem('nrdx-bands', $('#nrdx-bands').value); } catch {}
    renderBands();
  });

  // Load the site's live category list for firms, then any saved run.
  postJSON('NrsSearch.aspx/GetCategories', "{'firmOrIndiv':'F','selJurisdictionsList':''}").then(j => {
    const cats = (j.d || []).map(o => o.Value).filter(Boolean);
    if (cats.length) $('#nrdx-cat').innerHTML = cats.map(c => `<option${c === 'Exempt Market Dealer' ? ' selected' : ''}>${c}</option>`).join('');
  }).catch(() => {}).then(() => DB.get('run')).then(saved => {
    if (!saved || S.running) return;
    R = saved; applySettings(R.settings);
    if (!R.finished) status('Found an unfinished run — click Resume to continue it.');
    showSaved(); refreshButtons(); renderBands();
  }).catch(e => log('Could not read saved progress: ' + e.message));

  window.__nrdx = { show: () => { box.style.display = ''; }, state: S, get run() { return R; } };
})();
