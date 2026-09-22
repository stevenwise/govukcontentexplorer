/* GOV.UK content explorer — unofficial. Read-only against the public GOV.UK APIs.
 *
 * CORS finding (Phase 0):
 *   - search.json  -> Access-Control-Allow-Origin: *  (called direct from browser)
 *   - content/<p>  -> Access-Control-Allow-Origin: *  (called direct from browser)
 *   - organisations-> NO CORS header, blocked in browser -> proxied via Netlify Function
 */

'use strict';

const GOVUK = 'https://www.gov.uk';
const DAY = 86400000;
const AMBER_DAYS = 1825;  // 5 years
const RED_DAYS = 3650;    // 10 years

/* ---------- small helpers ---------- */

const el = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripTags(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
}

function wordCount(text) {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Humanise a content-type slug for display, e.g. employment_tribunal_decision
// -> "Employment tribunal decision". The raw slug stays the value/CSV field.
function formatLabel(slug) {
  if (!slug) return '';
  const s = String(slug).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Compact but unambiguous date, e.g. 3 Jul 2008 — used in the dense results table.
function fmtDateNumeric(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function staleTag(days) {
  if (days == null) return '';
  if (days > RED_DAYS) return ' <strong class="govuk-tag govuk-tag--red">10+ years</strong>';
  if (days > AMBER_DAYS) return ' <strong class="govuk-tag govuk-tag--yellow">5+ years</strong>';
  return '';
}

/* Accept a full www.gov.uk URL or a bare path; strip query, anchor, leading slash. */
function normalisePath(input) {
  let s = (input || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/(www\.)?gov\.uk/i, '');
  s = s.replace(/^https?:\/\/[^/]+/i, ''); // any other host -> keep path only
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  return s;
}

/* Turn an absolute www.gov.uk link into a path; leave genuinely external links alone. */
function toInternalPathOrNull(href) {
  if (!href) return null;
  let h = href.trim();
  if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:')) return null;
  // protocol-relative
  if (h.startsWith('//')) h = 'https:' + h;
  if (/^https?:\/\/(www\.)?gov\.uk(\/|$)/i.test(h)) {
    return h.replace(/^https?:\/\/(www\.)?gov\.uk/i, '') || '/';
  }
  if (/^https?:\/\//i.test(h)) return null; // external
  if (h.startsWith('/')) return h;          // already a path
  return null;                               // relative fragment, ignore
}

function externalDomain(href) {
  try {
    const u = new URL(href.startsWith('//') ? 'https:' + href : href);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

/* ---------- view switching ---------- */

function showView(which) {
  el('view-page').classList.toggle('app-hidden', which !== 'page');
  el('view-estate').classList.toggle('app-hidden', which !== 'estate');
  el('view-map').classList.toggle('app-hidden', which !== 'map');
  el('view-about').classList.toggle('app-hidden', which !== 'about');
  document.querySelectorAll('.govuk-service-navigation__item').forEach(li => {
    const active = li.dataset.view === which;
    li.classList.toggle('govuk-service-navigation__item--active', active);
    const link = li.querySelector('.govuk-service-navigation__link');
    const label = li.dataset.label;
    if (active) { link.setAttribute('aria-current', 'page'); link.innerHTML = `<strong class="govuk-service-navigation__active-fallback">${label}</strong>`; }
    else { link.removeAttribute('aria-current'); link.textContent = label; }
  });
}

/* ---------- Page view ---------- */

// Router: a URL or path loads directly; free text (a title, which contains
// spaces) searches GOV.UK and offers matching pages to inspect.
function fetchPage() {
  const raw = (el('page-url').value || '').trim();
  if (!raw) { el('page-status').textContent = 'Enter a GOV.UK URL, path, or page title.'; return; }
  if (/\s/.test(raw)) return searchPages(raw); // URLs and paths never contain spaces
  return loadPage(normalisePath(raw));
}

async function loadPage(path) {
  const status = el('page-status');
  const results = el('page-results');
  results.classList.add('app-hidden');
  results.innerHTML = '';
  el('page-empty').classList.add('app-hidden');

  if (!path) { status.textContent = 'Enter a GOV.UK URL, path, or page title.'; return; }

  status.textContent = 'Fetching /' + path + ' …';
  try {
    const r = await fetch(GOVUK + '/api/content/' + path);
    if (!r.ok) {
      status.textContent = r.status === 404
        ? 'Not found at /' + path + '. Check the path, or type the page title to search instead.'
        : 'GOV.UK returned ' + r.status + ' for /' + path + '.';
      return;
    }
    const data = await r.json();
    status.textContent = '';
    renderPage(data, path);
    results.classList.remove('app-hidden');
    history.replaceState(null, '', '?page=/' + path); // deep link to this page
  } catch (e) {
    status.textContent = 'Could not reach the GOV.UK content API: ' + e.message;
  }
}

// Search GOV.UK by title/text and list matching pages to inspect.
async function searchPages(query) {
  const status = el('page-status');
  const results = el('page-results');
  results.classList.add('app-hidden');
  results.innerHTML = '';
  el('page-empty').classList.add('app-hidden');
  status.textContent = 'Searching for “' + query + '” …';
  try {
    const r = await fetch(GOVUK + '/api/search.json?count=10&q=' + encodeURIComponent(query) +
      '&fields=title&fields=link&fields=format');
    const data = await r.json();
    const items = data.results || [];
    if (!items.length) { status.textContent = 'No pages found for “' + query + '”.'; return; }
    status.textContent = '';
    let h = `<h3 class="govuk-heading-m govuk-!-margin-top-6">Pages matching “${esc(query)}”</h3>
      <p class="govuk-body-s app-muted">Select a page to inspect it.</p>
      <ul class="govuk-list">`;
    items.forEach(it => {
      h += `<li class="govuk-!-margin-bottom-3">
        <a class="govuk-link" href="#" data-load-path="${esc(it.link)}">${esc(it.title)}</a>
        ${it.format ? '<span class="app-muted"> · ' + esc(formatLabel(it.format)) + '</span>' : ''}
        <br><span class="govuk-body-s app-muted">${esc(it.link)}</span>
      </li>`;
    });
    h += `</ul>`;
    results.innerHTML = h;
    results.classList.remove('app-hidden');
  } catch (e) {
    status.textContent = 'Could not search GOV.UK: ' + e.message;
  }
}

function renderPage(d, path) {
  const links = d.links || {};
  const details = d.details || {};
  const parts = Array.isArray(details.parts) ? details.parts : [];

  // Concatenate body + every part body (trap: multi-part guides hold content in parts[].body)
  const fullBodyHtml = (details.body || '') + parts.map(p => p.body || '').join(' ');

  const out = [];

  // Title + withdrawn (trap: withdrawn_notice is {} when NOT withdrawn — test emptiness)
  out.push(`<h3 class="govuk-heading-l govuk-!-margin-top-6">${esc(d.title || '(untitled)')}</h3>`);
  out.push(`<p class="govuk-body-s app-muted"><a class="govuk-link" href="${GOVUK}/${esc(path)}" target="_blank" rel="noopener">${GOVUK}/${esc(path)}</a></p>`);
  const wn = d.withdrawn_notice;
  if (wn && typeof wn === 'object' && Object.keys(wn).length > 0) {
    out.push(`<div class="app-flag"><strong>Withdrawn.</strong> ${esc(wn.explanation ? stripTags(wn.explanation) : '')} ${wn.withdrawn_at ? '(' + fmtDate(wn.withdrawn_at) + ')' : ''}</div>`);
  }

  out.push(renderOwnership(d, links));
  out.push(renderDates(d, details));
  out.push(renderStructure(d, links, details, parts));
  out.push(renderAccessLanguage(details, links, fullBodyHtml));
  out.push(renderNavigation(links));
  out.push(renderLinksOut(details, parts));

  el('page-results').innerHTML = out.join('\n');
}

function renderOwnership(d, links) {
  const ppo = (links.primary_publishing_organisation || [])[0];
  const editorial = ppo ? ppo.title : null;
  const orgs = (links.organisations || []).map(o => o.title);
  const app = d.publishing_app || '(unknown)';
  const gloss = app === 'publisher' ? 'Mainstream, GDS-managed'
              : app === 'whitehall' ? 'Departmental'
              : app;

  // Owners differ when the editorial owner is not among the policy organisations
  const differ = editorial && orgs.length && !orgs.includes(editorial);

  let h = `<div class="app-panel"><h3 class="govuk-heading-m">Ownership</h3>`;
  if (differ) {
    h += `<div class="app-flag"><strong>Editorial and policy owners differ.</strong>
      Editorial owner is <strong>${esc(editorial)}</strong>, policy owner is <strong>${esc(orgs.join(', '))}</strong>.
      This is invisible on the page itself and is usually the interesting bit.</div>`;
  }
  h += `<dl class="govuk-summary-list">
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Editorial owner</dt>
      <dd class="govuk-summary-list__value">${editorial ? esc(editorial) : '<span class="app-muted">none set</span>'}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Policy owner</dt>
      <dd class="govuk-summary-list__value">${orgs.length ? esc(orgs.join(', ')) : '<span class="app-muted">none set</span>'}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Publishing app</dt>
      <dd class="govuk-summary-list__value">${esc(app)} <span class="app-muted">(${esc(gloss)})</span></dd></div>
  </dl></div>`;
  return h;
}

function renderDates(d, details) {
  const first = d.first_published_at || details.first_public_at;
  const updated = d.public_updated_at || d.updated_at;
  const days = daysSince(updated);
  const ch = Array.isArray(details.change_history) ? details.change_history : [];

  let h = `<div class="app-panel"><h3 class="govuk-heading-m">Dates and staleness</h3>
    <dl class="govuk-summary-list">
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">First published</dt>
      <dd class="govuk-summary-list__value">${fmtDate(first)}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Last updated</dt>
      <dd class="govuk-summary-list__value">${fmtDate(updated)}${staleTag(days)}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Days since update</dt>
      <dd class="govuk-summary-list__value">${days == null ? '—' : days.toLocaleString('en-GB')}</dd></div>
    </dl>`;
  if (ch.length) {
    h += `<h4 class="govuk-heading-s">Change history</h4><ol class="govuk-list govuk-list--number">`;
    ch.forEach(c => {
      h += `<li>${fmtDate(c.public_timestamp)}: ${esc(stripTags(c.note || ''))}</li>`;
    });
    h += `</ol>`;
  }
  h += `</div>`;
  return h;
}

function renderStructure(d, links, details, parts) {
  const children = Array.isArray(links.children) ? links.children : [];
  const atts = Array.isArray(details.attachments) ? details.attachments : [];
  // File attachments: those with a real MIME content_type (HTML attachments have none)
  const fileAtts = atts.filter(a => a.content_type);

  let h = `<div class="app-panel"><h3 class="govuk-heading-m">Structure</h3>
    <p class="govuk-body">Document type: <strong>${esc(d.document_type || '—')}</strong></p>`;

  if (parts.length) {
    h += `<h4 class="govuk-heading-s">${parts.length} parts</h4><ol class="govuk-list govuk-list--number">`;
    parts.forEach(p => { h += `<li>${esc(p.title || '')} <span class="app-muted">(${esc(p.slug || '')})</span></li>`; });
    h += `</ol>`;
  }

  // Pages inside this publication — prefer links.children (richer than details.attachments)
  h += `<h4 class="govuk-heading-s">Pages inside this publication (${children.length})</h4>`;
  if (children.length) {
    h += `<ul class="govuk-list govuk-list--bullet">`;
    children.forEach(c => {
      const url = c.base_path ? GOVUK + c.base_path : (c.web_url || '#');
      h += `<li class="app-break"><a class="govuk-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title || url)}</a>
        <span class="app-muted"> (updated ${fmtDate(c.public_updated_at)})</span></li>`;
    });
    h += `</ul>`;
  } else {
    h += `<p class="govuk-body app-muted">No child pages. This publication has no attachment pages nested inside it.</p>`;
  }

  // File attachments
  if (fileAtts.length) {
    h += `<h4 class="govuk-heading-s">File attachments (${fileAtts.length})</h4>
      <table class="govuk-table app-table"><thead class="govuk-table__head"><tr class="govuk-table__row">
        <th scope="col" class="govuk-table__header">Title</th>
        <th scope="col" class="govuk-table__header">Type</th>
        <th scope="col" class="govuk-table__header">Size</th>
        <th scope="col" class="govuk-table__header">Accessible</th>
      </tr></thead><tbody class="govuk-table__body">`;
    fileAtts.forEach(a => {
      const acc = a.accessible === false
        ? '<strong class="govuk-tag govuk-tag--red">No</strong>'
        : a.accessible === true ? '<strong class="govuk-tag govuk-tag--green">Yes</strong>'
        : '<span class="app-muted">—</span>';
      h += `<tr class="govuk-table__row">
        <td class="govuk-table__cell app-break">${esc(a.title || '')}</td>
        <td class="govuk-table__cell">${esc(a.content_type || '')}</td>
        <td class="govuk-table__cell">${a.file_size ? (Math.round(a.file_size / 1024).toLocaleString('en-GB') + ' KB') : '—'}</td>
        <td class="govuk-table__cell">${acc}</td>
      </tr>`;
    });
    h += `</tbody></table>`;
  }

  h += `</div>`;
  return h;
}

function renderAccessLanguage(details, links, fullBodyHtml) {
  const atts = Array.isArray(details.attachments) ? details.attachments : [];
  const fileAtts = atts.filter(a => a.content_type);
  const words = wordCount(stripTags(fullBodyHtml));
  const pdfOnly = fileAtts.length > 0 && words < 200;

  // Welsh — three routes
  const routes = [];
  let welshAccessible = false;

  // 1. available_translations for a cy locale
  const cyTrans = (links.available_translations || []).find(t => t.locale === 'cy');
  if (cyTrans) { routes.push('a proper Welsh translation (available_translations)'); welshAccessible = true; }

  // 2. attachment filename ending -cym or -w (before extension)
  const cyAtt = atts.find(a => /(-cym|-w)\.[a-z0-9]+$/i.test(a.url || a.filename || ''));
  if (cyAtt) {
    routes.push('a Welsh attachment (' + esc(cyAtt.title || cyAtt.url) + ')');
    if (cyAtt.accessible === true) welshAccessible = true; // an inaccessible PDF does not count
  }

  // 3. body link whose visible text mentions Welsh / Cymraeg
  let bodyWelshHref = null;
  const anchorRe = /<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(fullBodyHtml)) !== null) {
    const text = stripTags(m[2]);
    if (/welsh|cymraeg/i.test(text)) { bodyWelshHref = m[1]; break; }
  }
  if (bodyWelshHref) { routes.push('a body link to the Welsh version (' + esc(bodyWelshHref) + ')'); welshAccessible = true; }

  const welshPresent = routes.length > 0;

  let h = `<div class="app-panel"><h3 class="govuk-heading-m">Accessibility and language</h3>`;

  h += `<dl class="govuk-summary-list">
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Body word count</dt>
      <dd class="govuk-summary-list__value">${words.toLocaleString('en-GB')}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">PDF-only risk</dt>
      <dd class="govuk-summary-list__value">${pdfOnly
        ? '<strong class="govuk-tag govuk-tag--red">Likely</strong>: has file attachments and under 200 words of body content'
        : '<span class="app-muted">No: enough body content, or no file attachments</span>'}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Welsh version</dt>
      <dd class="govuk-summary-list__value">${welshPresent
        ? 'Present, found via ' + routes.join('; ')
        : '<span class="app-muted">None found via any of the three routes</span>'}</dd></div>`;
  if (welshPresent) {
    h += `<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Welsh accessible</dt>
      <dd class="govuk-summary-list__value">${welshAccessible
        ? '<strong class="govuk-tag govuk-tag--green">Yes</strong>: at least one accessible route'
        : '<strong class="govuk-tag govuk-tag--red">No</strong>: only an inaccessible file (e.g. a PDF flagged not accessible)'}</dd></div>`;
  }
  h += `</dl>`;

  // Individual inaccessible attachments
  const inaccessible = atts.filter(a => a.accessible === false);
  if (inaccessible.length) {
    h += `<div class="app-flag"><strong>${inaccessible.length} attachment(s) flagged not accessible:</strong>
      <ul class="govuk-list govuk-list--bullet">`;
    inaccessible.forEach(a => { h += `<li class="app-break">${esc(a.title || a.url)}</li>`; });
    h += `</ul></div>`;
  }

  h += `</div>`;
  return h;
}

function renderNavigation(links) {
  const browse = (links.mainstream_browse_pages || []).map(o => o.title);
  const parent = (links.parent || []).map(o => o.title);
  const taxons = (links.taxons || []).map(o => o.title);

  let h = `<div class="app-panel"><h3 class="govuk-heading-m">Navigation</h3>`;
  if (browse.length || parent.length) {
    h += `<dl class="govuk-summary-list">`;
    if (browse.length) h += `<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Mainstream browse</dt><dd class="govuk-summary-list__value">${esc(browse.join(', '))}</dd></div>`;
    if (parent.length) h += `<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Parent</dt><dd class="govuk-summary-list__value">${esc(parent.join(', '))}</dd></div>`;
    h += `</dl>`;
  } else {
    h += `<p class="govuk-body app-muted">Not in any browse navigation.</p>`;
  }
  h += `<h4 class="govuk-heading-s">Taxons</h4>`;
  h += taxons.length
    ? `<p class="govuk-body">${esc(taxons.join(', '))}</p>`
    : `<p class="govuk-body app-muted">No taxons.</p>`;
  h += `</div>`;
  return h;
}

function renderLinksOut(details, parts) {
  const fullBodyHtml = (details.body || '') + parts.map(p => p.body || '').join(' ');
  const anchorRe = /<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  const internal = new Map();       // path -> link text
  const external = new Map();       // domain -> count
  let m;
  while ((m = anchorRe.exec(fullBodyHtml)) !== null) {
    const href = m[1];
    const text = stripTags(m[2]).trim();
    const internalPath = toInternalPathOrNull(href);
    if (internalPath) {
      if (!internal.has(internalPath)) internal.set(internalPath, text || internalPath);
    } else if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
      const dom = externalDomain(href);
      if (dom) external.set(dom, (external.get(dom) || 0) + 1);
    }
  }

  let h = `<div class="app-panel"><h3 class="govuk-heading-m">Links out</h3>`;

  h += `<h4 class="govuk-heading-s">Internal GOV.UK links (${internal.size})</h4>`;
  if (internal.size) {
    h += `<ul class="govuk-list govuk-list--bullet">`;
    [...internal.entries()].forEach(([p, t]) => {
      h += `<li class="app-break"><a class="govuk-link" href="${GOVUK}${esc(p)}" target="_blank" rel="noopener">${esc(t)}</a> <span class="app-muted">${esc(p)}</span></li>`;
    });
    h += `</ul>`;
  } else {
    h += `<p class="govuk-body app-muted">None.</p>`;
  }

  const extSorted = [...external.entries()].sort((a, b) => b[1] - a[1]);
  h += `<h4 class="govuk-heading-s">External domains (${extSorted.length})</h4>`;
  if (extSorted.length) {
    h += `<ul class="app-domain-list govuk-body">`;
    extSorted.forEach(([dom, n]) => { h += `<li>${esc(dom)} <span class="app-muted">×${n}</span></li>`; });
    h += `</ul>`;
  } else {
    h += `<p class="govuk-body app-muted">None.</p>`;
  }

  h += `</div>`;
  return h;
}

/* ---------- Estate view: aggregate screen ---------- */

const GUIDANCE_TYPES = ['guide', 'answer', 'transaction', 'guidance',
                        'detailed_guide', 'statutory_guidance', 'document_collection'];

const estate = {
  orgs: [],            // [{slug, title}]
  orgsSource: null,    // 'function' | 'aggregate-fallback'
  selected: null,      // {slug, title}
  formats: [],         // [{slug, documents}] sorted desc
  chart: null,
  activeIndex: -1,     // combobox keyboard highlight
  filtered: [],        // current filtered orgs
  restoring: false,    // true while rebuilding a view from the URL (suppresses URL churn + confirms)
  page: 1,             // table page (50 rows/page)
  typeChips: new Set(),// active content-type filter chips
  ownerChips: new Set(),// active editorial-owner filter chips (deep-linked)
  ownerChipsExpanded: false, // "Show all owners" disclosure open?
  staleChip: null,     // active staleness band: under1 | 1to5 | over5 | over10 | null
  yearFilter: null,    // year selected from the chart, or null
};

const OWNER_CHIP_CAP = 10; // show the top-N owners; the rest behind a disclosure

const PAGE_ROWS = 50;

// Both Estate and Map need the same organisation list; load it at most once.
let orgsPromise = null;
function ensureOrgs() {
  if (!orgsPromise) orgsPromise = loadOrganisations();
  return orgsPromise;
}

async function loadOrganisations() {
  // Primary: the Netlify Function (the one CORS-blocked endpoint).
  try {
    const r = await fetch('/api/organisations');
    if (r.ok) {
      const data = await r.json();
      if (data && Array.isArray(data.organisations) && data.organisations.length) {
        estate.orgs = data.organisations.map(o => ({ slug: o.slug, title: o.title }));
        estate.orgsSource = 'function';
        return;
      }
    }
  } catch (e) { /* fall through to fallback */ }

  // Fallback: derive from the CORS-enabled search aggregate (slug only, no titles).
  // Keeps the picker usable in pure-static local mode or if the function is down.
  try {
    const r = await fetch(GOVUK + '/api/search.json?count=0&aggregate_primary_publishing_organisation=1500');
    const data = await r.json();
    const opts = ((data.aggregates || {}).primary_publishing_organisation || {}).options || [];
    estate.orgs = opts.map(o => ({ slug: o.value.slug, title: o.value.slug }))
                      .sort((a, b) => a.slug.localeCompare(b.slug));
    estate.orgsSource = 'aggregate-fallback';
  } catch (e) {
    estate.orgsSource = 'failed';
  }
}

const ORG_LIST_CAP = 100;

function renderOrgOptions(query) {
  const list = el('estate-org-list');
  const q = (query || '').trim().toLowerCase();
  const matches = q
    ? estate.orgs.filter(o => o.title.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q))
    : estate.orgs;
  const totalMatches = matches.length;
  estate.filtered = matches.slice(0, ORG_LIST_CAP);
  estate.activeIndex = -1;

  if (!estate.filtered.length) {
    list.innerHTML = '<div class="app-combo-option app-muted">No matching organisation</div>';
  } else {
    let html = estate.filtered.map((o, i) => {
      const showSlug = o.title !== o.slug;
      return `<button type="button" class="app-combo-option" role="option" data-i="${i}">
        ${esc(o.title)}${showSlug ? ' <span class="app-muted">' + esc(o.slug) + '</span>' : ''}</button>`;
    }).join('');
    if (totalMatches > estate.filtered.length) {
      const more = totalMatches - estate.filtered.length;
      html += `<div class="app-combo-more app-muted">Showing first ${estate.filtered.length} of ${totalMatches.toLocaleString('en-GB')}. Keep typing to narrow (${more.toLocaleString('en-GB')} more).</div>`;
    }
    list.innerHTML = html;
  }
  list.classList.remove('app-hidden');
  el('estate-org-search').setAttribute('aria-expanded', 'true');
}

function selectOrg(o) {
  estate.selected = o;
  el('estate-org-search').value = o.title;
  el('estate-org-list').classList.add('app-hidden');
  el('estate-org-search').setAttribute('aria-expanded', 'false');
  el('estate-fetch').disabled = false;
  // Clear the previous org's breakdown and results so nothing stale lingers
  // until the new org's breakdown is fetched.
  if (!estate.restoring) {
    el('estate-aggregate').classList.add('app-hidden');
    el('estate-results').classList.add('app-hidden');
    el('estate-status').textContent = '';
    estate.rows = [];
  }
  updateUrl();
}

function moveActive(delta) {
  const n = estate.filtered.length;
  if (!n) return;
  estate.activeIndex = (estate.activeIndex + delta + n) % n;
  [...el('estate-org-list').querySelectorAll('.app-combo-option')].forEach((b, i) =>
    b.classList.toggle('app-active', i === estate.activeIndex));
}

async function fetchAggregate() {
  if (!estate.selected) return;
  const slug = estate.selected.slug;
  const status = el('estate-status');
  el('estate-aggregate').classList.add('app-hidden');
  status.textContent = 'Fetching breakdown for ' + slug + ' …';

  try {
    const url = GOVUK + '/api/search.json?filter_organisations=' + encodeURIComponent(slug) +
                '&count=0&aggregate_format=100';
    const r = await fetch(url);
    if (!r.ok) { status.textContent = 'GOV.UK returned ' + r.status + '.'; return; }
    const data = await r.json();
    status.textContent = '';

    const total = data.total || 0;
    estate.orgTotal = total; // the org's whole-index count, denominator for the "X of index" card
    el('estate-total').textContent = total.toLocaleString('en-GB');
    el('estate-total-sub').textContent = 'in the search index for ' + slug;

    const opts = ((data.aggregates || {}).format || {}).options || [];
    estate.formats = opts.map(o => ({ slug: o.value.slug, documents: o.documents }))
                         .sort((a, b) => b.documents - a.documents);

    el('estate-breakdown-details').open = false; // collapsed by default; it's an optional chart
    renderTypeCheckboxes();
    renderFormatChart();
    updateProjection();
    el('estate-empty').classList.add('app-hidden');
    el('estate-aggregate').classList.remove('app-hidden');
  } catch (e) {
    status.textContent = 'Could not reach the search API: ' + e.message;
  }
}

function renderTypeCheckboxes() {
  const box = el('estate-checkboxes');
  const fmts = estate.formats;
  const cbHtml = (f) => `
    <div class="govuk-checkboxes__item">
      <input class="govuk-checkboxes__input" id="cb-${esc(f.slug)}" type="checkbox" value="${esc(f.slug)}">
      <label class="govuk-label govuk-checkboxes__label" for="cb-${esc(f.slug)}">
        ${esc(formatLabel(f.slug))} <span class="app-muted">(${f.documents.toLocaleString('en-GB')})</span>
      </label>`.concat('</div>');

  const top = fmts.slice(0, 10);
  const rest = fmts.slice(10);
  let html = top.map(cbHtml).join('');
  if (rest.length) {
    html += `<details class="govuk-details govuk-!-margin-top-2 govuk-!-margin-bottom-0" id="estate-types-more">
      <summary class="govuk-details__summary"><span class="govuk-details__summary-text">Show all ${fmts.length} types</span></summary>
      <div class="govuk-details__text">${rest.map(cbHtml).join('')}</div>
    </details>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', updateProjection));
}

function checkedTypes() {
  return [...el('estate-checkboxes').querySelectorAll('input:checked')].map(c => c.value);
}

function updateProjection() {
  const checked = new Set(checkedTypes());
  const sum = estate.formats.filter(f => checked.has(f.slug)).reduce((a, f) => a + f.documents, 0);
  estate.projected = sum;
  el('estate-projected').textContent = sum.toLocaleString('en-GB');
  el('estate-projected-sub').textContent = checked.size
    ? `${checked.size} content type${checked.size === 1 ? '' : 's'} selected`
    : 'Tick content types below.';
  el('estate-get-results').disabled = checked.size === 0;
  updateUrl();
}

function setGuidanceTypes() {
  el('estate-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.checked = GUIDANCE_TYPES.includes(cb.value);
  });
  // Most guidance types sit below the top-10 cut, inside the disclosure — open
  // it so the ticked ones are visible.
  const more = el('estate-types-more');
  if (more && more.querySelector('input:checked')) more.open = true;
  updateProjection();
}

function clearTypes() {
  el('estate-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
  updateProjection();
}

function renderFormatChart() {
  const f = estate.formats;
  if (estate.chart) { estate.chart.destroy(); estate.chart = null; }
  if (!f.length) return;

  // Log scale when the top value dwarfs the median (>100x).
  const docs = f.map(x => x.documents).slice().sort((a, b) => a - b);
  const median = docs[Math.floor(docs.length / 2)] || 1;
  const useLog = median > 0 && (docs[docs.length - 1] / median) > 100;
  el('estate-chart-note').textContent = useLog
    ? 'Log scale: the top content type is more than 100× the median, so a linear axis would hide everything else. Bar tooltips show real counts.'
    : 'Linear scale.';

  // Chart.js cannot render horizontal bars on a native logarithmic axis (the bar
  // base sits at log(0) = -Infinity and every bar collapses). So when we want a
  // log view we plot log10(value) on a linear axis and label ticks/tooltips with
  // the real counts — same readability, reliable rendering.
  const plotted = useLog ? f.map(x => Math.log10(x.documents + 1)) : f.map(x => x.documents);

  const canvas = el('estate-chart');
  // With maintainAspectRatio:false, Chart.js sizes to the container height, so
  // set the wrapper tall enough to give every content-type row room.
  el('estate-chart-wrap').style.height = Math.max(240, f.length * 24) + 'px';

  estate.chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: f.map(x => formatLabel(x.slug)),
      datasets: [{ label: 'Items', data: plotted, backgroundColor: '#1d70b8' }],
    },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      responsive: true,
      animation: false, // place bars at final positions immediately; a backgrounded/throttled tab never runs the animation otherwise
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => f[c.dataIndex].documents.toLocaleString('en-GB') + ' items' } },
      },
      scales: {
        x: {
          min: 0,
          title: { display: true, text: useLog ? 'Items (log scale)' : 'Items' },
          ticks: useLog
            ? { callback: (v) => (Number.isInteger(v) ? Math.round(Math.pow(10, v)).toLocaleString('en-GB') : '') }
            : {},
        },
        y: { ticks: { autoSkip: false, font: { size: 11 } } },
      },
    },
  });
}

/* ---------- Estate view: results ---------- */

const PAGE_SIZE = 1500;
const CHART_COLOURS = ['#1d70b8', '#d4351c', '#00703c', '#f47738', '#4c2c92', '#912b88',
                       '#28a197', '#b58840', '#5694ca', '#85994b', '#6f777b', '#801650'];

// Display-only abbreviations for long owner names (full name kept for CSV/hover).
// Keyed by the exact GOV.UK org title.
const OWNER_ABBREV = {
  'Government Digital Service': 'GDS',
  'HM Revenue & Customs': 'HMRC',
  'HM Courts & Tribunals Service': 'HMCTS',
  'Department for Work and Pensions': 'DWP',
  'Ministry of Justice': 'MoJ',
  'Ministry of Housing, Communities and Local Government': 'MHCLG',
  'Department for Levelling Up, Housing and Communities': 'DLUHC',
  'Department for Education': 'DfE',
  'Department for Business and Trade': 'DBT',
  'Department for Environment, Food & Rural Affairs': 'Defra',
  'Foreign, Commonwealth & Development Office': 'FCDO',
  'Department of Health and Social Care': 'DHSC',
  'HM Treasury': 'HMT',
  'Department for Transport': 'DfT',
  'Department for Culture, Media and Sport': 'DCMS',
  'Department for Energy Security and Net Zero': 'DESNZ',
  'Department for Science, Innovation and Technology': 'DSIT',
  'Ministry of Defence': 'MOD',
  'Driver and Vehicle Licensing Agency': 'DVLA',
  'Driver and Vehicle Standards Agency': 'DVSA',
  'HM Prison and Probation Service': 'HMPPS',
  'UK Health Security Agency': 'UKHSA',
  'Valuation Office Agency': 'VOA',
  'Criminal Injuries Compensation Authority': 'CICA',
  'Government Equalities Office': 'GEO',
  "Attorney General's Office": 'AGO',
  'Environment Agency': 'EA',
  'Maritime and Coastguard Agency': 'MCA',
  'Rural Payments Agency': 'RPA',
};
const ownerDisplay = (name) => OWNER_ABBREV[name] || name;

async function fetchResults() {
  const types = checkedTypes();
  if (!estate.selected || !types.length) return;

  if (!estate.restoring && estate.projected > 10000 &&
      !confirm(`This selection is about ${estate.projected.toLocaleString('en-GB')} items. ` +
               `Pulling them all takes roughly ${Math.ceil(estate.projected / PAGE_SIZE)} requests to GOV.UK. Continue?`)) {
    return;
  }

  const status = el('estate-results-status');
  el('estate-get-results').disabled = true;
  el('estate-results').classList.add('app-hidden');

  // include_withdrawn brings withdrawn pages into the pull (GOV.UK's default
  // search hides them). primary_publishing_organisation is the editorial owner
  // (matching Page view) — the search API returns it as a slug, which we map to
  // a title via the org list. is_withdrawn is a boolean. All ride the one request.
  const base = GOVUK + '/api/search.json?filter_organisations=' + encodeURIComponent(estate.selected.slug) +
    types.map(t => '&filter_format=' + encodeURIComponent(t)).join('') +
    '&fields=title&fields=link&fields=format&fields=public_timestamp&fields=primary_publishing_organisation&fields=is_withdrawn' +
    '&debug=include_withdrawn';

  const orgTitleBySlug = new Map(estate.orgs.map(o => [o.slug, o.title]));
  const ownerTitle = (ppo) => {
    if (!Array.isArray(ppo) || !ppo.length) return '';
    const slug = ppo[0];
    return (orgTitleBySlug.get(slug) || slug).trim(); // fall back to the slug if not in the list
  };

  const rows = [];
  let start = 0, total = null;
  try {
    do {
      status.textContent = total == null
        ? 'Fetching…'
        : `Fetching ${rows.length.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}…`;
      const r = await fetch(base + '&count=' + PAGE_SIZE + '&start=' + start);
      if (!r.ok) { status.textContent = 'GOV.UK returned ' + r.status + ' during pagination.'; el('estate-get-results').disabled = false; return; }
      const data = await r.json();
      if (total == null) total = data.total || 0;
      const batch = data.results || [];
      batch.forEach(x => rows.push({
        title: x.title || '(untitled)',
        path: x.link || '',
        format: x.format || '',
        updated: x.public_timestamp || null,
        days: daysSince(x.public_timestamp),
        owner: ownerTitle(x.primary_publishing_organisation),
        withdrawn: !!x.is_withdrawn,
      }));
      start += PAGE_SIZE;
      if (!batch.length) break; // safety against an infinite loop
    } while (rows.length < total);
    status.textContent = ''; // clear the progress text once results render below
  } catch (e) {
    status.textContent = 'Could not complete pagination: ' + e.message;
    el('estate-get-results').disabled = false;
    return;
  }

  estate.rows = rows;
  estate.sort = { key: 'updated', dir: 'asc' }; // oldest-updated first = stalest first
  estate.page = 1;
  estate.typeChips = new Set();
  estate.ownerChips = new Set();
  estate.ownerChipsExpanded = false;
  estate.staleChip = null;
  estate.yearFilter = null;
  updateWithdrawnToggle();
  renderCards();
  renderYearBar();
  renderChips();
  renderTable();
  el('estate-results').classList.remove('app-hidden');
  el('estate-breakdown-details').open = false; // fold the tall breakdown away so results sit near the button
  el('estate-get-results').disabled = false;
  updateUrl();
  if (!estate.restoring) el('estate-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Withdrawn pages are fetched but hidden by default; the working set is the
// fetched rows minus withdrawn unless the toggle is on. Cards, charts, table
// and CSV all derive from this so counts stay consistent.
function withdrawnShown() {
  const cb = el('estate-show-withdrawn');
  return !!(cb && cb.checked);
}

function baseRows() {
  return withdrawnShown() ? estate.rows : estate.rows.filter(r => !r.withdrawn);
}

function updateWithdrawnToggle() {
  const n = (estate.rows || []).filter(r => r.withdrawn).length;
  const cb = el('estate-show-withdrawn');
  const label = el('estate-withdrawn-count');
  if (label) label.textContent = n ? `(${n.toLocaleString('en-GB')})` : '(none)';
  if (cb) cb.disabled = n === 0;
}

function renderCards() {
  const rows = baseRows();
  const orgName = estate.selected.title === estate.selected.slug ? estate.selected.slug : estate.selected.title;
  el('estate-results-heading').textContent = 'Results for ' + orgName;
  const now = Date.now();
  const within12m = rows.filter(r => r.updated && (now - Date.parse(r.updated)) < 365 * DAY).length;
  const over5 = rows.filter(r => r.days != null && r.days > AMBER_DAYS).length;
  const over10 = rows.filter(r => r.days != null && r.days > RED_DAYS).length;
  const owners = new Set(rows.map(r => r.owner).filter(Boolean));
  const total = rows.length;
  const orgTotal = estate.orgTotal || 0;
  const pct = (n, d) => {
    const v = d ? (n / d) * 100 : 0;
    return (v > 0 && v < 1 ? v.toFixed(1) : Math.round(v)) + '%';
  };

  const byType = {};
  rows.forEach(r => { byType[r.format] = (byType[r.format] || 0) + 1; });
  const typeList = Object.entries(byType).sort((a, b) => b[1] - a[1]);

  const card = (label, num, sub) => `
    <div class="govuk-grid-column-one-third">
      <div class="app-card">
        <div class="app-num">${num}</div>
        <div class="govuk-body-s govuk-!-margin-bottom-0">${label}</div>
        ${sub ? '<div class="govuk-body-s app-muted">' + sub + '</div>' : ''}
      </div>
    </div>`;

  const maxN = typeList.length ? typeList[0][1] : 1;
  const typeRows = typeList.map(([t, n], i) => {
    const pct = Math.max(2, Math.round((n / maxN) * 100));
    const colour = CHART_COLOURS[i % CHART_COLOURS.length];
    const share = rows.length ? Math.round((n / rows.length) * 100) : 0;
    return `<tr class="govuk-table__row">
      <td class="govuk-table__cell app-break" style="width:32%">${esc(formatLabel(t))}</td>
      <td class="govuk-table__cell" style="width:48%">
        <div class="app-typebar-track"><div class="app-typebar-fill" style="width:${pct}%;background:${colour}"></div></div>
      </td>
      <td class="govuk-table__cell" style="width:12%;text-align:right;white-space:nowrap">${n.toLocaleString('en-GB')}</td>
      <td class="govuk-table__cell app-muted" style="width:8%;text-align:right;white-space:nowrap">${share}%</td>
    </tr>`;
  }).join('');

  el('estate-cards').innerHTML =
    card('Total items in the selection', total.toLocaleString('en-GB'), estate.selected.slug) +
    card('of everything this org publishes', orgTotal ? pct(total, orgTotal) : '—',
         orgTotal ? `${total.toLocaleString('en-GB')} of ${orgTotal.toLocaleString('en-GB')} items in the index` : '') +
    card('Distinct editorial owners', owners.size.toLocaleString('en-GB'),
         owners.size > 1 ? 'includes pages owned by others' : 'all one owner') +
    card('Updated in last 12 months', within12m.toLocaleString('en-GB'), `${pct(within12m, total)} of the selection`) +
    card('Not updated in over 5 years', over5.toLocaleString('en-GB'), `${pct(over5, total)} of the selection`) +
    card('Not updated in over 10 years', over10.toLocaleString('en-GB'), `${pct(over10, total)} of the selection`) +
    `<div class="govuk-grid-column-full"><div class="app-card">
       <h4 class="govuk-heading-s govuk-!-margin-bottom-2">Count per content type</h4>
       <table class="govuk-table govuk-!-margin-bottom-0"><tbody class="govuk-table__body">${typeRows}</tbody></table>
     </div></div>`;
}

function renderYearBar() {
  if (estate.yearbar) { estate.yearbar.destroy(); estate.yearbar = null; }
  const byYear = {};
  baseRows().forEach(r => {
    if (!r.updated) return;
    const y = new Date(r.updated).getFullYear();
    if (!isNaN(y)) byYear[y] = (byYear[y] || 0) + 1;
  });
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const labels = [];
  if (years.length) {
    for (let y = years[0]; y <= years[years.length - 1]; y++) labels.push(y); // fill gaps
  }

  const colours = labels.map(y => (estate.yearFilter === y ? '#d4351c' : '#1d70b8'));
  estate.yearbar = new Chart(el('estate-yearbar').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: labels.map(y => byYear[y] || 0), backgroundColor: colours }] },
    options: {
      maintainAspectRatio: false, responsive: true, animation: false,
      onClick: (evt, els) => {
        if (!els.length) return;
        const y = labels[els[0].index];
        estate.yearFilter = (estate.yearFilter === y ? null : y); // toggle
        estate.page = 1;
        renderYearBar(); renderChips(); renderTable();
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { footer: () => 'Click to filter the table to this year' } },
      },
      scales: { x: { ticks: { autoSkip: false, maxRotation: 90, minRotation: 45, font: { size: 10 } } },
                y: { beginAtZero: true } },
    },
  });
}

const COLUMNS = [
  { key: 'title', label: 'Title' },
  { key: 'owner', label: 'Editorial owner' },
  { key: 'format', label: 'Content type' },
  { key: 'updated', label: 'Last updated' }, // merged: date + days-since + staleness tag
  { key: 'withdrawn', label: 'Withdrawn' },
];

// The Withdrawn column only earns its place when withdrawn pages are shown;
// otherwise it is all dashes and just eats width.
function visibleColumns() {
  return COLUMNS.filter(c => c.key !== 'withdrawn' || withdrawnShown());
}

// Middle-truncate a path so both ends stay visible; full path shown on hover.
function midTruncate(s, max = 60) {
  if (!s || s.length <= max) return s || '';
  const keep = max - 1, front = Math.ceil(keep / 2), back = Math.floor(keep / 2);
  return s.slice(0, front) + '…' + s.slice(s.length - back);
}

function bandMatch(days, band) {
  if (days == null) return false;
  if (band === 'under1') return days < 365;
  if (band === '1to5') return days >= 365 && days <= AMBER_DAYS;
  if (band === 'over5') return days > AMBER_DAYS;
  if (band === 'over10') return days > RED_DAYS;
  return true;
}

// The fully filtered, sorted result set (working set → text → chips → year →
// sort). Everything downstream — count, pagination, CSV — reads this.
function sortedFilteredRows() {
  const raw = (el('estate-table-filter').value || '').trim().toLowerCase();
  let rows = baseRows();
  if (raw) {
    // Commas separate OR-groups; spaces within a group are AND terms. A row
    // matches if any group has all its terms somewhere in the title or path.
    const orGroups = raw.split(',')
      .map(g => g.trim().split(/\s+/).filter(Boolean))
      .filter(g => g.length);
    if (orGroups.length) {
      rows = rows.filter(r => {
        const hay = (r.title + ' ' + r.path).toLowerCase();
        return orGroups.some(group => group.every(term => hay.includes(term)));
      });
    }
  }
  if (estate.typeChips.size) rows = rows.filter(r => estate.typeChips.has(r.format));
  if (estate.ownerChips.size) rows = rows.filter(r => estate.ownerChips.has(r.owner));
  if (estate.staleChip) rows = rows.filter(r => bandMatch(r.days, estate.staleChip));
  if (estate.yearFilter != null) rows = rows.filter(r => r.updated && new Date(r.updated).getFullYear() === estate.yearFilter);
  const { key, dir } = estate.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'days') { av = av == null ? -1 : av; bv = bv == null ? -1 : bv; return (av - bv) * mul; }
    if (key === 'updated') { av = av ? Date.parse(av) : 0; bv = bv ? Date.parse(bv) : 0; return (av - bv) * mul; }
    if (key === 'withdrawn') { return ((a.withdrawn ? 1 : 0) - (b.withdrawn ? 1 : 0)) * mul; }
    return String(av).localeCompare(String(bv)) * mul;
  });
  return rows;
}

function renderTable() {
  const cols = visibleColumns();
  const thead = el('estate-thead');
  thead.innerHTML = '<tr class="govuk-table__row">' + cols.map(c => {
    const active = estate.sort.key === c.key;
    const arrow = active ? (estate.sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
    return `<th scope="col" class="govuk-table__header app-sort" data-key="${c.key}">${esc(c.label)}<span class="app-arrow">${arrow}</span></th>`;
  }).join('') + '</tr>';

  const rows = sortedFilteredRows();
  const workingTotal = baseRows().length;
  el('estate-table-count').textContent =
    `${rows.length.toLocaleString('en-GB')} shown of ${workingTotal.toLocaleString('en-GB')}` +
    (rows.length !== workingTotal ? ' (filtered)' : '');
  el('estate-clear-filters').classList.toggle('app-hidden', !anyFilterActive());

  // Pagination
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  if (estate.page > pages) estate.page = pages;
  if (estate.page < 1) estate.page = 1;
  const start = (estate.page - 1) * PAGE_ROWS;
  const pageRows = rows.slice(start, start + PAGE_ROWS);

  const showWd = withdrawnShown();
  el('estate-tbody').innerHTML = pageRows.map(r => {
    const stale = r.days == null ? '' : r.days > RED_DAYS ? ' app-row-red' : r.days > AMBER_DAYS ? ' app-row-amber' : '';
    const cls = stale + (r.withdrawn ? ' app-row-withdrawn' : '');
    const updatedCell = fmtDateNumeric(r.updated) +
      (r.days == null ? '' : `<span class="app-days"><span class="app-days-count">${r.days.toLocaleString('en-GB')} days</span>${staleTag(r.days)}</span>`);
    const withdrawnCell = r.withdrawn
      ? '<strong class="govuk-tag govuk-tag--red">Withdrawn</strong>'
      : '<span class="app-muted">—</span>';
    return `<tr class="govuk-table__row${cls}">
      <td class="govuk-table__cell app-break">
        <a class="govuk-link" href="${GOVUK}${esc(r.path)}" target="_blank" rel="noopener">${esc(r.title)}</a>
        <span class="app-path" title="${esc(r.path)}">${esc(midTruncate(r.path))}</span>
        <a class="govuk-link app-inspect" href="#" data-inspect="${esc(r.path)}">Inspect in Page view</a>
      </td>
      <td class="govuk-table__cell app-break">${r.owner ? `<span title="${esc(r.owner)}">${esc(ownerDisplay(r.owner))}</span>` : '<span class="app-muted">—</span>'}</td>
      <td class="govuk-table__cell">${esc(formatLabel(r.format))}</td>
      <td class="govuk-table__cell">${updatedCell}</td>
      ${showWd ? `<td class="govuk-table__cell">${withdrawnCell}</td>` : ''}
    </tr>`;
  }).join('');

  renderPagination(estate.page, pages, rows.length, start, pageRows.length);
}

function renderPagination(page, pages, total, start, shown) {
  const box = el('estate-pagination');
  if (!total) { box.innerHTML = ''; return; }
  const from = start + 1, to = start + shown;
  box.innerHTML = `
    <div class="app-pager">
      <button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0" type="button" data-page="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="govuk-body-s app-muted" style="margin:0 12px;">Page ${page} of ${pages}&nbsp;&nbsp;|&nbsp;&nbsp;rows ${from.toLocaleString('en-GB')}–${to.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}</span>
      <button class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0" type="button" data-page="next" ${page >= pages ? 'disabled' : ''}>Next</button>
    </div>`;
}

function anyFilterActive() {
  return !!(estate.typeChips.size || estate.ownerChips.size || estate.staleChip ||
            estate.yearFilter != null || (el('estate-table-filter').value || '').trim());
}

function clearFilters() {
  estate.typeChips = new Set();
  estate.ownerChips = new Set();
  estate.staleChip = null;
  estate.yearFilter = null;
  el('estate-table-filter').value = '';
  estate.page = 1;
  renderYearBar(); renderChips(); renderTable(); updateUrl();
}

// Content-type + staleness-band filter chips, plus a year chip when the chart
// is filtered. Applied client-side; no re-fetch.
function renderChips() {
  const types = [...new Set(baseRows().map(r => r.format))].sort();
  const chip = (kind, val, label, active, title) =>
    `<button type="button" class="app-chip${active ? ' app-chip--active' : ''}" data-chip="${kind}" data-val="${esc(val)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;

  const typeHtml = types.map(t => chip('type', t, formatLabel(t), estate.typeChips.has(t), t)).join(' ');

  // Editorial owners, count descending, abbreviated labels (full name on hover),
  // capped at the top-N with a "Show all" disclosure.
  const ownerCounts = {};
  baseRows().forEach(r => { if (r.owner) ownerCounts[r.owner] = (ownerCounts[r.owner] || 0) + 1; });
  const owners = Object.entries(ownerCounts).sort((a, b) => b[1] - a[1]);
  // Auto-expand if any active owner sits beyond the cap, so its chip is visible.
  const activeBeyondCap = [...estate.ownerChips].some(o => owners.findIndex(e => e[0] === o) >= OWNER_CHIP_CAP);
  const expanded = estate.ownerChipsExpanded || activeBeyondCap;
  const shownOwners = expanded ? owners : owners.slice(0, OWNER_CHIP_CAP);
  let ownerHtml = shownOwners.map(([o, n]) =>
    chip('owner', o, `${ownerDisplay(o)} (${n.toLocaleString('en-GB')})`, estate.ownerChips.has(o), o)).join(' ');
  if (!expanded && owners.length > OWNER_CHIP_CAP) {
    ownerHtml += ` <button type="button" class="app-chip app-chip--more" data-chip="owners-more" data-val="">Show all ${owners.length} owners</button>`;
  }

  const bands = [['under1', 'Under 1 year'], ['1to5', '1 to 5 years'], ['over5', 'Over 5 years'], ['over10', 'Over 10 years']];
  const bandHtml = bands.map(([k, l]) => chip('stale', k, l, estate.staleChip === k)).join(' ');
  const yearHtml = estate.yearFilter != null
    ? `<button type="button" class="app-chip app-chip--active" data-chip="year" data-val="${estate.yearFilter}">Year: ${estate.yearFilter} ✕</button>`
    : '';
  el('estate-chips').innerHTML =
    `<div class="app-chip-row"><span class="app-chip-label">Content type</span>${typeHtml || '<span class="app-muted">—</span>'}</div>` +
    `<div class="app-chip-row"><span class="app-chip-label">Editorial owner</span>${ownerHtml || '<span class="app-muted">—</span>'}</div>` +
    `<div class="app-chip-row"><span class="app-chip-label">Staleness</span>${bandHtml} ${yearHtml}</div>`;
}

function downloadCsv() {
  const rows = sortedFilteredRows(); // export what the current sort/filter shows
  const header = ['title', 'path', 'editorial_owner', 'content_type', 'last_updated', 'days_since_update', 'withdrawn'];
  const csvCell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(',')];
  rows.forEach(r => lines.push(
    [r.title, r.path, r.owner, r.format, r.updated || '', r.days == null ? '' : r.days, r.withdrawn ? 'yes' : 'no'].map(csvCell).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `govuk-estate-${estate.selected.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- Estate view: URL state (deep links) ---------- */

// Serialise the current estate view into the query string. replaceState keeps
// the URL in sync without stacking a history entry per keystroke, so browser
// back/forward move between whole pages rather than every micro-change.
function updateUrl() {
  if (estate.restoring) return; // don't fight the restore in progress
  const p = new URLSearchParams();
  if (estate.selected) p.set('org', estate.selected.slug);
  const types = checkedTypes();
  if (types.length) p.set('types', types.join(','));
  if (estate.sort && estate.sort.key) { p.set('sort', estate.sort.key); p.set('dir', estate.sort.dir); }
  const q = (el('estate-table-filter').value || '').trim();
  if (q) p.set('q', q);
  // Owner titles can contain commas, so join with a pipe (never present in them).
  if (estate.ownerChips.size) p.set('owners', [...estate.ownerChips].join('|'));
  if (withdrawnShown()) p.set('withdrawn', '1');
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  const org = p.get('org');
  if (!org) return null;
  return {
    org,
    types: (p.get('types') || '').split(',').map(s => s.trim()).filter(Boolean),
    sort: p.get('sort') ? { key: p.get('sort'), dir: p.get('dir') === 'asc' ? 'asc' : 'desc' } : null,
    q: p.get('q') || '',
    owners: (p.get('owners') || '').split('|').filter(Boolean),
    withdrawn: p.get('withdrawn') === '1',
  };
}

// Rebuild the whole view from the URL on load: select the org, fetch the
// breakdown, restore ticked types, and if any are present pull the results and
// apply the saved sort + filter.
async function restoreFromUrl() {
  const st = readStateFromUrl();
  if (!st) return;
  estate.restoring = true;
  try {
    showView('estate');
    const found = estate.orgs.find(o => o.slug === st.org) || { slug: st.org, title: st.org };
    selectOrg(found);
    await fetchAggregate();
    if (st.types.length) {
      el('estate-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = st.types.includes(cb.value);
      });
      updateProjection();
      await fetchResults();
      if (st.sort) estate.sort = st.sort;
      el('estate-table-filter').value = st.q;
      estate.ownerChips = new Set(st.owners);
      const wcb = el('estate-show-withdrawn');
      if (wcb && !wcb.disabled) wcb.checked = st.withdrawn;
      renderCards();
      renderYearBar();
      renderChips();
      renderTable();
    }
  } finally {
    estate.restoring = false;
    updateUrl(); // write the canonical, fully-restored URL once
  }
}

function setupEstate() {
  const search = el('estate-org-search');

  ensureOrgs().then(() => {
    if (estate.orgsSource === 'aggregate-fallback') {
      el('estate-org-hint').textContent =
        'Type to search. (Org titles unavailable, showing slugs only. The organisations Function is not reachable; deploy to Netlify or run `netlify dev` for titles.)';
    } else if (estate.orgsSource === 'failed') {
      el('estate-org-hint').textContent = 'Could not load the organisation list.';
    } else {
      el('estate-org-hint').textContent = `Type to search by title or slug. ${estate.orgs.length.toLocaleString('en-GB')} organisations.`;
    }
    restoreFromUrl(); // deep-link: rebuild the view if the URL carries one
  });

  search.addEventListener('input', () => { estate.selected = null; el('estate-fetch').disabled = true; renderOrgOptions(search.value); });
  search.addEventListener('focus', () => renderOrgOptions(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      if (estate.activeIndex >= 0 && estate.filtered[estate.activeIndex]) { e.preventDefault(); selectOrg(estate.filtered[estate.activeIndex]); }
      else if (estate.selected) fetchAggregate();
    } else if (e.key === 'Escape') { el('estate-org-list').classList.add('app-hidden'); }
  });

  el('estate-org-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.app-combo-option[data-i]');
    if (btn) selectOrg(estate.filtered[+btn.dataset.i]);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#estate-org-search') && !e.target.closest('#estate-org-list')) {
      el('estate-org-list').classList.add('app-hidden');
    }
  });

  el('estate-fetch').addEventListener('click', fetchAggregate);
  el('estate-select-guidance').addEventListener('click', setGuidanceTypes);
  el('estate-clear-types').addEventListener('click', clearTypes);

  // Empty-state example: select the org and fetch its breakdown in one click.
  el('estate-empty').addEventListener('click', (e) => {
    const a = e.target.closest('[data-estate-org]');
    if (!a) return;
    e.preventDefault();
    const slug = a.dataset.estateOrg;
    selectOrg(estate.orgs.find(o => o.slug === slug) || { slug, title: slug });
    fetchAggregate();
  });

  // Re-render the breakdown chart to its container when the details is re-opened
  // (Chart.js measures 0 while inside a collapsed <details>).
  el('estate-breakdown-details').addEventListener('toggle', (e) => {
    if (e.target.open && estate.chart) estate.chart.resize();
  });

  // Results controls
  el('estate-get-results').addEventListener('click', fetchResults);
  el('estate-table-filter').addEventListener('input', () => { estate.page = 1; renderChips(); renderTable(); updateUrl(); });
  el('estate-show-withdrawn').addEventListener('change', () => {
    estate.page = 1; renderCards(); renderYearBar(); renderChips(); renderTable(); updateUrl();
  });
  el('estate-csv').addEventListener('click', downloadCsv);
  el('estate-thead').addEventListener('click', (e) => {
    const th = e.target.closest('.app-sort');
    if (!th) return;
    const key = th.dataset.key;
    if (estate.sort.key === key) estate.sort.dir = estate.sort.dir === 'asc' ? 'desc' : 'asc';
    else estate.sort = { key, dir: key === 'title' || key === 'format' || key === 'owner' ? 'asc' : 'desc' };
    estate.page = 1;
    renderTable();
    updateUrl();
  });

  // Filter chips (content type, staleness band, year)
  el('estate-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chip]');
    if (!btn) return;
    const { chip, val } = btn.dataset;
    if (chip === 'owners-more') { estate.ownerChipsExpanded = true; renderChips(); return; }
    if (chip === 'type') {
      if (estate.typeChips.has(val)) estate.typeChips.delete(val); else estate.typeChips.add(val);
    } else if (chip === 'owner') {
      if (estate.ownerChips.has(val)) estate.ownerChips.delete(val); else estate.ownerChips.add(val);
    } else if (chip === 'stale') {
      estate.staleChip = estate.staleChip === val ? null : val;
    } else if (chip === 'year') {
      estate.yearFilter = null; renderYearBar();
    }
    estate.page = 1;
    renderChips(); renderTable(); updateUrl();
  });

  el('estate-clear-filters').addEventListener('click', clearFilters);

  // "Inspect in Page view" — drill from a result row into the page analysis
  el('estate-tbody').addEventListener('click', (e) => {
    const link = e.target.closest('[data-inspect]');
    if (!link) return;
    e.preventDefault();
    showView('page');
    el('page-url').value = GOVUK + link.dataset.inspect;
    fetchPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Pagination
  el('estate-pagination').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    estate.page += btn.dataset.page === 'next' ? 1 : -1;
    renderTable();
    el('estate-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ---------- Map view ----------
 *
 * WHY BODY LINKS, NOT CURATED LINKS
 * ---------------------------------
 * A probe of HMCTS guidance found the Content API "links" object is near-empty
 * for real estates: no ordered_related_items, no related_guides, a single
 * over-broad taxon. The connective tissue lives in the prose: <a> links inside
 * details.body (and parts[].body). So the map is built from those. Most edges
 * point OUT of the filtered set toward a few shared destinations (e.g.
 * /find-court-tribunal), so we keep an outward destination as a node only when
 * two or more in-set pages link to it — otherwise the graph is an unreadable
 * hairball of one-off links. Everything is fetched live, read-only.
 */

const map = {
  mode: 'org',        // 'org' (filter an organisation) | 'seed' (trace a service)
  selected: null,     // {slug, title}
  filtered: [],       // current org-combo matches
  activeIndex: -1,    // combobox keyboard highlight
  formats: [],        // [{slug, documents}] for the chosen org
  cy: null,           // Cytoscape instance
  graph: null,        // computed {inset, hubs, edges, indeg, deg, pages}
  stats: null,
  searchTotal: 0,     // org mode: total matching in the search index
  seedMeta: null,     // seed mode: {seedCount, hops, reached}
  seedKeys: null,     // seed mode: the start-page keys, for the core group
  visibleTypes: new Set(), // content-type filter: empty = show all, else show only these
  fullscreen: false,
  restoring: false,   // true while rebuilding from the URL
};

// Distinguishes a single tap (focus) from a double tap (open) on a node.
const mapTap = { id: null, t: 0, timer: null };

// Register the fcose layout if its scripts loaded; otherwise fall back to cose.
let mapFcoseReady = false;
try {
  if (typeof cytoscape !== 'undefined' && typeof cytoscapeFcose !== 'undefined') {
    cytoscape.use(cytoscapeFcose);
    mapFcoseReady = true;
  }
} catch (e) { mapFcoseReady = false; }

// Register the SVG exporter if its script loaded.
let mapSvgReady = false;
try {
  if (typeof cytoscape !== 'undefined' && typeof cytoscapeSvg !== 'undefined') {
    cytoscape.use(cytoscapeSvg);
    mapSvgReady = true;
  }
} catch (e) { mapSvgReady = false; }

const MAP_DEFAULT_TYPES = ['detailed_guide', 'guidance'];
const MAP_HUB_MIN = 2;      // an outward destination is a node only if 2+ in-set pages link to it
const MAP_CONCURRENCY = 5;  // parallel Content API requests; gentle on GOV.UK

// GOV.UK "chrome" paths that would otherwise dominate as fake hubs.
const MAP_LINK_BLOCK = [/^\/help(\/|$)/, /^\/cookies/, /^\/contact(\/|$)/, /^\/sign-in/, /^\/random/];

// Normalise a path to a stable node key: drop query/anchor and any trailing slash.
const keyPath = (p) => (p || '').split('#')[0].split('?')[0].replace(/\/+$/, '');

/* ----- Map: organisation combobox (mirrors Estate's, with map- ids) ----- */

function mapRenderOrgOptions(query) {
  const list = el('map-org-list');
  const q = (query || '').trim().toLowerCase();
  const matches = q
    ? estate.orgs.filter(o => o.title.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q))
    : estate.orgs;
  const totalMatches = matches.length;
  map.filtered = matches.slice(0, ORG_LIST_CAP);
  map.activeIndex = -1;

  if (!map.filtered.length) {
    list.innerHTML = '<div class="app-combo-option app-muted">No matching organisation</div>';
  } else {
    let html = map.filtered.map((o, i) => {
      const showSlug = o.title !== o.slug;
      return `<button type="button" class="app-combo-option" role="option" data-i="${i}">
        ${esc(o.title)}${showSlug ? ' <span class="app-muted">' + esc(o.slug) + '</span>' : ''}</button>`;
    }).join('');
    if (totalMatches > map.filtered.length) {
      const more = totalMatches - map.filtered.length;
      html += `<div class="app-combo-more app-muted">Showing first ${map.filtered.length} of ${totalMatches.toLocaleString('en-GB')}. Keep typing to narrow (${more.toLocaleString('en-GB')} more).</div>`;
    }
    list.innerHTML = html;
  }
  list.classList.remove('app-hidden');
  el('map-org-search').setAttribute('aria-expanded', 'true');
}

function mapSelectOrg(o) {
  map.selected = o;
  el('map-org-search').value = o.title;
  el('map-org-list').classList.add('app-hidden');
  el('map-org-search').setAttribute('aria-expanded', 'false');
  el('map-load-types').disabled = false;
  if (!map.restoring) {
    el('map-setup').classList.add('app-hidden');
    el('map-results').classList.add('app-hidden');
    el('map-status').textContent = '';
  }
}

function mapMoveActive(delta) {
  const n = map.filtered.length;
  if (!n) return;
  map.activeIndex = (map.activeIndex + delta + n) % n;
  [...el('map-org-list').querySelectorAll('.app-combo-option')].forEach((b, i) =>
    b.classList.toggle('app-active', i === map.activeIndex));
}

/* ----- Map: content-type picker ----- */

async function mapLoadTypes() {
  if (!map.selected) return;
  const status = el('map-status');
  status.textContent = 'Fetching content types for ' + map.selected.slug + ' …';
  try {
    const url = GOVUK + '/api/search.json?filter_organisations=' + encodeURIComponent(map.selected.slug) +
                '&count=0&aggregate_format=100';
    const r = await fetch(url);
    if (!r.ok) { status.textContent = 'GOV.UK returned ' + r.status + '.'; return; }
    const data = await r.json();
    status.textContent = '';
    const opts = ((data.aggregates || {}).format || {}).options || [];
    map.formats = opts.map(o => ({ slug: o.value.slug, documents: o.documents }))
                      .sort((a, b) => b.documents - a.documents);
    mapRenderTypeCheckboxes();
    el('map-empty').classList.add('app-hidden');
    el('map-setup').classList.remove('app-hidden');
  } catch (e) {
    status.textContent = 'Could not reach the search API: ' + e.message;
  }
}

function mapRenderTypeCheckboxes() {
  const box = el('map-checkboxes');
  const anyDefault = map.formats.some(f => MAP_DEFAULT_TYPES.includes(f.slug));
  box.innerHTML = map.formats.map(f => `
    <div class="govuk-checkboxes__item">
      <input class="govuk-checkboxes__input" id="mcb-${esc(f.slug)}" type="checkbox" value="${esc(f.slug)}" ${anyDefault && MAP_DEFAULT_TYPES.includes(f.slug) ? 'checked' : ''}>
      <label class="govuk-label govuk-checkboxes__label" for="mcb-${esc(f.slug)}">
        ${esc(formatLabel(f.slug))} <span class="app-muted">(${f.documents.toLocaleString('en-GB')})</span>
      </label>
    </div>`).join('');
  box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', mapUpdateBuildEnabled));
  mapUpdateBuildEnabled();
}

function mapCheckedTypes() {
  return [...el('map-checkboxes').querySelectorAll('input:checked')].map(c => c.value);
}

function mapUpdateBuildEnabled() {
  el('map-build').disabled = mapCheckedTypes().length === 0;
}

/* ----- Map: fetch content with limited concurrency ----- */

async function mapFetchContents(paths, onProgress) {
  const results = new Array(paths.length);
  let i = 0;
  async function worker() {
    while (i < paths.length) {
      const idx = i++;
      try {
        const r = await fetch(GOVUK + '/api/content' + paths[idx]);
        results[idx] = r.ok ? await r.json() : null;
      } catch (e) {
        results[idx] = null;
      }
      onProgress();
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAP_CONCURRENCY, paths.length) }, worker));
  return results;
}

// Internal GOV.UK links found in a page's body (and parts), as a Set of node keys.
// Internal GOV.UK link keys found in a fragment of body HTML.
function mapLinksFromHtml(html) {
  const set = new Set();
  const re = /<a[^>]*href="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    const ip = toInternalPathOrNull(m[1]);
    if (!ip) continue;
    const k = keyPath(ip);
    if (k) set.add(k);
  }
  return set;
}

// All internal links across a page (body plus every part). Used for the crawl
// frontier, where we want the union of everything a fetched page points to.
function mapExtractLinks(content) {
  if (!content) return new Set();
  const details = content.details || {};
  const parts = Array.isArray(details.parts) ? details.parts : [];
  const html = (details.body || '') + parts.map(p => p.body || '').join(' ');
  return mapLinksFromHtml(html);
}

// Curated "Related content" / "Related guides" links. These live in the links
// object, not the body, so a prose-only read misses them. They belong to the
// whole page (the sidebar shows on every part of a guide).
function mapCuratedLinks(content) {
  const set = new Set();
  if (!content) return set;
  const L = content.links || {};
  ['ordered_related_items', 'related_guides'].forEach(g => {
    (L[g] || []).forEach(i => { const bp = i && i.base_path; if (bp) { const k = keyPath(bp); if (k) set.add(k); } });
  });
  return set;
}

// Body links plus curated related links: the full set of pages a page points to.
function mapAllLinks(content) {
  const s = mapExtractLinks(content);
  mapCuratedLinks(content).forEach(k => s.add(k));
  return s;
}

/* ----- Map: build + render ----- */

async function mapBuild() {
  const types = mapCheckedTypes();
  if (!map.selected || !types.length) return;
  map.seedKeys = null; // org mode has no start page, so no core group
  const cap = Math.max(10, Math.min(200, parseInt(el('map-cap').value, 10) || 100));
  el('map-cap').value = cap;
  const q = (el('map-q').value || '').trim();

  const bs = el('map-build-status');
  el('map-build').disabled = true;
  el('map-results').classList.add('app-hidden');

  // 1. Get the filtered page list (one search request, capped).
  bs.textContent = 'Finding pages…';
  const base = GOVUK + '/api/search.json?filter_organisations=' + encodeURIComponent(map.selected.slug) +
    types.map(t => '&filter_format=' + encodeURIComponent(t)).join('') +
    '&fields=title&fields=link&fields=format&fields=locale' +
    (q ? '&q=' + encodeURIComponent(q) : '');
  let list = [];
  try {
    const r = await fetch(base + '&count=' + cap + '&start=0');
    if (!r.ok) { bs.textContent = 'GOV.UK returned ' + r.status + '.'; el('map-build').disabled = false; return; }
    const data = await r.json();
    map.searchTotal = data.total || 0;
    list = (data.results || [])
      .map(x => ({ path: x.link || '', title: x.title || '(untitled)', format: x.format || '', welsh: x.locale === 'cy' }))
      .filter(x => x.path);
  } catch (e) {
    bs.textContent = 'Could not reach the search API: ' + e.message; el('map-build').disabled = false; return;
  }
  if (!list.length) { bs.textContent = 'No pages found for this selection.'; el('map-build').disabled = false; return; }

  // 2. Fetch each page's content to read its body links.
  el('map-progress').classList.remove('app-hidden');
  el('map-progress-fill').style.width = '0%';
  let done = 0;
  const onProgress = () => {
    done++;
    el('map-progress-fill').style.width = Math.round((done / list.length) * 100) + '%';
    bs.textContent = `Reading pages ${done.toLocaleString('en-GB')} of ${list.length.toLocaleString('en-GB')}…`;
  };
  const contents = await mapFetchContents(list.map(x => x.path), onProgress);
  list.forEach((x, i) => { x.content = contents[i]; });
  el('map-progress').classList.add('app-hidden');
  bs.textContent = '';

  // 3. Build the graph and draw it.
  mapComputeGraph(list);
  if (typeof cytoscape === 'undefined') {
    bs.textContent = 'The graph library failed to load, so the map cannot be drawn. Check the network and reload.';
    el('map-build').disabled = false;
    return;
  }
  el('map-results').classList.remove('app-hidden'); // visible first so the graph container has a size
  mapRender();
  el('map-build').disabled = false;
  mapUpdateUrl();
  if (!map.restoring) el('map-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ----- Map: seed-and-crawl mode (trace a service from its start pages) ----- */

function mapSetMode(mode) {
  map.mode = mode === 'seed' ? 'seed' : 'org';
  el('map-org-mode').classList.toggle('app-hidden', map.mode !== 'org');
  el('map-seed-mode').classList.toggle('app-hidden', map.mode !== 'seed');
  // A mode switch invalidates the org flow's type panel; hide it so the two
  // modes never show stale controls from each other.
  if (map.mode === 'seed') el('map-setup').classList.add('app-hidden');
  if (!map.restoring) mapUpdateUrl();
}

// Parse the seed textarea into normalised, leading-slash node keys.
function mapReadSeeds() {
  const raw = el('map-seeds').value || '';
  const keys = raw.split(/[\n,]+/)
    .map(s => normalisePath(s))        // full URL or path -> bare path
    .filter(Boolean)
    .map(p => keyPath('/' + p));       // -> '/path' with no trailing slash
  return [...new Set(keys)].filter(Boolean);
}

// Breadth-first crawl: fetch the seeds, follow their body links outward up to
// maxHops, fetching every page reached (so we can draw within-set edges and read
// titles), bounded by a hard cap on total pages. The pages we fetch become the
// "in set" nodes; links from them to pages we did not fetch become the outward
// hub squares, exactly as in organisation mode.
async function mapSeedBuild() {
  if (map.mode !== 'seed') return;
  const seeds = mapReadSeeds();
  const bs = el('map-seed-status');
  if (!seeds.length) { bs.textContent = 'Enter at least one GOV.UK URL or path to start from.'; return; }
  map.seedKeys = new Set(seeds); // the start pages, to highlight and centre their group
  const maxHops = parseInt(el('map-hops').value, 10) === 1 ? 1 : 2;
  const cap = Math.max(10, Math.min(300, parseInt(el('map-seed-cap').value, 10) || 150));
  el('map-seed-cap').value = cap;

  el('map-seed-build').disabled = true;
  el('map-results').classList.add('app-hidden');
  el('map-seed-progress').classList.remove('app-hidden');
  el('map-seed-progress-fill').style.width = '0%';

  const discovered = new Set(seeds); // every key we have queued or fetched
  const fetchedKeys = new Set();
  const contentByKey = new Map();
  const pages = [];
  let fetchedCount = 0;
  const onProgress = () => {
    fetchedCount++;
    el('map-seed-progress-fill').style.width = Math.round((fetchedCount / cap) * 100) + '%';
    bs.textContent = `Reading pages ${fetchedCount.toLocaleString('en-GB')}…`;
  };

  let toFetch = [...seeds];
  let depth = 0;
  try {
    while (toFetch.length && fetchedKeys.size < cap) {
      const batch = toFetch.filter(k => !fetchedKeys.has(k)).slice(0, cap - fetchedKeys.size);
      batch.forEach(k => fetchedKeys.add(k));
      const contents = await mapFetchContents(batch, onProgress); // key is '/path' -> Content API path
      batch.forEach((k, i) => {
        const d = contents[i];
        contentByKey.set(k, d);
        pages.push({ path: k, title: (d && d.title) || mapHubLabel(k), format: (d && d.document_type) || '',
                     welsh: !!(d && d.locale === 'cy'), content: d });
        // A multi-part guide arrives whole (every part is in details.parts), so
        // mark its root and all its part URLs as covered: they are expanded into
        // nodes at build time and must not be fetched again as separate pages.
        if (d && d.base_path && d.details && Array.isArray(d.details.parts) && d.details.parts.length) {
          const canon = keyPath(d.base_path);
          discovered.add(canon);
          d.details.parts.forEach(pt => { if (pt && pt.slug) discovered.add(keyPath(canon + '/' + pt.slug)); });
        }
      });
      if (depth + 1 > maxHops) break; // fetched the last hop's pages; do not expand further
      const next = [];
      batch.forEach(k => {
        mapAllLinks(contentByKey.get(k)).forEach(t => {
          if (!t || discovered.has(t)) return;
          if (MAP_LINK_BLOCK.some(re => re.test(t))) return;
          discovered.add(t);
          next.push(t);
        });
      });
      toFetch = next;
      depth++;
    }
  } catch (e) {
    bs.textContent = 'Could not complete the crawl: ' + e.message;
    el('map-seed-progress').classList.add('app-hidden');
    el('map-seed-build').disabled = false;
    return;
  }

  el('map-seed-progress').classList.add('app-hidden');
  bs.textContent = '';

  const reachable = pages.filter(p => p.content).length;
  if (!reachable) {
    bs.textContent = 'None of those start pages returned content from the GOV.UK Content API. Check the path, for example /make-court-claim-for-money.';
    el('map-seed-build').disabled = false;
    return;
  }

  map.seedMeta = { seedCount: seeds.length, hops: maxHops, reached: pages.length };
  mapComputeGraph(pages);
  if (typeof cytoscape === 'undefined') {
    bs.textContent = 'The graph library failed to load, so the map cannot be drawn. Check the network and reload.';
    el('map-seed-build').disabled = false;
    return;
  }
  // Show the results panel before rendering so the graph container has a real
  // size when the layout fits and centres the view.
  el('map-empty').classList.add('app-hidden');
  el('map-results').classList.remove('app-hidden');
  mapRender();
  el('map-seed-build').disabled = false;
  mapUpdateUrl();
  if (!map.restoring) el('map-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Turn fetched pages into graph units. A multi-part guide becomes one unit per
// part (its own title, URL and body links), because each part is a distinct page
// a user lands on. The content API returns every part in details.parts, so this
// needs no extra requests. The first part is served at the guide root; the rest
// at root/<slug>. Normal pages become one unit, keyed by base_path. Links to a
// part URL, or to the root, resolve to the matching part node.
function mapComputeUnits(pages) {
  const units = new Map();     // key -> {key, title, format, welsh, links:Set}
  const alias = new Map();     // root/<overview-slug> -> root (part 0)
  const doneGuides = new Set();
  pages.forEach(p => {
    const d = p.content;
    const reqKey = keyPath(p.path);
    if (!reqKey) return;
    const canon = (d && d.base_path) ? keyPath(d.base_path) : reqKey;
    const parts = (d && d.details && Array.isArray(d.details.parts)) ? d.details.parts : [];
    if (parts.length) {
      if (doneGuides.has(canon)) return; // expand each guide once
      doneGuides.add(canon);
      parts.forEach((pt, i) => {
        const slug = pt.slug || ('part-' + (i + 1));
        const key = i === 0 ? canon : keyPath(canon + '/' + slug);
        if (i === 0) alias.set(keyPath(canon + '/' + slug), canon); // /guide/overview -> /guide
        // links is a Map of targetKey -> kind ('body' | 'related') so edges can
        // be drawn differently. Body (prose) links win if a target is both.
        const links = new Map();
        mapLinksFromHtml(pt.body || '').forEach(k => links.set(k, 'body'));
        // The Related content sidebar belongs to the guide as a whole; attach it
        // to the first part (the guide root) rather than repeating it on all parts.
        if (i === 0) mapCuratedLinks(d).forEach(k => { if (!links.has(k)) links.set(k, 'related'); });
        units.set(key, {
          key,
          title: pt.title || p.title,
          format: (d && d.document_type) || p.format,
          welsh: !!(d && d.locale === 'cy'),
          links,
          guide: canon,          // which guide this part belongs to
          guideTitle: p.title,   // the guide's own title, for the group box label
        });
      });
    } else if (!units.has(canon)) {
      const links = new Map();
      if (d) {
        mapExtractLinks(d).forEach(k => links.set(k, 'body'));
        mapCuratedLinks(d).forEach(k => { if (!links.has(k)) links.set(k, 'related'); });
      }
      units.set(canon, { key: canon, title: p.title, format: p.format, welsh: p.welsh, links });
    }
  });
  return { units, alias };
}

function mapComputeGraph(pages) {
  const { units, alias } = mapComputeUnits(pages);
  const inset = units;                          // key -> unit (multi-part guides expanded)
  const canonOf = (t) => alias.get(t) || t;     // resolve /guide/overview to /guide

  const linkers = new Map(); // out-of-set target -> Set of in-set sources
  const rawEdges = [];       // {src, tgt, kind} (deduped later)
  units.forEach(u => {
    const src = u.key;
    u.links.forEach((kind, traw) => {
      const t = canonOf(traw);
      if (!t || t === src) return;
      if (MAP_LINK_BLOCK.some(re => re.test(t))) return;
      if (inset.has(t)) {
        rawEdges.push({ src, tgt: t, kind });
      } else {
        if (!linkers.has(t)) linkers.set(t, new Set());
        linkers.get(t).add(src);
        rawEdges.push({ src, tgt: t, out: true, kind });
      }
    });
  });

  // Keep an outward destination only when 2+ in-set pages point to it.
  const hubs = new Set([...linkers.entries()].filter(([, s]) => s.size >= MAP_HUB_MIN).map(([t]) => t));
  const kept = rawEdges.filter(e => !e.out || hubs.has(e.tgt));

  // Dedupe edges (a page can link the same target more than once). A body link
  // wins over a related link when both exist between the same pair.
  const edgeMap = new Map();
  kept.forEach(e => {
    const id = e.src + '>' + e.tgt;
    const existing = edgeMap.get(id);
    const kind = (existing && existing.kind === 'body') || e.kind === 'body' ? 'body' : 'related';
    edgeMap.set(id, { src: e.src, tgt: e.tgt, kind });
  });
  const edges = [...edgeMap.values()];

  const indeg = new Map(); // for node sizing
  const deg = new Map();   // total degree, for orphan detection
  edges.forEach(e => {
    indeg.set(e.tgt, (indeg.get(e.tgt) || 0) + 1);
    deg.set(e.src, (deg.get(e.src) || 0) + 1);
    deg.set(e.tgt, (deg.get(e.tgt) || 0) + 1);
  });

  // The "core" group (seed mode): the start page(s) and their whole guide. This
  // is the tight main group, highlighted and centred so it stands out from the
  // wider crawl radiating around it.
  let core = null;
  if (map.mode === 'seed' && map.seedKeys && map.seedKeys.size) {
    const seedUnits = new Set();
    inset.forEach((u, k) => { if (map.seedKeys.has(k) || (u.guide && map.seedKeys.has(u.guide))) seedUnits.add(k); });
    const seedGuides = new Set();
    inset.forEach((u, k) => { if (seedUnits.has(k) && u.guide) seedGuides.add(u.guide); });
    inset.forEach((u, k) => { if (u.guide && seedGuides.has(u.guide)) seedUnits.add(k); }); // all parts of a start guide
    core = seedUnits;
  }

  map.graph = { inset, hubs, edges, indeg, deg, core, pages: [...inset.values()] };
  map.visibleTypes = new Set(); // a fresh build shows all content types
  const withinCount = edges.filter(e => inset.has(e.tgt)).length;
  const orphanCount = [...inset.keys()].filter(k => !deg.get(k)).length;
  const welshCount = [...inset.values()].filter(p => p.welsh).length;
  map.stats = {
    pageCount: inset.size,
    hubCount: hubs.size,
    edgeCount: edges.length,
    withinCount,
    orphanCount,
    welshCount,
    searchTotal: map.searchTotal,
  };
}

// Colour each content type present in the set, most common first.
function mapFormatColours() {
  const counts = {};
  map.graph.pages.forEach(p => { counts[p.format] = (counts[p.format] || 0) + 1; });
  const order = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const cm = {};
  order.forEach((f, i) => { cm[f] = CHART_COLOURS[i % CHART_COLOURS.length]; });
  return cm;
}

// Prettify an outward destination path into a short label.
function mapHubLabel(k) {
  const seg = k.split('/').filter(Boolean).pop() || k;
  const s = seg.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function mapLayout() {
  // Spread nodes out generously. fit:false because we set our own readable zoom
  // afterwards (mapApplyView), so a big graph overflows the frame and is panned
  // rather than shrunk to a dense dot-cloud.
  if (mapFcoseReady) {
    return { name: 'fcose', quality: 'proof', animate: false, randomize: true, fit: false,
             padding: 40, nodeSeparation: 240, idealEdgeLength: 170, nodeRepulsion: 17000,
             edgeElasticity: 0.1, gravity: 0.06, gravityRange: 4,
             // fcose positions everything; mapCompactBoxes then packs each box's
             // parts into a tight uniform grid, so box tightness no longer depends
             // on whether the parts cross-link. Moderate compound gravity just keeps
             // the boxes from drifting apart.
             gravityCompound: 3, gravityRangeCompound: 1.5,
             packComponents: true, numIter: 3000 };
  }
  return { name: 'cose', animate: false, fit: false, padding: 40, randomize: true,
           nodeRepulsion: 32000, idealEdgeLength: 180, componentSpacing: 220, gravity: 0.35 };
}

// After a layout, set a readable zoom rather than fitting everything into the
// frame. Small graphs still fit; large ones stay at a legible node size and are
// panned. mapFcoseReady is irrelevant here.
// After the force layout, pack each guide box's parts into a compact uniform grid
// centred on where the layout put them. This makes every box equally tight,
// regardless of whether its parts cross-link (which the force layout can't do).
function mapCompactBoxes() {
  if (!map.cy) return;
  const GAP = 92;
  map.cy.nodes(':parent').forEach(parent => {
    const kids = parent.children();
    const n = kids.length;
    if (n < 2) return;
    let cx = 0, cy = 0;
    kids.forEach(k => { const p = k.position(); cx += p.x; cy += p.y; });
    cx /= n; cy /= n;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    kids.forEach((k, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      k.position({ x: cx + (col - (cols - 1) / 2) * GAP, y: cy + (row - (rows - 1) / 2) * GAP });
    });
  });
}

function mapApplyView() {
  if (!map.cy) return;
  map.cy.resize(); // measure the current container before fitting/centring
  mapCompactBoxes();
  const MIN = 0.6, MAX = 1.3;
  // Frame the core group (start page + what it links to) when there is one, so
  // the main group sits centred and readable; otherwise frame the whole graph.
  const coreNodes = map.cy.nodes('[core = 1]');
  const target = coreNodes.nonempty() ? coreNodes.union(coreNodes.parents()) : map.cy.elements();
  map.cy.fit(target, 55);
  const z = map.cy.zoom();
  if (z < MIN) map.cy.zoom(MIN);
  else if (z > MAX) map.cy.zoom(MAX);
  map.cy.center(target);
}

// Single click: zoom to a node and centre it. Double click: open it in Page view.
function mapFocusNode(n) {
  map.cy.elements().unselect();
  n.select();
  map.cy.animate({ center: { eles: n }, zoom: Math.max(map.cy.zoom(), 1.6) }, { duration: 350 });
}

function mapOpenNode(n) {
  const p = n.data('path');
  showView('page');
  el('page-url').value = GOVUK + '/' + String(p).replace(/^\/+/, '');
  loadPage(normalisePath(p));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function mapRender() {
  const g = map.graph;
  if (!g) return;
  const showHubs = el('map-show-hubs').checked;
  const showOrphans = el('map-show-orphans').checked;
  const showWelsh = el('map-show-welsh').checked;
  const showAllLabels = el('map-show-labels').checked;
  const typeFilter = map.visibleTypes;
  const cm = mapFormatColours();
  const indegVals = [...g.indeg.values()];
  const maxIndeg = indegVals.length ? Math.max(1, ...indegVals) : 1;
  const sizeFor = (k) => Math.round(18 + ((g.indeg.get(k) || 0) / maxIndeg) * 46);
  // Only the most-linked-to pages carry a label at rest; the rest reveal on hover.
  const majorCut = Math.max(3, Math.ceil(maxIndeg * 0.5));

  // Welsh toggle state on the control label.
  const wc = map.stats ? map.stats.welshCount : 0;
  el('map-welsh-count').textContent = wc ? '(' + wc.toLocaleString('en-GB') + ')' : '(none)';
  el('map-show-welsh').disabled = !wc;

  // Which in-set pages survive the filters (orphan, content type, Welsh)?
  const visiblePages = new Set();
  g.inset.forEach((p, k) => {
    if (!showOrphans && !g.deg.get(k)) return;
    if (typeFilter.size && !typeFilter.has(p.format)) return;
    if (!showWelsh && p.welsh) return;
    visiblePages.add(k);
  });

  // Group the visible parts of each multi-part guide into a compound box, so a
  // guide reads as one thing. Only when 2+ of its parts are actually on screen.
  const guideVisible = new Map(); // guide canon -> [visible part keys]
  visiblePages.forEach(k => {
    const u = g.inset.get(k);
    if (u.guide) { (guideVisible.get(u.guide) || guideVisible.set(u.guide, []).get(u.guide)).push(k); }
  });
  const groupTitle = new Map(); // guide canon -> title, for guides that earn a box
  guideVisible.forEach((keys, guide) => {
    // Box a guide only when 3+ of its parts are on screen. Two-part guides add
    // box clutter (and overlap) for little value, so they show as loose nodes.
    if (keys.length >= 3) groupTitle.set(guide, g.inset.get(keys[0]).guideTitle);
  });

  const els = [];
  groupTitle.forEach((title, guide) => {
    els.push({ data: { id: 'grp:' + guide, label: title, kind: 'group' } });
  });
  const core = g.core || new Set();
  visiblePages.forEach(k => {
    const p = g.inset.get(k);
    const grouped = p.guide && groupTitle.has(p.guide);
    const isCore = core.has(k);
    // Parts inside a guide box, and the start-page core group, always show their
    // label; loose nodes label only when well-linked, and on hover otherwise.
    const data = { id: k, label: midTruncate(p.title, 44), path: k, kind: 'page',
                   color: cm[p.format] || '#1d70b8', size: Math.round(sizeFor(k) * (isCore ? 1.25 : 1)),
                   major: (showAllLabels || grouped || isCore || (g.indeg.get(k) || 0) >= majorCut) ? 1 : 0 };
    if (grouped) data.parent = 'grp:' + p.guide;
    if (isCore) data.core = 1;
    els.push({ data });
  });

  // Edges among visible pages, plus edges to hubs when hubs are shown.
  const shownEdges = g.edges.filter(e =>
    visiblePages.has(e.src) && (visiblePages.has(e.tgt) || (showHubs && g.hubs.has(e.tgt))));
  // Keep only hubs actually reached by a surviving edge (no floating squares).
  const liveHubs = new Set();
  if (showHubs) shownEdges.forEach(e => { if (g.hubs.has(e.tgt)) liveHubs.add(e.tgt); });
  liveHubs.forEach(k => {
    els.push({ data: { id: k, label: mapHubLabel(k), path: k, kind: 'hub', size: sizeFor(k), major: 1 } });
  });

  const present = new Set(els.map(e => e.data.id));
  shownEdges.forEach((e, i) => {
    if (!present.has(e.src) || !present.has(e.tgt)) return;
    els.push({ data: { id: 'edge-' + i, source: e.src, target: e.tgt, kind: e.kind || 'body' } });
  });

  if (map.cy) { map.cy.destroy(); map.cy = null; }
  map.cy = cytoscape({
    container: el('map-graph'),
    elements: els,
    wheelSensitivity: 0.2,
    layout: { name: 'preset' }, // real layout runs below, so we can hook its completion
    style: [
      { selector: 'node', style: {
        'background-color': 'data(color)', 'width': 'data(size)', 'height': 'data(size)',
        'label': 'data(label)', 'font-size': '9px', 'color': '#0b0c0c',
        'text-wrap': 'wrap', 'text-max-width': '90px', 'text-valign': 'bottom',
        'text-margin-y': 2, 'min-zoomed-font-size': 8, 'text-opacity': 0,
      } },
      { selector: 'node[major = 1]', style: { 'text-opacity': 1 } },
      // The start-page core group: a dark ring makes it prominent.
      { selector: 'node[core = 1]', style: {
        'border-width': 4, 'border-color': '#0b0c0c', 'border-opacity': 0.85,
        'text-opacity': 1, 'font-weight': 'bold',
      } },
      { selector: 'node[kind="hub"]', style: {
        'shape': 'round-rectangle', 'background-color': '#f3f2f1',
        'border-width': 2, 'border-style': 'dashed', 'border-color': '#505a5f', 'font-weight': 'bold',
      } },
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#c8ccce', 'target-arrow-color': '#c8ccce',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier', 'opacity': 0.45,
      } },
      // Curated "Related content" links: dashed and tinted, to tell them apart
      // from prose links in the page body.
      { selector: 'edge[kind="related"]', style: {
        'line-style': 'dashed', 'line-dash-pattern': [5, 4],
        'line-color': '#8f7fc9', 'target-arrow-color': '#8f7fc9', 'opacity': 0.6,
      } },
      { selector: 'node.hl', style: { 'text-opacity': 1, 'font-weight': 'bold', 'z-index': 999 } },
      { selector: 'edge.hl', style: { 'line-color': '#1d70b8', 'target-arrow-color': '#1d70b8', 'opacity': 0.9, 'width': 2 } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-style': 'solid', 'border-color': '#1d70b8', 'text-opacity': 1 } },
      // Guide group box (compound parent): a faint labelled container. It receives
      // events so you can grab the box or its label and drag the whole group.
      { selector: ':parent', style: {
        'shape': 'round-rectangle', 'background-color': '#f3f2f1', 'background-opacity': 0.55,
        'border-width': 1, 'border-style': 'dashed', 'border-color': '#8f9296', 'padding': 16,
        'label': 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -14,
        'font-size': '12px', 'font-weight': 'bold', 'color': '#505a5f', 'text-opacity': 1,
        'text-wrap': 'wrap', 'text-max-width': '160px',
      } },
      // Selecting a box would draw a distracting border; keep it looking the same.
      { selector: ':parent:selected', style: { 'border-width': 1, 'border-color': '#8f9296', 'border-style': 'dashed' } },
    ],
  });

  // Run the real layout, then set a readable zoom (rather than fit-to-frame).
  const layout = map.cy.layout(mapLayout());
  layout.one('layoutstop', mapApplyView);
  layout.run();

  // Hover reveals a node's label and lights up its immediate links.
  map.cy.on('mouseover', 'node', (evt) => {
    const n = evt.target;
    n.addClass('hl');
    const e = n.connectedEdges();
    e.addClass('hl');
    e.connectedNodes().addClass('hl');
  });
  map.cy.on('mouseout', 'node', () => { map.cy.elements('.hl').removeClass('hl'); });

  // Single tap: focus and zoom to the node. Double tap: open it in Page view.
  map.cy.on('tap', 'node', (evt) => {
    const n = evt.target;
    if (n.isParent()) return; // the guide box is a container, not a page
    const now = Date.now();
    if (mapTap.id === n.id() && (now - mapTap.t) < 350) {
      clearTimeout(mapTap.timer);
      mapTap.id = null;
      mapOpenNode(n);
    } else {
      mapTap.id = n.id();
      mapTap.t = now;
      clearTimeout(mapTap.timer);
      mapTap.timer = setTimeout(() => { mapFocusNode(n); mapTap.id = null; }, 250);
    }
  });

  mapRenderTypeChips(cm);
  mapRenderLegend();
  mapRenderCards();
  if (map.mode === 'seed') {
    el('map-results-heading').textContent = 'Service map';
  } else {
    const orgName = map.selected.title === map.selected.slug ? map.selected.slug : map.selected.title;
    el('map-results-heading').textContent = 'Map of ' + orgName;
  }
}

// Content-type filter chips over the graph. Empty selection shows all; picking
// one or more shows only those. Present in both modes.
function mapRenderTypeChips(cm) {
  const box = el('map-type-chips');
  const counts = {};
  map.graph.inset.forEach(p => { counts[p.format] = (counts[p.format] || 0) + 1; });
  const types = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (types.length <= 1) { box.innerHTML = ''; return; } // nothing to filter by
  const chip = (t, n) => {
    const active = map.visibleTypes.has(t);
    return `<button type="button" class="app-chip${active ? ' app-chip--active' : ''}" data-type="${esc(t)}" title="${esc(t)}">
      <span class="app-legend-swatch" style="background:${cm[t] || '#1d70b8'};width:10px;height:10px;margin-right:5px;"></span>${esc(formatLabel(t) || 'Unknown')} (${n.toLocaleString('en-GB')})</button>`;
  };
  let html = `<div class="app-chip-row"><span class="app-chip-label">Content type</span>`;
  // One-click shortcut to filter the map to guidance content types (like Estate view).
  const presentGuidance = types.map(([t]) => t).filter(t => GUIDANCE_TYPES.includes(t));
  if (presentGuidance.length) {
    const allActive = map.visibleTypes.size === presentGuidance.length && presentGuidance.every(t => map.visibleTypes.has(t));
    html += `<button type="button" class="app-chip app-chip--more${allActive ? ' app-chip--active' : ''}" data-type-guidance="1">Guidance types</button> `;
  }
  html += types.map(([t, n]) => chip(t, n)).join(' ');
  if (map.visibleTypes.size) html += ` <button type="button" class="app-chip app-chip--clear" data-type-clear="1">Clear</button>`;
  html += `</div>`;
  box.innerHTML = html;
}

function mapRenderLegend() {
  // The content-type chips carry the colour key when there is more than one type,
  // so the legend only repeats a single type, plus the shared-destination marker.
  const present = [...new Set(map.graph.pages.map(p => p.format))].filter(Boolean);
  const cm = mapFormatColours();
  let html = '';
  if (present.length === 1) {
    html += `<span class="app-legend-item"><span class="app-legend-swatch" style="background:${cm[present[0]] || '#1d70b8'}"></span>${esc(formatLabel(present[0]))}</span>`;
  }
  if (map.graph.core && map.graph.core.size) {
    html += `<span class="app-legend-item"><span class="app-legend-swatch app-legend-swatch--core"></span>From your start page</span>`;
  }
  if (map.graph.hubs.size && el('map-show-hubs').checked) {
    html += `<span class="app-legend-item"><span class="app-legend-swatch app-legend-swatch--hub"></span>Shared destination (outside your set)</span>`;
  }
  // Only explain the two edge styles when curated related links are present.
  if (map.graph.edges.some(e => e.kind === 'related')) {
    html += `<span class="app-legend-item"><span class="app-legend-line"></span>Body link</span>`;
    html += `<span class="app-legend-item"><span class="app-legend-line app-legend-line--related"></span>Related content link</span>`;
  }
  el('map-legend').innerHTML = html;
}

// Org mode: mirror Estate view's quick guidance-type selection.
function mapSetGuidanceTypes() {
  el('map-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = GUIDANCE_TYPES.includes(cb.value); });
  mapUpdateBuildEnabled();
}
function mapClearTypes() {
  el('map-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
  mapUpdateBuildEnabled();
}

/* ----- Map: export (SVG for Figma/Miro, PNG) ----- */

function mapExportName(ext) {
  const base = map.mode === 'seed' ? 'govuk-service-map'
             : 'govuk-map-' + (map.selected ? map.selected.slug : 'org');
  return `${base}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function mapDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Vector export: the whole graph as SVG, so it imports into Figma/Miro editable.
function mapExportSvg() {
  if (!map.cy) return;
  if (!mapSvgReady || typeof map.cy.svg !== 'function') {
    alert('SVG export is unavailable because its library did not load. Use PNG instead, or reload the page.');
    return;
  }
  const svg = map.cy.svg({ scale: 1, full: true, bg: '#ffffff' });
  mapDownloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), mapExportName('svg'));
}

// Raster export: the whole graph as a high-resolution PNG.
function mapExportPng() {
  if (!map.cy) return;
  const blob = map.cy.png({ output: 'blob', full: true, scale: 2, bg: '#ffffff' });
  mapDownloadBlob(blob, mapExportName('png'));
}

// Expand the graph panel to fill the viewport (and back).
function mapToggleFullscreen(force) {
  map.fullscreen = force != null ? force : !map.fullscreen;
  el('map-panel').classList.toggle('app-map-fullscreen', map.fullscreen);
  el('map-fullscreen').textContent = map.fullscreen ? 'Exit full screen' : 'Full screen';
  document.body.style.overflow = map.fullscreen ? 'hidden' : '';
  if (map.cy) setTimeout(() => { map.cy.resize(); map.cy.fit(undefined, 24); }, 60);
}

function mapRenderCards() {
  const s = map.stats;
  const card = (num, label, sub) => `
    <div class="govuk-grid-column-one-third">
      <div class="app-card">
        <div class="app-num">${num}</div>
        <div class="govuk-body-s govuk-!-margin-bottom-0">${label}</div>
        ${sub ? '<div class="govuk-body-s app-muted">' + sub + '</div>' : ''}
      </div>
    </div>`;
  let firstSub;
  if (map.mode === 'seed' && map.seedMeta) {
    firstSub = `from ${map.seedMeta.seedCount} start page${map.seedMeta.seedCount === 1 ? '' : 's'}, ${map.seedMeta.hops} hop${map.seedMeta.hops === 1 ? '' : 's'}`;
  } else {
    firstSub = s.searchTotal > s.pageCount
      ? `first ${s.pageCount.toLocaleString('en-GB')} of ${s.searchTotal.toLocaleString('en-GB')} matching`
      : 'all matching pages';
  }
  el('map-cards').innerHTML =
    card(s.pageCount.toLocaleString('en-GB'), 'Pages mapped', firstSub) +
    card(s.hubCount.toLocaleString('en-GB'), 'Shared destinations', 'linked from 2+ of your pages') +
    card(s.withinCount.toLocaleString('en-GB'), 'Links within the set', 'page-to-page inside your selection') +
    card(s.orphanCount.toLocaleString('en-GB'), 'Unlinked pages',
         s.pageCount ? Math.round((s.orphanCount / s.pageCount) * 100) + '% have no links in or out' : '');
}

/* ----- Map: URL state (deep links) ----- */

function mapUpdateUrl() {
  if (map.restoring) return;
  const p = new URLSearchParams();
  if (map.mode === 'seed') {
    const seeds = mapReadSeeds();
    if (seeds.length) p.set('mseeds', seeds.join('|')); // paths never contain a pipe
    const hops = parseInt(el('map-hops').value, 10);
    if (hops === 1) p.set('mhops', '1');
    const cap = parseInt(el('map-seed-cap').value, 10);
    if (cap && cap !== 150) p.set('mscap', String(cap));
  } else {
    if (map.selected) p.set('map', map.selected.slug);
    const types = mapCheckedTypes();
    if (types.length) p.set('mtypes', types.join(','));
    const q = (el('map-q').value || '').trim();
    if (q) p.set('mq', q);
    const cap = parseInt(el('map-cap').value, 10);
    if (cap && cap !== 100) p.set('mcap', String(cap));
  }
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

async function mapRestoreFromUrl() {
  const p = new URLSearchParams(location.search);
  const seeds = p.get('mseeds');
  const org = p.get('map');
  if (!seeds && !org) return;
  map.restoring = true;
  try {
    showView('map');
    if (seeds) {
      el('map-mode-seed').checked = true;
      mapSetMode('seed');
      el('map-seeds').value = seeds.split('|').join('\n');
      if (p.get('mhops') === '1') el('map-hops').value = '1';
      if (p.get('mscap')) el('map-seed-cap').value = p.get('mscap');
      await mapSeedBuild();
    } else {
      const found = estate.orgs.find(o => o.slug === org) || { slug: org, title: org };
      mapSelectOrg(found);
      await mapLoadTypes();
      const types = (p.get('mtypes') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (types.length) {
        el('map-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = types.includes(cb.value); });
        if (p.get('mq')) el('map-q').value = p.get('mq');
        if (p.get('mcap')) el('map-cap').value = p.get('mcap');
        mapUpdateBuildEnabled();
        await mapBuild();
      }
    }
  } finally {
    map.restoring = false;
    mapUpdateUrl();
  }
}

function setupMap() {
  const search = el('map-org-search');

  ensureOrgs().then(() => {
    if (estate.orgsSource === 'aggregate-fallback') {
      el('map-org-hint').textContent = 'Type to search. (Org titles unavailable, showing slugs only.)';
    } else if (estate.orgsSource === 'failed') {
      el('map-org-hint').textContent = 'Could not load the organisation list.';
    } else {
      el('map-org-hint').textContent = `Type to search by title or slug. ${estate.orgs.length.toLocaleString('en-GB')} organisations.`;
    }
    mapRestoreFromUrl();
  });

  search.addEventListener('input', () => { map.selected = null; el('map-load-types').disabled = true; mapRenderOrgOptions(search.value); });
  search.addEventListener('focus', () => mapRenderOrgOptions(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mapMoveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mapMoveActive(-1); }
    else if (e.key === 'Enter') {
      if (map.activeIndex >= 0 && map.filtered[map.activeIndex]) { e.preventDefault(); mapSelectOrg(map.filtered[map.activeIndex]); }
      else if (map.selected) mapLoadTypes();
    } else if (e.key === 'Escape') { el('map-org-list').classList.add('app-hidden'); }
  });

  el('map-org-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.app-combo-option[data-i]');
    if (btn) mapSelectOrg(map.filtered[+btn.dataset.i]);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#map-org-search') && !e.target.closest('#map-org-list')) {
      el('map-org-list').classList.add('app-hidden');
    }
  });

  el('map-load-types').addEventListener('click', mapLoadTypes);
  el('map-build').addEventListener('click', mapBuild);
  el('map-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el('map-build').disabled) mapBuild(); });

  // Mode switch (organisation vs service seed-and-crawl)
  el('map-mode').addEventListener('change', (e) => {
    if (e.target.name === 'map-mode') mapSetMode(e.target.value);
  });
  el('map-seed-build').addEventListener('click', mapSeedBuild);

  // Empty-state examples: one per mode. Reuse the restore path so a single click
  // sets everything up and builds.
  el('map-empty').addEventListener('click', (e) => {
    const seedLink = e.target.closest('[data-map-seed]');
    const orgLink = e.target.closest('[data-map-org]');
    if (!seedLink && !orgLink) return;
    e.preventDefault();
    map.restoring = true;
    (async () => {
      try {
        if (seedLink) {
          el('map-mode-seed').checked = true;
          mapSetMode('seed');
          el('map-seeds').value = seedLink.dataset.mapSeed.split('|').join('\n');
          if (seedLink.dataset.mapHops === '1') el('map-hops').value = '1';
          await mapSeedBuild();
        } else {
          const slug = orgLink.dataset.mapOrg;
          mapSelectOrg(estate.orgs.find(o => o.slug === slug) || { slug, title: slug });
          await mapLoadTypes();
          const types = (orgLink.dataset.mapTypes || '').split(',').map(s => s.trim()).filter(Boolean);
          el('map-checkboxes').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = types.includes(cb.value); });
          mapUpdateBuildEnabled();
          await mapBuild();
        }
      } finally {
        map.restoring = false;
        mapUpdateUrl();
      }
    })();
  });

  // Org mode: quick guidance-type selection (mirrors Estate view).
  el('map-select-guidance').addEventListener('click', mapSetGuidanceTypes);
  el('map-clear-types').addEventListener('click', mapClearTypes);

  // Toggles and filters re-render the same graph (no re-fetch).
  el('map-show-hubs').addEventListener('change', () => { if (map.graph) mapRender(); });
  el('map-show-orphans').addEventListener('change', () => { if (map.graph) mapRender(); });
  el('map-show-welsh').addEventListener('change', () => { if (map.graph) mapRender(); });
  el('map-show-labels').addEventListener('change', () => { if (map.graph) mapRender(); });
  el('map-relayout').addEventListener('click', () => {
    if (!map.cy) return;
    const l = map.cy.layout(mapLayout());
    l.one('layoutstop', mapApplyView);
    l.run();
  });
  el('map-fit').addEventListener('click', () => { if (map.cy) map.cy.fit(undefined, 24); });
  el('map-fullscreen').addEventListener('click', () => mapToggleFullscreen());
  el('map-export-svg').addEventListener('click', mapExportSvg);
  el('map-export-png').addEventListener('click', mapExportPng);
  if (!mapSvgReady) el('map-export-svg').classList.add('app-hidden'); // hide if the SVG lib failed to load

  // Content-type filter chips.
  el('map-type-chips').addEventListener('click', (e) => {
    const clear = e.target.closest('[data-type-clear]');
    const guidance = e.target.closest('[data-type-guidance]');
    const chip = e.target.closest('[data-type]');
    if (clear) { map.visibleTypes.clear(); mapRender(); return; }
    if (guidance) {
      const present = [...new Set(map.graph.pages.map(p => p.format))].filter(t => GUIDANCE_TYPES.includes(t));
      const allActive = map.visibleTypes.size === present.length && present.every(t => map.visibleTypes.has(t));
      map.visibleTypes = allActive ? new Set() : new Set(present); // toggle guidance-only
      mapRender();
      return;
    }
    if (!chip) return;
    const t = chip.dataset.type;
    if (map.visibleTypes.has(t)) map.visibleTypes.delete(t); else map.visibleTypes.add(t);
    mapRender();
  });

  // Esc leaves full screen.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && map.fullscreen) mapToggleFullscreen(false);
  });
}

