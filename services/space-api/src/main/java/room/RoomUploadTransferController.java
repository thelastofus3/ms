package room;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.slf4j.LoggerFactory;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Semaphore;

/** Authenticated, byte-bounded transfers; no browser storage write capability escapes. */
@RestController
@RequestMapping("/v1/rooms/uploads/{id}/files/{index}")
public class RoomUploadTransferController {
    private static final long PART_SIZE=16L*1024*1024;
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final RoomQuotaService quota;
    private final TransactionTemplate tx;
    private final Semaphore transfers=new Semaphore(4);

    public RoomUploadTransferController(JdbcTemplate db,ObjectStorage storage,ObjectMapper json,
            PlatformTransactionManager manager,RoomQuotaService quota) {
        this.db=db; this.storage=storage; this.json=json; this.tx=new TransactionTemplate(manager); this.quota=quota;
    }
    @PutMapping
    public ResponseEntity<Void> single(@PathVariable UUID id,@PathVariable int index,HttpServletRequest request) {
        return transfer(id,index,null,request);
    }
    @PutMapping("/parts/{number}")
    public ResponseEntity<Void> part(@PathVariable UUID id,@PathVariable int index,@PathVariable int number,HttpServletRequest request) {
        return transfer(id,index,number,request);
    }
    private Map<String,Object> owned(UUID id,String owner,boolean lock) {
        var rows=db.queryForList("SELECT * FROM room_uploads WHERE id=? AND owner=?"+(lock ? " FOR UPDATE":""),id,owner);
        if(rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Room resource not found");
        return rows.getFirst();
    }
    private List<Map<String,Object>> media(Map<String,Object> row) {
        try {
            Object value=row.get("media");
            String encoded=value instanceof byte[] bytes ? new String(bytes,StandardCharsets.UTF_8) : value.toString();
            var tree=json.readTree(encoded);
            if(tree.isTextual()) tree=json.readTree(tree.asText());
            return json.convertValue(tree,new TypeReference<>(){});
        } catch(Exception error) { throw new IllegalStateException("Invalid stored upload metadata",error); }
    }
    private Map<String,Object> file(Map<String,Object> row,int index,Integer part,HttpServletRequest request) {
        if("capture".equals(Objects.toString(row.get("kind"),"capture"))) AuthService.requireCaptureUpload(request);
        quota.ensureAvailable(row);
        if(Boolean.TRUE.equals(row.get("sealed"))) throw new ResponseStatusException(HttpStatus.CONFLICT,"Completed uploads cannot be changed");
        var files=media(row);
        if(index<0 || index>=files.size()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Upload file not found");
        var result=files.get(index);
        long size=((Number)result.get("size")).longValue();
        if(size<1 || part==null && size>PART_SIZE || part!=null && (size<=PART_SIZE || part<1 || part>(size+PART_SIZE-1)/PART_SIZE))
            throw new IllegalArgumentException("Invalid upload file or part");
        return result;
    }
    private long expected(Map<String,Object> file,Integer part) {
        long size=((Number)file.get("size")).longValue();
        return part==null ? size : Math.min(PART_SIZE,size-(part-1L)*PART_SIZE);
    }
    private byte[] body(HttpServletRequest request,long expected) {
        if(request.getContentLengthLong()<0) throw new ResponseStatusException(HttpStatus.LENGTH_REQUIRED,"Supply the exact upload Content-Length");
        if(request.getContentLengthLong()!=expected) throw new IllegalArgumentException("Upload length does not match the declared file or part");
        try {
            byte[] bytes=request.getInputStream().readNBytes((int)expected+1);
            if(bytes.length!=expected) throw new IllegalArgumentException("Upload body does not match the declared file or part length");
            return bytes;
        } catch(IOException error) { throw new IllegalArgumentException("Upload body is incomplete"); }
    }
    private String initialize(UUID id,String owner,int index,int part,HttpServletRequest request) {
        return tx.execute(status -> {
            quota.lockOwner(owner);
            var row=owned(id,owner,true);
            var current=file(row,index,part,request);
            if(current.get("multipartId")!=null) return current.get("multipartId").toString();
            String multipart=storage.start(current.get("key").toString());
            var files=media(row); files.get(index).put("multipartId",multipart);
            try { db.update("UPDATE room_uploads SET media=?::jsonb WHERE id=?",json.writeValueAsString(files),id); }
            catch(com.fasterxml.jackson.core.JsonProcessingException error) { throw new IllegalStateException(error); }
            return multipart;
        });
    }
    private ResponseEntity<Void> transfer(UUID id,int index,Integer part,HttpServletRequest request) {
        var account=AuthService.current(request);
        if(!transfers.tryAcquire()) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Upload transfers are busy. Retry shortly.");
        try {
            var initial=file(owned(id,account.id(),false),index,part,request);
            long length=expected(initial,part);
            byte[] bytes=body(request,length);
            quota.prepareOwner(account.id());
            String multipart=part==null ? null : initialize(id,account.id(),index,part,request);
            var result=tx.execute(status -> {
                quota.lockOwner(account.id());
                var current=file(owned(id,account.id(),true),index,part,request);
                if(expected(current,part)!=length) throw new IllegalStateException("Upload declaration changed");
                String key=current.get("key").toString();
                if(part!=null) {
                    if(!Objects.equals(current.get("multipartId"),multipart)) throw new ResponseStatusException(HttpStatus.CONFLICT,"Multipart upload changed. Resume this upload.");
                    String etag=storage.uploadPart(key,multipart,part,bytes);
                    return ResponseEntity.ok().header("ETag",etag).<Void>build();
                }
                storage.putInput(key,bytes);
                return ResponseEntity.ok().<Void>build();
            });
            if(part==null) {
                try { quota.confirm(account.id(),initial.get("key").toString(),length); }
                catch(RuntimeException error) { LoggerFactory.getLogger(RoomUploadTransferController.class).warn("Upload {} confirmation will be reconciled",id); }
            }
            return result;
        } finally { transfers.release(); }
    }
}
