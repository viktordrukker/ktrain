# Admin Operations

## Authorization Model
- Admin PIN is removed.
- Admin access requires authenticated user role (`ADMIN` or `OWNER`) from Google sign-in or email/password sign-in.
- Owner-only operations remain protected by RBAC.

## Language Packs (Modal Workflow)
In Settings/Admin, use **Language Packs** modal to:
- Browse/filter packs by language/type/status
- Generate OpenAI-assisted draft packs (requires user OpenAI key)
- Edit items and publish/unpublish
- Import/export JSON

Pack status:
- `DRAFT`: review/edit only
- `PUBLISHED`: visible in game language selector
- `ARCHIVED`: hidden from gameplay

## Generation Prerequisites
- Admin user must configure personal OpenAI key.
- Prompt is safety-constrained for child-safe outputs.
- Generation creates `DRAFT` packs only.

## Service Settings (Admin-only)
- DB runtime controls
- SMTP settings
- Send test email
- Google auth settings (enabled/client ID/client secret)
- Password reset email flow depends on SMTP health.
- Config status panel shows `READY`/`DEGRADED`/`SETUP_REQUIRED` and remediation hints.

Secrets policy:
- SMTP password encrypted at rest.
- Google client secret encrypted at rest.
- Secrets never returned by API responses.

## Setup vs Remediation
- Setup mode is triggered only by missing/invalid required config (`database`, `adminUser`).
- Optional failures (SMTP, Google, OpenAI, RU packs) do not force setup; they appear as `DEGRADED`.
- Admin can remediate optional failures anytime in Settings/Admin without reinit.

## Live Activity
Start screen shows live activity:
- users playing now
- authorized vs guest count

Admin endpoints include mode breakdown for activity:
- `GET /api/admin/live/stats`

## Crash Diagnostics
- Open Settings -> Admin -> Crash diagnostics.
- Review recent crash events with version, phase, error summary, and stack.
- Acknowledge resolved incidents to clear unresolved warning banners.
- API equivalents:
  - `GET /api/admin/crashes`
  - `GET /api/admin/crashes/:id`
  - `POST /api/admin/crashes/:id/ack`

## Russian Pack Troubleshooting
- If Russian does not appear in Start settings, open Language Packs modal and confirm `ru` packs are `PUBLISHED` for `level2`, `level3`, and `sentence_words`.
- Use `POST /api/admin/seed-defaults` or restart app to trigger built-in EN/RU re-seeding for missing published packs.
- Verify pipeline with admin diagnostics endpoint:
  - `GET /api/admin/language/diagnostics?language=ru&level=2`
