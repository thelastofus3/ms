package room;

import com.fasterxml.jackson.databind.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.sql.Timestamp;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@RestController
@RequestMapping("/v1/rooms/jobs/{job}/tracking")
public class TrackingController {
    private static final long FRESH_MS=1500, MAX_CAPTURE_AGE_MS=3000, MAX_FUTURE_MS=5000;
    private final JdbcTemplate db;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final Map<String,Navigation> navigationCache=new ConcurrentHashMap<>();

    public TrackingController(JdbcTemplate db,ObjectStorage storage,ObjectMapper json,PlatformTransactionManager manager) {
        this.db=db;this.storage=storage;this.json=json;this.tx=new TransactionTemplate(manager);
    }
    public record CameraRequest(String name,Integer sceneVersion,Integer imageWidth,Integer imageHeight,List<TrackingHomography.Pair> points) {}
    public record StopRequest(UUID streamId) {}
    public record Position(Double x,Double y,Double z) {}
    public record Person(String id,Position position,Double confidence,String positionMethod,Double uncertaintyMeters) {}
    public record Frame(Integer sceneVersion,UUID calibrationRevision,UUID streamId,Long sequence,Long capturedAt,List<Person> people) {}
    record Navigation(double[][] boundary,double floorY) {}
    record Scene(int version,Navigation navigation,String manifestKey) {}

    private String owner(HttpServletRequest request) { return (String)request.getAttribute("roomOwner"); }
    private String encode(Object value) { try { return json.writeValueAsString(value); } catch(Exception e) { throw new IllegalStateException(e); } }
    private JsonNode decode(Object value) { try { return json.readTree(value.toString()); } catch(Exception e) { throw new IllegalStateException(e); } }
    private ResponseStatusException conflict(String reason) { return new ResponseStatusException(HttpStatus.CONFLICT,reason); }

