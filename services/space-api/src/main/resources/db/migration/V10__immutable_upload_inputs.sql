ALTER TABLE room_uploads ADD COLUMN inputs_pinned boolean NOT NULL DEFAULT false;
ALTER TABLE room_uploads ADD CONSTRAINT room_upload_pinned_is_sealed CHECK (NOT inputs_pinned OR sealed);
CREATE INDEX room_uploads_legacy_unpinned ON room_uploads(created_at,id) WHERE sealed AND NOT inputs_pinned;
