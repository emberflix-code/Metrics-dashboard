-- Marketer module: which booking calendar a location's GHL bookings come
-- from, mirrored from the marketing team's "Alloy booking calendars" Google
-- Sheet (Location | Calendar Name | Platform | Calendar Link) by
-- lib/bookingCalendars.ts. Informational only — bookings are still counted
-- from GHL contact tags (lib/ghl.ts fetchGhlBookings).
-- Record only — src/lib/db.ts runs the same statements idempotently at boot.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_calendar_name TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_platform TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_calendar_link TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_calendar_synced_at TIMESTAMPTZ;
