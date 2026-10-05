CREATE TABLE room_tracking_cameras (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES room_jobs(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
 scene_version integer NOT NULL,
 revision uuid NOT NULL,
 image_width integer NOT NULL CHECK (image_width BETWEEN 32 AND 16384),
 image_height integer NOT NULL CHECK (image_height BETWEEN 32 AND 16384),
 points jsonb NOT NULL,
 homography jsonb NOT NULL,
 fit_error_meters double precision NOT NULL CHECK (fit_error_meters >= 0 AND fit_error_meters <= 0.20),
 active_stream uuid,
 last_sequence bigint NOT NULL DEFAULT -1,
 last_captured_at bigint,
 snapshot jsonb NOT NULL DEFAULT '[]',
 snapshot_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (job_id, scene_version) REFERENCES room_versions(job_id, version)
);
CREATE INDEX room_tracking_cameras_job ON room_tracking_cameras(job_id, created_at);
