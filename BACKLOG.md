# Backlog

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

## Bookmarklet (Desktop Save)
Quick-save from desktop without opening Cerebro. Companion to the mobile share target.

**Behavior:**
1. Drag bookmarklet link to bookmarks bar once
2. Click it on any page → small overlay appears pre-filled with URL + page title
3. Optional tag input → hit Enter → calls `POST /api/saves` with Bearer token
4. Overlay auto-dismisses after 1.5s

**Implementation:**
- `GET /api/bookmarklet` returns the JS snippet (so it always uses the current worker URL)
- Overlay injected into the page DOM, removed on dismiss
- Token read from `localStorage` (same key as api.js: `cerebro_token`)

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

## ✅ Completed

### Save for Later
Grid page (`saves.html`) with URL, title, description, thumbnail, tags, type, read/unread. Server-side metadata fetch (OG tags + YouTube oEmbed). Filters by type/tag/unread/search. Mobile share target via PWA.

### Trusted Device Tokens
HMAC-SHA256 signed tokens stored in `localStorage`. 30-day expiry. `POST /api/auth/token` exchanges password for token. `checkAuth` accepts `Bearer` or `Basic`. Changing `APP_PASSWORD` invalidates all devices.

### PWA / Android Install
`manifest.json` with share_target, shortcuts, 192+512 PNG icons. Service worker (`sw.js`) with network-first HTML + cache-first static assets. Installed via Chrome "Add to Home Screen."

### Notes Split Panel
Split-panel layout: note list sidebar left, full-height editor right. Mobile: full-width list, tap to open editor overlay.
