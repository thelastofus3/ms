CREATE TABLE room_uploads (
 id uuid PRIMARY KEY, owner text NOT NULL, media jsonb NOT NULL,
 sealed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE room_jobs (
 id uuid PRIMARY KEY, owner text NOT NULL, upload_id uuid NOT NULL REFERENCES room_uploads(id),
 name text NOT NULL, profile text NOT NULL, idempotency_key text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED', stage text NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
 cancel_requested boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, error text, diagnostics jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner, idempotency_key), CHECK (progress BETWEEN 0 AND 100)
);
CREATE INDEX room_jobs_claim ON room_jobs(state, created_at);
CREATE TABLE room_versions (
 job_id uuid NOT NULL REFERENCES room_jobs(id), version integer NOT NULL,
 manifest_key text NOT NULL, ready boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id, version)
);
