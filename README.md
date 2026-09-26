# NexusKitty

A Chrome extension that reads the legal text a website actually shows you — terms,
privacy policy, cookie declaration — and tells you what is in it, in plain
language, with a quote you can check.

It exists because "we use cookies" is not a policy, and because most policies are
buried behind a consent wall, rendered only after JavaScript runs, and written in
a language the reader does not speak. NexusKitty handles all three before the
model ever sees a word.

Live backend: `https://nexuskitty.onrender.com` (Render, free tier).

---

## How it actually works

The interesting part of this project is not the prompt. It is getting a real
document out of a real website.

### 1. Discovery (content script, all frames, `document_idle`)

`extension/scripts/content.js` builds a payload of everything on the page: the
main text, any consent banner, detected trackers, and the consent controls.

Legal pages are rarely linked from the page you are on, so discovery is layered:

- Links are scored on the **last non-numeric path segment** of their URL, not
  the whole URL. A shop selling "thin-and-crispy-sandwich-**cookies**" must not
  outrank a cookie policy because the word is in a product name.
- **Commerce URLs are vetoed** (`/p/`, `/dp/`, `/product/`, `/item/`, `sku=`…),
  unless the visible link text itself says something legal.
- Tracking parameters are stripped before comparison, so
  `?bu_type=rank_list&track=…` does not create a second "document".
- Self-anchors, the bare homepage, and **translated duplicates of one document**
  are dropped — `/statiya/pravila-i-usloviya/339282/` and
  `/en/article/terms-conditions/339282/` are the same article, and paying to
  translate both is pure waste.
- If the page yields too little, `robots.txt` and `sitemap.xml` are consulted
  (once per origin, then cached).

### 2. Reading documents that JavaScript builds

A plain `fetch()` returns the empty shell of a React app. So for every discovered
legal URL the background service worker tries, in order:

1. **Static fetch** — cheap, and the right answer more often than you would
   hope. The charset comes from the HTTP header, then `<meta charset>`, then
   UTF-8. A body that is mostly source code is rejected rather than analysed.
2. **Offscreen iframe** — for sites that allow framing, the page is loaded into a
   hidden document and the real content script reports back the rendered text.
3. **Worker tab** — for everything else. One inactive tab is created once, kept
   in the tab strip, and re-pointed at each URL with `active: false`. It is never
   focused and never opened in front of you, but unlike the offscreen path it is
   a full browser, so hydration, lazy loading and consent walls all work.

Before reading the worker tab, a preparation pass clicks consent buttons
(accept *or* reject — getting past the wall matters more than which side you
pick), expands collapsed `<details>`, opens "show more" toggles, removes
full-viewport overlays, and scrolls to the bottom to trigger lazy content. Then
the DOM is read in the tab's isolated world, with settle rounds for apps that
paint their text a second after `load`.

Renders are cached for five minutes, concurrent requests for the same URL join
the one already in flight, and a failed navigation is reported as
`navigation_error` rather than as a script error.

### 3. Translation, and why the original still matters

The document is translated to English client-side, in ~500-character chunks,
four in flight, through Google's public translation endpoint. That translation is
sent to the model as `translated_text` **purely so it can reason in English**.

The document itself is sent as `text`, in its original language, and every
`evidence` quote in the response must be verbatim from it. The popup renders
those quotes with `lang` set to the detected language. This is the difference
between "the model says the site trains on your data" and "here is the sentence
that says it".

### 4. Analysis (FastAPI)

The backend hashes the document, checks the cache, and calls **Groq first**
(`gpt-oss-120b` over the OpenAI-compatible API), falling back to **Gemini**, and
finally to a deterministic local analysis if both providers are down. It never
raises: a degraded answer with `analysis_available: false` beats a spinner.

Results land in Supabase (`analyses`) together with a versioned snapshot of the
document (`tos_history`). On the next scan of the same domain, the two are
diffed — that is the **Time Machine** panel in the popup: which clauses were
added or removed since you last looked.

---

## What the popup gives you

- **Safety prediction** (0–100, higher is safer) and a short summary.
- **Findings** in six categories — Money, Privacy, User Content, AI Usage,
  Termination, Data Sale — each with an attention level, the section it came
  from, a verbatim quote, and a plain-language explanation.
- **Time Machine**: what changed in this document since the last scan.
- **Ask Kitty**: questions answered against the original document, with quotes.
- **History**: your last five scans, scoped to this browser installation.
- **Cookie breakdown** and **hypocrisy alerts** when the page's own claims
  contradict its behaviour.
- A per-site on/off switch, and a consent warning that appears on pages with
  high-risk consent controls.

---

## Repository layout

