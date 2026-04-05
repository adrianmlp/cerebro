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
