package room;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;

@RestController
@RequestMapping("/v1/rooms")
public class RoomQuotaController {
    private final RoomQuotaService quota;
    private final JdbcTemplate db;
    public RoomQuotaController(RoomQuotaService quota,JdbcTemplate db) { this.quota=quota; this.db=db; }
    public record Limits(@Min(1) Long storageLimitBytes,@Min(1) Integer pendingUploadLimit,@Min(1) Integer activeJobLimit) {}
    @GetMapping("/quota") public Map<String,Object> mine(HttpServletRequest request) {
        return quota.usage(AuthService.current(request).id());
    }
    private void administrator(UUID target,HttpServletRequest request) {
        var account=AuthService.current(request);
        if(account.role()!=Role.ADMIN || db.queryForObject("SELECT count(*) FROM room_accounts WHERE id=? AND role='ADMIN' AND NOT disabled",Integer.class,UUID.fromString(account.id()))!=1)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,"Administrator permission required");
        if(db.queryForObject("SELECT count(*) FROM room_accounts WHERE id=?",Integer.class,target)!=1)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Account not found");
    }
    @GetMapping("/auth/users/{id}/quota") public Map<String,Object> limits(@PathVariable UUID id,HttpServletRequest request) {
        administrator(id,request); return quota.limits(id.toString());
    }
    @PatchMapping("/auth/users/{id}/quota") public Map<String,Object> update(@PathVariable UUID id,@Valid @RequestBody Limits limits,HttpServletRequest request) {
        administrator(id,request); return quota.updateLimits(id.toString(),limits.storageLimitBytes(),limits.pendingUploadLimit(),limits.activeJobLimit());
    }
}
