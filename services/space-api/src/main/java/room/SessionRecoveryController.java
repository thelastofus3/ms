package room;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.TreeSet;

@RestController
@RequestMapping("/v1/rooms/session")
public class SessionRecoveryController {
    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final RoomQuotaService quota;
    public SessionRecoveryController(JdbcTemplate db, PlatformTransactionManager manager,RoomQuotaService quota) {
        this.db = db;
        this.transactions = new TransactionTemplate(manager);
        this.quota=quota;
    }
    public record Recovery(@NotNull @Pattern(regexp="[A-Za-z0-9_-]{43}") String token) {}

    // Links can only be issued by a local operator with database access.
    @PostMapping("/recover")
    public Map<String,Object> recover(@Valid @RequestBody Recovery body, HttpServletRequest request, HttpServletResponse response) {
        var account = AuthService.current(request);
        return transactions.execute(tx -> {
            db.queryForObject("SELECT id FROM room_auth_guard WHERE id=1 FOR UPDATE", Integer.class);
            if (db.queryForObject("SELECT count(*) FROM room_accounts WHERE id=? AND disabled=false", Integer.class, UUID.fromString(account.id())) != 1)
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
            var rows = db.queryForList("SELECT owner,job_id FROM room_session_recovery WHERE token_hash=? AND expires_at>? FOR UPDATE", AuthService.tokenHash(body.token()), Timestamp.from(Instant.now()));
            if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.GONE, "Recovery link has expired or was already used. Generate a new link with scripts/recover-room-session.ps1.");
            var saved = rows.getFirst();
            var legacy = saved.get("owner").toString();
            if (!AuthService.validToken(legacy)) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Recovery can only claim legacy resources");
            for(String owner:new TreeSet<>(java.util.List.of(legacy,account.id()))) quota.lockOwner(owner);
            db.queryForList("SELECT id FROM room_uploads WHERE owner=? ORDER BY id FOR UPDATE",legacy);
            var target = db.queryForList("SELECT owner FROM room_jobs WHERE id=? FOR UPDATE", saved.get("job_id"));
            if (target.isEmpty() || !target.getFirst().get("owner").equals(legacy))
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Recovery can only claim legacy resources");
            quota.transferLocked(legacy,account.id());
            var jobs = db.queryForList("SELECT id FROM room_jobs WHERE owner=? ORDER BY id FOR UPDATE", legacy);
            for (var job : jobs) {
                String key;
                do { key = "legacy-claim:" + job.get("id") + ":" + UUID.randomUUID(); }
                while (db.queryForObject("SELECT count(*) FROM room_jobs WHERE owner=? AND idempotency_key=?", Integer.class, account.id(), key) != 0);
                db.update("UPDATE room_jobs SET owner=?,idempotency_key=? WHERE id=? AND owner=?", account.id(), key, job.get("id"), legacy);
            }
            db.update("UPDATE room_uploads SET owner=? WHERE owner=?", account.id(), legacy);
            db.update("DELETE FROM room_session_recovery WHERE owner=?", legacy);
            return Map.<String,Object>of("jobId", saved.get("job_id"));
        });
    }
}
