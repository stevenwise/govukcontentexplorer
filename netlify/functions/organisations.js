/* Netlify Function: organisations proxy.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 0 found that https://www.gov.uk/api/organisations is the ONE GOV.UK
 * endpoint that does NOT send an Access-Control-Allow-Origin header, so a
 * browser cannot call it directly. search.json and content/<path> both send
 * `*` and are called straight from the browser. This function proxies only
 * the blocked endpoint, aggregates its 64 pages into one compact list, and
 * caches the result for 15 minutes.
 *
 * OUTBOUND IDENTIFICATION
 * -----------------------
 * GOV.UK asks automated clients to identify themselves. The outbound
 * User-Agent therefore carries a real contact email, read from the
 * CONTACT_EMAIL environment variable (never hardcoded). If it is not set the
 * function fails loudly rather than sending anonymous traffic — see README.
 */

'use strict';

const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
const TOOL = 'govuk-content-explorer (unofficial personal tool)';

// Fail loudly at module load so the missing variable is obvious in the logs.
if (!CONTACT_EMAIL) {
  console.error(
    '[organisations] FATAL: CONTACT_EMAIL environment variable is not set. ' +
    'GOV.UK requires an identifying contact email in the outbound User-Agent. ' +
    'Set CONTACT_EMAIL in Netlify > Site configuration > Environment variables.'
  );
}

const UPSTREAM = 'https://www.gov.uk/api/organisations';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const CONCURRENCY = 4;            // gentle on upstream; full list is cached 15 min

let cache = { at: 0, body: null };

function userAgent() {
  return `${TOOL}; contact: ${CONTACT_EMAIL}`;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`upstream ${r.status} for ${url}`);
  return r.json();
}

/* Fetch an array of URLs with limited concurrency. */
async function fetchAll(urls) {
  const results = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      results[idx] = await getJson(urls[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return results;
}

async function buildList() {
  const first = await getJson(`${UPSTREAM}?page=1`);
  const pages = first.pages || 1;
  const all = [...(first.results || [])];
  if (pages > 1) {
    const urls = [];
    for (let p = 2; p <= pages; p++) urls.push(`${UPSTREAM}?page=${p}`);
    const rest = await fetchAll(urls);
    rest.forEach(pg => { if (pg && pg.results) all.push(...pg.results); });
  }
  const organisations = all.map(o => ({
    slug: (o.details && o.details.slug) || o.id,
    title: o.title,
    web_url: o.web_url,
    updated_at: o.updated_at,
  })).filter(o => o.slug && o.title)
     .sort((a, b) => a.title.localeCompare(b.title));

  return { total: organisations.length, fetched_at: new Date().toISOString(), organisations };
}

exports.handler = async () => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=900',
  };

  if (!CONTACT_EMAIL) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: 'CONTACT_EMAIL environment variable is not set. GOV.UK requires an ' +
               'identifying contact email in the outbound User-Agent. Set CONTACT_EMAIL ' +
               'in Netlify > Site configuration > Environment variables, then redeploy.',
      }),
    };
  }

  // Serve from cache when fresh
  if (cache.body && (Date.now() - cache.at) < CACHE_TTL) {
    return { statusCode: 200, headers: { ...cors, 'X-Cache': 'HIT' }, body: cache.body };
  }

  try {
    const data = await buildList();
    cache = { at: Date.now(), body: JSON.stringify(data) };
    return { statusCode: 200, headers: { ...cors, 'X-Cache': 'MISS' }, body: cache.body };
  } catch (e) {
    console.error('[organisations] upstream error:', e.message);
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({ error: 'Could not fetch the organisation list from GOV.UK: ' + e.message }),
    };
  }
};
