# Cerebro

A personal memory augmentation web app. Capture tasks, notes, bookmarks, and calendar events using plain natural language — AI parses and categorizes everything automatically.

**Live app:** `cerebro-b9i.pages.dev` (Cloudflare Pages)
**Worker API:** `https://cerebro-worker.mlpdev.workers.dev`
**GitHub:** `adrianmlp/cerebro`

---

## What It Does

Type anything into the capture bar and Cerebro figures out what it is:

| What you type | Becomes |
|---|---|
| "Call dentist Tuesday at 2pm" | Task with due date |
| "Team standup every Monday 9am" | Calendar event |
| "https://example.com — great article" | Bookmark with AI summary |
| "Idea: add leaderboard to NGP" | Note with tags |

Then ask questions in plain English: *"What did I want to follow up on this week?"* — AI searches your entries and answers conversationally.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Hosting | Cloudflare Pages (auto-deploys on push to `main`) |
| API | Cloudflare Worker (`worker/index.js`) |
| Database | Cloudflare D1 SQLite — binding: `DB`, database: `cerebro-db` |
| AI | Cloudflare Workers AI — Llama 3.1 8B (free, no API key needed) |
| Auth | HTTP Basic Auth via Worker — browser remembers credentials |
| Frontend | Vanilla HTML + CSS + JS — no build step |

---

## File Map

```
cerebro/
  index.html        # Main SPA — all views in one page
  style.css         # Dark theme UI
  app.js            # Frontend logic — capture, views, search, calendar
  worker/
    index.js        # All /api/* routes + AI parsing + auth
  wrangler.toml     # Cloudflare config — Worker name, D1 binding, AI binding
  _routes.json      # Routes /api/* to the Worker
  README.md         # This file
```

---

## Views

- **Inbox** — all entries, newest first (default view)
- **Tasks** — filterable by open / done, sorted by due date
- **Notes** — all note-type entries
- **Bookmarks** — URL entries with AI summaries
- **Calendar** — month grid with tasks and events plotted by due date
- **Search bar** (top right) — plain-English Q&A over all your entries

---

## API Endpoints

All routes require HTTP Basic Auth.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/capture` | Submit raw text → AI parses → saves entry |
| GET | `/api/entries` | List entries (`?type=`, `?status=`, `?from=`, `?to=`) |
| PATCH | `/api/entries/:id` | Update fields or status |
| DELETE | `/api/entries/:id` | Delete entry |
| GET | `/api/search?q=` | AI-powered Q&A search over entries |
| GET | `/api/calendar?year=&month=` | Entries with due dates in a given month |

---

## Database Schema

```sql
entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT,    -- 'task' | 'note' | 'bookmark' | 'event'
  title       TEXT,
  body        TEXT,
  url         TEXT,
  due_date    TEXT,    -- YYYY-MM-DD
  tags        TEXT,    -- comma-separated
  status      TEXT,    -- 'open' | 'done' | 'archived'
  ai_summary  TEXT,
  raw_input   TEXT,
  created_at  TEXT,
  updated_at  TEXT
)
```

---

## Deployment

### Static frontend (auto)
Push to `main` → Cloudflare Pages auto-deploys within ~60 seconds.

### Worker (manual, after any `worker/index.js` change)
```bash
cd /c/Users/admau/Claude/cerebro
npx wrangler deploy
```

### Secrets (set once)
```bash
npx wrangler secret put APP_PASSWORD   # your login password
```

---

## Backlog

### Phase 2
- [ ] Inline due date editing on entry cards
- [ ] Bookmark view with full URL display

### Phase 3
- [ ] Smart search / Ask interface (Claude-powered Q&A)
- [ ] Daily digest route (`/digest`) — overdue tasks + today's events

### Future
- [ ] Custom domain
- [ ] Mobile-optimized layout
- [ ] Browser extension for one-click bookmark capture
- [ ] Recurring events support
- [ ] Tags filter / browse by tag

---

*Last updated: April 2026 — Phase 1 shipped (capture, inbox, tasks, notes, bookmarks, calendar)*
