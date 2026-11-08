package room;

import org.junit.jupiter.api.Test;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.web.server.ResponseStatusException;
import java.util.concurrent.*;
import java.time.Instant;
import java.time.Duration;
import java.time.Clock;
import java.time.ZoneOffset;
import static org.junit.jupiter.api.Assertions.*;

class AuthServiceTest {
    @Test void successfulLoginsReleaseTheirOwnClientAdmission() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        for (int i = 0; i < 31; i++)
            assertEquals(admin, f.auth.login("admin", "a secure bootstrap password", "198.51.100.1").account());
    }

    @Test void recreatedServicesShareUsernameFailures() {
        var f = new AuthTestDatabase();
        var replica = new AuthService(f.db, f.transactions, f.tokens);
        for (int i = 0; i < 10; i++) {
            var auth = i % 2 == 0 ? f.auth : replica;
            assertEquals(401, assertThrows(ResponseStatusException.class,
                    () -> auth.login("missing", null, "198.51.100.2")).getStatusCode().value());
        }
        var restarted = new AuthService(f.db, f.transactions, f.tokens);
        var rejected = assertThrows(ResponseStatusException.class,
                () -> restarted.login(" MISSING ", null, "198.51.100.3"));
        assertEquals(429, rejected.getStatusCode().value());
        assertTrue(Integer.parseInt(rejected.getHeaders().getFirst("Retry-After")) > 0);
    }

    @Test void recreatedServicesShareRegistrationValidationFailures() {
        var f = new AuthTestDatabase();
        for (int i = 0; i < 10; i++)
            assertEquals(400, assertThrows(ResponseStatusException.class,
                    () -> f.auth.register("ab", "short", "198.51.100.4")).getStatusCode().value());
        var restarted = new AuthService(f.db, f.transactions, f.tokens);
        var rejected = assertThrows(ResponseStatusException.class,
                () -> restarted.register("ab", "short", "198.51.100.4"));
        assertEquals(429, rejected.getStatusCode().value());
        assertTrue(Integer.parseInt(rejected.getHeaders().getFirst("Retry-After")) > 0);
    }

    @Test void apiErrorsPreserveRetryAfter() {
        var headers = new org.springframework.http.HttpHeaders();
        headers.set("Retry-After", "900");
        var rejected = new ResponseStatusException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS, "Try later") {
            @Override public org.springframework.http.HttpHeaders getHeaders() { return headers; }
        };
        assertEquals("900", new ApiErrors().status(rejected).getHeaders().getFirst("Retry-After"));
    }

    @Test void concurrentReplicaLoginsCannotExceedTheUsernameBudget() throws Exception {
        var f = new AuthTestDatabase();
        var replica = new AuthService(f.db, f.transactions, f.tokens);
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(12)) {
            var results = new java.util.ArrayList<Future<Integer>>();
            for (int i = 0; i < 24; i++) {
                final var auth = i % 2 == 0 ? f.auth : replica;
                results.add(workers.submit(() -> {
                    start.await();
                    return assertThrows(ResponseStatusException.class,
                            () -> auth.login("parallel-missing", null, "198.51.100.6")).getStatusCode().value();
                }));
            }
            start.countDown();
            int admitted = 0;
            for (var result : results) {
                int status = result.get(20, TimeUnit.SECONDS);
                assertTrue(status == 401 || status == 429);
                if (status == 401) admitted++;
            }
            assertEquals(10, admitted);
        }
    }

    @Test void rejectedUsernameAdmissionsDoNotConsumeTheClientsOtherBudget() {
        var f = new AuthTestDatabase();
        for (int i = 0; i < 10; i++)
            assertEquals(401, assertThrows(ResponseStatusException.class,
                    () -> f.auth.login("blocked", null, "198.51.100.7")).getStatusCode().value());
        for (int i = 0; i < 40; i++)
            assertEquals(429, assertThrows(ResponseStatusException.class,
                    () -> f.auth.login("blocked", null, "198.51.100.8")).getStatusCode().value());
        for (int i = 0; i < 30; i++) {
            String username = "other-" + i;
            assertEquals(401, assertThrows(ResponseStatusException.class,
                    () -> f.auth.login(username, null, "198.51.100.8")).getStatusCode().value());
        }
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> f.auth.login("another", null, "198.51.100.8")).getStatusCode().value());
    }


    @Test void registrationNormalizesUsernamesAndIssuesOnlyPlyPermissions() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        var registered = f.auth.register(" New.User ", "a secure registration password", "10.0.0.1");
        assertEquals("new.user", registered.account().username());
        assertEquals(Role.SPLAT_UPLOADER, registered.account().role());
        assertFalse(registered.account().disabled());
        assertEquals(registered.account(), f.auth.resolve(registered.token()));
        assertEquals(registered.account(), f.auth.login("NEW.USER", "a secure registration password", "10.0.0.1").account());
        assertEquals(403, assertThrows(ResponseStatusException.class,
                () -> f.auth.updateUser(registered.account(), registered.account().id(), null, Role.ADMIN, null)).getStatusCode().value());
        assertEquals(admin, f.auth.users(admin).stream().filter(account -> account.id().equals(admin.id())).findFirst().orElseThrow());
    }

    @Test void registrationCannotReplaceAnExistingAccountThroughCaseNormalization() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        assertEquals(409, assertThrows(ResponseStatusException.class,
                () -> f.auth.register(" ADMIN ", "a different registration password", "10.0.0.1")).getStatusCode().value());
        assertEquals(admin, f.auth.login("admin", "a secure bootstrap password", "10.0.0.1").account());
        assertEquals(401, assertThrows(ResponseStatusException.class,
                () -> f.auth.login("admin", "a different registration password", "10.0.0.1")).getStatusCode().value());
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void registrationValidatesCredentialsBeforeCreatingAnAccount() {
        var f = new AuthTestDatabase();
        for (String username : new String[]{"ab", "invalid space", "-invalid", "a".repeat(65)})
            assertEquals(400, assertThrows(ResponseStatusException.class,
                    () -> f.auth.register(username, "a secure registration password", "10.0.0.1")).getStatusCode().value());
        for (String password : new String[]{"short", " ".repeat(12), "a".repeat(1025)})
            assertEquals(400, assertThrows(ResponseStatusException.class,
                    () -> f.auth.register("valid-user", password, "10.0.0.1")).getStatusCode().value());
        assertEquals(0, f.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void registrationThrottlesFailuresPerAddressWithoutConsumingTheLoginBudget() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        for (int i = 0; i < 10; i++) assertEquals(409, assertThrows(ResponseStatusException.class,
                () -> f.auth.register("admin", "a secure registration password", "10.0.0.8")).getStatusCode().value());
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> f.auth.register("visitor", "a secure registration password", "10.0.0.8")).getStatusCode().value());
        assertEquals(admin, f.auth.login("admin", "a secure bootstrap password", "10.0.0.8").account());
        assertEquals(Role.SPLAT_UPLOADER, f.auth.register("visitor", "a secure registration password", "10.0.0.9").account().role());
        assertEquals(2, f.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void concurrentRegistrationOfTheSameNormalizedNameCreatesOneAccount() throws Exception {
        var f = new AuthTestDatabase();
        f.admin();
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var a = workers.submit(() -> register(f, " Builder ", ready, start));
            var b = workers.submit(() -> register(f, "BUILDER", ready, start));
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            assertEquals(1, a.get(10, TimeUnit.SECONDS) + b.get(10, TimeUnit.SECONDS));
        }
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_accounts WHERE username='builder' AND role='SPLAT_UPLOADER'", Integer.class));
        assertEquals(2, f.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void loginIssuesACompactJwt() {
        var f = new AuthTestDatabase();
        f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        assertEquals(3, login.token().split("\\.").length);
    }

    @Test void bootstrapRequiresAnExplicitPasswordOnlyForAnEmptyDatabase() {
        var f = new AuthTestDatabase();
        assertThrows(IllegalStateException.class, () -> f.auth.bootstrap("admin", null));
        f.admin();
        assertDoesNotThrow(() -> f.auth.bootstrap("ignored", null));
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void logoutRevokesAllTokensAndAReplayCannotRevokeANewLogin() {
        var f = new AuthTestDatabase();
        f.admin();
        var first = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        var second = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        assertNotEquals(first.token(), second.token());
        f.auth.logout(first.token());
        assertNull(f.auth.resolve(first.token()));
        assertNull(f.auth.resolve(second.token()));
        var fresh = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        f.auth.logout(first.token());
        assertEquals(fresh.account(), f.auth.resolve(fresh.token()));
    }

    @Test void passwordsAreSaltedAndJwtLoginsExpireWithoutSessionStorage() throws Exception {
        var now = Instant.parse("2026-10-11T12:00:00Z");
        var f = new AuthTestDatabase(Clock.fixed(now, ZoneOffset.UTC));
        var admin = f.admin();
        var user = f.auth.createUser(admin, "builder", "a secure bootstrap password", Role.RECONSTRUCTOR);
        var hashes = f.db.queryForList("SELECT password_hash FROM room_accounts", String.class);
        assertNotEquals(hashes.get(0), hashes.get(1));
        assertTrue(hashes.stream().noneMatch(h -> h.contains("a secure bootstrap password")));
        var first = f.auth.login("builder", "a secure bootstrap password", "10.0.0.1");
        var second = f.auth.login("builder", "a secure bootstrap password", "10.0.0.1");
        assertNotEquals(first.token(), second.token());
        assertEquals(user, f.auth.resolve(first.token()));
        assertEquals(user, f.auth.resolve(second.token()));
        var claims = SignedJWT.parse(second.token()).getJWTClaimsSet();
        assertEquals(now, claims.getIssueTime().toInstant());
        assertEquals(now.plus(Duration.ofHours(24)), claims.getExpirationTime().toInstant());
        assertEquals(user.id(), claims.getSubject());
        assertEquals(0, f.db.queryForObject("SELECT count(*) FROM information_schema.tables WHERE table_name='ROOM_SESSIONS'", Integer.class));
        var expired = new AuthService(f.db, f.transactions, new JwtTokenService(AuthTestDatabase.JWT_SECRET,
                Clock.fixed(now.plus(Duration.ofHours(24)), ZoneOffset.UTC)));
        assertNull(expired.resolve(second.token()));
    }

    @Test void sensitiveAccountChangesRevokeExistingTokens() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        var user = f.auth.createUser(admin, "builder", "a strong builder password", Role.RECONSTRUCTOR);
        var login = f.auth.login("builder", "a strong builder password", "10.0.0.2");
        f.auth.logout(login.token());
        assertNull(f.auth.resolve(login.token()));
        login = f.auth.login("builder", "a strong builder password", "10.0.0.2");
        f.auth.updateUser(admin, user.id(), null, Role.SPLAT_UPLOADER, null);
        assertNull(f.auth.resolve(login.token()));
        login = f.auth.login("builder", "a strong builder password", "10.0.0.2");
        f.auth.updateUser(admin, user.id(), "a changed builder password", null, null);
        assertNull(f.auth.resolve(login.token()));
        login = f.auth.login("builder", "a changed builder password", "10.0.0.2");
        f.auth.updateUser(admin, user.id(), null, null, true);
        assertNull(f.auth.resolve(login.token()));
        assertEquals(401, assertThrows(ResponseStatusException.class,
                () -> f.auth.login("builder", "a changed builder password", "10.0.0.2")).getStatusCode().value());
        f.auth.updateUser(admin, user.id(), null, null, false);
        assertNull(f.auth.resolve(login.token()));
    }

    @Test void unchangedAccountUpdatesPreserveExistingTokens() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        f.auth.updateUser(admin, admin.id(), null, Role.ADMIN, false);
        assertEquals(admin, f.auth.resolve(login.token()));
    }

    @Test void jwtResolutionUsesTheCurrentAccountAndRejectsUnknownAccounts() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        var user = f.auth.createUser(admin, "builder", "a strong builder password", Role.RECONSTRUCTOR);
        var login = f.auth.login("builder", "a strong builder password", "10.0.0.2");
        f.db.update("UPDATE room_accounts SET role='SPLAT_UPLOADER' WHERE id=?", java.util.UUID.fromString(user.id()));
        assertEquals(Role.SPLAT_UPLOADER, f.auth.resolve(login.token()).role());
        assertNull(f.auth.resolve(f.tokens.issue(java.util.UUID.randomUUID().toString(), 0)));
        assertNull(f.auth.resolve("L".repeat(43)));
        assertNull(f.auth.resolve("invalid.jwt.token"));
    }

    @Test void loginErrorsDoNotExposeWhetherAnAccountExistsAndAreThrottled() {
        var f = new AuthTestDatabase();
        f.admin();
        var missing = assertThrows(ResponseStatusException.class, () -> f.auth.login("missing", "bad", "10.0.0.3"));
        var wrong = assertThrows(ResponseStatusException.class, () -> f.auth.login("admin", "bad", "10.0.0.3"));
        assertEquals(missing.getReason(), wrong.getReason());
        assertEquals(401, wrong.getStatusCode().value());
        for (int i = 0; i < 9; i++) assertThrows(ResponseStatusException.class,
                () -> f.auth.login("admin", "bad", "10.0.0.4"));
        assertEquals(429, assertThrows(ResponseStatusException.class,
                () -> f.auth.login("admin", "bad", "10.0.0.4")).getStatusCode().value());
    }

    @Test void nonAdministratorsCannotManageAccountsAndTheLastAdministratorIsProtected() {
        var f = new AuthTestDatabase();
        var admin = f.admin();
        var uploader = f.auth.createUser(admin, "uploader", "an uploader secure password", Role.SPLAT_UPLOADER);
        assertEquals(403, assertThrows(ResponseStatusException.class,
                () -> f.auth.createUser(uploader, "intruder", "some strong password", Role.ADMIN)).getStatusCode().value());
        assertEquals(403, assertThrows(ResponseStatusException.class, () -> f.auth.users(uploader)).getStatusCode().value());
        assertEquals(409, assertThrows(ResponseStatusException.class,
                () -> f.auth.updateUser(admin, admin.id(), null, Role.RECONSTRUCTOR, null)).getStatusCode().value());
        assertEquals(409, assertThrows(ResponseStatusException.class,
                () -> f.auth.updateUser(admin, admin.id(), null, null, true)).getStatusCode().value());
    }

    @Test void concurrentDemotionsCannotRemoveBothRemainingAdministrators() throws Exception {
        var f = new AuthTestDatabase();
        var first = f.admin();
        var second = f.auth.createUser(first, "second-admin", "a second admin password", Role.ADMIN);
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var a = workers.submit(() -> demote(f, first, ready, start));
            var b = workers.submit(() -> demote(f, second, ready, start));
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            assertEquals(1, a.get(10, TimeUnit.SECONDS) + b.get(10, TimeUnit.SECONDS));
        }
        assertEquals(1, f.db.queryForObject("SELECT count(*) FROM room_accounts WHERE role='ADMIN' AND disabled=false", Integer.class));
    }

    private int demote(AuthTestDatabase f, AuthService.Account actor, CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown(); start.await();
        try { f.auth.updateUser(actor, actor.id(), null, Role.RECONSTRUCTOR, null); return 1; }
        catch (ResponseStatusException denied) { assertEquals(409, denied.getStatusCode().value()); return 0; }
    }

    private int register(AuthTestDatabase f, String username, CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown(); start.await();
        try { f.auth.register(username, "a secure registration password", "10.0.0.1"); return 1; }
        catch (ResponseStatusException denied) { assertEquals(409, denied.getStatusCode().value()); return 0; }
    }
}
