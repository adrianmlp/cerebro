# Cerebro

Personal productivity dashboard. Cloudflare Pages (frontend) + Worker (API) + D1 (SQLite) + Workers AI.

## Stack
- **Frontend:** Vanilla HTML/CSS/JS, no build step. Push to GitHub → auto-deploys Pages.
- **Worker:** `worker/index.js` → `npx wrangler deploy` (no `--name` flag — uses `name = "cerebro-worker"` from wrangler.toml, which deploys to `cerebro-worker.mlpdev.workers.dev`, the URL all pages reference in their `<meta name="worker-url">` tag. **Never use `--name cerebro-api` or any other name override** — that deploys to a different, unused worker.)
- **DB:** Cloudflare D1, binding `DB` (SQLite). **Never use `wrangler d1 execute`** — add migrations as `try/catch ALTER TABLE` at top of `fetch()`.
- **AI:** Workers AI, binding `AI`, model `@cf/meta/llama-3.1-8b-instruct`
- **Auth:** HMAC-signed 30-day tokens in `localStorage`. `POST /api/auth/token` exchanges password. `APP_PASSWORD` change invalidates all tokens.
- **PWA:** `manifest.json` + `sw.js`. Cache key `cerebro-vN` — **bump N on every JS/CSS deploy, including hotfixes**. HTML = network-first; static assets = cache-first. Android share target → `save.html`.

## Pages
| File | Purpose |
|------|---------|
| `index.html` + `dashboard.js` | Dashboard: Daily Brief (cache-first), floating chat bar (starts collapsed) |
| `tasks.html` + `tasks.js` | Tasks CRUD |
| `calendar.html` + `calendar.js` | Calendar + Outlook ICS. Deep-link: `?view=day&date=YYYY-MM-DD` |
| `notes.html` + `notes.js` | Notes (split-panel) |
| `saves.html` + `saves.js` | Bookmarks grid |
| `save.html` | PWA share target |
| `settings.html` + `settings.js` | Settings: tag-input for tickers/teams/topics, weather ZIP, Gmail filters |
| `api.js` | `apiFetch()`, `toast()`, date/priority helpers |
| `nav.js` | Nav + hamburger |
| `style.css` | Deep Ocean dark theme, design tokens |
| `sw.js` | Service worker (currently `cerebro-v41`) |

## DB Schema
```sql
tasks(id, title, description, priority[URGENT|HIGH|NORMAL|BACKLOG], completed, due_date, created_at, updated_at)
calendar_events(id, title, description, start_time, end_time, color, is_important, location, recurrence_type[NONE|DAILY|WEEKLY|BIWEEKLY|MONTHLY], recurrence_end, parent_event_id, exception_date, is_deleted, created_at, updated_at)
notes(id, title, content, event_id, tags, created_at, updated_at)
outlook_events(uid, title, description, organizer, location, start_time, end_time, is_all_day, recurrence_rule, recurrence_exceptions, event_tzid, local_start, synced_at)
hidden_outlook_events(uid, title, hidden_at)
settings(key TEXT PK, value TEXT)
saves(id, url, title, description, thumbnail, type[article|video|link], tags, is_read, created_at)
```

## Settings Keys
`brief_tickers`, `brief_teams`, `brief_topics` — comma-separated.
`weather_zip` — fallback ZIP for weather when GPS unavailable.
`outlook_last_sync` — ISO timestamp.
`gmail_refresh_token`, `gmail_access_token`, `gmail_token_expires` — OAuth tokens.
`gmail_filter_senders`, `gmail_filter_topics` — comma-separated Gmail filters.
`gmail_oauth_state` — temp state param during OAuth flow.

## Worker Secrets
`APP_PASSWORD`. `OUTLOOK_ICS_URL` (+ `_2`–`_10`) — Outlook ICS feeds.
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Gmail OAuth.

