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
  el('nav-page').className = 'govuk-button' + (which === 'page' ? '' : ' govuk-button--secondary');
  el('nav-estate').className = 'govuk-button' + (which === 'estate' ? '' : ' govuk-button--secondary');
}

/* ---------- Page view ---------- */

async function fetchPage() {
  const path = normalisePath(el('page-url').value);
  const status = el('page-status');
  const results = el('page-results');
  results.classList.add('app-hidden');
  results.innerHTML = '';

  if (!path) {
    status.textContent = 'Enter a GOV.UK URL or path.';
    return;
  }

  status.textContent = 'Fetching /' + path + ' …';
  try {
    const r = await fetch(GOVUK + '/api/content/' + path);
    if (!r.ok) {
      status.textContent = r.status === 404
        ? 'Not found. GOV.UK has no content item at /' + path + ' (check the path, or it may be a search-only page).'
        : 'GOV.UK returned ' + r.status + ' for /' + path + '.';
      return;
    }
    const data = await r.json();
    status.textContent = '';
    renderPage(data, path);
    results.classList.remove('app-hidden');
  } catch (e) {
    status.textContent = 'Could not reach the GOV.UK content API: ' + e.message;
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
      <dd class="govuk-summary-list__value">${esc(app)} <span class="app-muted">— ${esc(gloss)}</span></dd></div>
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
      h += `<li>${fmtDate(c.public_timestamp)} — ${esc(stripTags(c.note || ''))}</li>`;
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
        <span class="app-muted"> — updated ${fmtDate(c.public_updated_at)}</span></li>`;
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
        ? '<strong class="govuk-tag govuk-tag--red">Likely</strong> — has file attachments and under 200 words of body content'
        : '<span class="app-muted">No — enough body content, or no file attachments</span>'}</dd></div>
    <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Welsh version</dt>
      <dd class="govuk-summary-list__value">${welshPresent
        ? 'Present, found via ' + routes.join('; ')
        : '<span class="app-muted">None found via any of the three routes</span>'}</dd></div>`;
  if (welshPresent) {
    h += `<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Welsh accessible</dt>
      <dd class="govuk-summary-list__value">${welshAccessible
        ? '<strong class="govuk-tag govuk-tag--green">Yes</strong> — at least one accessible route'
        : '<strong class="govuk-tag govuk-tag--red">No</strong> — only an inaccessible file (e.g. a PDF flagged not accessible)'}</dd></div>`;
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
};

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
      html += `<div class="app-combo-more app-muted">Showing first ${estate.filtered.length} of ${totalMatches.toLocaleString('en-GB')} — keep typing to narrow (${more.toLocaleString('en-GB')} more).</div>`;
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
  const sel = el('estate-org-selected');
  el('estate-org-selected-name').textContent = o.title === o.slug ? o.slug : `${o.title} (${o.slug})`;
  sel.classList.remove('app-hidden');
  el('estate-fetch').disabled = false;
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
    el('estate-total').textContent = total.toLocaleString('en-GB');
    el('estate-total-sub').textContent = 'in the search index for ' + slug;

    const opts = ((data.aggregates || {}).format || {}).options || [];
    estate.formats = opts.map(o => ({ slug: o.value.slug, documents: o.documents }))
                         .sort((a, b) => b.documents - a.documents);

    el('estate-breakdown-details').open = false; // collapsed by default; it's an optional chart
    renderTypeCheckboxes();
    renderFormatChart();
    updateProjection();
    el('estate-aggregate').classList.remove('app-hidden');
  } catch (e) {
    status.textContent = 'Could not reach the search API: ' + e.message;
  }
}

