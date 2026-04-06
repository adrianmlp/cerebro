# Cerebro

Personal productivity dashboard. Cloudflare Pages (frontend) + Worker (API) + D1 (SQLite) + Workers AI.

## Stack
- **Frontend:** Vanilla HTML/CSS/JS, no build step. Push to GitHub → auto-deploys Pages.
- **Worker:** `worker/index.js` → `npx wrangler deploy`
- **DB:** Cloudflare D1, binding `DB` (SQLite). **Never use `wrangler d1 execute`** — add migrations as `try/catch ALTER TABLE` at top of `fetch()`.
- **AI:** Workers AI, binding `AI`, model `@cf/meta/llama-3.1-8b-instruct`
- **Auth:** HMAC-signed 30-day tokens in `localStorage`. `POST /api/auth/token` exchanges password. `APP_PASSWORD` change invalidates all tokens.
- **PWA:** `manifest.json` + `sw.js`. Cache key `cerebro-vN` — **bump N on every JS/CSS deploy**. HTML = network-first; static assets = cache-first. Android share target → `save.html`.

## Pages
| File | Purpose |
|------|---------|
| `index.html` + `dashboard.js` | Dashboard: collapsible tasks chip, Daily Brief, floating chat bar (starts collapsed) |
| `tasks.html` + `tasks.js` | Tasks CRUD |
| `calendar.html` + `calendar.js` | Calendar + Outlook ICS. Deep-link: `?view=day&date=YYYY-MM-DD` |
| `notes.html` + `notes.js` | Notes (split-panel) |
| `saves.html` + `saves.js` | Bookmarks grid |
| `save.html` | PWA share target |
| `settings.html` + `settings.js` | Settings page: tag-input UI for brief tickers/teams/topics |
| `api.js` | `apiFetch()`, `toast()`, date/priority helpers |
| `nav.js` | Nav + hamburger |
| `style.css` | Deep Ocean dark theme, design tokens |
| `sw.js` | Service worker (currently `cerebro-v11`) |

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
`brief_tickers`, `brief_teams`, `brief_topics` — comma-separated. `outlook_last_sync` — ISO timestamp.

## Worker Secrets
`APP_PASSWORD`. `OUTLOOK_ICS_URL` (+ `_2`–`_10`) — Outlook ICS feeds.

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
GET             /api/brief?date=YYYY-MM-DD
GET/PUT         /api/brief/settings
GET/POST        /api/saves
PATCH/DELETE    /api/saves/:id
```

## Daily Brief
`GET /api/brief?date=YYYY-MM-DD` — client passes local date to avoid timezone issues. Fetches in parallel:
- **Stocks:** Yahoo Finance v8 `interval=1m&range=1d` per symbol. Returns `price`, `changePercent` (official `regularMarketChangePercent`), `marketState` (REGULAR/PRE/POST/CLOSED).
- **Sports:** ESPN scoreboard API. Returns `home/away`, scores (blank when `statusState=pre`), `status`, `statusState` (pre/in/post), `date`, `broadcasts[]`.
- **News:** Bing RSS (Google fallback) for `brief_topics`. Also fetches `sportsNews` using `brief_teams` as topics.
- **D1:** due tasks + today's meetings (personal + Outlook).

Response: `{ dueToday, meetings, stocks, sports, news, sportsNews, settings }`.

Brief grid: 4 stocks/row desktop → 2 mobile; 3 scores/row desktop → 1 mobile.

## Other Patterns
- **Saves:** `POST /api/saves` → `fetchSaveMeta()` server-side (YouTube oEmbed, else Open Graph). Auto-detects type.
- **Recurring events:** Personal = `recurrence_type` field, on-demand generation. Outlook = RRULE from ICS, DST-safe via `local_start` + IANA tz.
- **Outlook sync:** Cron `0 */6 * * *`. ICS → `outlook_events` → instances at query time.
- **AI Chat:** `chat` mode (create tasks/events) + `transcript` mode (extract from meeting notes). Tasks/events/notes injected into system prompt.
- **Settings page:** Tag-input UI (type + Enter to add, × to remove). Saves comma-separated to `brief_tickers/teams/topics` via `PUT /api/brief/settings`.
- **Cherry-pick workflow:** Feature branch `claude/thirsty-poitras` → cherry-pick commits to `main` for Pages deploy.

## Applied Learning
- Google News RSS blocks CF Worker IPs; use Bing RSS with Google fallback.
- Yahoo Finance v7 `/quote` needs crumb/cookie; use v8 `/chart/{symbol}`.
- Yahoo Finance v8 `interval=1d` returns `CLOSED` marketState during hours; use `interval=1m&range=1d`.
- ESPN returns score `"0"` for pre-game; use `statusState` (pre/in/post) to detect unstarted games.
- Don't use `cf: { cacheTtl }` on external fetches — caches failures; also causes stale market state.
- Bump SW `CACHE` version on every frontend JS/CSS deploy.
- SW `respondWith` must not reject — causes ERR_FAILED; clone response before async cache write.
- Sports team filter: all words in user's term must appear in team name (not reverse).
- Brief timezone: pass `?date=` from client; don't hardcode LA tz in worker.
- Buttons rendered inside `innerHTML` don't exist at page load; use event delegation on `document`.
- Branches diverge from main; always merge main before building new features.