## API Routes
```
POST            /api/auth/token
GET/POST        /api/tasks
PATCH           /api/tasks/:id
GET/POST        /api/events
PATCH/GET       /api/events/:id
GET/POST        /api/events/:id/notes
GET             /api/outlook/events?start=&end=
GET/POST/DELETE /api/outlook/hide[/:uid]
GET             /api/outlook/search?q=
POST            /api/sync/outlook
GET             /api/sync/status
GET/POST/PATCH  /api/notes[/:id]
POST            /api/chat
GET             /api/brief?date=YYYY-MM-DD[&lat=&lon=]
GET/PUT         /api/brief/settings
GET             /api/news?topic=TEXT
GET/POST        /api/saves
PATCH/DELETE    /api/saves/:id
GET             /api/gmail/auth
GET             /api/gmail/callback  ← must be BEFORE checkAuth gate
GET             /api/gmail/status
DELETE          /api/gmail/disconnect
GET/PUT         /api/gmail/settings
GET             /api/gmail/test
```

## Daily Brief
`GET /api/brief?date=YYYY-MM-DD[&lat=&lon=]` — client passes local date + optional GPS coords.

Fetches in parallel:
- **Stocks:** Yahoo Finance v8 `interval=1m&range=1d`. Returns `price`, `changePercent` (`regularMarketChangePercent`), `marketState` (REGULAR/PRE/POST/CLOSED).
- **Sports:** ESPN scoreboard API. Returns `home/away`, scores (blank when `statusState=pre`), `status`, `statusState` (pre/in/post), `statusDetail` (e.g. "Q3 - 5:22", "Top 3rd"), `date`, `broadcasts[]`.
- **News:** Bing RSS (Google fallback) for `brief_topics`. Grouped by topic in UI.
- **Sports News:** Same `briefFetchNews()` called with `brief_teams`. Grouped by topic.
- **Weather:** GPS lat/lon → Open-Meteo directly. ZIP → `geocodeZip()` (Open-Meteo geocoding primary, zippopotam.us fallback) → Open-Meteo. Returns current + 5-day forecast.
- **Gmail:** `fetchGmailEmails()` if connected. Filtered by senders + keywords.
- **D1:** Tasks due in next 7 days OR priority URGENT/HIGH (regardless of due date) + today's meetings.

Response: `{ dueToday, meetings, stocks, sports, news, sportsNews, weather, weatherLocation, gmailEmails, gmailConnected, settings }`.

Brief grid: 4 stocks/row desktop → 2 mobile; 3 scores/row desktop → 1 mobile.

## Brief Caching (dashboard.js)
- Cache key: `cerebro_brief_v1_YYYY-MM-DD` in `localStorage` (auto-expires at midnight via date key).
- TTL: 3 hours. On page load: if cache < 3h → render instantly, show "Updated Xm ago", no API call.
- If cache ≥ 3h: show stale data while fetching fresh in background.
- Refresh button (↺): always force-fetches, bypasses cache.
- `renderBrief(data)` is pure rendering; `loadBrief(forceRefresh)` handles cache + fetch.
- Bump `BRIEF_CACHE_VERSION` constant if brief response shape changes.

## Weather
- **GPS path:** `navigator.geolocation` with `maximumAge: Infinity` (reuse any cached fix) + `timeout: 8000`. Passes `&lat=&lon=` to brief endpoint → Open-Meteo direct.
- **ZIP path:** `geocodeZip()` → Open-Meteo geocoding API (primary, same domain = CF-accessible) → zippopotam.us fallback → Open-Meteo weather.
- **Open-Meteo:** `api.open-meteo.com/v1/forecast` with `forecast_days=6`, daily weathercode. Returns WMO codes mapped to emoji/label via `wmoInfo()`.
- Weather card clicks → AccuWeather search by lat,lon or ZIP.
- **Geocoding gotcha:** Nominatim and many geocoding APIs block CF Worker IPs. Always use Open-Meteo geocoding or zippopotam.us.

## Gmail Integration
- OAuth 2.0 flow: `/api/gmail/auth` → Google → `/api/gmail/callback` → redirect to settings with `?gmail=connected`.
- Callback route must be placed **before** the `checkAuth` gate in the router.
- Tokens stored in D1 `settings` table. Access token auto-refreshed via `getGmailAccessToken()`.
- Brief shows compact single-line email rows (sender + subject). Click → preview modal with snippet + action buttons (→ Task / → Event / → Note / Open ↗).
- Gmail search: bare terms for single words, quoted (`"multi word"`) for phrases. **No `body:` operator** — Gmail API rejects it.
- App must be in Google Cloud "Testing" mode with test users added, or published for general use.

