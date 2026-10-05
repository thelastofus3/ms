package room;

import com.fasterxml.jackson.databind.*;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;
import java.io.ByteArrayInputStream;
import java.sql.Timestamp;
import java.util.*;

@RestController
@RequestMapping("/v1/rooms/jobs/{job}/tracking/alignments")
public class AlignmentController {
    private static final int MAX_JPEG_BYTES=2*1024*1024, MAX_SNAPSHOT_SIDE=1280;
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final TrackingController tracking;
    private final TransactionTemplate tx;
    public record Request(String name,UUID cameraId,Integer sceneVersion,Integer imageWidth,Integer imageHeight,String imageDataUrl) {}

    public AlignmentController(JdbcTemplate db,ObjectStorage storage,ObjectMapper json,TrackingController tracking,PlatformTransactionManager manager) {
        this.db=db;this.storage=storage;this.json=json;this.tracking=tracking;this.tx=new TransactionTemplate(manager);
    }
    private String owner(HttpServletRequest request) { return (String)request.getAttribute("roomOwner"); }
    private String encode(Object value) { try { return json.writeValueAsString(value); } catch(Exception e) { throw new IllegalStateException(e); } }
    private ResponseStatusException conflict(String message) { return new ResponseStatusException(HttpStatus.CONFLICT,message); }
    private void ownedJob(UUID job,String owner,boolean lock) {
        if(db.queryForList("SELECT id FROM room_jobs WHERE id=? AND owner=?"+(lock ? " FOR UPDATE":""),job,owner).isEmpty())
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Room resource not found");
    }
    private Map<String,Object> alignment(UUID job,UUID id,boolean lock) {
        var rows=db.queryForList("SELECT * FROM room_camera_alignments WHERE id=? AND job_id=?"+(lock ? " FOR UPDATE":""),id,job);
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Camera alignment not found");
        return rows.getFirst();
    }
    private Map<String,Object> view(Map<String,Object> row) {
        var result=new LinkedHashMap<String,Object>();result.put("id",row.get("id"));result.put("state",row.get("state"));
        result.put("stage",row.get("stage"));result.put("error",row.get("error"));result.put("createdAt",((Timestamp)row.get("created_at")).toInstant().toString());
        result.put("updatedAt",((Timestamp)row.get("updated_at")).toInstant().toString());
        try { result.put("progress",row.get("progress")==null ? json.createObjectNode():json.readTree(row.get("progress").toString())); }
        catch(java.io.IOException e) { throw new IllegalStateException("Invalid camera progress",e); }
        return result;
    }
    private void deleteFrame(Map<String,Object> row) {
        if(row.get("frame_deleted_at")!=null)return;
        try { storage.delete(row.get("frame_key").toString());db.update("UPDATE room_camera_alignments SET frame_deleted_at=now() WHERE id=? AND frame_deleted_at IS NULL",row.get("id")); }
        catch(RuntimeException e) { LoggerFactory.getLogger(AlignmentController.class).warn("Camera alignment frame cleanup will be retried for {}",row.get("id")); }
    }
    private void expire(UUID job) {
        var rows=db.queryForList("""
            UPDATE room_camera_alignments a SET state='FAILED',stage='expired',error='Camera alignment expired or its room/camera setup changed. Align automatically again.',
              lease_token=NULL,lease_until=NULL,result=NULL,updated_at=now()
            WHERE a.job_id=? AND a.state IN ('QUEUED','RUNNING','READY') AND (
              a.created_at<=now()-interval '10 minutes' OR
              (a.state='RUNNING' AND a.lease_until<=now()) OR
              a.scene_version<>(SELECT version FROM room_versions WHERE job_id=a.job_id ORDER BY version DESC LIMIT 1) OR
              (a.camera_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM room_tracking_cameras c WHERE c.id=a.camera_id AND c.job_id=a.job_id AND c.revision=a.camera_revision)))
            RETURNING a.*
            """,job);
        rows.forEach(this::deleteFrame);
    }
    static byte[] jpeg(Request body) {
        if(body==null || body.name()==null || body.name().trim().isEmpty() || body.name().trim().length()>100 || body.sceneVersion()==null || body.sceneVersion()<1 ||
                body.imageWidth()==null || body.imageHeight()==null || body.imageWidth()<32 || body.imageHeight()<32 || body.imageWidth()>4096 || body.imageHeight()>4096)
            throw new IllegalArgumentException("Supply a camera name, current scene version and original live dimensions from 32 to 4096 pixels.");
        String data=body.imageDataUrl(),prefix="data:image/jpeg;base64,";
        if(data==null || !data.startsWith(prefix) || data.length()>prefix.length()+((MAX_JPEG_BYTES+2)/3)*4)
            throw new IllegalArgumentException("Send one JPEG camera snapshot of at most 2 MiB.");
        byte[] bytes;
        try { bytes=Base64.getDecoder().decode(data.substring(prefix.length())); }
        catch(IllegalArgumentException e) { throw new IllegalArgumentException("The camera snapshot is not valid base64 JPEG data."); }
        if(bytes.length<4 || bytes.length>MAX_JPEG_BYTES || (bytes[0]&255)!=255 || (bytes[1]&255)!=216 || (bytes[bytes.length-2]&255)!=255 || (bytes[bytes.length-1]&255)!=217)
            throw new IllegalArgumentException("The camera snapshot is not a complete JPEG image.");
        var readers=ImageIO.getImageReadersByFormatName("JPEG");
        if(!readers.hasNext())throw new IllegalStateException("JPEG image support is unavailable");
        var reader=readers.next();
        try(var input=new MemoryCacheImageInputStream(new ByteArrayInputStream(bytes))) {
            boolean[] malformed={false};reader.addIIOReadWarningListener((source,warning) -> malformed[0]=true);
            reader.setInput(input,true,true);int width=reader.getWidth(0),height=reader.getHeight(0);
            if(width<32 || height<32 || width>MAX_SNAPSHOT_SIDE || height>MAX_SNAPSHOT_SIDE)
                throw new IllegalArgumentException("Resize the camera snapshot to at most 1280 pixels per side, keeping its full image.");
            double aspectDifference=Math.abs((double)body.imageWidth()/width / ((double)body.imageHeight()/height)-1);
            if(aspectDifference>0.015)throw new IllegalArgumentException("The snapshot crop or aspect ratio differs from the live camera. Capture the full frame.");
            if(reader.read(0)==null || malformed[0])throw new IllegalArgumentException("The JPEG snapshot could not be decoded completely.");
            return bytes;
        } catch(java.io.IOException e) { throw new IllegalArgumentException("The JPEG snapshot is malformed or truncated."); }
        finally { reader.dispose(); }
    }
    @PostMapping
    public Map<String,Object> create(@PathVariable UUID job,@RequestBody Request body,HttpServletRequest request) {
        ownedJob(job,owner(request),false);byte[] frame=jpeg(body);UUID id=UUID.randomUUID();String key="camera-alignments/"+job+"/"+id+".jpg";
        boolean[] written={false};
        try {
            return tx.execute(status -> {
                var scene=tracking.scene(job,owner(request),body.sceneVersion(),true);expire(job);
                if(!db.queryForList("SELECT id FROM room_camera_alignments WHERE job_id=? AND state IN ('QUEUED','RUNNING')",job).isEmpty())
                    throw conflict("A camera alignment is already running. Wait for it or cancel it before retrying.");
                UUID revision=null;
                if(body.cameraId()!=null)revision=(UUID)tracking.camera(job,body.cameraId(),true).get("revision");
                else if(db.queryForObject("SELECT count(*) FROM room_tracking_cameras WHERE job_id=?",Long.class,job)>=16)
                    throw new IllegalArgumentException("A room can have at most 16 tracking cameras.");
                written[0]=true;storage.writeJpeg(key,frame);
                db.update("INSERT INTO room_camera_alignments(id,job_id,camera_id,camera_revision,name,scene_version,image_width,image_height,frame_key,manifest_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        id,job,body.cameraId(),revision,body.name().trim(),body.sceneVersion(),body.imageWidth(),body.imageHeight(),key,scene.manifestKey());
                return view(alignment(job,id,false));
            });
        } catch(RuntimeException e) {
            if(written[0])try { storage.delete(key); } catch(RuntimeException ignored) { LoggerFactory.getLogger(AlignmentController.class).warn("Unpublished camera alignment frame cleanup failed for {}",id); }
            throw e;
        }
    }
    @GetMapping("/{id}")
    public Map<String,Object> status(@PathVariable UUID job,@PathVariable UUID id,HttpServletRequest request) {
        ownedJob(job,owner(request),false);expire(job);var row=alignment(job,id,false);
        if(Set.of("FAILED","CANCELLED","APPLIED").contains(row.get("state")))deleteFrame(row);
        return view(row);
    }
    @PostMapping("/{id}/cancel")
    public Map<String,Object> cancel(@PathVariable UUID job,@PathVariable UUID id,HttpServletRequest request) {
        return tx.execute(status -> {
            ownedJob(job,owner(request),true);var row=alignment(job,id,true);
            if(Set.of("QUEUED","RUNNING","READY").contains(row.get("state")))db.update("UPDATE room_camera_alignments SET state='CANCELLED',stage='cancelled',error=NULL,result=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=? AND job_id=? AND state IN ('QUEUED','RUNNING','READY')",id,job);
            var changed=alignment(job,id,false);deleteFrame(changed);return view(changed);
        });
    }
    @PostMapping("/{id}/apply")
    public Map<String,Object> apply(@PathVariable UUID job,@PathVariable UUID id,HttpServletRequest request) {
        ownedJob(job,owner(request),false);expire(job);
        return tx.execute(status -> {
            ownedJob(job,owner(request),true);var row=alignment(job,id,true);
            int version=((Number)row.get("scene_version")).intValue();var scene=tracking.scene(job,owner(request),version,false);
            if("APPLIED".equals(row.get("state")))return tracking.view(tracking.camera(job,(UUID)row.get("applied_camera_id"),false));
            if(!"READY".equals(row.get("state")))throw conflict("Wait for a successful camera alignment before applying it.");
            if(((Timestamp)row.get("created_at")).getTime()<=System.currentTimeMillis()-600000)throw conflict("Camera alignment expired. Align automatically again.");
            UUID camera=(UUID)row.get("camera_id");
            if(camera!=null) {
                var current=tracking.camera(job,camera,true);
                if(!Objects.equals(current.get("revision"),row.get("camera_revision")))throw conflict("This camera was changed while aligning. Align it again.");
            } else if(db.queryForObject("SELECT count(*) FROM room_tracking_cameras WHERE job_id=?",Long.class,job)>=16)
                throw conflict("A room can have at most 16 tracking cameras.");
            JsonNode result;
            try { result=row.get("result")==null ? null:json.readTree(row.get("result").toString()); }
            catch(java.io.IOException e) { throw new IllegalStateException("Invalid stored camera alignment result",e); }
            int width=((Number)row.get("image_width")).intValue(),height=((Number)row.get("image_height")).intValue();
            var fitted=AlignmentGeometry.validate(result,width,height,scene.navigation());UUID revision=UUID.randomUUID();
            if(camera==null) {
                camera=UUID.randomUUID();
                db.update("INSERT INTO room_tracking_cameras(id,job_id,name,scene_version,revision,image_width,image_height,points,homography,fit_error_meters,geometry) VALUES(?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?::jsonb)",
                        camera,job,row.get("name"),version,revision,width,height,encode(fitted.points()),encode(fitted.homography()),fitted.fitErrorMeters(),encode(fitted.geometry()));
            } else db.update("UPDATE room_tracking_cameras SET name=?,scene_version=?,revision=?,image_width=?,image_height=?,points=?::jsonb,homography=?::jsonb,fit_error_meters=?,geometry=?::jsonb,active_stream=NULL,last_sequence=-1,last_captured_at=NULL,snapshot='[]',snapshot_at=NULL,updated_at=now() WHERE id=? AND job_id=?",
                    row.get("name"),version,revision,width,height,encode(fitted.points()),encode(fitted.homography()),fitted.fitErrorMeters(),encode(fitted.geometry()),camera,job);
            db.update("UPDATE room_camera_alignments SET state='APPLIED',stage='applied',applied_camera_id=?,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=? AND job_id=?",camera,id,job);
            deleteFrame(row);return tracking.view(tracking.camera(job,camera,false));
        });
    }
}
