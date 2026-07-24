-- Agency Overview: active/inactive flag for clients.
-- Clients default active=true so nothing existing changes on deploy.
-- Marking a client inactive hides it from /admin/overview without
-- deleting its data or affecting its own dashboard/login.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_clients_active ON clients (active);
