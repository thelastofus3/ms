package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import org.slf4j.LoggerFactory;

@Service
@Order(-100)
public class RoomQuotaService implements ApplicationRunner {
    public static final long MAX_OUTPUT_BATCH=2L*1024*1024*1024;
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final long defaultStorage;
    private final int defaultPending,defaultActive,ttl;
    public RoomQuotaService(JdbcTemplate db,ObjectStorage storage,ObjectMapper json,PlatformTransactionManager manager) {
        this.db=db; this.storage=storage; this.json=json; this.tx=new TransactionTemplate(manager);
        try { defaultStorage=Math.multiplyExact(positive("ROOM_ACCOUNT_STORAGE_GIB",20),1024L*1024*1024); }
        catch(ArithmeticException error) { throw new IllegalArgumentException("ROOM_ACCOUNT_STORAGE_GIB is too large"); }
        defaultPending=positiveInt("ROOM_ACCOUNT_PENDING_UPLOADS",3);
        defaultActive=positiveInt("ROOM_ACCOUNT_ACTIVE_JOBS",2); ttl=positiveInt("ROOM_UPLOAD_TTL_HOURS",24);
    }
    private static long positive(String name,long fallback) {
        String value=System.getenv().getOrDefault(name,Long.toString(fallback));
        if(!value.matches("[0-9]+")) throw new IllegalArgumentException(name+" must be a positive integer");
        try { long result=Long.parseLong(value); if(result>0) return result; }
        catch(NumberFormatException ignored) {}
        throw new IllegalArgumentException(name+" must be a positive integer");
    }
    private static int positiveInt(String name,int fallback) {
        long value=positive(name,fallback);
        if(value>Integer.MAX_VALUE) throw new IllegalArgumentException(name+" is too large");
        return (int)value;
    }
    public static class QuotaExceeded extends ResponseStatusException {
        public final String dimension;
        public QuotaExceeded(String dimension) { super(HttpStatus.CONFLICT,"Account "+dimension+" quota exceeded"); this.dimension=dimension; }
    }
    public static class OutputLeaseLost extends IllegalStateException {
        public OutputLeaseLost() { super("Output worker lease was lost"); }
    }
    private static void transactionRequired() {
        if(!TransactionSynchronizationManager.isActualTransactionActive()) throw new IllegalStateException("Owner admission requires a transaction");
    }
    private static void standalone() {
        if(TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("Reserve storage before entering the publication transaction");
    }
    /** Commit deferred historical inventory before any resource transaction can write S3. */
    public void prepareOwner(String owner) {
        standalone();
        tx.executeWithoutResult(status -> lockOwner(owner));
    }
    public void lockOwner(String owner) {
        transactionRequired();
        db.update("INSERT INTO room_quota_owners(owner) VALUES(?) ON CONFLICT DO NOTHING",owner);
        var guard=db.queryForMap("SELECT * FROM room_quota_owners WHERE owner=? FOR UPDATE",owner);
        if(!Boolean.TRUE.equals(guard.get("initialized"))) initializeLocked(owner);
    }
    private Map<String,Object> effective(String owner) {
        return db.queryForMap("SELECT COALESCE(o.storage_limit_bytes,d.storage_limit_bytes) AS storage_limit_bytes,"+
                "COALESCE(o.pending_upload_limit,d.pending_upload_limit) AS pending_upload_limit,"+
                "COALESCE(o.active_job_limit,d.active_job_limit) AS active_job_limit FROM room_quota_owners o CROSS JOIN room_quota_defaults d WHERE o.owner=? AND d.id=1",owner);
    }
    private long charged(String owner) {
        return db.queryForObject("SELECT COALESCE(SUM(maximum_bytes),0) FROM room_storage_allocations WHERE owner=? AND released_at IS NULL",Long.class,owner);
    }
    private long pending(String owner) {
        return db.queryForObject("SELECT count(*) FROM room_uploads WHERE owner=? AND NOT sealed AND discarded_at IS NULL AND (NOT api_upload OR expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)",Long.class,owner);
    }
    private long active(String owner) {
        return db.queryForObject("SELECT count(*) FROM room_jobs WHERE owner=? AND state IN ('QUEUED','RUNNING')",Long.class,owner);
    }
    private static void validate(String kind,UUID id,Map<String,Long> objects) {
        if(id==null || objects==null || objects.isEmpty() || !Set.of("upload","job","alignment","calibration").contains(kind))
            throw new IllegalArgumentException("Invalid storage reservation");
        long total=0;
        for(var entry:objects.entrySet()) {
            String key=entry.getKey(); Long size=entry.getValue();
            boolean prefix=key!=null && switch(kind) {
                case "upload" -> key.startsWith("inputs/"+id+"/") || key.startsWith("sealed-inputs/"+id+"/");
                case "alignment" -> key.startsWith("camera-alignments/") && key.endsWith("/"+id+".jpg");
                default -> key.startsWith("outputs/"+id+"/");
            };
            if(!prefix || key.length()>1024 || key.chars().anyMatch(c -> c<32) || size==null || size<1)
                throw new IllegalArgumentException("Invalid storage key or byte length");
            try { total=Math.addExact(total,size); } catch(ArithmeticException error) { throw new IllegalArgumentException("Storage reservation is too large"); }
        }
        if(!kind.equals("upload") && total>MAX_OUTPUT_BATCH) throw new IllegalArgumentException("Output batch exceeds 2 GiB");
    }
    public void reserve(String owner,String resourceKind,UUID resourceId,Map<String,Long> objects) {
        standalone();
        tx.executeWithoutResult(status -> { lockOwner(owner); reserveLocked(owner,resourceKind,resourceId,objects); });
    }
    public void reserveLocked(String owner,String resourceKind,UUID resourceId,Map<String,Long> objects) {
        transactionRequired(); validate(resourceKind,resourceId,objects);
        long extra=0;
        var fresh=new LinkedHashMap<String,Long>();
        for(var entry:objects.entrySet()) {
            var rows=db.queryForList("SELECT * FROM room_storage_allocations WHERE object_key=?",entry.getKey());
            if(rows.isEmpty()) { extra=Math.addExact(extra,entry.getValue()); fresh.put(entry.getKey(),entry.getValue()); }
            else {
                var existing=rows.getFirst();
                if(!owner.equals(existing.get("owner")) || !resourceKind.equals(existing.get("resource_kind")) ||
                        !resourceId.equals(existing.get("resource_id")) || ((Number)existing.get("maximum_bytes")).longValue()!=entry.getValue() || existing.get("released_at")!=null)
                    throw new ResponseStatusException(HttpStatus.CONFLICT,"Storage allocation identity differs");
            }
        }
        long limit=((Number)effective(owner).get("storage_limit_bytes")).longValue();
        if(extra>0 && (extra>limit || charged(owner)>limit-extra)) throw new QuotaExceeded("storage");
        for(var entry:fresh.entrySet()) db.update("INSERT INTO room_storage_allocations(object_key,owner,resource_kind,resource_id,maximum_bytes) VALUES(?,?,?,?,?)",
                entry.getKey(),owner,resourceKind,resourceId,entry.getValue());
    }
    public void reserveJobOutputs(UUID jobId,UUID leaseToken,Map<String,Long> objects) {
        standalone(); validate("job",jobId,objects);
        String result=tx.execute(status -> {
            try { return db.queryForObject("SELECT room_reserve_job_outputs(?,?,?::jsonb)",String.class,jobId,leaseToken,json.writeValueAsString(objects)); }
            catch(com.fasterxml.jackson.core.JsonProcessingException error) { throw new IllegalArgumentException("Invalid output allocation"); }
        });
        if("LEASE_LOST".equals(result)) throw new OutputLeaseLost();
        if("QUOTA_EXCEEDED".equals(result)) throw new QuotaExceeded("storage");
        if(!"RESERVED".equals(result)) throw new IllegalStateException("Unexpected output reservation result");
    }
    public void confirm(String owner,String key,long bytes) {
        if(bytes<0) throw new IllegalArgumentException("Invalid confirmed object size");
        int changed=db.update("UPDATE room_storage_allocations SET confirmed_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE owner=? AND object_key=? AND released_at IS NULL AND maximum_bytes>=?",bytes,owner,key,bytes);
        if(changed!=1) throw new IllegalStateException("Object write lacks its admitted storage allocation");
    }
    public void releaseVerifiedAbsent(String owner,String key) {
        standalone();
        tx.executeWithoutResult(status -> {
            lockOwner(owner);
            if(storage.exists(key)) throw new IllegalStateException("Stored object remains present");
            db.update("UPDATE room_storage_allocations SET released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE owner=? AND object_key=? AND released_at IS NULL",owner,key);
        });
    }
    public void ensureAvailable(Map<String,Object> upload) {
        if(upload.get("discarded_at")!=null) throw new ResponseStatusException(HttpStatus.GONE,"Upload session was discarded. Start a fresh upload.");
        if(Boolean.TRUE.equals(upload.get("api_upload")) && upload.get("expires_at")!=null &&
                instant(upload.get("expires_at")).isBefore(Instant.now())) {
            Object id=upload.get("id");
            if(id==null || db.queryForObject("SELECT count(*) FROM room_jobs WHERE upload_id=?",Long.class,id)==0)
                throw new ResponseStatusException(HttpStatus.GONE,"Upload session expired. Start a fresh upload.");
        }
    }
    private static Instant instant(Object value) {
        if(value instanceof Timestamp timestamp) return timestamp.toInstant();
        if(value instanceof java.time.OffsetDateTime time) return time.toInstant();
        if(value instanceof Instant time) return time;
        throw new IllegalStateException("Invalid stored timestamp");
    }
    private static String time(Object value) { return value==null ? null : instant(value).toString(); }
    private Map<String,Object> limitView(String owner) {
        var values=effective(owner);
        return Map.of("storageLimitBytes",values.get("storage_limit_bytes"),"pendingUploadLimit",values.get("pending_upload_limit"),"activeJobLimit",values.get("active_job_limit"));
    }
    public Map<String,Object> usage(String owner) {
        return tx.execute(status -> {
            lockOwner(owner); var result=new LinkedHashMap<>(limitView(owner));
            result.put("storageChargedBytes",charged(owner));
            result.put("storageConfirmedBytes",db.queryForObject("SELECT COALESCE(SUM(confirmed_bytes),0) FROM room_storage_allocations WHERE owner=? AND released_at IS NULL",Long.class,owner));
            result.put("pendingUploads",pending(owner)); result.put("activeJobs",active(owner));
            var uploads=new ArrayList<Map<String,Object>>();
            for(var row:db.queryForList("SELECT u.* FROM room_uploads u WHERE u.owner=? AND u.cleaned_at IS NULL AND NOT EXISTS(SELECT 1 FROM room_jobs j WHERE j.upload_id=u.id) ORDER BY u.created_at DESC,u.id",owner)) {
                var item=new LinkedHashMap<String,Object>();
                item.put("id",row.get("id")); item.put("kind",row.get("kind")); item.put("sealed",row.get("sealed"));
                item.put("createdAt",time(row.get("created_at"))); item.put("expiresAt",time(row.get("expires_at")));
                item.put("discardedAt",time(row.get("discarded_at"))); item.put("discardable",Boolean.TRUE.equals(row.get("api_upload")) && row.get("discarded_at")==null);
                uploads.add(item);
            }
            result.put("uploads",uploads); return result;
        });
    }
    public Map<String,Object> limits(String owner) { return tx.execute(status -> { lockOwner(owner); return limitView(owner); }); }
    public Map<String,Object> updateLimits(String owner,Long bytes,Integer pending,Integer active) {
        if(bytes!=null && bytes<1 || pending!=null && pending<1 || active!=null && active<1) throw new IllegalArgumentException("Quota limits must be positive");
        return tx.execute(status -> {
            lockOwner(owner);
            db.update("UPDATE room_quota_owners SET storage_limit_bytes=COALESCE(?,storage_limit_bytes),pending_upload_limit=COALESCE(?,pending_upload_limit),active_job_limit=COALESCE(?,active_job_limit) WHERE owner=?",bytes,pending,active,owner);
            return limitView(owner);
        });
    }
    public void checkPendingLocked(String owner) {
        transactionRequired();
        if(pending(owner)>=((Number)effective(owner).get("pending_upload_limit")).longValue()) throw new QuotaExceeded("pendingUploads");
    }
    public void checkActiveLocked(String owner) {
        transactionRequired();
        if(active(owner)>=((Number)effective(owner).get("active_job_limit")).longValue()) throw new QuotaExceeded("activeJobs");
    }
    public void transferLocked(String source,String target) {
        transactionRequired();
        var limits=effective(target); long moved=charged(source), limit=((Number)limits.get("storage_limit_bytes")).longValue();
        if(moved>limit || charged(target)>limit-moved) throw new QuotaExceeded("storage");
        if(pending(target)+pending(source)>((Number)limits.get("pending_upload_limit")).longValue()) throw new QuotaExceeded("pendingUploads");
        if(active(target)+active(source)>((Number)limits.get("active_job_limit")).longValue()) throw new QuotaExceeded("activeJobs");
        db.update("UPDATE room_storage_allocations SET owner=?,updated_at=CURRENT_TIMESTAMP WHERE owner=?",target,source);
    }
    public int uploadTtlHours() { return ttl; }
    private void inventory(String owner,String kind,UUID id,String key,long maximum,Long confirmed) {
        var rows=db.queryForList("SELECT owner FROM room_storage_allocations WHERE object_key=?",key);
        if(!rows.isEmpty()) {
            if(!owner.equals(rows.getFirst().get("owner"))) throw new IllegalStateException("Historical object has conflicting ownership");
            return;
        }
        db.update("INSERT INTO room_storage_allocations(object_key,owner,resource_kind,resource_id,maximum_bytes,confirmed_bytes) VALUES(?,?,?,?,?,?)",key,owner,kind,id,maximum,confirmed);
    }
    private void initializeLocked(String owner) {
        var uploads=db.queryForList("SELECT * FROM room_uploads WHERE owner=? ORDER BY id FOR UPDATE",owner);
        for(var upload:uploads) {
            UUID id=UUID.fromString(upload.get("id").toString());
            var observed=new LinkedHashMap<String,Long>();
            observed.putAll(storage.objects("inputs/"+id+"/")); observed.putAll(storage.objects("sealed-inputs/"+id+"/"));
            try {
                Object raw=upload.get("media");
                String encoded=raw instanceof byte[] bytes ? new String(bytes,StandardCharsets.UTF_8) : raw.toString();
                var media=json.readTree(encoded); if(media.isTextual()) media=json.readTree(media.asText());
                if(!media.isArray()) throw new IllegalStateException("Invalid historical media");
                for(var file:media) {
                    String key=file.path("key").asText(); long size=file.path("size").asLong(-1);
                    if(key.isBlank() || size<1) throw new IllegalStateException("Invalid historical media identity");
                    inventory(owner,"upload",id,key,Math.max(size,observed.getOrDefault(key,0L)),observed.get(key));
                    String staging=file.path("stagingKey").asText();
                    if(!staging.isBlank()) inventory(owner,"upload",id,staging,Math.max(size,observed.getOrDefault(staging,0L)),observed.get(staging));
                    if(!Boolean.TRUE.equals(upload.get("inputs_pinned")))
                        inventory(owner,"upload",id,InputPinningService.snapshotKey(id,key),size,null);
                }
            } catch(java.io.IOException error) { throw new IllegalStateException("Cannot initialize historical storage accounting",error); }
            for(var object:observed.entrySet()) inventory(owner,"upload",id,object.getKey(),object.getValue(),object.getValue());
        }
        for(var job:db.queryForList("SELECT id FROM room_jobs WHERE owner=? ORDER BY id FOR UPDATE",owner)) {
            UUID id=UUID.fromString(job.get("id").toString());
            for(var object:storage.objects("outputs/"+id+"/").entrySet()) inventory(owner,"job",id,object.getKey(),object.getValue(),object.getValue());
            for(var object:storage.objects("camera-alignments/"+id+"/").entrySet()) inventory(owner,"alignment",id,object.getKey(),object.getValue(),object.getValue());
        }
        db.update("UPDATE room_quota_owners SET initialized=true WHERE owner=?",owner);
    }
    @Override public void run(ApplicationArguments arguments) {
        db.update("UPDATE room_quota_defaults SET storage_limit_bytes=?,pending_upload_limit=?,active_job_limit=? WHERE id=1",defaultStorage,defaultPending,defaultActive);
        var owners=db.queryForList("SELECT owner FROM room_uploads UNION SELECT owner FROM room_jobs UNION SELECT CAST(id AS text) AS owner FROM room_accounts");
        for(var row:owners) {
            String owner=row.get("owner").toString();
            try { tx.executeWithoutResult(status -> lockOwner(owner)); }
            catch(RuntimeException error) { LoggerFactory.getLogger(RoomQuotaService.class).warn("Storage accounting for owner {} is pending ({})",owner,error.getClass().getSimpleName()); }
        }
    }
}
