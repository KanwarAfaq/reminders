# Kanwar Reminders

Standalone PWA + Android app: reminders (alarm, vibration, push, LINE card) and a daily work-hours log (school, class, duration, totals between dates).

## Setup (Vercel)
1. Storage → connect **Upstash Redis** (can reuse the existing store).
2. Env vars: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
3. Open the app, set a PIN, enable notifications in Settings.

## Reliable timing
* **Android APK**: reminders are scheduled as native alarms on the phone, so they ring on time even offline.
* **LINE / push when the phone is off**: create a free per-minute job at cron-job.org that calls
  `https://<your-domain>/api/hub?op=tick` every minute.
