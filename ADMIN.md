# Admin Operations

## Authorization Model
- Admin PIN is removed.
- Admin access requires authenticated user role (`ADMIN` or `OWNER`).
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

Secrets policy:
- SMTP password encrypted at rest.
- Secrets never returned by API responses.

## Live Activity
Start screen shows live activity:
- users playing now
- authorized vs guest count

Admin endpoints include mode breakdown for activity:
- `GET /api/admin/live/stats`
