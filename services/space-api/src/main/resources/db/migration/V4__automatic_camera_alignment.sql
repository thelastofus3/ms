ALTER TABLE room_tracking_cameras ADD COLUMN geometry jsonb;

CREATE TABLE room_camera_alignments (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES room_jobs(id) ON DELETE CASCADE,
 camera_id uuid REFERENCES room_tracking_cameras(id),
 camera_revision uuid,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
 scene_version integer NOT NULL,
 image_width integer NOT NULL CHECK (image_width BETWEEN 32 AND 4096),
 image_height integer NOT NULL CHECK (image_height BETWEEN 32 AND 4096),
 frame_key text NOT NULL,
 manifest_key text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','READY','FAILED','APPLIED','CANCELLED')),
 stage text NOT NULL DEFAULT 'queued',
 error text,
 result jsonb,
 lease_token uuid,
 lease_until timestamptz,
 frame_deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 applied_camera_id uuid REFERENCES room_tracking_cameras(id),
 FOREIGN KEY (job_id,scene_version) REFERENCES room_versions(job_id,version),
 CHECK ((camera_id IS NULL) = (camera_revision IS NULL))
);
CREATE UNIQUE INDEX room_camera_alignments_one_live ON room_camera_alignments(job_id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX room_camera_alignments_claim ON room_camera_alignments(state,created_at);
