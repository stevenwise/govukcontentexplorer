# GOV.UK content explorer (unofficial)

A small web app that puts a visual front end on the two public GOV.UK APIs, so a
content or service designer can explore a department's guidance estate without
writing code.

**This is an unofficial personal tool. It is not an HMCTS, MoJ or GDS service.**
It is read-only against the public GOV.UK APIs.

Two views:

- **Page view** — paste any GOV.UK URL or path and see editorial vs policy
  ownership, the pages hidden inside a publication, staleness, whether a Welsh
  version exists (and whether it is accessible), and what the page links out to.
- **Estate view** — pick an organisation and see what it publishes, broken down
  by content type and age. An aggregate screen first (total items, per-type bar
  chart, live projected row count) so you can size a pull before making it, then
  results: summary cards, doughnut + year-of-last-update charts, and a sortable,
  filterable table with amber/red staleness tinting and CSV export.

## The CORS finding (Phase 0)

Whether this needed a backend came down to one question: do the GOV.UK APIs allow
cross-origin browser requests? Tested with a real cross-origin `fetch()`, the
answer splits by endpoint:

| Endpoint | `Access-Control-Allow-Origin` | In-browser |
|---|---|---|
| `search.json` | `*` | works — called direct from the browser |
| `content/<path>` | `*` | works — called direct from the browser |
| `organisations` | **absent** | **blocked** — proxied by a Netlify Function |

So the app is a static site. Only `/api/organisations` (which populates the org
picker in Estate view) needs a server, and that is the single small Netlify
Function in `netlify/functions/organisations.js`. Everything else runs in the
browser.

## Running it

### Locally

Page view needs nothing but a static server (it calls the CORS-enabled endpoints
direct):

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123.

Estate view (next phase) uses the organisations Function, which needs the Netlify
CLI so the function runs locally:

```bash
export CONTACT_EMAIL="you@example.com"
netlify dev
```

### Deploying to Netlify

1. Push this folder to Netlify (drag-and-drop or connect the repo). `netlify.toml`
   already sets the publish directory and functions directory.
2. **Set the `CONTACT_EMAIL` environment variable** — see below. Without it the
   organisations Function fails loudly and returns a clear 500.
3. **Password protection**: Site configuration → Access & security → Visitor
   access → set a site password (Netlify Pro feature). Nothing to configure in
   code.

### `CONTACT_EMAIL` (required for the Function)

GOV.UK asks automated clients to identify themselves. The Function's outbound
`User-Agent` therefore carries a real contact email, read from the
**`CONTACT_EMAIL`** environment variable — never hardcoded — so GOV.UK can reach
the operator if the traffic misbehaves. If it is not set, the Function logs a
fatal error and returns HTTP 500 with an explanatory message rather than sending
anonymous traffic. Set it in Netlify → Site configuration → Environment variables
(and in your shell for `netlify dev`).

## Three API traps that would otherwise cost you an afternoon

1. **The two APIs are inconsistent by design.** In the *search* API, `document_type`
   is always `"edition"` — use the `format` field for content type. In the
   *content* API there is no `format` field — use `document_type`. They disagree on
   purpose.

2. **`withdrawn_notice` is `{}` when a page is *not* withdrawn**, not `null` or
   absent. Test it for emptiness (`Object.keys(...).length`), or every page shows
   as withdrawn.

3. **Welsh versions hide in three places, and `available_translations` misses most
   of them.** Check all three: (a) `links.available_translations` for a `cy`
   locale; (b) `details.attachments` for a filename ending `-cym` or `-w`; (c) a
   body link whose visible text mentions "Welsh" / "Cymraeg". A page can have both
   a proper translation and an inaccessible PDF — the accessible route wins.

(Related: `links.children` is richer than `details.attachments` for the HTML pages
nested inside a publication, and multi-part guides hold their content in
`details.parts[].body`, not `details.body` — so concatenate both when counting
words or extracting links.)

## Files

```
index.html                        the app (GOV.UK Frontend + Chart.js via CDN)
app.js                            vanilla JS: view switching + Page view
netlify/functions/organisations.js  proxy for the one CORS-blocked endpoint
netlify.toml                      Netlify config (publish dir, function, redirect)
```

We deliberately do **not** load the GDS Transport font — it is licensed for real
government services only, and this is not one. The Arial fallback is the correct
choice and still reads as GOV.UK.