## News
- `briefFetchNews(topicStr)`: Bing RSS primary, Google fallback per topic (up to 4 topics, 3 items each).
- `splitTitleSource(title, rssSource)`: extracts source from "Title — Source" pattern. Use **greedy** `(.*)` not `(.*?)` to split at the **last** dash (source is always at end).
- `GET /api/news?topic=TEXT`: expanded fetch (up to 20 items, both Bing + Google, deduped by title, sorted by pubDate). Used by topic drill-down modal.
- News grouped by topic in UI: `brief-news-group-header` with `data-topic` → click opens `/api/news` modal.

## Calendar Deep-Link
- `?view=day&date=YYYY-MM-DD` sets `calView` and `cursor` on load.
- **Must sync segmented buttons** on init: `document.querySelectorAll('.segmented button').forEach(b => b.classList.toggle('active', b.dataset.view === calView))` — HTML defaults to Month active.
- When deep-linking to day view, don't `setDate(1)` on cursor.

## Other Patterns
- **Saves:** `POST /api/saves` → `fetchSaveMeta()` server-side (YouTube oEmbed, else Open Graph). Auto-detects type.
- **Recurring events:** Personal = `recurrence_type` field, on-demand generation. Outlook = RRULE from ICS, DST-safe via `local_start` + IANA tz.
- **Outlook sync:** Cron `0 */6 * * *`. ICS → `outlook_events` → instances at query time.
- **AI Chat:** `chat` mode (create tasks/events) + `transcript` mode (extract from meeting notes). Tasks/events/notes injected into system prompt.
- **Settings page:** Tag-input UI (`makeTagInput()`). Saves comma-separated via `PUT /api/brief/settings` (now includes `weatherZip`).
- **Cherry-pick workflow:** Feature branch `claude/thirsty-poitras` → cherry-pick commits to `main` for Pages deploy.

## Applied Learning
- Google News RSS blocks CF Worker IPs; use Bing RSS with Google fallback.
- Yahoo Finance v7 `/quote` needs crumb/cookie; use v8 `/chart/{symbol}`.
- Yahoo Finance v8 `interval=1d` returns `CLOSED` marketState during hours; use `interval=1m&range=1d`.
- ESPN returns score `"0"` for pre-game; use `statusState` (pre/in/post) to detect unstarted games.
- ESPN live game state: use `status.type.shortDetail` for formatted string ("Q3 - 5:22", "Top 3rd", "76'").
- Don't use `cf: { cacheTtl }` on external fetches — caches failures; also causes stale market state.
- **Bump SW `CACHE` version on every frontend JS/CSS deploy — including hotfixes.** Forgetting causes stale JS served from SW cache; hard refresh works but regular refresh doesn't.
- SW `respondWith` must not reject — causes ERR_FAILED; clone response before async cache write.
- Sports team filter: all words in user's term must appear in team name (not reverse).
- Brief timezone: pass `?date=` from client; don't hardcode LA tz in worker.
- Buttons rendered inside `innerHTML` don't exist at page load; use event delegation on `document`.
- Branches diverge from main; always merge main before building new features.
- Nominatim, zippopotam.us, wttr.in — unreliable from CF Workers (may block CF IPs). Use Open-Meteo geocoding API for ZIP→lat/lon (same domain as weather, guaranteed accessible).
- `splitTitleSource` regex: use greedy `(.*)` to split at last dash for source extraction; non-greedy `(.*?)` incorrectly splits at first dash.
- Tasks with null `due_date` crash date helpers (`split`, etc.) — always guard with `if (!d) return ''`.
- Gmail OAuth callback must be before `checkAuth` gate — Google redirects without Cerebro auth token.
- `const` declarations inside refactored functions can duplicate if old code isn't fully removed — causes `SyntaxError: Identifier already declared` that only appears on SW-cached loads (hard refresh works).
- GPS `maximumAge: Infinity` reuses any cached browser position instantly; don't use short TTLs or the brief stalls waiting for a fresh GPS fix every load.
- Brief cache: key by `cerebro_brief_v1_YYYY-MM-DD` — auto-invalidates at midnight without explicit cleanup logic.
- **Worker deploy: always `npx wrangler deploy` with no `--name` flag.** The wrangler.toml name is `cerebro-worker`, matching the `<meta name="worker-url">` in all HTML pages. Using `--name cerebro-api` or any other name deploys to a dead worker the app never calls — changes silently have no effect.