function renderTypeCheckboxes() {
  const box = el('estate-checkboxes');
  box.innerHTML = estate.formats.map(f => `
    <div class="govuk-checkboxes__item">
      <input class="govuk-checkboxes__input" id="cb-${esc(f.slug)}" type="checkbox" value="${esc(f.slug)}">
      <label class="govuk-label govuk-checkboxes__label" for="cb-${esc(f.slug)}">
        ${esc(f.slug)} <span class="app-muted">(${f.documents.toLocaleString('en-GB')})</span>
      </label>
    </div>`).join('');
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
    ? 'Log scale — the top content type is more than 100× the median, so a linear axis would hide everything else. Bar tooltips show real counts.'
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
      labels: f.map(x => x.slug),
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
  // search hides them). They are hidden in the table by default and revealed
  // with the "Show withdrawn pages" toggle. organisations[0] is the editorial
  // owner; is_withdrawn is a boolean. All ride along on the same request.
  const base = GOVUK + '/api/search.json?filter_organisations=' + encodeURIComponent(estate.selected.slug) +
    types.map(t => '&filter_format=' + encodeURIComponent(t)).join('') +
    '&fields=title&fields=link&fields=format&fields=public_timestamp&fields=organisations&fields=is_withdrawn' +
    '&debug=include_withdrawn';

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
        owner: (Array.isArray(x.organisations) && x.organisations[0] && x.organisations[0].title) || '',
        withdrawn: !!x.is_withdrawn,
      }));
      start += PAGE_SIZE;
      if (!batch.length) break; // safety against an infinite loop
    } while (rows.length < total);
    status.textContent = `Done. ${rows.length.toLocaleString('en-GB')} items.`;
  } catch (e) {
    status.textContent = 'Could not complete pagination: ' + e.message;
    el('estate-get-results').disabled = false;
    return;
  }

  estate.rows = rows;
  estate.sort = { key: 'days', dir: 'desc' };
  updateWithdrawnToggle();
  renderCards();
  renderYearBar();
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
  const now = Date.now();
  const within12m = rows.filter(r => r.updated && (now - Date.parse(r.updated)) < 365 * DAY).length;
  const over5 = rows.filter(r => r.days != null && r.days > AMBER_DAYS).length;
  const over10 = rows.filter(r => r.days != null && r.days > RED_DAYS).length;
  const owners = new Set(rows.map(r => r.owner).filter(Boolean));

  const byType = {};
  rows.forEach(r => { byType[r.format] = (byType[r.format] || 0) + 1; });
  const typeList = Object.entries(byType).sort((a, b) => b[1] - a[1]);

  const card = (label, num, sub) => `
    <div class="govuk-grid-column-one-quarter">
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
      <td class="govuk-table__cell app-break" style="width:32%">${esc(t)}</td>
      <td class="govuk-table__cell" style="width:48%">
        <div class="app-typebar-track"><div class="app-typebar-fill" style="width:${pct}%;background:${colour}"></div></div>
      </td>
      <td class="govuk-table__cell" style="width:12%;text-align:right;white-space:nowrap">${n.toLocaleString('en-GB')}</td>
      <td class="govuk-table__cell app-muted" style="width:8%;text-align:right;white-space:nowrap">${share}%</td>
    </tr>`;
  }).join('');

  el('estate-cards').innerHTML =
    card('Total items', rows.length.toLocaleString('en-GB'), estate.selected.slug) +
    card('Distinct editorial owners', owners.size.toLocaleString('en-GB'),
         owners.size > 1 ? 'the estate includes pages owned by others' : 'all one owner') +
    card('Updated in last 12 months', within12m.toLocaleString('en-GB'), 'by last-updated date') +
    card('Not updated in over 5 years', over5.toLocaleString('en-GB'), '&gt; 1,825 days') +
    card('Not updated in over 10 years', over10.toLocaleString('en-GB'), '&gt; 3,650 days') +
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

  estate.yearbar = new Chart(el('estate-yearbar').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data: labels.map(y => byYear[y] || 0), backgroundColor: '#1d70b8' }] },
    options: {
      maintainAspectRatio: false, responsive: true, animation: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { autoSkip: false, maxRotation: 90, minRotation: 45, font: { size: 10 } } },
                y: { beginAtZero: true } },
    },
  });
}

const COLUMNS = [
  { key: 'title', label: 'Title' },
  { key: 'path', label: 'Path' },
  { key: 'owner', label: 'Editorial owner' },
  { key: 'format', label: 'Content type' },
  { key: 'updated', label: 'Last updated' },
  { key: 'days', label: 'Days since update' },
  { key: 'withdrawn', label: 'Withdrawn' },
];

