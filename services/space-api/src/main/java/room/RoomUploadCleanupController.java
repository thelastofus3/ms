package room;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/v1/rooms/uploads")
public class RoomUploadCleanupController {
    private final RoomUploadCleanup cleanup;
    public RoomUploadCleanupController(RoomUploadCleanup cleanup) { this.cleanup=cleanup; }
    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String,Object>> discard(@PathVariable UUID id,HttpServletRequest request) {
        return ResponseEntity.accepted().body(cleanup.discard(id,AuthService.current(request).id()));
    }
}
