"""Durable jobs. PostgreSQL row locks and lease ownership fence stale workers."""

import hashlib
import json
import time
import uuid

from sqlalchemy import (
    Column,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    and_,
    create_engine,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.schema import CreateSchema


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, url):
        self.engine = create_engine(url, pool_pre_ping=True)
        self.postgres = self.engine.dialect.name == "postgresql"
        self.metadata = MetaData(schema="avatar" if self.postgres else None)
        self.jobs = Table(
            "jobs",
            self.metadata,
            Column("id", String, primary_key=True),
            Column("owner", String, nullable=False),
            Column("avatar_id", String, nullable=False),
            Column("version", Integer, nullable=False),
            Column("profile", Text, nullable=False),
            Column("request_hash", String, nullable=False),
            Column("idempotency_key", String),
            Column("status", String, nullable=False),
            Column("created_at", Float, nullable=False),
            Column("lease_owner", String),
            Column("lease_until", Float),
            Column("error", Text),
            Column("result_path", Text),
            Column("approved", Integer, nullable=False, default=0),
            UniqueConstraint("owner", "idempotency_key"),
        )
        self.references = Table(
            "references",
            self.metadata,
            Column("id", String, primary_key=True),
            Column("owner", String, nullable=False),
            Column("path", Text, nullable=False),
        )
        with self.engine.begin() as conn:
            if self.postgres:
                conn.execute(CreateSchema("avatar", if_not_exists=True))
            self.metadata.create_all(conn)

    def create(self, owner, profile, key=None, avatar_id=None):
        payload = json.dumps(profile, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256((payload + "|" + str(avatar_id)).encode()).hexdigest()

        def existing():
            with self.engine.connect() as conn:
                row = (
                    conn.execute(
                        select(self.jobs).where(
                            self.jobs.c.owner == owner,
                            self.jobs.c.idempotency_key == key,
                        )
                    )
                    .mappings()
                    .first()
                )
            if row and row["request_hash"] != digest:
                raise Conflict("Idempotency key already used for a different profile")
            return dict(row) if row else None

        if key:
            found = existing()
            if found:
                return found
        job = dict(
            id=str(uuid.uuid4()),
            owner=owner,
            avatar_id=str(uuid.uuid4()),
            version=1,
            profile=payload,
            request_hash=digest,
            idempotency_key=key,
            status="QUEUED",
            created_at=time.time(),
            approved=0,
        )
        try:
            with self.engine.begin() as conn:
                if avatar_id:
                    lock = (
                        select(self.jobs.c.id)
                        .where(
                            self.jobs.c.avatar_id == avatar_id,
                            self.jobs.c.owner == owner,
                        )
                        .order_by(self.jobs.c.version)
                        .limit(1)
                    )
                    if self.postgres:
                        lock = lock.with_for_update()
                    if not conn.execute(lock).first():
                        raise LookupError("Avatar not found")
                    latest = conn.execute(
                        select(func.max(self.jobs.c.version)).where(
                            self.jobs.c.avatar_id == avatar_id
                        )
                    ).scalar_one()
                    job.update(avatar_id=avatar_id, version=latest + 1)
                conn.execute(self.jobs.insert().values(**job))
        except IntegrityError:
            if key:
                found = existing()
                if found:
                    return found
            raise
        return self.get(job["id"], owner)

    def get(self, job_id, owner=None):
        query = select(self.jobs).where(self.jobs.c.id == job_id)
        if owner is not None:
            query = query.where(self.jobs.c.owner == owner)
        with self.engine.connect() as conn:
            row = conn.execute(query).mappings().first()
        return dict(row) if row else None

    def version(self, avatar_id, version, owner):
        with self.engine.connect() as conn:
            row = (
                conn.execute(
                    select(self.jobs).where(
                        self.jobs.c.avatar_id == avatar_id,
                        self.jobs.c.version == version,
                        self.jobs.c.owner == owner,
                        self.jobs.c.status == "SUCCEEDED",
                    )
                )
                .mappings()
                .first()
            )
        return dict(row) if row else None

    def cancel(self, job_id, owner):
        with self.engine.begin() as conn:
            conn.execute(
                update(self.jobs)
                .where(
                    self.jobs.c.id == job_id,
                    self.jobs.c.owner == owner,
                    self.jobs.c.status.in_(["QUEUED", "RUNNING"]),
                )
                .values(status="CANCELLED", lease_owner=None, lease_until=None)
            )
        return self.get(job_id, owner)

    def claim(self, worker, now=None, lease_seconds=30):
        now = time.time() if now is None else now
        eligible = or_(
            self.jobs.c.status == "QUEUED",
            and_(self.jobs.c.status == "RUNNING", self.jobs.c.lease_until < now),
        )
        with self.engine.begin() as conn:
            query = (
                select(self.jobs)
                .where(eligible)
                .order_by(self.jobs.c.created_at)
                .limit(1)
            )
            if self.postgres:
                query = query.with_for_update(skip_locked=True)
            row = conn.execute(query).mappings().first()
            if not row:
                return None
            result = conn.execute(
                update(self.jobs)
                .where(self.jobs.c.id == row["id"], eligible)
                .values(
                    status="RUNNING",
                    lease_owner=worker,
                    lease_until=now + lease_seconds,
                    error=None,
                )
            )
            if result.rowcount != 1:
                return None
            return {
                **dict(row),
                "status": "RUNNING",
                "lease_owner": worker,
                "lease_until": now + lease_seconds,
            }

    def heartbeat(self, job_id, worker):
        with self.engine.begin() as conn:
            return (
                conn.execute(
                    update(self.jobs)
                    .where(
                        self.jobs.c.id == job_id,
                        self.jobs.c.lease_owner == worker,
                        self.jobs.c.status == "RUNNING",
                    )
                    .values(lease_until=time.time() + 30)
                ).rowcount
                == 1
            )

    def finish(self, job_id, worker, status, *, error=None, result_path=None):
        if status not in ("SUCCEEDED", "FAILED"):
            raise ValueError("Invalid terminal state")
        if status == "SUCCEEDED" and not result_path:
            raise ValueError("Validated result path required")
        with self.engine.begin() as conn:
            return (
                conn.execute(
                    update(self.jobs)
                    .where(
                        self.jobs.c.id == job_id,
                        self.jobs.c.lease_owner == worker,
                        self.jobs.c.status == "RUNNING",
                    )
                    .values(
                        status=status,
                        error=error,
                        result_path=result_path,
                        lease_owner=None,
                        lease_until=None,
                    )
                ).rowcount
                == 1
            )

    def approve(self, job_id, owner):
        with self.engine.begin() as conn:
            conn.execute(
                update(self.jobs)
                .where(
                    self.jobs.c.id == job_id,
                    self.jobs.c.owner == owner,
                    self.jobs.c.status == "SUCCEEDED",
                )
                .values(approved=1)
            )

    def add_reference(self, owner, path, reference_id):
        with self.engine.begin() as conn:
            conn.execute(
                self.references.insert().values(
                    id=reference_id, owner=owner, path=str(path)
                )
            )

    def reference(self, reference_id, owner):
        with self.engine.connect() as conn:
            row = (
                conn.execute(
                    select(self.references).where(
                        self.references.c.id == reference_id,
                        self.references.c.owner == owner,
                    )
                )
                .mappings()
                .first()
            )
        return dict(row) if row else None
