ALTER TABLE room_uploads ADD COLUMN kind text NOT NULL DEFAULT 'capture'
    CHECK (kind IN ('capture','splat'));
ALTER TABLE room_jobs ADD COLUMN kind text NOT NULL DEFAULT 'capture'
    CHECK (kind IN ('capture','splat'));
CREATE INDEX room_jobs_kind_claim ON room_jobs(kind,state,created_at);
