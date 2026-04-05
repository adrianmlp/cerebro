# Cerebro

Personal productivity dashboard. Cloudflare Pages (frontend) + Worker (API) + D1 (SQLite) + Workers AI.

## Stack
- **Frontend:** Vanilla HTML/CSS/JS, no build step. Deploy: push to GitHub → auto-deploys Pages.
- **Worker:** `worker/index.js`. Deploy: `npx wrangler deploy`
- **DB:** Cloudflare D1, binding `DB`, SQLite
- **AI:** Cloudflare Workers AI, binding `AI`, model `@cf/meta/llama-3.1-8b-instruct`
- **Auth:** HTTP Basic Auth, no username, password = `APP_PASSWORD` Worker secret

## Pages
- `index.html` + `dashboard.js` — Dashboard (Tasks Today, Schedule, Daily Brief, AI Chat)
- `tasks.html` + `tasks.js` — Tasks CRUD
- `calendar.html` + `calendar.js` — Calendar + Outlook ICS sync
- `notes.html` + `notes.js` — Notes
- `api.js` — Shared `apiFetch()` helper + auth (sessionStorage password)
- `nav.js` — Nav bar
- `style.css` — Dark theme, design tokens

## DB Schema
```sql
tasks(id, title, description, priority[URGENT|HIGH|NORMAL|BACKLOG], completed, due_date, created_at, updated_at)
calendar_events(id, title, description, start_time, end_time, color, is_important, location, recurrence_type[NONE|DAILY|WEEKLY|BIWEEKLY|MONTHLY], recurrence_end, parent_event_id, exception_date, is_deleted, created_at, updated_at)
notes(id, title, content, event_id, tags, created_at, updated_at)
outlook_events(uid, title, description, organizer, location, start_time, end_time, is_all_day, recurrence_rule, recurrence_exceptions, event_tzid, local_start, synced_at)
hidden_outlook_events(uid, title, hidden_at)
settings(key TEXT PK, value TEXT)
```

## Settings Keys
- `brief_tickers` — comma-separated stock symbols
- `brief_teams` — comma-separated sports teams
- `brief_topics` — comma-separated news topics
- `outlook_last_sync` — ISO timestamp

## Worker Secrets
- `APP_PASSWORD` — login password
- `OUTLOOK_ICS_URL` (+ `_2` through `_10`) — Outlook ICS feed URLs

## Key Patterns

### D1 Migrations
**Never use `wrangler d1 execute`.** Add migrations as `try/catch` `ALTER TABLE` statements at the top of the Worker `fetch()` handler.

### API Routes (all require Basic Auth)
```
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
GET             /api/brief
GET/PUT         /api/brief/settings
```

### Daily Brief
`GET /api/brief` fetches in parallel: Yahoo Finance v8 chart API (stocks), ESPN API (sports), Bing News RSS w/ Google fallback (news), D1 (due tasks + today's meetings).

### Recurring Events
- Personal: `recurrence_type` field, instances generated on-demand
- Outlook: RRULE parsed from ICS, DST-correct via stored `local_start` + IANA tz

### Outlook Sync
Cron: `0 */6 * * *`. Parses ICS from `OUTLOOK_ICS_URL` secrets, stores base events in `outlook_events`, generates instances at query time.

### AI Chat
Two modes: `chat` (conversational, can create tasks/events) and `transcript` (extract tasks/events from meeting notes). Context includes recent tasks, events, notes injected into system prompt.

## Applied Learning
When something fails repeatedly, when Adrian has to re-explain, or when a workaround is found for a platform/tool limitation, add a one-line bullet here. Keep each bullet under 15 words. No explanations. Only add things that will save time in future sessions.

- Google News RSS blocks Cloudflare Worker IPs on some edge regions; use Bing RSS instead.
- Yahoo Finance v7 `/quote` requires crumb/cookie; use v8 `/chart/{symbol}` per-symbol instead.
- Don't use `cf: { cacheTtl }` on external fetches that may fail — caches the failure.
