package room;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.Map;

@Repository
public class PlyImportRepository {
    public record Job(UUID id, UUID leaseToken, int attempts, String media) {}
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private static final String FENCE = "id=? AND lease_token=? AND kind='splat' AND state='RUNNING' AND lease_until>now()";

    public PlyImportRepository(JdbcTemplate db, PlatformTransactionManager manager) {
        this.db = db; this.tx = new TransactionTemplate(manager);
    }

    public Job claim() {
        return tx.execute(status -> {
            db.update("""
                UPDATE room_jobs SET state=CASE WHEN cancel_requested THEN 'CANCELLED' ELSE 'FAILED' END,
                    error=CASE WHEN cancel_requested THEN NULL ELSE 'PLY import failed after three attempts' END,
                    lease_token=NULL,lease_until=NULL,updated_at=now()
                WHERE kind='splat' AND ((state='QUEUED' AND (cancel_requested OR attempts>=3))
                    OR (state='RUNNING' AND lease_until<now() AND (cancel_requested OR attempts>=3)))
                """);
            var rows = db.queryForList("""
                SELECT j.*,(SELECT u.media FROM room_uploads u WHERE u.id=j.upload_id) AS media
                FROM room_jobs j WHERE j.kind='splat' AND NOT j.cancel_requested AND j.attempts<3
                    AND (j.state='QUEUED' OR (j.state='RUNNING' AND j.lease_until<now()))
                    AND EXISTS(SELECT 1 FROM room_uploads u WHERE u.id=j.upload_id AND u.kind='splat' AND u.sealed AND u.inputs_pinned AND u.owner=j.owner)
                    AND EXISTS(SELECT 1 FROM room_quota_owners q WHERE q.owner=j.owner AND q.initialized)
                ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED
                """);
            if (rows.isEmpty()) return null;
            var row = rows.getFirst();
            UUID id = UUID.fromString(row.get("id").toString()), token = UUID.randomUUID();
            db.update("""
                UPDATE room_jobs SET state='RUNNING',stage='snapshot',progress=0,error=NULL,
                    attempts=attempts+1,lease_token=?,lease_until=now()+interval '120' second,updated_at=now()
                WHERE id=?
                """, token, id);
            Object media = row.get("media");
            String encoded = media instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8) : media.toString();
            return new Job(id, token, ((Number)row.get("attempts")).intValue() + 1, encoded);
        });
    }

    public boolean heartbeat(Job job) {
        return db.update("UPDATE room_jobs SET lease_until=now()+interval '120' second WHERE " + FENCE + " AND NOT cancel_requested",
                job.id(), job.leaseToken()) == 1;
    }

    public boolean stage(Job job, String name, int progress) {
        return db.update("UPDATE room_jobs SET stage=?,progress=?,updated_at=now() WHERE " + FENCE + " AND NOT cancel_requested",
                name, progress, job.id(), job.leaseToken()) == 1;
    }

    public void reserveOutputs(Job job, Map<String,Long> objects) {
        if(TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("Output reservations must commit before publication");
        long total=0;
        for(long bytes:objects.values()) {
            if(bytes<1) throw new IllegalArgumentException("Output allocations require positive byte lengths");
            if(bytes>RoomQuotaService.MAX_OUTPUT_BATCH-total) throw new RoomQuotaService.QuotaExceeded("storage");
            total+=bytes;
        }
        final String encoded;
        try { encoded=new ObjectMapper().writeValueAsString(objects); }
        catch(com.fasterxml.jackson.core.JsonProcessingException error) { throw new IllegalStateException(error); }
        String result=tx.execute(status -> db.queryForObject(
                "SELECT room_reserve_job_outputs(?,?,?::jsonb)",String.class,job.id(),job.leaseToken(),encoded));
        if("LEASE_LOST".equals(result)) throw new RoomQuotaService.OutputLeaseLost();
        if("QUOTA_EXCEEDED".equals(result)) throw new RoomQuotaService.QuotaExceeded("storage");
        if(!"RESERVED".equals(result)) throw new IllegalStateException("Output reservation could not complete");
    }

    public void confirmOutput(Job job,String key,long bytes) {
        if(bytes<1 || !key.startsWith("outputs/"+job.id()+"/"+job.leaseToken()+"/"))
            throw new IllegalArgumentException("Invalid confirmed attempt output");
        // Confirmation records an already successful write. It never admits a
        // write, lowers the ceiling, or changes the publication lease fence.
        int changed=db.update("""
            UPDATE room_storage_allocations SET confirmed_bytes=?,updated_at=CURRENT_TIMESTAMP
            WHERE object_key=? AND resource_kind='job' AND resource_id=? AND released_at IS NULL
                AND maximum_bytes>=? AND owner=(SELECT owner FROM room_jobs WHERE id=?)
            """,bytes,key,job.id(),bytes,job.id());
        if(changed!=1)throw new IllegalStateException("Output write lacks its admitted storage allocation");
    }

    public boolean publish(Job job, String manifestKey, String diagnostics) {
        return Boolean.TRUE.equals(tx.execute(status -> {
            if (db.queryForList("SELECT id FROM room_jobs WHERE " + FENCE + " AND NOT cancel_requested FOR UPDATE",
                    job.id(), job.leaseToken()).isEmpty()) return false;
            db.update("INSERT INTO room_versions(job_id,version,manifest_key,ready) VALUES(?,1,?,false)", job.id(), manifestKey);
            db.update("""
                UPDATE room_jobs SET state='IMPORTED',stage='imported',progress=100,diagnostics=CAST(? AS jsonb),
                    error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=?
                """, diagnostics, job.id());
            return true;
        }));
    }

    public void fail(Job job, String error, boolean permanent, boolean interrupted) {
        String bounded = error == null ? "PLY import could not complete" : error.substring(0, Math.min(error.length(), 1000));
        db.update("""
            UPDATE room_jobs SET state=CASE WHEN cancel_requested THEN 'CANCELLED' WHEN ? OR attempts>=3 THEN 'FAILED' ELSE 'QUEUED' END,
                stage=CASE WHEN cancel_requested THEN 'cancelled' WHEN ? OR attempts>=3 THEN 'failed' ELSE 'queued' END,
                error=CASE WHEN cancel_requested THEN NULL ELSE ? END,lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE
            """ + FENCE + " AND (NOT ? OR cancel_requested)", permanent, permanent, bounded, job.id(), job.leaseToken(), interrupted);
    }
}
