# Backlog

---

## Projects
Add a Projects layer above tasks for managing 4–6 concurrent workstreams.

**Features:**
- `projects` table: id, name, status, goal, color, created_at
- Tasks get a `project_id` field (migration via try/catch ALTER TABLE)
- Projects page: list view with open task count + last activity per project
- Tasks page: filter/group by project
- Dashboard card: project status overview
- AI chat gains project context — "catch me up on Project X"

---

## Garmin Integration
Show daily activity and workouts in the Daily Brief.

**Approach:** Hit `connect.garmin.com` directly with credentials stored as Worker secrets (`GARMIN_EMAIL`, `GARMIN_PASSWORD`). Same method used by most self-hosted Garmin tools.

**Data to show in Daily Brief:**
- Steps today vs. goal
- Last logged workout (type, duration, distance)

**Notes:**
- Official Garmin Health API requires partner approval — not practical for personal use
- Garmin Connect undocumented API requires session cookie auth (fetch login → extract cookie → use for data calls)
- May need to refresh session periodically; store cookie in D1 settings table

---

## Daily AI Morning Briefing
Proactive AI-written daily summary generated each morning by the cron worker.

**Features:**
- Runs at a morning hour (e.g. `0 8 * * *`) via wrangler cron trigger
- AI synthesizes: due tasks, today's meetings, open follow-ups, and a prioritization suggestion
- Stored in D1 (`daily_briefs` table: date, content, created_at)
- Shown as a highlighted section at the top of the dashboard — no need to open chat
- Replaces or augments current "Updated X:XX AM" subtitle

---

## Follow-up Tracker
Lightweight commitments tracking — things owed to others or waiting on.

**Features:**
- `followups` table: id, title, person, direction (owe/waiting), due_date, project_id, status, created_at
- Dashboard card showing open follow-ups
- Auto-extraction from meeting transcript analysis (detect "I'll follow up", "I'll send", "waiting on X")
- Manual quick-add from dashboard
- Snooze / mark done inline
- Linked to project optionally

---

## Goals + Weekly Review
Structured goals system with a weekly AI-driven reflection.

**Features:**
- `goals` table: id, title, timeframe (WEEKLY/MONTHLY/QUARTERLY), status, linked tasks, created_at
- Goals page or section within Notes/Dashboard
- Weekly review: every Sunday, AI pulls last week's completed tasks + missed items and prompts 3 reflection questions
- Review answers saved as a dated note automatically
- Goals shown on dashboard with progress indicator

---

## Dashboard Redesign (Mockups)
Three mockup options built — need design decision before implementing.

**Mockups:** `mockup-a.html`, `mockup-b.html`, `mockup-c.html` in project root.

**Concepts:**
- **A — Focus Mode:** Tasks/Schedule collapsed to chips. Brief full-width. Chat floats as a bottom bar expanding upward.
- **B — Sidebar Chat:** Chat fixed as a right-side panel. Brief scrolls on the left.
- **C — Command Bar:** Bento grid brief. Chat as a minimal floating command bar (Spotlight-style).

**Shared across all:** Larger text, collapsed tasks/schedule, brief as primary content, persistent chat.

---

## Save for Later (Read-it-Later / Bookmarks)
Quick-save articles, links, and YouTube videos with tags. Max 1–2 clicks from any device.

**Save mechanisms (both together):**
- **Bookmarklet** (desktop): drag once to bookmarks bar → click on any page → popup pre-filled with URL + page title → add tags → Save. One click after setup.
- **PWA Share Target** (mobile): add `manifest.json` to make Cerebro installable → appears in native iOS/Android share sheet → one tap saves URL + title automatically.

**DB:**
```sql
saves(id, url, title, description, thumbnail, type[article|video|link], tags, notes, is_read, created_at)
```

**Worker (server-side metadata fetch to avoid CORS):**
- `POST /api/saves` — save a URL; Worker fetches Open Graph tags (title, description, og:image) server-side
- YouTube URLs: fetch oEmbed (`youtube.com/oembed`) for title + thumbnail automatically
- `GET /api/saves` — list saves (filter by tag, type, is_read)
- `PATCH /api/saves/:id` — update tags, notes, mark read
- `DELETE /api/saves/:id`

**Frontend:**
- `saves.html` — grid/list view with tag filters, read/unread toggle, search
- Card shows thumbnail (if available), title, domain, tags, save date
- Click card → opens URL in new tab + marks as read
- Bookmarklet code served from `GET /bookmarklet` — one JS snippet to copy/drag

**Bookmarklet behavior:**
1. Click bookmarklet on any page
2. Small overlay appears (bottom-right corner) pre-filled with current URL + `document.title`
3. Optional tag input (comma-separated)
4. Hit Enter or click Save — calls `POST /api/saves` with Basic auth header from sessionStorage
5. Overlay auto-dismisses after 1.5s

**PWA Share Target:**
- Add `manifest.json` with `share_target` pointing to `/save?url={url}&title={title}`
- Worker or Pages function handles the redirect → saves + shows confirmation

---

## Trusted Device Tokens
Store a signed HMAC token in localStorage so trusted devices stay logged in for 30 days without re-entering the password.

**Plan:** `C:\Users\admau\.claude\plans\glimmering-crafting-meadow.md`

**Summary of changes:**
- `worker/index.js` — add `signToken`/`verifyToken`, make `checkAuth` async, add `POST /api/auth/token`
- `api.js` — swap sessionStorage password for localStorage token; prompt only on first visit or expiry

**Trade-offs:**
- No per-device revocation (changing `APP_PASSWORD` invalidates all devices)
- Token visible in DevTools like any localStorage value
- 30-day expiry hardcoded (easy to change)
