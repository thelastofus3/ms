package room;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.*;

@Service
public class AuthService implements ApplicationRunner {
    public record Account(String id, String username, Role role, boolean disabled) {}
    record Login(Account account, String token) {}
    private record StoredAccount(Account account, String passwordHash, long tokenVersion) {}
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PASSWORD_ITERATIONS = 600_000;
    private static final String DUMMY_HASH = hashPassword(randomToken());
    private final JdbcTemplate db;
    private final TransactionTemplate transactions;
    private final JwtTokenService tokens;
    private final AuthRateLimiter rateLimiter;

    public AuthService(JdbcTemplate db, PlatformTransactionManager manager, JwtTokenService tokens) {
        this(db, manager, tokens, new AuthRateLimiter(db, manager));
    }

    @Autowired
    public AuthService(JdbcTemplate db, PlatformTransactionManager manager, JwtTokenService tokens, AuthRateLimiter rateLimiter) {
        this.db = db;
        this.transactions = new TransactionTemplate(manager);
        this.tokens = tokens;
        this.rateLimiter = rateLimiter;
    }

    @Override public void run(ApplicationArguments args) {
        bootstrap(System.getenv().getOrDefault("ROOM_ADMIN_USERNAME", "admin"), System.getenv("ROOM_ADMIN_PASSWORD"));
    }

    void bootstrap(String username, String password) {
        transactions.executeWithoutResult(tx -> {
            lockAccounts();
            if (db.queryForObject("SELECT count(*) FROM room_accounts", Long.class) != 0) return;
            if (password == null || password.isBlank())
                throw new IllegalStateException("ROOM_ADMIN_PASSWORD is required when no accounts exist");
            insertUser(normalizeUsername(username), password, Role.ADMIN);
        });
    }

    public static Account current(HttpServletRequest request) {
        if (!(request.getAttribute("roomAccount") instanceof Account account) || account.disabled())
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        return account;
    }

    public static Account requireCaptureUpload(HttpServletRequest request) {
        var account = current(request);
        if (!account.role().canUploadCapture()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Capture upload permission required");
        return account;
    }

    Account resolve(String token) {
        var identity = tokens.verify(token);
        if (identity == null) return null;
        var found = db.query("SELECT id,username,role,disabled FROM room_accounts WHERE id=? AND token_version=? AND disabled=false",
                (row, n) -> account(row), UUID.fromString(identity.accountId()), identity.version());
        return found.isEmpty() ? null : found.getFirst();
    }

    Login login(String username, String password, String clientAddress) {
        String normalized = username == null ? "" : username.trim().toLowerCase(Locale.ROOT);
        if (normalized.length() > 64) normalized = "invalid";
        var admission = rateLimiter.admitLogin(clientAddress, normalized);
        var stored = storedByUsername(normalized);
        boolean correct = verifyPassword(password, stored == null ? DUMMY_HASH : stored.passwordHash());
        if (!correct || stored == null || stored.account().disabled()) throw invalidCredentials();
        var checked = stored;
        var result = transactions.execute(tx -> {
            lockAccounts();
            var fresh = storedById(checked.account().id());
            if (fresh == null || fresh.account().disabled() || !fresh.passwordHash().equals(checked.passwordHash())) throw invalidCredentials();
            return new Login(fresh.account(), tokens.issue(fresh.account().id(), fresh.tokenVersion()));
        });
        rateLimiter.loginSucceeded(admission, normalized);
        return result;
    }

    Login register(String username, String password, String clientAddress) {
        rateLimiter.admitRegistration(clientAddress);
        var normalized = normalizeUsername(username);
        validatePassword(password);
        return transactions.execute(tx -> {
            lockAccounts();
            try {
                var account = insertUser(normalized, password, Role.SPLAT_UPLOADER);
                return new Login(account, tokens.issue(account.id(), 0));
            } catch (DuplicateKeyException conflict) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Username is already in use");
            }
        });
    }

    void logout(String token) {
        var identity = tokens.verify(token);
        if (identity == null) return;
        transactions.executeWithoutResult(tx -> {
            lockAccounts();
            db.update("UPDATE room_accounts SET token_version=token_version+1,updated_at=now() WHERE id=? AND token_version=?",
                    UUID.fromString(identity.accountId()), identity.version());
        });
    }

    List<Account> users(Account actor) {
        checkAdministrator(actor);
        return db.query("SELECT id,username,role,disabled FROM room_accounts ORDER BY username", (row, n) -> account(row));
    }

