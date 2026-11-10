# Repton Boarding Demo

Fictional boarding demo for feedback. No school records or credentials.

Render free service: build `npm ci && npm run build && node --test *.test.mjs`; start `node hosted-demo.mjs`; health `/healthz`; Node 22.22.0.

The hosted service uses Render’s HTTPS address and auto-enters fictional Avery. Testers share Avery and Robin. Notes reset on process restart; do not enter personal information. No school integrations are contacted. Free hosting wakes on request after inactivity.

Local: `npm ci && npm run demo`. Production school Worker authentication is separate and unchanged.
