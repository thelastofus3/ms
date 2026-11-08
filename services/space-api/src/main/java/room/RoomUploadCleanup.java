package room;

import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.*;

/** Closes upload sessions before storage cleanup; charges survive unsuccessful deletion. */
@Service
public class RoomUploadCleanup {
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final RoomQuotaService quota;
    private final TransactionTemplate tx;

    public RoomUploadCleanup(JdbcTemplate db,ObjectStorage storage,RoomQuotaService quota,PlatformTransactionManager manager) {
        this.db=db; this.storage=storage; this.quota=quota; this.tx=new TransactionTemplate(manager);
    }
    private Map<String,Object> row(UUID id,String owner) {
        var rows=db.queryForList("SELECT * FROM room_uploads WHERE id=? AND owner=? FOR UPDATE",id,owner);
        if(rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Room resource not found");
        return rows.getFirst();
    }
    private boolean attached(UUID id) {
        return db.queryForObject("SELECT count(*) FROM room_jobs WHERE upload_id=?",Integer.class,id)>0;
    }
    public Map<String,Object> discard(UUID id,String owner) {
        return tx.execute(status -> {
            quota.lockOwner(owner);
            var upload=row(id,owner);
            if(!Boolean.TRUE.equals(upload.get("api_upload")))
                throw new ResponseStatusException(HttpStatus.CONFLICT,"Legacy upload data is preserved; operator cleanup is required");
            if(attached(id)) throw new ResponseStatusException(HttpStatus.CONFLICT,"This upload is used by a saved job and cannot be discarded");
            if(upload.get("discarded_at")==null)
                db.update("UPDATE room_uploads SET discarded_at=now() WHERE id=? AND discarded_at IS NULL",id);
            return Map.of("id",id,"discarded",true,"cleanupPending",upload.get("cleaned_at")==null);
        });
    }
    private boolean expired(Map<String,Object> row) {
        Object value=row.get("expires_at");
        Instant instant=value instanceof Timestamp timestamp ? timestamp.toInstant() :
                value instanceof OffsetDateTime date ? date.toInstant() : value instanceof Instant time ? time : null;
        return instant!=null && !instant.isAfter(Instant.now());
    }
    public void cleanup(UUID id,String owner) {
        // This phase owns the same owner/upload locks used by transfer and sealing.
        // No release runs inside it: the ledger's standalone transaction would deadlock.
        List<String> absent=tx.execute(status -> {
            quota.lockOwner(owner);
            var upload=row(id,owner);
            if(!Boolean.TRUE.equals(upload.get("api_upload")) || upload.get("cleaned_at")!=null || attached(id)) return null;
            if(upload.get("discarded_at")==null) {
                if(!expired(upload)) return null;
                db.update("UPDATE room_uploads SET discarded_at=now() WHERE id=? AND discarded_at IS NULL",id);
                // Closing must commit before any external deletion, even if deletion fails.
                return List.<String>of();
            }
            String staging="inputs/"+id+"/", pinned="sealed-inputs/"+id+"/";
            var keys=new LinkedHashSet<String>();
            for(var allocation:db.queryForList("""
                    SELECT object_key FROM room_storage_allocations
                    WHERE owner=? AND resource_id=? AND released_at IS NULL
                      AND (object_key LIKE ? OR object_key LIKE ?)
                    """,owner,id,staging+"%",pinned+"%")) keys.add(allocation.get("object_key").toString());
            keys.addAll(storage.objects(staging).keySet()); keys.addAll(storage.objects(pinned).keySet());
            for(String key:keys) if(!key.startsWith(staging) && !key.startsWith(pinned))
                throw new IllegalStateException("Cleanup found an unrelated object");
            storage.abortMultipartUploads(staging);
            if(storage.hasMultipartUploads(staging)) throw new IllegalStateException("Multipart cleanup remains pending");
            for(String key:keys) storage.delete(key);
            for(String key:keys) if(storage.exists(key)) throw new IllegalStateException("Upload object cleanup remains pending");
            return new ArrayList<>(keys);
        });
        if(absent==null) return;
        // An empty result may be the newly closed phase. Re-enter once so that
        // closure remains durable independently of storage/release failures.
        var closed=db.queryForList("SELECT discarded_at,cleaned_at FROM room_uploads WHERE id=? AND owner=?",id,owner);
        if(closed.isEmpty() || closed.getFirst().get("discarded_at")==null) return;
        if(absent.isEmpty()) {
            var remaining=db.queryForList("""
                SELECT object_key FROM room_storage_allocations WHERE owner=? AND resource_id=? AND released_at IS NULL
                  AND (object_key LIKE ? OR object_key LIKE ?)
                """,owner,id,"inputs/"+id+"/%","sealed-inputs/"+id+"/%");
            if(!remaining.isEmpty()) { cleanup(id,owner); return; }
        }
        // Closed sessions never regain writable operations or attach to a job.
        for(String key:absent) quota.releaseVerifiedAbsent(owner,key);
        tx.executeWithoutResult(status -> {
            quota.lockOwner(owner);
            var upload=row(id,owner);
            if(upload.get("discarded_at")==null || attached(id)) return;
            Integer remaining=db.queryForObject("""
                SELECT count(*) FROM room_storage_allocations WHERE owner=? AND resource_id=? AND released_at IS NULL
                  AND (object_key LIKE ? OR object_key LIKE ?)
                """,Integer.class,owner,id,"inputs/"+id+"/%","sealed-inputs/"+id+"/%");
            if(remaining==0) db.update("UPDATE room_uploads SET cleaned_at=now() WHERE id=? AND cleaned_at IS NULL",id);
        });
    }
    @Scheduled(fixedDelayString="${room.quota.cleanup-ms:60000}",scheduler="roomQuotaCleanupScheduler")
    public void sweep() {
        var candidates=db.queryForList("""
            SELECT id,owner FROM room_uploads u WHERE api_upload AND cleaned_at IS NULL
              AND (discarded_at IS NOT NULL OR expires_at<=now())
              AND (cleanup_retry_at IS NULL OR cleanup_retry_at<=now())
              AND NOT EXISTS(SELECT 1 FROM room_jobs j WHERE j.upload_id=u.id)
            ORDER BY COALESCE(cleanup_retry_at,created_at),id LIMIT 25
            """);
        for(var candidate:candidates) {
            UUID id=UUID.fromString(candidate.get("id").toString());
            try { cleanup(id,candidate.get("owner").toString()); }
            catch(RuntimeException error) {
                try { db.update("UPDATE room_uploads SET cleanup_retry_at=now()+interval '1' minute WHERE id=? AND cleaned_at IS NULL",id); }
                catch(RuntimeException deferred) { LoggerFactory.getLogger(RoomUploadCleanup.class).warn("Upload {} cleanup retry could not be deferred",id); }
                LoggerFactory.getLogger(RoomUploadCleanup.class).warn("Upload {} cleanup remains pending",id);
            }
        }
    }
}