function sortedFilteredRows() {
  const q = (el('estate-table-filter').value || '').trim().toLowerCase();
  let rows = baseRows();
  if (q) rows = rows.filter(r => r.title.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
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
  const thead = el('estate-thead');
  thead.innerHTML = '<tr class="govuk-table__row">' + COLUMNS.map(c => {
    const active = estate.sort.key === c.key;
    const arrow = active ? (estate.sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
    return `<th scope="col" class="govuk-table__header app-sort" data-key="${c.key}">${esc(c.label)}<span class="app-arrow">${arrow}</span></th>`;
  }).join('') + '</tr>';

  const rows = sortedFilteredRows();
  const workingTotal = baseRows().length;
  el('estate-table-count').textContent =
    `${rows.length.toLocaleString('en-GB')} shown of ${workingTotal.toLocaleString('en-GB')}` +
    (rows.length !== workingTotal ? ' (filtered)' : '');

  const MAX_RENDER = 2000; // keep the DOM manageable; CSV always has everything
  const slice = rows.slice(0, MAX_RENDER);
  el('estate-tbody').innerHTML = slice.map(r => {
    const stale = r.days == null ? '' : r.days > RED_DAYS ? ' app-row-red' : r.days > AMBER_DAYS ? ' app-row-amber' : '';
    const cls = stale + (r.withdrawn ? ' app-row-withdrawn' : '');
    const withdrawnCell = r.withdrawn
      ? '<strong class="govuk-tag govuk-tag--red">Withdrawn</strong>'
      : '<span class="app-muted">—</span>';
    return `<tr class="govuk-table__row${cls}">
      <td class="govuk-table__cell app-break"><a class="govuk-link" href="${GOVUK}${esc(r.path)}" target="_blank" rel="noopener">${esc(r.title)}</a></td>
      <td class="govuk-table__cell app-break">${esc(r.path)}</td>
      <td class="govuk-table__cell app-break">${r.owner ? esc(r.owner) : '<span class="app-muted">—</span>'}</td>
      <td class="govuk-table__cell">${esc(r.format)}</td>
      <td class="govuk-table__cell">${fmtDate(r.updated)}</td>
      <td class="govuk-table__cell">${r.days == null ? '—' : r.days.toLocaleString('en-GB')}${staleTag(r.days)}</td>
      <td class="govuk-table__cell">${withdrawnCell}</td>
    </tr>`;
  }).join('');

  if (rows.length > MAX_RENDER) {
    el('estate-tbody').innerHTML +=
      `<tr class="govuk-table__row"><td class="govuk-table__cell app-muted" colspan="${COLUMNS.length}">Showing first ${MAX_RENDER.toLocaleString('en-GB')} rows. Filter to narrow, or use Download CSV for the full set.</td></tr>`;
  }
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
      const wcb = el('estate-show-withdrawn');
      if (wcb && !wcb.disabled) wcb.checked = st.withdrawn;
      renderCards();
      renderYearBar();
      renderTable();
    }
  } finally {
    estate.restoring = false;
    updateUrl(); // write the canonical, fully-restored URL once
  }
}

function setupEstate() {
  const search = el('estate-org-search');

  loadOrganisations().then(() => {
    if (estate.orgsSource === 'aggregate-fallback') {
      el('estate-org-hint').textContent =
        'Type to search. (Org titles unavailable — showing slugs only. The organisations Function is not reachable; deploy to Netlify or run `netlify dev` for titles.)';
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

  // Re-render the breakdown chart to its container when the details is re-opened
  // (Chart.js measures 0 while inside a collapsed <details>).
  el('estate-breakdown-details').addEventListener('toggle', (e) => {
    if (e.target.open && estate.chart) estate.chart.resize();
  });

  // Results controls
  el('estate-get-results').addEventListener('click', fetchResults);
  el('estate-table-filter').addEventListener('input', () => { renderTable(); updateUrl(); });
  el('estate-show-withdrawn').addEventListener('change', () => {
    renderCards(); renderYearBar(); renderTable(); updateUrl();
  });
  el('estate-csv').addEventListener('click', downloadCsv);
  el('estate-thead').addEventListener('click', (e) => {
    const th = e.target.closest('.app-sort');
    if (!th) return;
    const key = th.dataset.key;
    if (estate.sort.key === key) estate.sort.dir = estate.sort.dir === 'asc' ? 'desc' : 'asc';
    else estate.sort = { key, dir: key === 'title' || key === 'path' || key === 'format' ? 'asc' : 'desc' };
    renderTable();
    updateUrl();
  });
}

/* ---------- wire up ---------- */

document.addEventListener('DOMContentLoaded', () => {
  el('nav-page').addEventListener('click', () => showView('page'));
  el('nav-estate').addEventListener('click', () => showView('estate'));
  el('page-fetch').addEventListener('click', fetchPage);
  el('page-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchPage(); });
  setupEstate();
});
