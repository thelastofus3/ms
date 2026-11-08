package room;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.nio.charset.StandardCharsets;
import java.util.*;

@Service
public class InputPinningService implements ApplicationRunner {
    private static final Logger log=LoggerFactory.getLogger(InputPinningService.class);
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final RoomQuotaService quota;

    public InputPinningService(JdbcTemplate db,ObjectStorage storage,ObjectMapper json,PlatformTransactionManager manager,RoomQuotaService quota) {
        this.db=db; this.storage=storage; this.json=json; this.tx=new TransactionTemplate(manager); this.quota=quota;
    }
    public static String snapshotKey(UUID uploadId,String stagingKey) {
        return "sealed-inputs/"+uploadId+"/"+UUID.nameUUIDFromBytes((uploadId+":"+stagingKey).getBytes(StandardCharsets.UTF_8));
    }

    List<Map<String,Object>> media(Object value) {
        try {
            String encoded=value instanceof byte[] bytes ? new String(bytes,StandardCharsets.UTF_8) : value.toString();
            var tree=json.readTree(encoded);
            if(tree.isTextual()) tree=json.readTree(tree.asText());
            return json.convertValue(tree,new TypeReference<>(){});
        } catch(Exception error) { throw new IllegalStateException("Invalid stored upload metadata",error); }
    }

    /** Caller holds this upload's FOR UPDATE lock throughout pinning and commit. */
    public void pinLocked(UUID id,Map<String,Object> row) {
        if(Boolean.TRUE.equals(row.get("inputs_pinned"))) return;
        var files=media(row.get("media"));
        if(files.isEmpty()) throw new IllegalArgumentException("Upload has no input files");
        var pinned=new ArrayList<Map<String,Object>>();
        for(var file:files) {
            String source=file.get("key").toString();
            long expected=((Number)file.get("size")).longValue();
            if(expected<1) throw new IllegalArgumentException("Invalid uploaded file size");
            var snapshot=storage.snapshotOnce(source,expected,snapshotKey(id,source));
            quota.confirm(row.get("owner").toString(),snapshot.key(),snapshot.size());
            var entry=new LinkedHashMap<>(file);
            entry.put("stagingKey",source); entry.put("key",snapshot.key());
            entry.put("size",snapshot.size()); entry.put("sha256",snapshot.sha256());
            entry.remove("multipartId"); pinned.add(entry);
        }
        try {
            db.update("UPDATE room_uploads SET media=?::jsonb,inputs_pinned=true,sealed=true WHERE id=?",
                    json.writeValueAsString(pinned),id);
        } catch(com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override public void run(ApplicationArguments arguments) {
        // Legacy objects are pinned independently. A missing object must not make
        // the API unavailable or discard other uploads; lazy complete/create retry.
        var uploads=db.queryForList("SELECT id,owner FROM room_uploads WHERE sealed AND NOT inputs_pinned ORDER BY created_at,id");
        for(var upload:uploads) {
            UUID id=UUID.fromString(upload.get("id").toString());
            try {
                quota.prepareOwner(upload.get("owner").toString());
                tx.executeWithoutResult(status -> {
                    quota.lockOwner(upload.get("owner").toString());
                    var rows=db.queryForList("SELECT * FROM room_uploads WHERE id=? FOR UPDATE",id);
                    if(!rows.isEmpty() && Boolean.TRUE.equals(rows.getFirst().get("sealed"))) pinLocked(id,rows.getFirst());
                });
            } catch(RuntimeException error) {
                log.warn("Legacy upload {} remains unpinned ({})",id,error.getClass().getSimpleName());
            }
        }
    }
}
