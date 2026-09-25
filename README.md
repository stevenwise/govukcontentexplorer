# GOV.UK Content Explorer (unofficial)

A small web app that puts a visual front end on the public GOV.UK APIs, so a
content or service designer can explore how government guidance is published and
how it connects, without writing any code. It is read-only and live: nothing is
stored, and every view is built fresh from the public APIs.

> **Unofficial personal tool.** It is not an HMCTS, MoJ or GDS service. It reads
> the public GOV.UK APIs only.

Live: **https://govukcontentexplorer.netlify.app**

## What you can do

Three views:

- **Page view** — paste any GOV.UK URL or path and see who owns it (editorial vs
  policy), the pages hidden inside a publication, how out of date it is, whether
  there is an accessible Welsh version, and what the page links out to.

- **Estate view** — pick an organisation and see everything it publishes, broken
  down by content type and age: summary cards, charts, and a sortable, filterable
  table with staleness highlighting and CSV export. An overview screen comes first
  so you can size a pull before you make it.

- **Content ecosystem map** — trace a service from a starting page and see it
  drawn as a map. It follows the links written into each page to show how the
  content connects, groups the parts of a guide together, highlights the service
  you are tracing, and marks the shared pages that several parts send people to.
  Publications are opened up into the HTML pages inside them, and you can switch
  on external sites to see where the service signposts people outside GOV.UK,
  such as Citizens Advice. You can filter by content type or language, rearrange
  and save the layout, share an exact view by link, and export to image (SVG or
  PNG) or spreadsheet (CSV).

## How it works (in brief)

- It reads the two public GOV.UK APIs live in the browser: the **Search API** (to
  list what an organisation publishes) and the **Content API** (to read a page,
  the pages inside it, its ownership, dates and links). There is no database and
  nothing is saved.

- The map is drawn with **Cytoscape.js** using the **fCoSE** force-directed layout
  engine, followed by a tidy pass that packs each guide into a neat grid and
  frames the view on the service you are tracing, so the map reads clearly instead
  of as a tangle of lines.

- It runs as a static site. One small serverless function fetches the list of
  organisations (the only piece the browser cannot request directly).

## Running it locally

Most of the app is a static site, so a plain web server is enough:

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123. The organisation picker in Estate view uses the
small serverless function; if you need that part locally, run `netlify dev` with a
`CONTACT_EMAIL` set (GOV.UK asks automated clients to identify themselves).

---

A note on the look: it deliberately does not use the official GDS Transport font,
which is licensed for real government services only. The Arial fallback still reads
as GOV.UK and keeps the tool clearly unofficial.
