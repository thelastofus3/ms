CREATE TABLE room_quota_defaults (
 id integer PRIMARY KEY CHECK (id=1),
 storage_limit_bytes bigint NOT NULL CHECK (storage_limit_bytes>0),
 pending_upload_limit integer NOT NULL CHECK (pending_upload_limit>0),
 active_job_limit integer NOT NULL CHECK (active_job_limit>0)
);
INSERT INTO room_quota_defaults VALUES(1,21474836480,3,2);
CREATE TABLE room_quota_owners (
 owner text PRIMARY KEY,
 storage_limit_bytes bigint CHECK (storage_limit_bytes>0),
 pending_upload_limit integer CHECK (pending_upload_limit>0),
 active_job_limit integer CHECK (active_job_limit>0),
 initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE room_storage_allocations (
 object_key text PRIMARY KEY CHECK (length(object_key) BETWEEN 1 AND 1024),
 owner text NOT NULL REFERENCES room_quota_owners(owner),
 resource_kind text NOT NULL CHECK (resource_kind IN ('upload','job','alignment','calibration')),
 resource_id uuid NOT NULL,
 maximum_bytes bigint NOT NULL CHECK (maximum_bytes>=0),
 confirmed_bytes bigint CHECK (confirmed_bytes>=0 AND confirmed_bytes<=maximum_bytes),
 released_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_storage_allocations_owner ON room_storage_allocations(owner) WHERE released_at IS NULL;
CREATE INDEX room_storage_allocations_resource ON room_storage_allocations(resource_kind,resource_id);
ALTER TABLE room_uploads ADD COLUMN api_upload boolean NOT NULL DEFAULT false;
ALTER TABLE room_uploads ADD COLUMN expires_at timestamptz;
ALTER TABLE room_uploads ADD COLUMN discarded_at timestamptz;
ALTER TABLE room_uploads ADD COLUMN cleaned_at timestamptz;
ALTER TABLE room_uploads ADD COLUMN cleanup_retry_at timestamptz;
CREATE INDEX room_uploads_account_pending ON room_uploads(owner) WHERE NOT sealed AND discarded_at IS NULL;
CREATE INDEX room_jobs_account_active ON room_jobs(owner) WHERE state IN ('QUEUED','RUNNING');
