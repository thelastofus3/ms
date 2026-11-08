package room;

import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class PlyImportRepositoryTest {
    JdbcTemplate db;
    PlyImportRepository repository;

    @BeforeEach void setUp() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:ply-" + UUID.randomUUID() + ";MODE=PostgreSQL;DB_CLOSE_DELAY=-1");
        db = new JdbcTemplate(source);
        db.execute("CREATE TABLE room_uploads(id uuid PRIMARY KEY,owner text,kind text,media text,sealed boolean,inputs_pinned boolean)");
        db.execute("CREATE TABLE room_jobs(id uuid PRIMARY KEY,owner text,upload_id uuid,kind text,state text DEFAULT 'QUEUED'," +
                "stage text DEFAULT 'queued',progress integer DEFAULT 0,cancel_requested boolean DEFAULT false," +
                "attempts integer DEFAULT 0,lease_token uuid,lease_until timestamp with time zone,error text,diagnostics jsonb DEFAULT '{}'," +
                "created_at timestamp with time zone DEFAULT now(),updated_at timestamp with time zone DEFAULT now())");
        db.execute("CREATE TABLE room_versions(job_id uuid,version integer,manifest_key text,ready boolean,PRIMARY KEY(job_id,version))");
        db.execute("CREATE TABLE room_quota_owners(owner text PRIMARY KEY,initialized boolean)");
        db.update("INSERT INTO room_quota_owners VALUES('owner',true)");
        repository = new PlyImportRepository(db, new DataSourceTransactionManager(source));
    }

    UUID queue(String kind) {
        UUID id = UUID.randomUUID(), upload = UUID.randomUUID();
        db.update("INSERT INTO room_uploads VALUES(?,'owner',?,'[{\"name\":\"room.ply\",\"key\":\"sealed-inputs/test\",\"size\":400}]',true,true)", upload, kind);
        db.update("INSERT INTO room_jobs(id,owner,upload_id,kind) VALUES(?,'owner',?,?)", id, upload, kind);
        return id;
    }

    String state(UUID id) { return db.queryForObject("SELECT state FROM room_jobs WHERE id=?", String.class, id); }

    @Test void claimsOnlySealedSplatJobsAndIncrementsAttempts() {
        UUID capture = queue("capture"), splat = queue("splat");
        var job = repository.claim();
        assertEquals(splat, job.id());
        assertEquals(1, job.attempts());
        assertEquals("RUNNING", state(splat));
        assertEquals("QUEUED", state(capture));
        assertNull(repository.claim());
        assertTrue(repository.heartbeat(job));
    }

    @Test void unsealedOrMismatchedUploadsCannotBeImported() {
        UUID splat = queue("splat");
        db.update("UPDATE room_uploads SET sealed=false");
        assertNull(repository.claim());
        db.update("UPDATE room_uploads SET sealed=true,kind='capture'");
        assertNull(repository.claim());
        assertEquals("QUEUED", state(splat));
    }
    @Test void completedLegacyUploadCannotBeClaimedUntilPinned() {
        UUID splat=queue("splat");
        db.update("UPDATE room_uploads SET inputs_pinned=false");
        assertNull(repository.claim());
        assertEquals(0,db.queryForObject("SELECT attempts FROM room_jobs WHERE id=?",Integer.class,splat));
        db.update("UPDATE room_uploads SET inputs_pinned=true");
        assertEquals(splat,repository.claim().id());
    }
    @Test void queuedLegacyJobWaitsUntilOwnerStorageInventoryIsInitialized() {
        UUID splat=queue("splat");
        db.update("UPDATE room_quota_owners SET initialized=false");
        assertNull(repository.claim());
        assertEquals(0,db.queryForObject("SELECT attempts FROM room_jobs WHERE id=?",Integer.class,splat));
        db.update("UPDATE room_quota_owners SET initialized=true");
        assertEquals(splat,repository.claim().id());
    }

    @Test void recoversExpiredAttemptsAndFailsAfterThree() {
        UUID splat = queue("splat");
        var first = repository.claim();
        db.update("UPDATE room_jobs SET lease_until=now()-interval '1' second");
        var second = repository.claim();
        assertEquals(2, second.attempts());
        assertNotEquals(first.leaseToken(), second.leaseToken());
        assertFalse(repository.heartbeat(first));
        assertFalse(repository.publish(first, "stale/manifest.json", "{}"));
        db.update("UPDATE room_jobs SET lease_until=now()-interval '1' second");
        assertEquals(3, repository.claim().attempts());
        db.update("UPDATE room_jobs SET lease_until=now()-interval '1' second");
        assertNull(repository.claim());
        assertEquals("FAILED", state(splat));
        assertEquals(0, db.queryForObject("SELECT count(*) FROM room_versions", Integer.class));
    }

    @Test void cancellationFencesHeartbeatStagesAndPublication() {
        UUID splat = queue("splat");
        var job = repository.claim();
        db.update("UPDATE room_jobs SET cancel_requested=true WHERE id=?", splat);
        assertFalse(repository.heartbeat(job));
        assertFalse(repository.stage(job, "publication", 90));
        assertFalse(repository.publish(job, "cancelled/manifest.json", "{}"));
        repository.fail(job, "interrupted", false, true);
        assertEquals("CANCELLED", state(splat));
        assertNull(db.queryForObject("SELECT error FROM room_jobs WHERE id=?", String.class, splat));
        assertEquals(0, db.queryForObject("SELECT count(*) FROM room_versions", Integer.class));
    }

    @Test void successPublishesOneVersionAndClearsLeaseAtomically() {
        UUID splat = queue("splat");
        var job = repository.claim();
        assertTrue(repository.publish(job, "outputs/immutable/manifest.json", "{\"vertices\":1}"));
        assertEquals("IMPORTED", state(splat));
        assertEquals("imported", db.queryForObject("SELECT stage FROM room_jobs WHERE id=?", String.class, splat));
        assertEquals(100, db.queryForObject("SELECT progress FROM room_jobs WHERE id=?", Integer.class, splat));
        assertNull(db.queryForObject("SELECT lease_token FROM room_jobs WHERE id=?", UUID.class, splat));
        assertEquals("outputs/immutable/manifest.json", db.queryForObject("SELECT manifest_key FROM room_versions", String.class));
        assertFalse(db.queryForObject("SELECT ready FROM room_versions", Boolean.class));
        assertFalse(repository.publish(job, "duplicate/manifest.json", "{}"));
    }

    @Test void transientErrorsRetryAtMostThreeTimesAndInvalidPlyFailsImmediately() {
        UUID splat = queue("splat");
        for (int attempt = 1; attempt <= 3; attempt++) {
            var job = repository.claim();
            repository.fail(job, "temporary storage error", false, false);
            assertEquals(attempt < 3 ? "QUEUED" : "FAILED", state(splat));
        }
        assertNull(repository.claim());
        UUID invalid = queue("splat");
        repository.fail(repository.claim(), "Unsupported PLY", true, false);
        assertEquals("FAILED", state(invalid));
    }

    @Test void lostOrExpiredLeaseCannotFailOrPublishReplacementAttempt() {
        UUID splat = queue("splat");
        var old = repository.claim();
        db.update("UPDATE room_jobs SET lease_until=now()-interval '1' second WHERE id=?", splat);
        repository.fail(old, "late failure", false, false);
        assertEquals("RUNNING", state(splat));
        var replacement = repository.claim();
        repository.fail(old, "stale failure", true, false);
        assertFalse(repository.publish(old, "stale/manifest.json", "{}"));
        assertTrue(repository.heartbeat(replacement));
        assertEquals("RUNNING", state(splat));
    }

    @Test void anotherImporterSkipsAnAlreadyLockedQueuedJob() throws Exception {
        UUID locked = queue("splat"), available = queue("splat");
        db.update("UPDATE room_jobs SET created_at=now()-interval '2' second WHERE id=?", locked);
        try (var connection = db.getDataSource().getConnection()) {
            connection.setAutoCommit(false);
            try (var lock = connection.prepareStatement("SELECT id FROM room_jobs WHERE id=? FOR UPDATE")) {
                lock.setObject(1, locked);
                try (var row = lock.executeQuery()) { assertTrue(row.next()); }
            }
            assertEquals(available, repository.claim().id());
            assertEquals("QUEUED", state(locked));
            assertEquals("RUNNING", state(available));
            connection.rollback();
        }
    }
}
