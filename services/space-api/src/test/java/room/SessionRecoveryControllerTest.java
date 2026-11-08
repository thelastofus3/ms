package room;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.server.ResponseStatusException;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class SessionRecoveryControllerTest {
    private static final String LEGACY = "L".repeat(43);
    private static final String TOKEN = "T".repeat(43);

    @Test void recoveryClaimsLegacyJobsAndUploadsAtomicallyWithoutIdempotencyCollisions() {
        var f = fixture(); var owner = f.admin();
        var oldJob = addJob(f, LEGACY, "same-key");
        addJob(f, owner.id(), "same-key");
        f.db.update("INSERT INTO room_session_recovery(token_hash,owner,job_id,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))", AuthService.tokenHash(TOKEN), LEGACY, oldJob);
        var req = new MockHttpServletRequest(); req.setAttribute("roomAccount", owner);
        var result = new SessionRecoveryController(f.db, f.transactions, org.mockito.Mockito.mock(RoomQuotaService.class)).recover(new SessionRecoveryController.Recovery(TOKEN), req, new MockHttpServletResponse());
        assertEquals(oldJob.toString(), result.get("jobId").toString());
        assertEquals(0, f.db.queryForObject("SELECT count(*) FROM room_jobs WHERE owner=?", Integer.class, LEGACY));
        assertEquals(0, f.db.queryForObject("SELECT count(*) FROM room_uploads WHERE owner=?", Integer.class, LEGACY));
        assertEquals(2, f.db.queryForObject("SELECT count(*) FROM room_jobs WHERE owner=?", Integer.class, owner.id()));
        assertEquals(410, assertThrows(ResponseStatusException.class, () -> new SessionRecoveryController(f.db, f.transactions, org.mockito.Mockito.mock(RoomQuotaService.class))
                .recover(new SessionRecoveryController.Recovery(TOKEN), req, new MockHttpServletResponse())).getStatusCode().value());
    }

    @Test void recoveryCannotTransferAnAccountOwnerOrConsumeItsLink() {
        var f = fixture(); var owner = f.admin();
        var other = UUID.randomUUID().toString(); var job = addJob(f, other, "other-job");
        f.db.update("INSERT INTO room_session_recovery(token_hash,owner,job_id,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))", AuthService.tokenHash(TOKEN), other, job);
        var req = new MockHttpServletRequest(); req.setAttribute("roomAccount", owner);
        assertEquals(403, assertThrows(ResponseStatusException.class, () -> new SessionRecoveryController(f.db, f.transactions, org.mockito.Mockito.mock(RoomQuotaService.class))
                .recover(new SessionRecoveryController.Recovery(TOKEN), req, new MockHttpServletResponse())).getStatusCode().value());
        assertEquals(other, f.db.queryForObject("SELECT owner FROM room_jobs WHERE id=?", String.class, job));
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_session_recovery", Integer.class));
    }

    @Test void recoveryRequiresAuthenticationBeforeConsumingAValidLink() {
        var f = fixture(); var job = addJob(f, LEGACY, "legacy-job");
        f.db.update("INSERT INTO room_session_recovery(token_hash,owner,job_id,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))", AuthService.tokenHash(TOKEN), LEGACY, job);
        assertEquals(401, assertThrows(ResponseStatusException.class, () -> new SessionRecoveryController(f.db, f.transactions, org.mockito.Mockito.mock(RoomQuotaService.class))
                .recover(new SessionRecoveryController.Recovery(TOKEN), new MockHttpServletRequest(), new MockHttpServletResponse())).getStatusCode().value());
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_session_recovery", Integer.class));
    }

    @Test void failedUploadTransferRollsBackJobRekeysAndKeepsTheRecoveryLink() {
        var f = fixture(); var owner = f.admin(); var job = addJob(f, LEGACY, "original-key");
        f.db.update("INSERT INTO room_session_recovery(token_hash,owner,job_id,expires_at) VALUES (?,?,?,DATEADD('HOUR',1,CURRENT_TIMESTAMP))", AuthService.tokenHash(TOKEN), LEGACY, job);
        f.db.execute("ALTER TABLE room_uploads ADD CONSTRAINT block_transfer CHECK (owner='" + LEGACY + "')");
        var req = new MockHttpServletRequest(); req.setAttribute("roomAccount", owner);
        assertThrows(org.springframework.dao.DataIntegrityViolationException.class, () -> new SessionRecoveryController(f.db, f.transactions, org.mockito.Mockito.mock(RoomQuotaService.class))
                .recover(new SessionRecoveryController.Recovery(TOKEN), req, new MockHttpServletResponse()));
        assertEquals(LEGACY, f.db.queryForObject("SELECT owner FROM room_jobs WHERE id=?", String.class, job));
        assertEquals("original-key", f.db.queryForObject("SELECT idempotency_key FROM room_jobs WHERE id=?", String.class, job));
        assertEquals(LEGACY, f.db.queryForObject("SELECT owner FROM room_uploads", String.class));
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_session_recovery", Integer.class));
    }

    private AuthTestDatabase fixture() {
        var f = new AuthTestDatabase();
        f.db.execute("CREATE TABLE room_uploads(id UUID PRIMARY KEY, owner TEXT NOT NULL)");
        f.db.execute("CREATE TABLE room_jobs(id UUID PRIMARY KEY, owner TEXT NOT NULL, upload_id UUID NOT NULL REFERENCES room_uploads(id), idempotency_key TEXT NOT NULL, UNIQUE(owner,idempotency_key))");
        f.db.execute("CREATE TABLE room_session_recovery(token_hash CHAR(64) PRIMARY KEY, owner TEXT NOT NULL, job_id UUID NOT NULL REFERENCES room_jobs(id), expires_at TIMESTAMP WITH TIME ZONE NOT NULL)");
        return f;
    }
    private UUID addJob(AuthTestDatabase f, String owner, String key) {
        var upload = UUID.randomUUID(); var job = UUID.randomUUID();
        f.db.update("INSERT INTO room_uploads(id,owner) VALUES (?,?)", upload, owner);
        f.db.update("INSERT INTO room_jobs(id,owner,upload_id,idempotency_key) VALUES (?,?,?,?)", job, owner, upload, key);
        return job;
    }
}
