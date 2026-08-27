# GOV.UK content explorer: build spec

**For:** Claude Code
**Owner:** Steve Wise
**Status:** Draft for build
**Type:** Side project, personal experiment

---

## 1. What this is

A local web app that puts a visual front end on the two public GOV.UK APIs, so a content or service designer can explore a department's guidance estate without writing any code.

Two things it does:

**Estate view.** Enter an organisation slug. See what that department publishes, broken down by content type, age and format, with a filterable table and CSV export.

**Page view.** Paste any GOV.UK URL. See who owns it editorially, what pages hide inside it as attachments, whether it has a Welsh version and whether that version is accessible, how stale it is, and what it links out to.

It is not the audit pipeline. That runs in batch and produces a register. This is the interactive companion for looking things up and showing people.

## 2. Non-goals

- No database. Everything is fetched live and held in memory
- No user accounts, no deployment, no hosting. It runs on localhost
- No scoring, triage or scope decisions. Those are human judgements and belong in the pipeline
- No editing. Read-only against GOV.UK

## 3. Phase 0: settle the CORS question first

**Do this before building anything.** Open a browser console on any page and run:

```js
fetch('https://www.gov.uk/api/search.json?count=1')
  .then(r => r.json()).then(console.log).catch(console.error)
```

- **If it returns data**, the APIs allow cross-origin requests and the app can be a single static HTML file with no backend at all. Much simpler.
- **If it throws a CORS error**, the app needs a thin local backend to proxy the calls.

Report which it is before writing the app. The rest of this spec assumes a backend proxy, since that path works either way and adds caching. Drop it if Phase 0 says it isn't needed.

## 4. Stack

- **Backend:** Python, FastAPI, `httpx`. One file, `server.py`
- **Frontend:** a single `index.html` with vanilla JavaScript. No build step, no framework
- **Styling:** GOV.UK Design System via CDN, so it looks like the thing it describes
  `https://cdn.jsdelivr.net/npm/govuk-frontend@5/dist/govuk/govuk-frontend.min.css`
- **Charts:** Chart.js via CDN. Bar and doughnut only
- **Run:** `uvicorn server:app --reload` then open `localhost:8000`

Keep the whole thing to two files plus a README.

## 5. Backend

Three endpoints, all thin proxies with a 15 minute in-memory cache keyed on the full upstream URL.

| Endpoint | Proxies to |
|---|---|
| `GET /api/organisations` | `https://www.gov.uk/api/organisations` |
| `GET /api/search?<params>` | `https://www.gov.uk/api/search.json` with params passed through |
| `GET /api/content?url=<govuk url or path>` | `https://www.gov.uk/api/content/<path>` |

Rules:

- Normalise the `url` parameter: accept a full `https://www.gov.uk/...` URL or a bare path, strip the leading slash, strip query strings and anchors
- Rate limit outbound calls to 2 per second
- Set a user agent identifying the tool and a contact email, read from an env var
- Return upstream errors as JSON with a clear message rather than a stack trace
- Serve `index.html` at `/`

## 6. Estate view

### Input

- Organisation picker, populated from `/api/organisations`, searchable, showing the slug alongside the title
- Content type checkboxes, populated **after** the first call from the `aggregate_format` response so the user sees real counts before choosing. Default all off with a "select guidance types" shortcut that ticks: `guide`, `answer`, `transaction`, `guidance`, `detailed_guide`, `statutory_guidance`, `document_collection`
- A "fetch" button, disabled until an organisation is chosen

### Before fetching

Call `search.json?filter_organisations=<slug>&count=0&aggregate_format=100` and show:

- Total items in the index for that organisation
- A horizontal bar chart of items per content type, sorted descending, log scale if the top value is more than 100 times the median
- The projected row count for the current checkbox selection, updating live

**This is the most useful screen in the app.** For HMCTS it makes it immediately obvious that 98.6% of the index is tribunal decisions. Do not skip it in favour of going straight to results.

### Results

Paginate `search.json` with `count=1500` and `start` until exhausted, showing progress. Then render:

**Summary cards**
- Total items
- Count per content type
- Count of items published in the last 12 months
- Count of items not updated in over 5 years, and over 10 years

**Charts**
- Doughnut: items by content type
- Bar: items by year of last update, so staleness is visible at a glance

