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


def connect():
    return psycopg.connect(DATABASE, row_factory=dict_row, connect_timeout=10)


def claim():
    with connect() as db:
        db.execute("""UPDATE room_jobs SET state=CASE WHEN cancel_requested THEN 'CANCELLED' ELSE 'FAILED' END,
            error=CASE WHEN cancel_requested THEN NULL ELSE 'Worker lease expired after three attempts' END,
            lease_token=NULL, lease_until=NULL, updated_at=now()
            WHERE state='RUNNING' AND lease_until<now() AND (cancel_requested OR attempts>=3)""")
        row = db.execute("""SELECT j.*, u.media FROM room_jobs j JOIN room_uploads u ON u.id=j.upload_id
            WHERE (j.state='QUEUED' OR (j.state='RUNNING' AND j.lease_until<now())) AND NOT j.cancel_requested
            AND j.attempts<3 ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED""").fetchone()
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


def fail(job, message, diagnostics):
    with connect() as db:
        db.execute("""UPDATE room_jobs SET state=CASE WHEN cancel_requested THEN 'CANCELLED' ELSE 'FAILED' END,
            error=CASE WHEN cancel_requested THEN NULL ELSE %s END, diagnostics=%s,
            lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=%s AND lease_token=%s AND state='RUNNING'""", (message[:1000], Jsonb(diagnostics), job["id"], job["lease_token"]))