    Scene scene(UUID job,String owner,Integer expected,boolean lock) {
        var jobs=db.queryForList("SELECT state FROM room_jobs WHERE id=? AND owner=?"+(lock ? " FOR UPDATE":""),job,owner);
        if(jobs.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Room resource not found");
        var versions=db.queryForList("SELECT version,ready,manifest_key FROM room_versions WHERE job_id=? ORDER BY version DESC LIMIT 1",job);
        if(versions.isEmpty() || !"READY".equals(jobs.getFirst().get("state")) || !Boolean.TRUE.equals(versions.getFirst().get("ready")))
            throw conflict("Finish and save room calibration before tracking people.");
        var version=versions.getFirst();int number=((Number)version.get("version")).intValue();
        if(expected!=null && expected!=number) throw conflict("Room calibration changed. Reload the room and recalibrate this camera.");
        String key=version.get("manifest_key").toString();
        Navigation navigation=navigationCache.get(key);
        if(navigation==null) {
            try {
                var manifest=json.readTree(storage.read(key));var n=manifest.path("navigation");var polygon=n.path("boundary");
                if(!manifest.path("ready").asBoolean() || !polygon.isArray() || polygon.size()<3 || polygon.size()>128 || !n.path("floorY").isNumber())
                    throw new IllegalStateException("Saved room has no valid navigation floor");
                double floorY=n.path("floorY").asDouble();double[][] points=new double[polygon.size()][2];
                for(int i=0;i<points.length;i++) {
                    var p=polygon.get(i);
                    if(!p.isArray() || p.size()!=2 || !p.get(0).isNumber() || !p.get(1).isNumber()) throw new IllegalStateException("Invalid saved walking boundary");
                    points[i]=new double[]{p.get(0).asDouble(),p.get(1).asDouble()};
                    if(!TrackingHomography.finite(points[i])) throw new IllegalStateException("Invalid saved walking boundary");
                }
                if(!Double.isFinite(floorY)) throw new IllegalStateException("Invalid saved floor height");
                navigation=new Navigation(points,floorY);
                if(navigationCache.size()>=128)navigationCache.clear();
                navigationCache.put(key,navigation);
            } catch(java.io.IOException e) { throw new IllegalStateException(e); }
        }
        return new Scene(number,navigation,key);
    }
    Map<String,Object> camera(UUID job,UUID camera,boolean lock) {
        var rows=db.queryForList("SELECT * FROM room_tracking_cameras WHERE id=? AND job_id=?"+(lock ? " FOR UPDATE":""),camera,job);
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Tracking camera not found");
        return rows.getFirst();
    }
    Map<String,Object> view(Map<String,Object> row) {
        var result=new LinkedHashMap<String,Object>();
        result.put("id",row.get("id"));result.put("name",row.get("name"));result.put("sceneVersion",row.get("scene_version"));
        result.put("revision",row.get("revision"));result.put("imageWidth",row.get("image_width"));result.put("imageHeight",row.get("image_height"));
        result.put("points",decode(row.get("points")));result.put("homography",decode(row.get("homography")));
        result.put("geometry",row.get("geometry")==null ? null:decode(row.get("geometry")));
        result.put("fitErrorMeters",row.get("fit_error_meters"));result.put("updatedAt",((Timestamp)row.get("updated_at")).toInstant().toString());
        return result;
    }
    private TrackingHomography.Fit calibration(CameraRequest body) {
        if(body==null || body.name()==null || body.name().trim().isEmpty() || body.name().trim().length()>100)
            throw new IllegalArgumentException("Give this camera a name of 1 to 100 characters.");
        if(body.sceneVersion()==null || body.sceneVersion()<1 || body.imageWidth()==null || body.imageHeight()==null ||
                body.imageWidth()<32 || body.imageWidth()>16384 || body.imageHeight()<32 || body.imageHeight()>16384)
            throw new IllegalArgumentException("Supply the saved room version and camera image dimensions.");
        return TrackingHomography.fit(body.points());
    }

    @GetMapping("/cameras")
    public List<Map<String,Object>> cameras(@PathVariable UUID job,HttpServletRequest request) {
        scene(job,owner(request),null,false);
        return db.queryForList("SELECT * FROM room_tracking_cameras WHERE job_id=? ORDER BY created_at",job).stream().map(this::view).toList();
    }
    @PostMapping("/cameras")
    public Map<String,Object> create(@PathVariable UUID job,@RequestBody CameraRequest body,HttpServletRequest request) {
        return tx.execute(status -> {
            scene(job,owner(request),body==null ? null:body.sceneVersion(),true);
            var fit=calibration(body);
            if(db.queryForObject("SELECT count(*) FROM room_tracking_cameras WHERE job_id=?",Long.class,job)>=16)
                throw new IllegalArgumentException("A room can have at most 16 tracking cameras.");
            UUID id=UUID.randomUUID(),revision=UUID.randomUUID();
            db.update("INSERT INTO room_tracking_cameras(id,job_id,name,scene_version,revision,image_width,image_height,points,homography,fit_error_meters) VALUES(?,?,?,?,?,?,?,?::jsonb,?::jsonb,?)",
                    id,job,body.name().trim(),body.sceneVersion(),revision,body.imageWidth(),body.imageHeight(),encode(body.points()),encode(fit.homography()),fit.fitErrorMeters());
            return view(camera(job,id,false));
        });
    }
    @PostMapping("/cameras/{id}")
    public Map<String,Object> update(@PathVariable UUID job,@PathVariable UUID id,@RequestBody CameraRequest body,HttpServletRequest request) {
        return tx.execute(status -> {
            scene(job,owner(request),body==null ? null:body.sceneVersion(),true);camera(job,id,true);
            var fit=calibration(body);
            db.update("UPDATE room_tracking_cameras SET name=?,scene_version=?,revision=?,image_width=?,image_height=?,points=?::jsonb,homography=?::jsonb,fit_error_meters=?,geometry=NULL,active_stream=NULL,last_sequence=-1,last_captured_at=NULL,snapshot='[]',snapshot_at=NULL,updated_at=now() WHERE id=? AND job_id=?",
                    body.name().trim(),body.sceneVersion(),UUID.randomUUID(),body.imageWidth(),body.imageHeight(),encode(body.points()),encode(fit.homography()),fit.fitErrorMeters(),id,job);
            return view(camera(job,id,false));
        });
    }
    @PostMapping("/cameras/{id}/start")
    public Map<String,Object> start(@PathVariable UUID job,@PathVariable UUID id,HttpServletRequest request) {
        return tx.execute(status -> {
            var scene=scene(job,owner(request),null,true);var camera=camera(job,id,true);
            if(((Number)camera.get("scene_version")).intValue()!=scene.version())throw conflict("Recalibrate this camera for the current room version.");
            UUID stream=UUID.randomUUID();
            db.update("UPDATE room_tracking_cameras SET active_stream=?,last_sequence=-1,last_captured_at=NULL,snapshot='[]',snapshot_at=NULL WHERE id=? AND job_id=?",stream,id,job);
            return Map.of("streamId",stream);
        });
    }
    @PostMapping("/cameras/{id}/stop")
    public Map<String,Object> stop(@PathVariable UUID job,@PathVariable UUID id,@RequestBody StopRequest body,HttpServletRequest request) {
        return tx.execute(status -> {
            scene(job,owner(request),null,true);camera(job,id,true);
            if(body==null || body.streamId()==null)throw new IllegalArgumentException("Supply the camera stream identifier.");
            // A delayed stop from another tab must never stop a replacement stream.
            db.update("UPDATE room_tracking_cameras SET active_stream=NULL,last_sequence=-1,last_captured_at=NULL,snapshot='[]',snapshot_at=NULL WHERE id=? AND job_id=? AND active_stream=?",id,job,body.streamId());
            return Map.of("stopped",true);
        });
    }
    @PostMapping("/cameras/{id}/frames")
    public Map<String,Object> frame(@PathVariable UUID job,@PathVariable UUID id,@RequestBody Frame body,HttpServletRequest request) {
        return tx.execute(status -> {
            var scene=scene(job,owner(request),body==null ? null:body.sceneVersion(),true);var camera=camera(job,id,true);
            if(body==null || body.sceneVersion()==null || body.calibrationRevision()==null || body.streamId()==null || body.sequence()==null || body.capturedAt()==null || body.people()==null || body.people().size()>5 || body.sequence()<0)
                throw new IllegalArgumentException("Supply scene version, camera revision, stream, sequence, capture time and at most five people.");
            if(((Number)camera.get("scene_version")).intValue()!=scene.version() || !body.calibrationRevision().equals(camera.get("revision")) || !body.streamId().equals(camera.get("active_stream")))
                throw conflict("This camera stream or calibration is no longer current.");
            long now=System.currentTimeMillis(),captured=body.capturedAt();
            if(captured<now-MAX_CAPTURE_AGE_MS || captured>now+MAX_FUTURE_MS)
                throw new IllegalArgumentException("The detection capture time is stale or ahead of the server clock.");
            if(body.sequence()<=((Number)camera.get("last_sequence")).longValue() || camera.get("last_captured_at")!=null && captured<((Number)camera.get("last_captured_at")).longValue())
                throw conflict("An older detection frame has already been superseded.");
            var people=new ArrayList<Person>();var ids=new HashSet<String>();
            for(var person:body.people()) {
                if(person==null || person.id()==null || !person.id().matches("[A-Za-z0-9_-]{1,64}") || !ids.add(person.id()) || person.position()==null || person.confidence()==null)
                    throw new IllegalArgumentException("Use distinct anonymous track identifiers and complete positions.");
                var p=person.position();double confidence=person.confidence();
                if(p.x()==null || p.y()==null || p.z()==null || !TrackingHomography.finite(p.x(),p.y(),p.z(),confidence) || confidence<0 || confidence>1)
                    throw new IllegalArgumentException("Detection coordinates and confidence must be finite and confidence must be between zero and one.");
                if(person.positionMethod()!=null && !Set.of("floor","estimated").contains(person.positionMethod()))
                    throw new IllegalArgumentException("Position method must be floor or estimated.");
                if(person.uncertaintyMeters()!=null && (!Double.isFinite(person.uncertaintyMeters()) || person.uncertaintyMeters()<0 || person.uncertaintyMeters()>3) ||
                        "estimated".equals(person.positionMethod()) && person.uncertaintyMeters()==null)
                    throw new IllegalArgumentException("Estimated positions require finite uncertainty between zero and three metres.");
                if(Math.abs(p.y()-scene.navigation().floorY())>0.15 || !nearFootprint(p.x(),p.z(),scene.navigation().boundary()))
                    throw new IllegalArgumentException("Detection positions must lie on or near the saved room's walking floor.");
                if(confidence>=0.35)people.add(person);
            }
            db.update("UPDATE room_tracking_cameras SET last_sequence=?,last_captured_at=?,snapshot=?::jsonb,snapshot_at=now() WHERE id=? AND job_id=?",body.sequence(),captured,encode(people),id,job);
            return Map.of("accepted",true);
        });
    }
    @GetMapping
    public Map<String,Object> latest(@PathVariable UUID job,@RequestParam int sceneVersion,HttpServletRequest request) {
        var scene=scene(job,owner(request),sceneVersion,false);long now=System.currentTimeMillis();var cameras=new ArrayList<Map<String,Object>>();
        for(var row:db.queryForList("SELECT * FROM room_tracking_cameras WHERE job_id=? AND scene_version=? AND active_stream IS NOT NULL AND snapshot_at>now()-interval '1500 milliseconds'",job,scene.version())) {
            if(row.get("last_captured_at")==null)continue;
            long received=((Timestamp)row.get("snapshot_at")).getTime(),captured=((Number)row.get("last_captured_at")).longValue();
            long age=Math.max(0,Math.max(now-received,now-captured));if(age>FRESH_MS)continue;
            var value=new LinkedHashMap<String,Object>();value.put("cameraId",row.get("id"));value.put("name",row.get("name"));value.put("calibrationRevision",row.get("revision"));
            value.put("streamId",row.get("active_stream"));value.put("ageMs",age);value.put("people",decode(row.get("snapshot")));cameras.add(value);
        }
        return Map.of("sceneVersion",scene.version(),"serverTime",now,"cameras",cameras);
    }

    private static boolean nearFootprint(double x,double z,double[][] boundary) {
        boolean inside=false;
        for(int i=0,j=boundary.length-1;i<boundary.length;j=i++) {
            var a=boundary[j];var b=boundary[i];
            if((a[1]>z)!=(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
            double dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz;
            double t=length==0 ? 0:Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/length));
            if(Math.hypot(x-(a[0]+dx*t),z-(a[1]+dz*t))<=0.25)return true;
        }
        return inside;
    }
}
