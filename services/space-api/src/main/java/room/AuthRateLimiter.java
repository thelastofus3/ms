package room;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;

/** Shared fixed-window admissions. Transactions commit before account/password work starts. */
@Component
public class AuthRateLimiter {
    private static final Duration WINDOW = Duration.ofMinutes(15);
    private static final int INSERT_RETRIES = 8;
    private record Bucket(String scope, String hash, int limit) {}
    private record Window(UUID id, Instant end, int count) {}

    public static final class LoginAdmission {
        private final Bucket client;
        private final Bucket username;
        private final UUID clientWindow;
        private final UUID usernameWindow;
        private boolean released;

        private LoginAdmission(Bucket client, Bucket username, UUID clientWindow, UUID usernameWindow) {
            this.client = client;
            this.username = username;
            this.clientWindow = clientWindow;
            this.usernameWindow = usernameWindow;
        }
    }

    private final JdbcTemplate db;
    private final TransactionTemplate transactions;

    public AuthRateLimiter(JdbcTemplate db, PlatformTransactionManager manager) {
        this.db = db;
        transactions = new TransactionTemplate(manager);
        transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transactions.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
    }

    public LoginAdmission admitLogin(String clientAddress, String username) {
        // This order is used for admission and success, including newly inserted rows.
        var client = bucket("login_client", clientAddress, 30);
        var user = bucket("login_username", username, 10);
        return retryInsert(() -> transactions.execute(tx -> {
            var clientWindow = lockOrCreate(client);
            var usernameWindow = lockOrCreate(user);
            var now = databaseNow();
            var blockingUntil = blockingUntil(now, client, clientWindow, user, usernameWindow);
            if (blockingUntil != null) throw rejected("login", now, blockingUntil);
            clientWindow = increment(client, clientWindow, now);
            usernameWindow = increment(user, usernameWindow, now);
            return new LoginAdmission(client, user, clientWindow.id(), usernameWindow.id());
        }));
    }

    public void loginSucceeded(LoginAdmission admission, String username) {
        Objects.requireNonNull(admission);
        if (!admission.username.hash().equals(bucket("login_username", username, 10).hash()))
            throw new IllegalArgumentException("Login admission does not match username");
        synchronized (admission) {
            if (admission.released) return;
            transactions.executeWithoutResult(tx -> {
                // Lock in the same scope/key order as admission; missing or expired windows are harmless.
                lockExisting(admission.client);
                lockExisting(admission.username);
                db.update("UPDATE room_auth_rate_limits SET attempt_count=attempt_count-1 "
                                + "WHERE scope=? AND key_hash=? AND window_id=? AND attempt_count>0",
                        admission.client.scope(), admission.client.hash(), admission.clientWindow);
                db.update("UPDATE room_auth_rate_limits SET attempt_count=0 WHERE scope=? AND key_hash=? AND window_id=?",
                        admission.username.scope(), admission.username.hash(), admission.usernameWindow);
            });
            admission.released = true;
        }
    }

    public void admitRegistration(String clientAddress) {
        var client = bucket("registration_client", clientAddress, 10);
        retryInsert(() -> transactions.execute(tx -> {
            var prior = lockOrCreate(client);
            var now = databaseNow();
            if (prior.end().isAfter(now) && prior.count() >= client.limit())
                throw rejected("registration", now, prior.end());
            increment(client, prior, now);
            return null;
        }));
    }

    @Scheduled(initialDelayString = "${room.auth.maintenance.initial-delay-ms:60000}",
            fixedDelayString = "${room.auth.maintenance.delay-ms:60000}", scheduler = "authMaintenanceScheduler")
    public void cleanExpiredWindows() {
        transactions.executeWithoutResult(tx -> {
            var now = databaseNow();
            // A bounded, ordered lock set avoids evicting active rows or blocking admissions indefinitely.
            var expired = db.query("SELECT scope,key_hash FROM room_auth_rate_limits WHERE window_end<=? "
                            + "ORDER BY scope,key_hash LIMIT 1000 FOR UPDATE",
                    (row, n) -> new Bucket(row.getString("scope"), row.getString("key_hash"), 0), Timestamp.from(now));
            for (var bucket : expired)
                db.update("DELETE FROM room_auth_rate_limits WHERE scope=? AND key_hash=? AND window_end<=?",
                        bucket.scope(), bucket.hash(), Timestamp.from(now));
        });
    }

    private Bucket bucket(String scope, String identity, int limit) {
        return new Bucket(scope, AuthService.tokenHash(Objects.toString(identity, "unknown")), limit);
    }

    private Window lockExisting(Bucket bucket) {
        var rows = db.query("SELECT window_id,window_end,attempt_count FROM room_auth_rate_limits "
                        + "WHERE scope=? AND key_hash=? FOR UPDATE",
                (row, n) -> new Window(row.getObject("window_id", UUID.class), row.getTimestamp("window_end").toInstant(),
                        row.getInt("attempt_count")), bucket.scope(), bucket.hash());
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private Window lockOrCreate(Bucket bucket) {
        var prior = lockExisting(bucket);
        if (prior != null) return prior;
        var empty = new Window(UUID.randomUUID(), databaseNow(), 0);
        // A first-row race aborts this entire transaction. Retry happens only after rollback.
        db.update("INSERT INTO room_auth_rate_limits(scope,key_hash,attempt_count,window_id,window_end) VALUES(?,?,0,?,?)",
                bucket.scope(), bucket.hash(), empty.id(), Timestamp.from(empty.end()));
        return empty;
    }

    private Window increment(Bucket bucket, Window prior, Instant now) {
        var next = prior.end().isAfter(now)
                ? new Window(prior.id(), prior.end(), prior.count() + 1)
                : new Window(UUID.randomUUID(), now.plus(WINDOW), 1);
        db.update("UPDATE room_auth_rate_limits SET attempt_count=?,window_id=?,window_end=? WHERE scope=? AND key_hash=?",
                next.count(), next.id(), Timestamp.from(next.end()), bucket.scope(), bucket.hash());
        return next;
    }

    private Instant databaseNow() {
        return Objects.requireNonNull(db.queryForObject("SELECT CURRENT_TIMESTAMP", Timestamp.class)).toInstant();
    }

    private Instant blockingUntil(Instant now, Bucket client, Window clientWindow, Bucket user, Window userWindow) {
        Instant end = null;
        if (clientWindow.end().isAfter(now) && clientWindow.count() >= client.limit()) end = clientWindow.end();
        if (userWindow.end().isAfter(now) && userWindow.count() >= user.limit()
                && (end == null || userWindow.end().isAfter(end))) end = userWindow.end();
        return end;
    }

    private ResponseStatusException rejected(String operation, Instant now, Instant until) {
        long seconds = Math.max(1, (Duration.between(now, until).toMillis() + 999) / 1000);
        var headers = new HttpHeaders();
        headers.set(HttpHeaders.RETRY_AFTER, Long.toString(seconds));
        return new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Too many " + operation + " attempts. Try again later.") {
            @Override public HttpHeaders getHeaders() { return headers; }
        };
    }

    private <T> T retryInsert(Supplier<T> operation) {
        for (int attempt = 0; ; attempt++) {
            try { return operation.get(); }
            catch (DuplicateKeyException conflict) {
                if (attempt >= INSERT_RETRIES - 1) throw conflict;
            }
        }
    }
}
