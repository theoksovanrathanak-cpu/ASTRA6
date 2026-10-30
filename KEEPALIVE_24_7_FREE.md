# Keep Free Plan 24/7 Hosting - No Sleep

## Current Setup (Free Plan)
- Render free sleeps after 15 min inactivity → cold start 30-60s
- To keep 24/7 on free, need external pings every <15 min

## Solution 1: Self-Ping (Already Implemented ✅)
- `main.py` has background thread `keep_alive_ping()` 
- Pings `https://astra6.onrender.com/health` and `/api/status` every 10 min
- Keeps service alive as long as at least 1 instance running
- Works but Render may still sleep if no incoming HTTP (self-ping from same instance may not count as external traffic)

## Solution 2: UptimeRobot (Recommended for Free 24/7) - FREE
1. Go to https://uptimerobot.com → Sign Up Free
2. Add New Monitor:
   - Type: HTTP(s)
   - Friendly Name: ASTRA6
   - URL: https://astra6.onrender.com/health
   - Monitoring Interval: 5 minutes
   - Alert Contacts: your email
3. Save → UptimeRobot will ping every 5 min → keeps Render free alive 24/7
4. Also add second monitor for https://astra6.onrender.com/api/status

## Solution 3: GitHub Actions Cron (Free Backup)
- Create `.github/workflows/keepalive.yml` that pings every 10 min via GitHub Actions
- Free 2000 min/month, enough for 24/7

## Solution 4: Cron-Job.org (Free)
- https://cron-job.org → Create cron that GET https://astra6.onrender.com/health every 10 min

## Current Implementation
- `keep_alive_ping()` thread started on app startup
- `/api/keepalive` endpoint returns 24/7 status
- `/health` endpoint for uptime monitors

## Check if 24/7 Working
- GET https://astra6.onrender.com/api/keepalive → should return ok
- GET https://astra6.onrender.com/health → should return ok
- Logs should show "🔄 Keepalive ping ... status 200" every 10 min
- UptimeRobot dashboard shows 100% uptime

## If Still Sleeps
- Free plan may still sleep despite pings if Render detects low traffic
- Best free workaround: UptimeRobot + self-ping combined
- True 24/7 guaranteed only on paid $7/mo Starter plan
