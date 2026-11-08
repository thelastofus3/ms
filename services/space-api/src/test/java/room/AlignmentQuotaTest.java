package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.TransactionSystemException;
import org.springframework.transaction.support.DefaultTransactionStatus;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import software.amazon.awssdk.services.s3.model.S3Exception;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class AlignmentQuotaTest {
    JdbcTemplate db;
    ObjectStorage storage;
    RoomQuotaService quota;
    AlignmentController controller;
    MockHttpServletRequest request;
    final UUID job=UUID.randomUUID();
    final String owner=UUID.randomUUID().toString();
    final Map<String,byte[]> objects=new HashMap<>();
    final Map<String,Long> allocations=new HashMap<>();
    final Map<String,Long> confirmed=new HashMap<>();
    boolean unknownCommit, deletionError;

    @BeforeEach void setup() {
        var source=new JdbcDataSource();
        source.setURL("jdbc:h2:mem:alignment-quota-"+UUID.randomUUID()+";MODE=PostgreSQL;DB_CLOSE_DELAY=-1");
        db=new JdbcTemplate(source) {
            @Override public List<Map<String,Object>> queryForList(String sql,Object... args) {
                // Expiration's PostgreSQL UPDATE RETURNING is outside these admission/cleanup cases.
                if(sql.contains("UPDATE room_camera_alignments a")) return List.of();
                return super.queryForList(sql,args);
            }
        };
        db.execute("CREATE TABLE room_jobs(id uuid PRIMARY KEY,owner text,state text)");
        db.execute("CREATE TABLE room_tracking_cameras(id uuid,job_id uuid,revision uuid)");
        db.execute("CREATE TABLE room_camera_alignments(id uuid PRIMARY KEY,job_id uuid,camera_id uuid,camera_revision uuid,"+
                "name text,scene_version int,image_width int,image_height int,frame_key text,manifest_key text,state text DEFAULT 'QUEUED',"+
                "stage text DEFAULT 'queued',error text,progress text,result text,lease_token uuid,lease_until timestamp with time zone,"+
                "frame_deleted_at timestamp,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),applied_camera_id uuid)");
        db.update("INSERT INTO room_jobs VALUES(?,?,'READY')",job,owner);
        var manager=new DataSourceTransactionManager(source) {
            @Override protected void doCommit(DefaultTransactionStatus status) {
                super.doCommit(status);
                if(unknownCommit) throw new TransactionSystemException("Commit acknowledgement lost");
            }
        };
        storage=mock(ObjectStorage.class);quota=mock(RoomQuotaService.class);
        doAnswer(call -> {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive(),"Reservation joined the resource transaction");
            allocations.putAll(call.<Map<String,Long>>getArgument(3));return null;
        }).when(quota).reserve(anyString(),anyString(),any(UUID.class),anyMap());
        doAnswer(call -> {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive(),"Confirmation joined the resource transaction");
            String key=call.getArgument(1);long bytes=call.getArgument(2);
            assertEquals((long)objects.get(key).length,bytes);assertEquals(allocations.get(key),(Long)bytes);
            confirmed.put(key,bytes);return null;
        }).when(quota).confirm(anyString(),anyString(),anyLong());
        doAnswer(call -> {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive(),"Release joined the resource transaction");
            String key=call.getArgument(1);assertFalse(objects.containsKey(key),"Released stored frame");
            allocations.remove(key);return null;
        }).when(quota).releaseVerifiedAbsent(anyString(),anyString());
        doAnswer(call -> {objects.put(call.getArgument(0),call.getArgument(1));return null;}).when(storage).writeJpeg(anyString(),any(byte[].class));
        doAnswer(call -> {if(deletionError)throw new IllegalStateException("Deletion unavailable");objects.remove(call.getArgument(0));return null;}).when(storage).delete(anyString());
        when(storage.size(anyString())).thenAnswer(call -> {
            var bytes=objects.get(call.<String>getArgument(0));
            if(bytes==null)throw S3Exception.builder().statusCode(404).message("absent").build();
            return (long)bytes.length;
        });
        var tracking=mock(TrackingController.class);
        when(tracking.scene(eq(job),eq(owner),any(),anyBoolean())).thenReturn(new TrackingController.Scene(1,null,"outputs/scene/manifest.json"));
        controller=new AlignmentController(db,storage,new ObjectMapper(),tracking,manager,quota);
        request=new MockHttpServletRequest();request.setAttribute("roomOwner",owner);
    }

    AlignmentController.Request body() throws Exception {
        var output=new ByteArrayOutputStream();ImageIO.write(new BufferedImage(32,32,BufferedImage.TYPE_INT_RGB),"jpg",output);
        return new AlignmentController.Request("Camera",null,1,32,32,"data:image/jpeg;base64,"+Base64.getEncoder().encodeToString(output.toByteArray()));
    }
    UUID frame(String state,boolean alreadyDeleted) {
        UUID id=UUID.randomUUID();String key="camera-alignments/"+job+"/"+id+".jpg";
        allocations.put(key,4L);if(!alreadyDeleted)objects.put(key,new byte[]{1,2,3,4});
        db.update("INSERT INTO room_camera_alignments(id,job_id,name,scene_version,image_width,image_height,frame_key,manifest_key,state,frame_deleted_at) VALUES(?,?,'Camera',1,32,32,?,'outputs/manifest.json',?,?)",
                id,job,key,state,alreadyDeleted ? java.sql.Timestamp.from(java.time.Instant.now()):null);
        return id;
    }

    @Test void quotaRefusalPreventsFrameWriteAndAlignmentInsertion() throws Exception {
        doThrow(new RoomQuotaService.QuotaExceeded("storage")).when(quota).reserve(anyString(),anyString(),any(UUID.class),anyMap());
        assertThrows(RoomQuotaService.QuotaExceeded.class,() -> controller.create(job,body(),request));
        assertTrue(objects.isEmpty());
        assertEquals(0,db.queryForObject("SELECT count(*) FROM room_camera_alignments",Integer.class));
    }
    @Test void frameReservationCommitsBeforeResourceTransactionAndWrite() throws Exception {
        doAnswer(call -> {
            String key=call.getArgument(0);byte[] bytes=call.getArgument(1);
            assertEquals((long)bytes.length,allocations.get(key));objects.put(key,bytes);return null;
        }).when(storage).writeJpeg(anyString(),any(byte[].class));
        controller.create(job,body(),request);
        assertEquals(1,allocations.size());assertEquals(1,objects.size());
    }
    @Test void unknownCommitRetainsTheReferencedFrameAndItsCharge() throws Exception {
        unknownCommit=true;
        assertThrows(TransactionSystemException.class,() -> controller.create(job,body(),request));
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_camera_alignments",Integer.class));
        assertEquals(1,objects.size());assertEquals(1,allocations.size());
    }
    @Test void settledFrameCleanupReleasesOnlyAfterDeletionAndConfirmedAbsence() {
        UUID id=frame("FAILED",false);
        controller.status(job,id,request);
        assertTrue(objects.isEmpty());assertTrue(allocations.isEmpty());
        controller.status(job,id,request);
        assertTrue(allocations.isEmpty());
    }
    @Test void failedDeletionRetainsStorageCharge() {
        UUID id=frame("CANCELLED",false);deletionError=true;
        controller.status(job,id,request);
        assertEquals(1,objects.size());assertEquals(1,allocations.size());
    }
    @Test void localizerDeletedReadyFrameCanBeReconciledWithoutDeletingAReferencedLiveFrame() {
        UUID id=frame("READY",true);
        controller.status(job,id,request);
        assertTrue(allocations.isEmpty());
        UUID live=frame("RUNNING",false);
        controller.status(job,live,request);
        assertEquals(1,objects.size());assertEquals(1,allocations.size());
    }
    @Test void cancellationSettlesBeforeFrameDeletionAndAllocationRelease() {
        UUID id=frame("RUNNING",false);
        controller.cancel(job,id,request);
        assertEquals("CANCELLED",db.queryForObject("SELECT state FROM room_camera_alignments WHERE id=?",String.class,id));
        assertTrue(objects.isEmpty());assertTrue(allocations.isEmpty());
    }
    @Test void absentFrameAllocationReleaseIsRetriedIfReconciliationFailed() {
        UUID id=frame("FAILED",false);
        doThrow(new IllegalStateException("Quota database unavailable"))
                .doAnswer(call -> {allocations.remove(call.<String>getArgument(1));return null;})
                .when(quota).releaseVerifiedAbsent(anyString(),anyString());
        controller.status(job,id,request);
        assertTrue(objects.isEmpty());assertEquals(1,allocations.size());
        controller.status(job,id,request);
        assertTrue(allocations.isEmpty());
    }
    @Test void successfulFrameWriteConfirmsExactBytesWithoutChangingItsReservation() throws Exception {
        controller.create(job,body(),request);
        assertEquals(allocations,confirmed);
        assertEquals(1,confirmed.size());
    }
    @Test void uncertainFrameWriteRetainsAnUnconfirmedAllocation() throws Exception {
        doAnswer(call -> {objects.put(call.getArgument(0),call.getArgument(1));throw new IllegalStateException("Uncertain frame write");})
                .when(storage).writeJpeg(anyString(),any(byte[].class));
        assertThrows(IllegalStateException.class,() -> controller.create(job,body(),request));
        assertEquals(1,objects.size());assertEquals(1,allocations.size());assertTrue(confirmed.isEmpty());
    }
}
