-- The production desk row can never be deleted, so its audit rows stay undeletable
-- (audit_log_no_delete only lets rows go once their sandbox row is gone).
-- Someone with direct database access could still DROP the triggers; the hash chain and an
-- exported audit CSV (its last hash) are what detect that.
CREATE TRIGGER sandboxes_keep_main BEFORE DELETE ON sandboxes
WHEN OLD.id = 'main'
BEGIN
  SELECT RAISE(ABORT, 'the production desk cannot be deleted');
END;
