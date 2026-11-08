package room;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import software.amazon.awssdk.services.s3.model.CompletedPart;
import java.util.*;

@RestController
@RequestMapping("/v1/rooms")
public class RoomController {
    private static final long PART_SIZE=16L*1024*1024;
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final InputPinningService pinning;
    private final RoomQuotaService quota;
    public RoomController(JdbcTemplate db,ObjectStorage storage,ObjectMapper json,org.springframework.transaction.PlatformTransactionManager manager,InputPinningService pinning,RoomQuotaService quota) {
        this.db=db; this.storage=storage; this.json=json; this.tx=new TransactionTemplate(manager); this.pinning=pinning; this.quota=quota;
    }
    public record Media(@NotBlank @Size(max=255) String name, @Min(1) long size, @NotBlank String contentType) {}
    public record UploadRequest(@NotEmpty @Size(max=500) List<@Valid Media> files,
                                @Pattern(regexp="capture|splat") String kind) {
        public UploadRequest(List<Media> files) { this(files, "capture"); }
    }
    public record Part(@Min(1) int number, @NotBlank String etag) {}
    public record CompletedFile(@NotBlank String key,List<@Valid Part> parts) {}
    public record Completion(@NotNull List<@Valid CompletedFile> files) {}
    public record JobRequest(@NotNull UUID uploadId,@NotBlank @Size(max=100) String name,@Pattern(regexp="local|quality") String profile,@NotBlank @Size(max=100) String idempotencyKey) {}
    public record ReconstructionRequest(@NotBlank @Size(max=100) String idempotencyKey) {}
    private String owner(HttpServletRequest request) { return (String)request.getAttribute("roomOwner"); }
    private String kind(Map<String,Object> row) { return Objects.toString(row.get("kind"), "capture"); }
    private void requireUploadKind(String kind,HttpServletRequest request) {
        AuthService.current(request);
        if(kind.equals("capture")) AuthService.requireCaptureUpload(request);
        else if(!kind.equals("splat")) throw new IllegalArgumentException("Unknown upload kind");
    }
    private String encode(Object value) { try { return json.writeValueAsString(value); } catch(Exception e) { throw new IllegalStateException(e); } }
    private List<Map<String,Object>> media(Object value) { try { return json.readValue(value.toString(),new TypeReference<>(){}); } catch(Exception e) { throw new IllegalStateException(e); } }
    private Map<String,Object> owned(String table,UUID id,String owner,boolean lock) {
        var rows=db.queryForList("SELECT * FROM "+table+" WHERE id=? AND owner=?"+(lock ? " FOR UPDATE":""),id,owner);
        if(rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Room resource not found");
        return rows.getFirst();
    }
    @PostMapping("/uploads")
    public Map<String,Object> upload(@Valid @RequestBody UploadRequest body,HttpServletRequest request) {
        String kind=body.kind()==null ? "capture" : body.kind();
        requireUploadKind(kind,request);
        if(kind.equals("splat")) {
            if(body.files().size()!=1 || !body.files().getFirst().name().toLowerCase(Locale.ROOT).endsWith(".ply"))
                throw new IllegalArgumentException("Import exactly one Gaussian PLY file");
            if(body.files().getFirst().size()>1024L*1024*1024)
                throw new IllegalArgumentException("PLY file exceeds the 1 GiB import limit");
        } else {
        long total=0; int videos=0;
        for(var f:body.files()) {
            boolean video=Set.of("video/mp4","video/quicktime","video/webm").contains(f.contentType());
            if(!video && !Set.of("image/jpeg","image/png","image/webp").contains(f.contentType())) throw new IllegalArgumentException("Use JPEG, PNG, WebP, MP4, MOV or WebM");
            if(f.size()>(video ? 2L*1024*1024*1024 : 25L*1024*1024)) throw new IllegalArgumentException("File exceeds upload limit");
            total+=f.size(); if(video) videos++;
        }
        if(total>3L*1024*1024*1024 || (videos>0 && body.files().size()!=1)) throw new IllegalArgumentException("Upload one video or up to 500 photos, at most 3 GiB total");
        if(videos==0 && body.files().size()<12) throw new IllegalArgumentException("Upload at least 12 overlapping photos or one video");
        }
        return tx.execute(status -> {
        quota.lockOwner(owner(request)); quota.checkPendingLocked(owner(request));
        UUID id=UUID.randomUUID(); var files=new ArrayList<Map<String,Object>>(); var operations=new ArrayList<Map<String,Object>>();
        var allocations=new LinkedHashMap<String,Long>(); int index=0;
        for(var f:body.files()) {
            String key="inputs/"+id+"/"+UUID.randomUUID();
            var entry=new LinkedHashMap<String,Object>(); entry.put("key",key); entry.put("name",f.name()); entry.put("size",f.size()); entry.put("contentType",f.contentType());
            allocations.put(key,f.size()); allocations.put(InputPinningService.snapshotKey(id,key),f.size());
            String route="/v1/rooms/uploads/"+id+"/files/"+index++;
            if(f.size()>PART_SIZE) {
                var parts=new ArrayList<Map<String,Object>>();
                for(int n=1;n<=(f.size()+PART_SIZE-1)/PART_SIZE;n++) parts.add(Map.of("number",n,"url",route+"/parts/"+n));
                operations.add(Map.of("key",key,"partSize",PART_SIZE,"parts",parts));
            } else operations.add(Map.of("key",key,"url",route));
            files.add(entry);
        }
        quota.reserveLocked(owner(request),"upload",id,allocations);
        db.update("INSERT INTO room_uploads(id,owner,media,kind,api_upload,expires_at) VALUES(?,?,?::jsonb,?,true,?)",id,owner(request),encode(files),kind,
                java.sql.Timestamp.from(java.time.Instant.now().plus(java.time.Duration.ofHours(quota.uploadTtlHours()))));
        return Map.of("id",id,"files",operations,"kind",kind);
        });
    }
    @PostMapping("/uploads/{id}/complete")
    public Map<String,Object> complete(@PathVariable UUID id,@Valid @RequestBody Completion body,HttpServletRequest request) {
        var initial=owned("room_uploads",id,owner(request),false);
        requireUploadKind(kind(initial),request); quota.ensureAvailable(initial);
        quota.prepareOwner(owner(request));
        return tx.execute(status -> {
            quota.lockOwner(owner(request));
            var row=owned("room_uploads",id,owner(request),true);
            requireUploadKind(kind(row),request);
            quota.ensureAvailable(row);
            if(Boolean.TRUE.equals(row.get("sealed"))) {
                pinning.pinLocked(id,row);
                return Map.of("id",id,"sealed",true);
            }
            var files=media(row.get("media"));
            if(body.files().size()!=files.size()) throw new IllegalArgumentException("All uploaded files are required");
            var supplied=new HashMap<String,CompletedFile>();
            for(var file:body.files()) {
                if(supplied.put(file.key(),file)!=null) throw new IllegalArgumentException("Unknown or duplicate upload file");
            }
            for(var file:files) if(!supplied.containsKey(file.get("key").toString()))
                throw new IllegalArgumentException("Unknown or duplicate upload file");
            var pending=new LinkedHashMap<String,List<CompletedPart>>();
            // Validate every supplied part list before completing any object.
            for(var f:files) {
                String key=f.get("key").toString(); long expected=((Number)f.get("size")).longValue();
                if(f.containsKey("multipartId")) {
                    var parts=supplied.get(key).parts();
                    if(parts!=null && !parts.isEmpty()) {
                        int count=(int)((expected+PART_SIZE-1)/PART_SIZE);
                        if(parts.size()!=count) throw new IllegalArgumentException("Missing upload parts");
                        var sorted=parts.stream().sorted(Comparator.comparingInt(Part::number)).toList();
                        var completed=new ArrayList<CompletedPart>();
                        for(int i=0;i<count;i++) {
                            var p=sorted.get(i);
                            if(p.number()!=i+1 || p.etag()==null || p.etag().isBlank()) throw new IllegalArgumentException("Upload part order is invalid");
                            completed.add(CompletedPart.builder().partNumber(p.number()).eTag(p.etag()).build());
                        }
                        pending.put(key,completed);
                    }
                } else if(supplied.get(key).parts()!=null && !supplied.get(key).parts().isEmpty()) {
                    throw new IllegalArgumentException("Single-part upload does not accept multipart parts");
                }
            }
            var complete=new ArrayList<Map<String,Object>>();
            for(var f:files) if(f.containsKey("multipartId")) {
                String key=f.get("key").toString(); long expected=((Number)f.get("size")).longValue();
                boolean done=false;
                try { done=storage.size(key)==expected; }
                catch(software.amazon.awssdk.services.s3.model.S3Exception e) { if(e.statusCode()!=404) throw e; }
                if(!done) {
                    if(!pending.containsKey(key)) throw new IllegalArgumentException("Missing upload parts");
                    complete.add(f);
                }
            }
            for(var f:complete) storage.complete(f.get("key").toString(),f.get("multipartId").toString(),pending.get(f.get("key").toString()));
            for(var file:files) {
                String key=file.get("key").toString(); long expected=((Number)file.get("size")).longValue();
                if(storage.size(key)!=expected) throw new IllegalArgumentException("Uploaded file size does not match");
                quota.confirm(owner(request),key,expected);
            }
            pinning.pinLocked(id,row);
            return Map.of("id",id,"sealed",true);
        });
    }
    @GetMapping("/uploads/{id}")
    public Map<String,Object> resume(@PathVariable UUID id,HttpServletRequest request) {
        return tx.execute(status -> {
        quota.lockOwner(owner(request));
        var row=owned("room_uploads",id,owner(request),true);
        requireUploadKind(kind(row),request);
        quota.ensureAvailable(row);
        if(Boolean.TRUE.equals(row.get("sealed")))
            return Map.of("id",id,"sealed",true,"files",List.of(),"kind",kind(row));
        var operations=new ArrayList<Map<String,Object>>();
        int index=0;
        for(var f:media(row.get("media"))) {
            String key=f.get("key").toString(); long size=((Number)f.get("size")).longValue();
            String route="/v1/rooms/uploads/"+id+"/files/"+index++;
            if(size>PART_SIZE) {
                var parts=new ArrayList<Map<String,Object>>();
                for(int n=1;n<=(size+PART_SIZE-1)/PART_SIZE;n++) parts.add(Map.of("number",n,"url",route+"/parts/"+n));
                operations.add(Map.of("key",key,"partSize",PART_SIZE,"parts",parts));
            } else operations.add(Map.of("key",key,"url",route));
        }
        return Map.of("id",id,"sealed",row.get("sealed"),"files",operations,"kind",kind(row));
        });
    }
    @PostMapping("/jobs")
    public ResponseEntity<Map<String,Object>> create(@Valid @RequestBody JobRequest body,HttpServletRequest request) {
        var initial=owned("room_uploads",body.uploadId(),owner(request),false);
        requireUploadKind(kind(initial),request); quota.ensureAvailable(initial);
        quota.prepareOwner(owner(request));
        return tx.execute(status -> {
        String owner=owner(request), profile=body.profile()==null ? "local":body.profile();
        quota.lockOwner(owner);
        var upload=owned("room_uploads",body.uploadId(),owner,true);
        String kind=kind(upload);
        requireUploadKind(kind,request);
        quota.ensureAvailable(upload);
        if(!Boolean.TRUE.equals(upload.get("sealed"))) throw new IllegalArgumentException("Finish uploading first");
        var existing=db.queryForList("SELECT * FROM room_jobs WHERE owner=? AND idempotency_key=?",owner,body.idempotencyKey());
        if(!existing.isEmpty()) {
            var row=existing.getFirst();
            if(!row.get("upload_id").equals(body.uploadId()) || !row.get("profile").equals(profile) || !row.get("name").equals(body.name()))
                throw new ResponseStatusException(HttpStatus.CONFLICT,"Idempotency key has different inputs");
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(view(row));
        }
        quota.checkActiveLocked(owner);
        pinning.pinLocked(body.uploadId(),upload);
        db.update("INSERT INTO room_jobs(id,owner,upload_id,name,profile,idempotency_key,kind,stage) VALUES(?,?,?,?,?,?,?,?)",UUID.randomUUID(),owner,body.uploadId(),body.name(),profile,body.idempotencyKey(),kind,kind.equals("splat") ? "import_queued" : "queued");
        var row=db.queryForMap("SELECT * FROM room_jobs WHERE owner=? AND idempotency_key=?",owner,body.idempotencyKey());
        if(!row.get("upload_id").equals(body.uploadId()) || !row.get("profile").equals(profile) || !row.get("name").equals(body.name())) throw new ResponseStatusException(HttpStatus.CONFLICT,"Idempotency key has different inputs");
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(view(row));
        });
    }
    @GetMapping("/jobs")
    public List<Map<String,Object>> list(HttpServletRequest request) {
        return db.queryForList("SELECT * FROM room_jobs WHERE owner=? ORDER BY created_at DESC LIMIT 100",owner(request)).stream().map(this::view).toList();
    }
    @PostMapping("/jobs/{id}/reconstruct")
    public ResponseEntity<Map<String,Object>> reconstructAgain(@PathVariable UUID id,@Valid @RequestBody ReconstructionRequest body,HttpServletRequest request) {
        AuthService.requireCaptureUpload(request);
        var source=owned("room_jobs",id,owner(request),false);
        if(kind(source).equals("splat")) throw new ResponseStatusException(HttpStatus.CONFLICT,"Imported PLY scenes cannot be reconstructed; upload a new PLY instead");
        if(Set.of("QUEUED","RUNNING").contains(source.get("state"))) throw new ResponseStatusException(HttpStatus.CONFLICT,"Wait for this reconstruction to finish or cancel it first");
        String key="reconstruct:"+id+":"+body.idempotencyKey();
        return create(new JobRequest((UUID)source.get("upload_id"),source.get("name").toString(),source.get("profile").toString(),key),request);
    }
    @GetMapping("/jobs/{id}")
    public Map<String,Object> job(@PathVariable UUID id,HttpServletRequest request) { return view(owned("room_jobs",id,owner(request),false)); }
    private Map<String,Object> view(Map<String,Object> row) {
        var result=new LinkedHashMap<String,Object>();
        for(String name:List.of("id","name","profile","state","stage","progress","error","created_at","updated_at","cancel_requested")) result.put(name,row.get(name));
        result.put("kind",kind(row));
        try { result.put("diagnostics",json.readTree(row.get("diagnostics").toString())); } catch(Exception e) { throw new IllegalStateException(e); }
        var versions=db.queryForList("SELECT version,ready FROM room_versions WHERE job_id=? ORDER BY version DESC LIMIT 1",row.get("id"));
        if(!versions.isEmpty()) { var v=versions.getFirst(); result.put("version",v.get("version")); result.put("manifestUrl","/v1/rooms/scenes/"+row.get("id")+"/versions/"+v.get("version")); }
        return result;
    }
    @PostMapping("/jobs/{id}/cancel")
    public Map<String,Object> cancel(@PathVariable UUID id,HttpServletRequest request) {
        return tx.execute(status -> {
            var row=owned("room_jobs",id,owner(request),true);
            if(Set.of("QUEUED","RUNNING").contains(row.get("state"))) {
                db.update("UPDATE room_jobs SET cancel_requested=true,state=CASE WHEN state='QUEUED' THEN 'CANCELLED' ELSE state END,updated_at=now() WHERE id=?",id);
            }
            return view(owned("room_jobs",id,owner(request),false));
        });
    }
    @GetMapping("/scenes/{id}/versions/{version}")
    public JsonNode manifest(@PathVariable UUID id,@PathVariable int version,HttpServletRequest request) {
        owned("room_jobs",id,owner(request),false);
        var rows=db.queryForList("SELECT manifest_key FROM room_versions WHERE job_id=? AND version=?",id,version);
        if(rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Scene version not found");
        String key=rows.getFirst().get("manifest_key").toString();
        try {
            var document=(ObjectNode)json.readTree(storage.read(key));
            String prefix=key.substring(0,key.lastIndexOf('/')+1);
            var fields=document.withObject("assets").fields();
            while(fields.hasNext()) { var asset=(ObjectNode)fields.next().getValue(); String path=asset.path("path").asText();
                if(!path.matches("[A-Za-z0-9][A-Za-z0-9._-]*")) throw new IllegalStateException("Invalid stored asset path");
                asset.put("url",storage.getUrl(prefix+path));
            }
            return document;
        } catch(java.io.IOException e) { throw new IllegalStateException(e); }
    }
    @PostMapping("/jobs/{id}/calibration")
    public Map<String,Object> calibrate(@PathVariable UUID id,@RequestBody Normalization.Calibration body,HttpServletRequest request) {
        String owner=owner(request);
        var prepared=tx.execute(status -> {
            quota.lockOwner(owner);
            var job=owned("room_jobs",id,owner(request),true);
            if(kind(job).equals("splat")) throw new ResponseStatusException(HttpStatus.CONFLICT,"Imported PLY scenes have no reconstructed collision geometry to calibrate");
            if(!Set.of("NEEDS_CALIBRATION","NEEDS_REVIEW","READY").contains(job.get("state"))) throw new IllegalArgumentException("Wait for reconstruction to finish");
            var previous=db.queryForMap("SELECT * FROM room_versions WHERE job_id=? ORDER BY version DESC LIMIT 1",id);
            int version=((Number)previous.get("version")).intValue()+1;
            String oldKey=previous.get("manifest_key").toString();
            try {
                var manifest=(ObjectNode)json.readTree(storage.read(oldKey));
                var camera=manifest.path("previewCamera");
                var normalized=Normalization.apply(body,new Normalization.Point(camera.get(12).asDouble(),camera.get(13).asDouble(),camera.get(14).asDouble()));
                normalized.forEach((k,v) -> manifest.set(k,json.valueToTree(v)));
                manifest.set("calibration", json.valueToTree(body));
                manifest.put("version",version); manifest.put("units","meters"); manifest.put("ready",true);
                String key=oldKey.substring(0,oldKey.lastIndexOf('/')+1)+"manifest-v"+version+"-"+UUID.randomUUID()+".json";
                return new CalibrationOutput(version-1,version,key,encode(manifest));
            } catch(java.io.IOException e) { throw new IllegalStateException(e); }
        });
        long bytes=prepared.document().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        quota.reserve(owner,"calibration",id,Map.of(prepared.key(),bytes));
        boolean[] writeStarted={false};
        try {
            return tx.execute(status -> {
                quota.lockOwner(owner);
                var job=owned("room_jobs",id,owner,true);
                if(!Set.of("NEEDS_CALIBRATION","NEEDS_REVIEW","READY").contains(job.get("state")))
                    throw new ResponseStatusException(HttpStatus.CONFLICT,"Room changed while preparing calibration. Retry.");
                int latest=db.queryForObject("SELECT MAX(version) FROM room_versions WHERE job_id=?",Integer.class,id);
                if(latest!=prepared.previousVersion()) throw new ResponseStatusException(HttpStatus.CONFLICT,"Room version changed while preparing calibration. Retry.");
                writeStarted[0]=true;
                storage.write(prepared.key(),prepared.document());
                quota.confirm(owner,prepared.key(),bytes);
                db.update("INSERT INTO room_versions(job_id,version,manifest_key,ready) VALUES(?,?,?,true)",id,prepared.version(),prepared.key());
                db.update("UPDATE room_jobs SET state='READY',updated_at=now() WHERE id=?",id);
                return view(owned("room_jobs",id,owner,false));
            });
        } catch(RuntimeException error) {
            if(!writeStarted[0]) {
                try { quota.releaseVerifiedAbsent(owner,prepared.key()); }
                catch(RuntimeException cleanup) { org.slf4j.LoggerFactory.getLogger(RoomController.class).warn("Unused calibration reservation remains charged ({})",cleanup.getClass().getSimpleName()); }
            }
            throw error;
        }
    }
    private record CalibrationOutput(int previousVersion,int version,String key,String document) {}
}