```
backend/
  app/
    main.py            FastAPI app: 6 endpoints, auth headers, caching, Time Machine
    config.py          Settings via pydantic-settings (reads .env)
    schemas.py         Request/response models, clause categories
    prompts.py         System prompts for the analysis engine
    database.py        Supabase client
    services/
      llm_service.py   Groq → Gemini → local fallback, response parsing
      db_service.py    Supabase reads/writes, hash cache, snapshots
  requirements.txt     Only what app/ imports — see the note below
  .env.example
extension/
  manifest.json        MV3: activeTab, scripting, storage, offscreen, <all_urls>
  content.js           (scripts/) discovery, extraction, translation, caching
  background.js        (scripts/) fetch, offscreen + worker-tab rendering
  offscreen.js         (scripts/) the offscreen document hosting the hidden iframe
  offscreen.html
  popup/
    popup.html/.js/.css  The UI
    config.js           Generated, git-ignored — see scripts/sync_extension_config.py
    config.example.js   Template
scripts/
  sync_extension_config.py   Copies backend/.env values into extension/popup/config.js
database/
  schema.sql           Supabase DDL (run once in the Supabase SQL editor)
render.yaml            Render service definition
```

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/health` | Liveness. Returns the running build's commit (`RENDER_GIT_COMMIT`). |
| `POST` | `/api/analyze` | Analyse a document. Cached by URL + content hash. |
| `POST` | `/api/ask` | Answer a question against a document. |
| `POST` | `/api/classify` | Is this text a legal/consent document? |
| `GET`  | `/api/history` | Recent scans for this browser installation. |

Requests carry `X-Client-Id`: a random UUID generated once and stored in
`chrome.storage.local`. It is not a login and identifies an installation, not a
person; it scopes history reads and writes only. Analysis caching is *not*
scoped by it — the same public document yields the same findings for everyone,
and sharing that cache is the point.

**About `EXTENSION_API_KEY`:** the popup still requires it and sends it as
`X-Extension-Key`, but the backend does not currently verify it. The header is
inert. Treat the API as public and put rate limiting in front of it if that
matters to you. An `EXTENSION_API_KEY` value was committed to this repository
before `config.js` was git-ignored; since the repository is public, that value
should be considered compromised and replaced everywhere it is used.

---

## Setup

### Backend

```bash
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then fill it in
uvicorn app.main:app --reload
```

Required in `.env`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GROQ_API_KEY`. Optional
but recommended: `SUPABASE_SERVICE_ROLE_KEY` (history writes),
`GEMINI_API_KEY` (second provider), `EXTENSION_API_KEY`.

Then run `database/schema.sql` in the Supabase SQL editor. It creates `analyses`
and `tos_history`; the app degrades to an in-memory cache if Supabase is
unreachable, so a failed schema does not stop the service from starting.

### Extension

```bash
python scripts/sync_extension_config.py     # generates extension/popup/config.js
```

Then `chrome://extensions` → enable Developer mode → **Load unpacked** → pick the
`extension` folder. `config.js` decides which backend is used:

```javascript
const APP_ENV = 'development';   // http://localhost:8000
const APP_ENV = 'production';    // https://nexuskitty.onrender.com
```

Open a terms or privacy page, click the icon. If the tab was already open when
the extension was reloaded, the popup re-injects the content script by itself —
you do not need to refresh the page.

---

## Deploying the backend

`render.yaml` holds the whole service definition: Python 3.11, root directory
`backend`, `pip install --no-cache-dir -r requirements.txt`, and
`uvicorn app.main:app --host 0.0.0.0 --port $PORT`, with `/api/health` as the
health check. Every secret is declared `sync: false` and lives only in the
Render dashboard.

Push to `master` and Render deploys. Verify which build is actually serving by
calling `/api/health` — if `commit` says `local`, you are not talking to a
Render build.

Do not replace `backend/requirements.txt` with a `pip freeze` of your local
virtualenv. The one that was there listed ~170 packages (torch, tensorflow,
streamlit, keras, librosa) that `app/` never imports, with pins resolved on
Windows; installing it on Render took minutes at best and failed at worst.

On the free tier the service sleeps after ~15 minutes of inactivity and the
first request after that can take 30–50 seconds to wake up. The popup's health
check has a 10-second budget, so on a cold instance it will report the backend as
unavailable — retry rather than assuming something is broken.

---

## Known limits

- PDFs and text drawn into canvases or images are not read. Policy PDFs are a
  real gap, not an oversight we are proud of.
- Discovery is keyword-based and covers the languages we have seen legal pages
  in. A site whose policy slugs are in an untested language may be found only
  through its own links or sitemap, not by search.
- The translation endpoint is Google's public one. It is not an SLA and not a
  secret; it can rate-limit or change.
- The consent-wall preparation clicks real buttons. It clicks at most a handful,
  never submits a form, and only ever runs in the hidden worker tab — but it is
  still automated interaction with a third-party site.
- Login walls, CAPTCHAs and geo-blocks are not solved. A site that refuses the
  render is reported as such instead of being quietly analysed as an empty page.
- Because the popup is an action popup, it closes if you click away. A full
  analysis can take 20–40 seconds on a JavaScript-heavy site; a side panel or a
  background task with a notification would be the fix, and is not built yet.

---

## License

MIT

Built for LexHack 2026 (Digital Rights & Policy Tech / AI Safety track).
