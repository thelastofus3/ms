CREATE TABLE room_auth_guard (
 id integer PRIMARY KEY CHECK (id = 1)
);
INSERT INTO room_auth_guard (id) VALUES (1);

CREATE TABLE room_accounts (
 id uuid PRIMARY KEY,
 username varchar(64) NOT NULL UNIQUE,
 password_hash varchar(512) NOT NULL,
 role varchar(32) NOT NULL CHECK (role IN ('ADMIN', 'RECONSTRUCTOR', 'SPLAT_UPLOADER')),
 disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_sessions (
 token_hash char(64) PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES room_accounts(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_sessions_account ON room_sessions(account_id);
CREATE INDEX room_sessions_expiry ON room_sessions(expires_at);
