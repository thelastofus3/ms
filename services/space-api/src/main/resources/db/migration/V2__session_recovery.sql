CREATE TABLE room_session_recovery (
 token_hash char(64) PRIMARY KEY,
 owner text NOT NULL,
 job_id uuid NOT NULL REFERENCES room_jobs(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
