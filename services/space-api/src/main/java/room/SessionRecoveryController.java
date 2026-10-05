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
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;

@RestController
@RequestMapping("/v1/rooms/session")
public class SessionRecoveryController {
    private final JdbcTemplate db;
    public SessionRecoveryController(JdbcTemplate db) { this.db = db; }
    public record Recovery(@NotNull @Pattern(regexp="[A-Za-z0-9_-]{43}") String token) {}

    // Links can only be issued by a local operator with database access.
    @PostMapping("/recover")
    public Map<String,Object> recover(@Valid @RequestBody Recovery body, HttpServletRequest request, HttpServletResponse response) {
        String hash;
        try { hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body.token().getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
        var rows = db.queryForList("DELETE FROM room_session_recovery WHERE token_hash=? AND expires_at>now() RETURNING owner,job_id", hash);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.GONE, "Recovery link has expired or was already used. Generate a new link with scripts/recover-room-session.ps1.");
        var saved = rows.getFirst();
        SessionFilter.setSessionCookie(request, response, saved.get("owner").toString());
        return Map.of("jobId", saved.get("job_id"));
    }
}
