ALTER TABLE room_accounts
 ADD COLUMN token_version bigint NOT NULL DEFAULT 0 CHECK (token_version >= 0);

DROP TABLE room_sessions;