    Account createUser(Account actor, String username, String password, Role role) {
        var normalized = normalizeUsername(username);
        validatePassword(password);
        if (role == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Role is required");
        return transactions.execute(tx -> {
            lockAccounts();
            checkAdministrator(actor);
            try { return insertUser(normalized, password, role); }
            catch (DuplicateKeyException conflict) { throw new ResponseStatusException(HttpStatus.CONFLICT, "Username is already in use"); }
        });
    }

    Account updateUser(Account actor, String id, String password, Role role, Boolean disabled) {
        final UUID accountId;
        try { accountId = UUID.fromString(id); }
        catch (IllegalArgumentException invalid) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid account identifier"); }
        if (password != null) validatePassword(password);
        return transactions.execute(tx -> {
            lockAccounts();
            checkAdministrator(actor);
            var stored = storedById(accountId.toString());
            if (stored == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Account not found");
            var current = stored.account();
            var nextRole = role == null ? current.role() : role;
            var nextDisabled = disabled == null ? current.disabled() : disabled;
            if (current.role() == Role.ADMIN && !current.disabled() && (nextRole != Role.ADMIN || nextDisabled)
                    && db.queryForObject("SELECT count(*) FROM room_accounts WHERE role='ADMIN' AND disabled=false", Long.class) <= 1)
                throw new ResponseStatusException(HttpStatus.CONFLICT, "The last enabled administrator cannot be demoted or disabled");
            boolean sensitiveChange = password != null || nextRole != current.role() || nextDisabled != current.disabled();
            db.update("UPDATE room_accounts SET password_hash=?,role=?,disabled=?,token_version=token_version+?,updated_at=now() WHERE id=?",
                    password == null ? stored.passwordHash() : hashPassword(password), nextRole.name(), nextDisabled, sensitiveChange ? 1 : 0, accountId);
            return new Account(current.id(), current.username(), nextRole, nextDisabled);
        });
    }

    private void checkAdministrator(Account actor) {
        var actual = actor == null ? null : storedById(actor.id());
        if (actual == null || actual.account().disabled() || actual.account().role() != Role.ADMIN)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Administrator permission required");
    }

    private void lockAccounts() { db.queryForObject("SELECT id FROM room_auth_guard WHERE id=1 FOR UPDATE", Integer.class); }

    private Account insertUser(String username, String password, Role role) {
        validatePassword(password);
        var id = UUID.randomUUID();
        db.update("INSERT INTO room_accounts(id,username,password_hash,role) VALUES (?,?,?,?)", id, username, hashPassword(password), role.name());
        return new Account(id.toString(), username, role, false);
    }

    private StoredAccount storedByUsername(String username) {
        var found = db.query("SELECT id,username,role,disabled,password_hash,token_version FROM room_accounts WHERE username=?",
                (row, n) -> new StoredAccount(account(row), row.getString("password_hash"), row.getLong("token_version")), username);
        return found.isEmpty() ? null : found.getFirst();
    }

    private StoredAccount storedById(String id) {
        var found = db.query("SELECT id,username,role,disabled,password_hash,token_version FROM room_accounts WHERE id=?",
                (row, n) -> new StoredAccount(account(row), row.getString("password_hash"), row.getLong("token_version")), UUID.fromString(id));
        return found.isEmpty() ? null : found.getFirst();
    }

    private static Account account(ResultSet row) throws SQLException {
        return new Account(row.getString("id"), row.getString("username"), Role.valueOf(row.getString("role")), row.getBoolean("disabled"));
    }

    private static String normalizeUsername(String username) {
        var normalized = username == null ? "" : username.trim().toLowerCase(Locale.ROOT);
        if (!normalized.matches("[a-z0-9][a-z0-9_.-]{2,63}"))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Username must contain 3-64 letters, digits, dots, underscores or hyphens");
        return normalized;
    }

    private static void validatePassword(String password) {
        if (password == null || password.isBlank() || password.length() < 12 || password.length() > 1024)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Password must contain 12-1024 characters");
    }

    private static ResponseStatusException invalidCredentials() { return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid username or password"); }
    static boolean validToken(String token) { return token != null && token.matches("[A-Za-z0-9_-]{43}"); }
    private static String randomToken() {
        var bytes = new byte[32]; RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
    static String tokenHash(String token) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static String hashPassword(String password) {
        var salt = new byte[16]; RANDOM.nextBytes(salt);
        return "pbkdf2-sha256$" + PASSWORD_ITERATIONS + "$" + Base64.getEncoder().encodeToString(salt) + "$"
                + Base64.getEncoder().encodeToString(derive(password, salt, PASSWORD_ITERATIONS));
    }
    private static boolean verifyPassword(String password, String stored) {
        if (password == null || password.length() > 1024) return false;
        try {
            var parts = stored.split("\\$");
            if (parts.length != 4 || !parts[0].equals("pbkdf2-sha256")) return false;
            int iterations = Integer.parseInt(parts[1]);
            if (iterations < 100_000 || iterations > 2_000_000) return false;
            return MessageDigest.isEqual(Base64.getDecoder().decode(parts[3]), derive(password, Base64.getDecoder().decode(parts[2]), iterations));
        } catch (IllegalArgumentException invalid) { return false; }
    }
    private static byte[] derive(String password, byte[] salt, int iterations) {
        var spec = new PBEKeySpec(password.toCharArray(), salt, iterations, 256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); }
        catch (Exception e) { throw new IllegalStateException(e); }
        finally { spec.clearPassword(); }
    }
}
