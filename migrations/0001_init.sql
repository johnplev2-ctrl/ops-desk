-- Ops desk schema. Every row carries sandbox_id; every query filters on it.
-- In demo mode a sandbox is one visitor's private copy. In production there is one sandbox: 'main'.
-- Times are epoch milliseconds (UTC).

CREATE TABLE sandboxes (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  template     TEXT NOT NULL
);
CREATE INDEX sandboxes_by_created ON sandboxes (created_at);

-- The production desk exists from the start, so its audit rows are undeletable from day one.
-- Demo cookies can never name it (sandbox ids are 22 random base64url characters) and the purge skips it.
INSERT INTO sandboxes (id, created_at, template) VALUES ('main', 0, 'production');

CREATE TABLE requests (
  sandbox_id     TEXT NOT NULL,
  ref            INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('repair', 'purchase', 'task')),
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  details        TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 500),
  location       TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 60),
  cost_cents     INTEGER CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 10000000),
  due_at         INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'done')),
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  decided_at     INTEGER,
  decided_by     TEXT,
  decision_note  TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 280),
  completed_at   INTEGER,
  completed_by   TEXT,
  proof_photo    TEXT CHECK (proof_photo IS NULL OR proof_photo IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6')),
  PRIMARY KEY (sandbox_id, ref)
);
CREATE INDEX requests_by_status ON requests (sandbox_id, status, due_at);

CREATE TABLE checklist_items (
  sandbox_id  TEXT NOT NULL,
  ref         INTEGER NOT NULL,
  pos         INTEGER NOT NULL CHECK (pos BETWEEN 1 AND 12),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  done_at     INTEGER,
  done_by     TEXT,
  PRIMARY KEY (sandbox_id, ref, pos)
);

-- Append-only, hash-chained audit log.
-- hash = SHA-256 over the canonical entry including prev_hash (see src/audit.ts).
CREATE TABLE audit_log (
  sandbox_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'system')),
  action      TEXT NOT NULL,
  ref         INTEGER,
  detail      TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 400),
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL CHECK (length(hash) = 64),
  PRIMARY KEY (sandbox_id, seq)
);

-- New entries must extend the chain: next seq, previous entry's hash.
CREATE TRIGGER audit_log_extend_only BEFORE INSERT ON audit_log
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit_log WHERE sandbox_id = NEW.sandbox_id), 0) + 1
  OR NEW.prev_hash <> COALESCE((SELECT hash FROM audit_log WHERE sandbox_id = NEW.sandbox_id AND seq = NEW.seq - 1), 'GENESIS')
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: entry does not extend the chain');
END;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: updates are not allowed');
END;

-- Rows can only be removed after their whole sandbox is gone (demo retention purge).
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
WHEN EXISTS (SELECT 1 FROM sandboxes WHERE id = OLD.sandbox_id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: deletes are not allowed');
END;

-- In-app alert feed plus the outbound message each alert would send.
CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  audience    TEXT NOT NULL CHECK (audience IN ('owner', 'manager', 'staff')),
  ref         INTEGER,
  text        TEXT NOT NULL CHECK (length(text) <= 200),
  read_at     INTEGER,
  delivery    TEXT NOT NULL DEFAULT 'stub',
  payload     TEXT NOT NULL DEFAULT '' CHECK (length(payload) <= 1000)
);
CREATE INDEX alerts_by_audience ON alerts (sandbox_id, audience, id);

-- Demo abuse guard: how many sandboxes were created today, per hashed IP and in total.
CREATE TABLE mint_counters (
  bucket  TEXT PRIMARY KEY,
  day     INTEGER NOT NULL,
  n       INTEGER NOT NULL
);
