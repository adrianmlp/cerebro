# Backlog

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