/* ---------- wire up ---------- */

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.govuk-service-navigation__link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showView(a.closest('.govuk-service-navigation__item').dataset.view);
    });
  });
  el('page-fetch').addEventListener('click', fetchPage);
  el('page-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchPage(); });
  // Clearing the input brings the empty state (explanation + examples) back.
  el('page-url').addEventListener('input', () => {
    if (!(el('page-url').value || '').trim()) {
      el('page-results').classList.add('app-hidden');
      el('page-empty').classList.remove('app-hidden');
      el('page-status').textContent = '';
      history.replaceState(null, '', location.pathname);
    }
  });
  // Clicking an example (empty state) or a search result loads that page's analysis.
  el('view-page').addEventListener('click', (e) => {
    const a = e.target.closest('[data-load-path]');
    if (!a) return;
    e.preventDefault();
    el('page-url').value = GOVUK + a.dataset.loadPath;
    loadPage(normalisePath(a.dataset.loadPath));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  setupEstate();
  setupMap();

  // Deep link: ?page=/path opens Page view and loads it immediately.
  const pageParam = new URLSearchParams(location.search).get('page');
  if (pageParam) {
    showView('page');
    el('page-url').value = GOVUK + normalisePath(pageParam).replace(/^/, '/');
    loadPage(normalisePath(pageParam));
  }
});
