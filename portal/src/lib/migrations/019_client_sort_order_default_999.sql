-- Flip the sort_order default from 0 to 999. With 0 as the default, typing
-- "1" on a client made it sort AFTER every untouched client (which still
-- sat at 0) instead of to the top. 999 means untouched clients sort last,
-- so assigning 1, 2, 3... to the clients you care about puts them first
-- immediately, without having to renumber everyone else.

ALTER TABLE clients ALTER COLUMN sort_order SET DEFAULT 999;
UPDATE clients SET sort_order = 999 WHERE sort_order = 0;
