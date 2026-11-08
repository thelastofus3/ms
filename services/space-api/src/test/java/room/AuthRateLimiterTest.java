package room;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

class AuthRateLimiterTest {
    protected JdbcTemplate db;
    protected DataSourceTransactionManager manager;

    protected AuthRateLimiter fixture() {
        var f = new AuthTestDatabase();
        db = f.db;
        manager = f.transactions;
        return replica();
    }

    private AuthRateLimiter replica() { return new AuthRateLimiter(db, manager); }

    @Test void concurrentReplicasAdmitExactlyThirtyClientAttemptsAcrossDistinctUsernames() throws Exception {
        var first = fixture();
        var second = replica();
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(16)) {
            var results = new ArrayList<Future<Boolean>>();
            for (int i = 0; i < 64; i++) {
                String username = "target-" + i;
                var limiter = i % 2 == 0 ? first : second;
                results.add(workers.submit(() -> {
                    start.await();
                    try { limiter.admitLogin("198.51.100.20", username); return true; }
                    catch (ResponseStatusException rejected) { assertEquals(429, rejected.getStatusCode().value()); return false; }
                }));
            }
            start.countDown();
            int admitted = 0;
            for (var result : results) if (result.get(30, TimeUnit.SECONDS)) admitted++;
            assertEquals(30, admitted);
        }
        // Rejected transactions must not leave their username rows/counters behind.
        assertEquals(30, db.queryForObject("SELECT count(*) FROM room_auth_rate_limits WHERE scope='login_username'", Integer.class));
    }

    @Test void concurrentReplicasAdmitExactlyTenRegistrationAttempts() throws Exception {
        var first = fixture();
        var second = replica();
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(12)) {
            var results = new ArrayList<Future<Boolean>>();
            for (int i = 0; i < 32; i++) {
                var limiter = i % 2 == 0 ? first : second;
                results.add(workers.submit(() -> {
                    start.await();
                    try { limiter.admitRegistration("198.51.100.21"); return true; }
                    catch (ResponseStatusException rejected) { assertEquals(429, rejected.getStatusCode().value()); return false; }
                }));
            }
            start.countDown();
            int admitted = 0;
            for (var result : results) if (result.get(30, TimeUnit.SECONDS)) admitted++;
            assertEquals(10, admitted);
        }
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> replica().admitRegistration("198.51.100.21")).getStatusCode().value());
    }

    @Test void staleSuccessCannotReleaseEitherReplacementWindow() {
        var limiter = fixture();
        var stale = limiter.admitLogin("198.51.100.22", "admin");
        db.update("UPDATE room_auth_rate_limits SET window_end=?", Timestamp.from(Instant.now().minusSeconds(60)));
        limiter.admitLogin("198.51.100.22", "admin");
        limiter.loginSucceeded(stale, "admin");
        for (int i = 0; i < 9; i++) limiter.admitLogin("198.51.100.22", "admin");
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> limiter.admitLogin("198.51.100.23", "admin")).getStatusCode().value());
        for (int i = 0; i < 20; i++) limiter.admitLogin("198.51.100.22", "target-" + i);
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> limiter.admitLogin("198.51.100.22", "another")).getStatusCode().value());
    }

    @Test void successReleasesOnlyItsOwnClientAdmissionAndIsIdempotent() {
        var limiter = fixture();
        for (int i = 0; i < 20; i++) limiter.admitLogin("198.51.100.24", "target-" + i);
        var successful = limiter.admitLogin("198.51.100.24", "admin");
        limiter.loginSucceeded(successful, "admin");
        limiter.loginSucceeded(successful, "admin");
        for (int i = 20; i < 30; i++) limiter.admitLogin("198.51.100.24", "target-" + i);
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> limiter.admitLogin("198.51.100.24", "admin")).getStatusCode().value());
    }

    @Test void loginSuccessClearsTheExistingUsernameFailures() {
        var limiter = fixture();
        for (int i = 0; i < 9; i++) limiter.admitLogin("198.51.100.25", "admin");
        var successful = limiter.admitLogin("198.51.100.26", "admin");
        limiter.loginSucceeded(successful, "admin");
        for (int i = 0; i < 10; i++) limiter.admitLogin("198.51.100.26", "admin");
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> limiter.admitLogin("198.51.100.27", "admin")).getStatusCode().value());
    }

    @Test void retryAfterUsesTheLongestBlockingWindowAndSurvivesApiMapping() {
        var limiter = fixture();
        for (int i = 0; i < 30; i++) limiter.admitLogin("198.51.100.28", "target-" + i);
        for (int i = 0; i < 10; i++) limiter.admitLogin("198.51.100.29", "admin");
        db.update("UPDATE room_auth_rate_limits SET window_end=? WHERE scope='login_client'",
                Timestamp.from(Instant.now().plusSeconds(60)));
        db.update("UPDATE room_auth_rate_limits SET window_end=? WHERE scope='login_username'",
                Timestamp.from(Instant.now().plusSeconds(180)));
        var rejected = assertThrows(ResponseStatusException.class,
                () -> limiter.admitLogin("198.51.100.28", "admin"));
        long seconds = Long.parseLong(new ApiErrors().status(rejected).getHeaders().getFirst("Retry-After"));
        assertTrue(seconds >= 175 && seconds <= 181, "longest blocking window: " + seconds);
    }

    @Test void admissionPersistsWhenAccountWorkRollsBack() {
        var limiter = fixture();
        var outer = new TransactionTemplate(manager);
        outer.executeWithoutResult(tx -> {
            limiter.admitRegistration("198.51.100.30");
            tx.setRollbackOnly();
        });
        for (int i = 0; i < 9; i++) replica().admitRegistration("198.51.100.30");
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> replica().admitRegistration("198.51.100.30")).getStatusCode().value());
    }

    @Test void expiredRegistrationResetsAndCleanupKeepsActiveRows() {
        var limiter = fixture();
        for (int i = 0; i < 10; i++) limiter.admitRegistration("198.51.100.31");
        db.update("UPDATE room_auth_rate_limits SET window_end=?", Timestamp.from(Instant.now().minusSeconds(60)));
        limiter.admitRegistration("198.51.100.31");
        limiter.admitLogin("198.51.100.32", "private-username");
        db.update("UPDATE room_auth_rate_limits SET window_end=? WHERE scope='login_username'",
                Timestamp.from(Instant.now().minusSeconds(60)));
        limiter.cleanExpiredWindows();
        assertEquals(2, db.queryForObject("SELECT count(*) FROM room_auth_rate_limits", Integer.class));
        var hashes = db.queryForList("SELECT key_hash FROM room_auth_rate_limits", String.class);
        assertTrue(hashes.stream().allMatch(hash -> hash.matches("[a-f0-9]{64}")));
        for (int i = 0; i < 9; i++) limiter.admitRegistration("198.51.100.31");
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> limiter.admitRegistration("198.51.100.31")).getStatusCode().value());
    }
}