**Table**
- Columns: title (linked to the live page), path, content type, last updated, days since update
- Sortable on every column
- Free-text filter across title and path
- Rows where days since update exceeds 1825 tinted amber, over 3650 tinted red
- Download as CSV button

`fields=title,link,format,public_timestamp` on the search call gives everything the table needs.

## 7. Page view

### Input

A single text box accepting a GOV.UK URL or path, and a fetch button. Should accept anything a user might paste, including URLs with query strings or anchors.

### Output

Six panels.

**Ownership**
- `primary_publishing_organisation[0].title` labelled "Editorial owner"
- `links.organisations[].title` labelled "Policy owner"
- `publishing_app`, with a plain-English gloss: `publisher` → "Mainstream, GDS-managed", `whitehall` → "Departmental"
- Flag prominently when the two owners differ, because that is invisible on the page itself and is usually the interesting bit

**Dates and staleness**
- First published, last updated, days since update
- Amber over 5 years, red over 10
- The `details.change_history` list if present, as a simple timeline

**Structure**
- `document_type`
- Number of parts if `details.parts` exists, listed with their slugs
- **Attachment children from `links.children`**, each listed with its own title, URL and last updated date. Label the panel "Pages inside this publication" and show a count. If there are none, say so explicitly
- Distinguish HTML attachments from file attachments in `details.attachments`, showing `content_type` and `file_size` for files

**Accessibility and language**
- PDF-only: true if attachments exist and the body has under 200 words
- Welsh: check all three places it hides, and say which one found it
  1. `links.available_translations` for a `cy` locale
  2. `details.attachments` for a filename ending `-cym` or `-w`
  3. Body HTML for a link to a Welsh-slugged path
- Welsh accessible: true if **any** route is accessible. A page can have both a proper translation and an inaccessible PDF; the translation wins
- Any attachment with `accessible: false` flagged individually

**Navigation**
- `links.mainstream_browse_pages` and `links.parent`, or an explicit "not in any browse navigation" message
- `links.taxons`

**Links out**
- Internal GOV.UK links extracted from `details.body` and every `details.parts[].body`, with their link text, deduplicated
- External domains with counts
- Normalise absolute `https://www.gov.uk/...` URLs to paths before classifying internal versus external, or GOV.UK will appear as a third party

## 8. Traps, all verified against live responses

| Trap | Handling |
|---|---|
| Search API `document_type` is always `"edition"` | Use `format` for content type in search results |
| Content API has no `format` field | Use `document_type` there. The two APIs are inconsistent by design |
| `withdrawn_notice` returns `{}` when not withdrawn | Test for emptiness, not presence, or everything shows as withdrawn |
| `links.children` is richer than `details.attachments` | Prefer `children` for HTML attachments, use `attachments` for files and the `accessible` flag |
| `available_translations` misses most Welsh versions | Check all three routes in section 7 |
| Body HTML mixes relative paths and absolute gov.uk URLs | Normalise before classifying |
| Multi-part guides hold content in `details.parts[].body`, not `details.body` | Concatenate both when extracting links or counting words |

## 9. Build order

1. **Phase 0.** Answer the CORS question. Report the result
2. Backend with the three proxy endpoints. Test each with curl
3. Page view. It is self-contained, immediately useful, and exercises every API trap
4. Estate view, aggregate screen only. Stop and look at it
5. Estate view results, table and charts
6. CSV export

Build and check each phase before moving on.

## 10. Done when

- Entering `hm-courts-and-tribunals-service` shows 159,971 items with employment tribunal decisions as the dominant type
- Ticking the seven guidance content types projects roughly 1,600 items
- Pasting `https://www.gov.uk/government/publications/third-party-debt-orders-and-charging-orders-ex325` shows HMCTS as editorial owner, Whitehall as publishing app, four pages inside the publication, and Welsh present via an attachment flagged not accessible
- Pasting `https://www.gov.uk/make-court-claim-for-money` shows GDS as editorial owner against HMCTS as policy owner, eight parts, and Welsh found via a body link
- Pasting a bare path, a full URL, and a URL with an anchor all work

## 11. README

Short. What it does, the CORS finding, how to run it, and the three API traps in section 8 that would otherwise cost someone an afternoon.
