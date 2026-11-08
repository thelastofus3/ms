import threading
import uuid
import json
import time
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from .settings import DATABASE, SCRATCH


class Stopped(RuntimeError):
    pass


class StorageQuotaExceeded(RuntimeError):
    pass


def reserve_outputs(job, objects):
    """Commit exact output allocations before the caller can write any object."""
    with connect() as db:
        row = db.execute("SELECT room_reserve_job_outputs(%s,%s,%s) AS result",
                         (job["id"], job["lease_token"], Jsonb(objects))).fetchone()
    result = row["result"] if row else None
    if result == "LEASE_LOST":
        raise Stopped("Output reservation lease lost or cancelled")
    if result == "QUOTA_EXCEEDED":
        raise StorageQuotaExceeded("Account storage quota exceeded before saving results")
    if result != "RESERVED":
        raise RuntimeError("Output storage reservation could not complete")


def confirm_output(job, key, size):
    """Record a known successful write without lowering its reserved ceiling."""
    if size < 1 or not key.startswith(f"outputs/{job['id']}/{job['lease_token']}/"):
        raise ValueError("Invalid confirmed attempt output")
    with connect() as db:
        changed = db.execute("""UPDATE room_storage_allocations SET confirmed_bytes=%s,updated_at=CURRENT_TIMESTAMP
            WHERE object_key=%s AND resource_kind='job' AND resource_id=%s AND released_at IS NULL
            AND maximum_bytes>=%s AND owner=(SELECT owner FROM room_jobs WHERE id=%s)""",
            (size, key, job["id"], size, job["id"])).rowcount
        if changed != 1:
            raise RuntimeError("Output write lacks its admitted storage allocation")


def connect():
    return psycopg.connect(DATABASE, row_factory=dict_row, connect_timeout=10)


def claim():
    with connect() as db:
        db.execute("""UPDATE room_jobs SET state=CASE WHEN cancel_requested THEN 'CANCELLED' ELSE 'FAILED' END,
            error=CASE WHEN cancel_requested THEN NULL ELSE 'Worker lease expired after three attempts' END,
            lease_token=NULL, lease_until=NULL, updated_at=now()
            WHERE kind='capture' AND state='RUNNING' AND lease_until<now() AND (cancel_requested OR attempts>=3)""")
        row = db.execute("""SELECT j.*, u.media FROM room_jobs j JOIN room_uploads u ON u.id=j.upload_id
            WHERE (j.state='QUEUED' OR (j.state='RUNNING' AND j.lease_until<now())) AND NOT j.cancel_requested
            AND j.kind='capture' AND j.attempts<3
            AND u.owner=j.owner AND u.kind='capture' AND u.sealed AND u.inputs_pinned
            AND EXISTS(SELECT 1 FROM room_quota_owners q WHERE q.owner=j.owner AND q.initialized)
            ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED""").fetchone()
        if row is None:
            return None
        token = uuid.uuid4()
        db.execute("""UPDATE room_jobs SET state='RUNNING',stage='preprocessing',progress=0,error=NULL,
            attempts=attempts+1,lease_token=%s,lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=%s""", (token, row["id"]))
        row["lease_token"] = token
        return row


class Lease:
    def __init__(self, job):
        self.job = job
        self.stop = threading.Event()
        self.done = threading.Event()
        self.reason = "Worker lease lost or cancelled"
        self.current_stage = "preprocessing"
        self.stage_started = time.time()
        self.last_progress = 0
        self.progress_lock = threading.Lock()
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.done.set()
        self.thread.join(timeout=15)

    def _heartbeat(self):
        while not self.done.is_set():
            try:
                with connect() as db:
                    row = db.execute("""UPDATE room_jobs SET lease_until=now()+interval '120 seconds'
                        WHERE id=%s AND lease_token=%s AND state='RUNNING' AND lease_until>now() AND NOT cancel_requested
                        RETURNING id""", (self.job["id"], self.job["lease_token"])).fetchone()
                    if not row:
                        self.stop.set()
                        return
            except Exception:
                self.stop.set()
                return
            self.done.wait(20)

    def check(self):
        if self.stop.is_set():
            raise Stopped(self.reason)

    def stage(self, name, progress):
        self.check()
        self.current_stage = name
        self.stage_started = time.time()
        with connect() as db:
            row = db.execute("""UPDATE room_jobs SET stage=%s,progress=%s,updated_at=now()
                WHERE id=%s AND lease_token=%s AND lease_until>now() AND NOT cancel_requested AND state='RUNNING'
                RETURNING id""", (name, progress, self.job["id"], self.job["lease_token"])).fetchone()
            if not row:
                self.stop.set()
                self.check()
        self.progress(name.replace("_", " ").capitalize(), "Starting this step", force=True)

    def progress(self, label, activity, completed=None, total=None, unit=None, force=False):
        """Publish bounded work counters without a DB round trip for every frame or upload chunk."""
        self.check()
        with self.progress_lock:
            now = time.time()
            if not force and now - self.last_progress < 1:
                return
            self.last_progress = now
            data = {"stage": self.current_stage, "label": label, "activity": activity,
                    "startedAt": self.stage_started, "updatedAt": now, "percent": None}
            if completed is not None and total and total > 0:
                data.update(completed=min(completed, total), total=total, unit=unit,
                            percent=round(min(100, 100 * completed / total), 1))
            root = SCRATCH / str(self.job["id"]) / str(self.job["lease_token"])
            root.mkdir(parents=True, exist_ok=True)
            temporary = root / "live-progress.tmp"
            temporary.write_text(json.dumps(data))
            temporary.replace(root / "live-progress.json")

    def publish(self, manifest_key, diagnostics):
        self.check()
        with connect() as db:
            row = db.execute("""SELECT * FROM room_jobs WHERE id=%s AND lease_token=%s
                AND lease_until>now() AND NOT cancel_requested AND state='RUNNING' FOR UPDATE""",
                (self.job["id"], self.job["lease_token"])).fetchone()
            if not row:
                raise Stopped("Publication lease is no longer valid")
            db.execute("INSERT INTO room_versions(job_id,version,manifest_key,ready) VALUES(%s,1,%s,false)", (self.job["id"], manifest_key))
            db.execute("""UPDATE room_jobs SET state='NEEDS_CALIBRATION',stage='complete',progress=100,
                diagnostics=%s,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=%s""", (Jsonb(diagnostics), self.job["id"]))
            self.done.set()


def fail(job, message, diagnostics, *, interrupted=False):
    # A lost lease leaves the attempt for claim() to recover. Only an explicit
    # cancellation may settle an interrupted attempt while its lease is valid.
    with connect() as db:
        db.execute("""UPDATE room_jobs SET state=CASE WHEN cancel_requested THEN 'CANCELLED' ELSE 'FAILED' END,
            error=CASE WHEN cancel_requested THEN NULL ELSE %s END, diagnostics=%s,
            lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=%s AND lease_token=%s AND state='RUNNING' AND lease_until>now()
            AND (NOT %s OR cancel_requested)""",
            (message[:1000], Jsonb(diagnostics), job["id"], job["lease_token"], interrupted))
