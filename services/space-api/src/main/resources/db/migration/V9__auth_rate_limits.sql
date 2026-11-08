CREATE TABLE room_auth_rate_limits (
 scope varchar(32) NOT NULL CHECK (scope IN ('login_client', 'login_username', 'registration_client')),
 key_hash char(64) NOT NULL,
 attempt_count integer NOT NULL CHECK (attempt_count >= 0),
 window_id uuid NOT NULL,
 window_end timestamptz NOT NULL,
 PRIMARY KEY (scope, key_hash)
);
CREATE INDEX room_auth_rate_limits_expiry ON room_auth_rate_limits(window_end);
