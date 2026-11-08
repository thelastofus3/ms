package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RoomQuotaAdmissionTest {
    JdbcTemplate db;
    DataSourceTransactionManager manager;
    ObjectStorage storage;
    RoomQuotaService quota;
    RoomController controller;
    MockHttpServletRequest request;
    ObjectMapper json=new ObjectMapper();
    @BeforeEach void setup() {
        var source=new JdbcDataSource();
        source.setURL("jdbc:h2:mem:quota-"+UUID.randomUUID()+";MODE=PostgreSQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        var nativeDb=new JdbcTemplate(source); db=spy(nativeDb); manager=new DataSourceTransactionManager(source);
        // H2 cannot parse PostgreSQL's targeted ON CONFLICT. Keep real row/state
        // behavior while removing only that dialect clause in this fixture.
        doAnswer(call -> nativeDb.update(call.<String>getArgument(0).replace(" ON CONFLICT(owner,idempotency_key) DO NOTHING", ""),
                (Object[])call.getRawArguments()[1]))
            .when(db).update(contains("ON CONFLICT(owner,idempotency_key)"),any(Object[].class));
        db.execute("CREATE TABLE room_uploads(id uuid PRIMARY KEY,owner text,media text,kind text DEFAULT 'splat',sealed boolean DEFAULT false,inputs_pinned boolean DEFAULT false,api_upload boolean DEFAULT false,expires_at timestamp with time zone,discarded_at timestamp with time zone,cleaned_at timestamp with time zone,created_at timestamp with time zone DEFAULT now())");
        db.execute("CREATE TABLE room_jobs(id uuid PRIMARY KEY,owner text,upload_id uuid,name text,profile text DEFAULT 'local',idempotency_key text,state text DEFAULT 'QUEUED',kind text DEFAULT 'splat',stage text DEFAULT 'queued',progress integer DEFAULT 0,error text,diagnostics text DEFAULT '{}',cancel_requested boolean DEFAULT false,created_at timestamp with time zone DEFAULT now(),updated_at timestamp with time zone DEFAULT now(),UNIQUE(owner,idempotency_key))");
        db.execute("CREATE TABLE room_versions(job_id uuid,version integer,manifest_key text,ready boolean)");
        db.execute("CREATE TABLE room_quota_defaults(id integer PRIMARY KEY,storage_limit_bytes bigint,pending_upload_limit integer,active_job_limit integer)");
        db.execute("INSERT INTO room_quota_defaults VALUES(1,100,1,1)");
        db.execute("CREATE TABLE room_quota_owners(owner text PRIMARY KEY,storage_limit_bytes bigint,pending_upload_limit integer,active_job_limit integer,initialized boolean DEFAULT false)");
        db.execute("INSERT INTO room_quota_owners(owner,initialized) VALUES('owner',true)");
        db.execute("CREATE TABLE room_storage_allocations(object_key text PRIMARY KEY,owner text,resource_kind text,resource_id uuid,maximum_bytes bigint,confirmed_bytes bigint,released_at timestamp with time zone,created_at timestamp with time zone DEFAULT now(),updated_at timestamp with time zone DEFAULT now())");
        storage=mock(ObjectStorage.class); when(storage.putUrl(anyString())).thenReturn("http://storage/upload");
        quota=new RoomQuotaService(db,storage,json,manager);
        controller=new RoomController(db,storage,json,manager,new InputPinningService(db,storage,json,manager,quota),quota);
        request=new MockHttpServletRequest(); request.setAttribute("roomOwner","owner");
        request.setAttribute("roomAccount",new AuthService.Account("owner","admin",Role.ADMIN,false));
    }
    UUID upload(boolean sealed) {
        UUID id=UUID.randomUUID();
        db.update("INSERT INTO room_uploads(id,owner,media,sealed,inputs_pinned) VALUES(?,'owner','[]',?,?)",id,sealed,sealed);
        return id;
    }
    void exhausted(Runnable action) {
        var error=assertThrows(ResponseStatusException.class,action::run);
        assertEquals(409,error.getStatusCode().value());
    }
    @Test void declarationCannotAllocateTwoCopiesBeyondStorageAllowance() {
        exhausted(()->controller.upload(new RoomController.UploadRequest(List.of(new RoomController.Media("scene.ply",51,"application/octet-stream")),"splat"),request));
        assertEquals(0,db.queryForObject("SELECT count(*) FROM room_uploads",Integer.class));
        verifyNoInteractions(storage);
    }
    @Test void pendingUploadLimitRejectsAnotherDeclarationBeforeStorageWork() {
        upload(false);
        exhausted(()->controller.upload(new RoomController.UploadRequest(List.of(new RoomController.Media("scene.ply",10,"application/octet-stream")),"splat"),request));
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_uploads",Integer.class));
        verifyNoInteractions(storage);
    }
    @Test void activeJobLimitCountsRunningCancellationButNotTerminalJobs() {
        UUID upload=upload(true), job=UUID.randomUUID();
        db.update("INSERT INTO room_jobs(id,owner,upload_id,name,idempotency_key,state,cancel_requested) VALUES(?,'owner',?,'old','old','RUNNING',true)",job,upload);
        exhausted(()->controller.create(new RoomController.JobRequest(upload,"new","local","new"),request));
        db.update("UPDATE room_jobs SET state='FAILED' WHERE id=?",job);
        assertEquals(202,controller.create(new RoomController.JobRequest(upload,"new","local","new"),request).getStatusCode().value());
    }
    @Test void matchingIdempotentJobSucceedsAtFullLimitAndChangedInputsConflict() {
        UUID upload=upload(true);
        var body=new RoomController.JobRequest(upload,"scene","local","same");
        var first=controller.create(body,request);
        assertEquals(first.getBody().get("id"),controller.create(body,request).getBody().get("id"));
        exhausted(()->controller.create(new RoomController.JobRequest(upload,"other","local","same"),request));
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_jobs",Integer.class));
    }
    @Test void declarationReturnsOnlyRelativeTransfersWithTwoDurableAllocations() {
        var result=controller.upload(new RoomController.UploadRequest(List.of(new RoomController.Media("scene.ply",10,"application/octet-stream")),"splat"),request);
        var operations=(List<Map<String,Object>>)result.get("files");
        assertTrue(operations.getFirst().get("url").toString().startsWith("/v1/rooms/uploads/"));
        assertEquals(20L,db.queryForObject("SELECT SUM(maximum_bytes) FROM room_storage_allocations",Long.class));
        assertEquals(2,db.queryForObject("SELECT count(*) FROM room_storage_allocations",Integer.class));
        verifyNoInteractions(storage);
    }
    @Test void exactKeyReservationIsIdempotentAndChargesRemainAfterFailure() {
        UUID upload=UUID.randomUUID(); String key="inputs/"+upload+"/file";
        quota.reserve("owner","upload",upload,Map.of(key,60L));
        quota.reserve("owner","upload",upload,Map.of(key,60L));
        assertEquals(60L,quota.usage("owner").get("storageChargedBytes"));
        assertThrows(RoomQuotaService.QuotaExceeded.class,()->quota.reserve("owner","upload",upload,Map.of(key+"2",41L)));
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_storage_allocations",Integer.class));
        when(storage.exists(key)).thenReturn(true);
        assertThrows(IllegalStateException.class,()->quota.releaseVerifiedAbsent("owner",key));
        assertEquals(60L,quota.usage("owner").get("storageChargedBytes"));
        when(storage.exists(key)).thenReturn(false);
        quota.releaseVerifiedAbsent("owner",key); quota.releaseVerifiedAbsent("owner",key);
        assertEquals(0L,quota.usage("owner").get("storageChargedBytes"));
    }
    @Test void reducingLimitsPreservesExistingChargeButDeniesNewAllocation() {
        UUID id=UUID.randomUUID(); String key="inputs/"+id+"/file";
        quota.reserve("owner","upload",id,Map.of(key,80L));
        quota.updateLimits("owner",50L,null,null);
        quota.reserve("owner","upload",id,Map.of(key,80L));
        assertEquals(80L,quota.usage("owner").get("storageChargedBytes"));
        assertThrows(RoomQuotaService.QuotaExceeded.class,()->quota.reserve("owner","upload",id,Map.of(key+"2",1L)));
    }
    @Test void expiryRejectsUnattachedSessionsButPreservesAttachedRetry() {
        UUID id=upload(true);
        db.update("UPDATE room_uploads SET api_upload=true,expires_at=DATEADD('HOUR',-1,CURRENT_TIMESTAMP) WHERE id=?",id);
        var row=db.queryForMap("SELECT * FROM room_uploads WHERE id=?",id);
        assertEquals(410,assertThrows(ResponseStatusException.class,()->quota.ensureAvailable(row)).getStatusCode().value());
        db.update("INSERT INTO room_jobs(id,owner,upload_id,name,idempotency_key,state) VALUES(?,'owner',?,'old','old','FAILED')",UUID.randomUUID(),id);
        quota.ensureAvailable(row);
        db.update("UPDATE room_uploads SET discarded_at=CURRENT_TIMESTAMP WHERE id=?",id);
        assertThrows(ResponseStatusException.class,()->quota.ensureAvailable(db.queryForMap("SELECT * FROM room_uploads WHERE id=?",id)));
    }
    @Test void bootstrapChargesActualOrphanInputsAndOutputsWithoutChangingResourceRows() {
        UUID id=upload(true), job=UUID.randomUUID();
        db.update("INSERT INTO room_jobs(id,owner,upload_id,name,idempotency_key) VALUES(?,'owner',?,'old','old')",job,id);
        db.update("UPDATE room_quota_owners SET initialized=false WHERE owner='owner'");
        when(storage.objects(anyString())).thenReturn(Map.of());
        when(storage.objects("inputs/"+id+"/")).thenReturn(Map.of("inputs/"+id+"/orphan",11L));
        when(storage.objects("outputs/"+job+"/")).thenReturn(Map.of("outputs/"+job+"/asset",20L));
        assertEquals(31L,quota.usage("owner").get("storageChargedBytes"));
        assertEquals(31L,quota.usage("owner").get("storageConfirmedBytes"));
        assertEquals("[]",db.queryForObject("SELECT media FROM room_uploads WHERE id=?",String.class,id));
        verify(storage,never()).delete(anyString());
    }
    @Test void reservationCannotBeRolledBackInsidePublicationTransaction() {
        var transaction=new org.springframework.transaction.support.TransactionTemplate(manager);
        UUID id=UUID.randomUUID();
        assertThrows(IllegalStateException.class,()->transaction.executeWithoutResult(status -> quota.reserve("owner","upload",id,Map.of("inputs/"+id+"/file",10L))));
        assertEquals(0,db.queryForObject("SELECT count(*) FROM room_storage_allocations",Integer.class));
    }
    @Test void administratorCanChangeOnlyRequestedLimitAndOtherRolesCannot() {
        UUID administrator=UUID.randomUUID(),target=UUID.randomUUID();
        db.execute("CREATE TABLE room_accounts(id uuid PRIMARY KEY,role text,disabled boolean DEFAULT false)");
        db.update("INSERT INTO room_accounts(id,role) VALUES(?,'ADMIN'),(?,'SPLAT_UPLOADER')",administrator,target);
        when(storage.objects(anyString())).thenReturn(Map.of());
        var api=new RoomQuotaController(quota,db);
        var actor=new MockHttpServletRequest();
        actor.setAttribute("roomAccount",new AuthService.Account(administrator.toString(),"admin",Role.ADMIN,false));
        var result=api.update(target,new RoomQuotaController.Limits(200L,null,null),actor);
        assertEquals(200L,result.get("storageLimitBytes")); assertEquals(1,result.get("pendingUploadLimit"));
        assertEquals(100L,quota.limits("owner").get("storageLimitBytes"));
        actor.setAttribute("roomAccount",new AuthService.Account(target.toString(),"splat",Role.SPLAT_UPLOADER,false));
        assertEquals(403,assertThrows(ResponseStatusException.class,()->api.update(target,new RoomQuotaController.Limits(10L,null,null),actor)).getStatusCode().value());
        var body=(Map<?,?>)new ApiErrors().quota(new RoomQuotaService.QuotaExceeded("storage")).getBody();
        assertEquals("QUOTA_EXCEEDED",body.get("code")); assertEquals("storage",body.get("dimension"));
    }
    @Test void cleanedTombstonesLeaveUsageSummariesAndRemainUnavailable() {
        UUID id=upload(false); db.update("UPDATE room_uploads SET api_upload=true,discarded_at=CURRENT_TIMESTAMP,cleaned_at=CURRENT_TIMESTAMP WHERE id=?",id);
        assertEquals(List.of(),quota.usage("owner").get("uploads"));
        assertThrows(ResponseStatusException.class,()->quota.ensureAvailable(db.queryForMap("SELECT * FROM room_uploads WHERE id=?",id)));
    }
    Normalization.Calibration calibration() {
        var p0=new Normalization.Point(0,0,0); var px=new Normalization.Point(1,0,0); var pz=new Normalization.Point(0,0,1);
        return new Normalization.Calibration(List.of(p0,px),1,List.of(p0,px,pz),
                List.of(p0,new Normalization.Point(2,0,0),new Normalization.Point(2,0,2),new Normalization.Point(0,0,2)),
                new Normalization.Point(.5,0,.5),false,true,List.of(),List.of());
    }
    @Test void calibrationReservesOutsideResourceTransactionBeforeAnyObjectWrite() {
        UUID upload=upload(true),job=UUID.randomUUID();
        db.update("INSERT INTO room_jobs(id,owner,upload_id,name,idempotency_key,state,kind) VALUES(?,'owner',?,'scene','calibrate','READY','capture')",job,upload);
        String key="outputs/"+job+"/attempt/manifest.json";
        db.update("INSERT INTO room_versions VALUES(?,1,?,false)",job,key);
        when(storage.read(key)).thenReturn("{\"previewCamera\":[1,0,0,0,0,1,0,0,0,0,1,0,0,1,3,1]}");
        var mockQuota=mock(RoomQuotaService.class);
        var api=new RoomController(db,storage,json,manager,new InputPinningService(db,storage,json,manager,mockQuota),mockQuota);
        doAnswer(call -> {
            assertFalse(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive());
            throw new RoomQuotaService.QuotaExceeded("storage");
        }).when(mockQuota).reserve(eq("owner"),eq("calibration"),eq(job),anyMap());
        assertThrows(RoomQuotaService.QuotaExceeded.class,()->api.calibrate(job,calibration(),request));
        verify(storage,never()).write(anyString(),anyString());
        doAnswer(call -> { db.update("INSERT INTO room_versions VALUES(?,2,?,true)",job,"outputs/"+job+"/attempt/other.json"); return null; })
            .when(mockQuota).reserve(eq("owner"),eq("calibration"),eq(job),anyMap());
        assertEquals(409,assertThrows(ResponseStatusException.class,()->api.calibrate(job,calibration(),request)).getStatusCode().value());
        verify(storage,never()).write(anyString(),anyString());
        verify(mockQuota).releaseVerifiedAbsent(eq("owner"),anyString());
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"complete","create","backfill"})
    void deferredLegacyInventoryMustCommitBeforeFirstCopyAndSurviveSecondFailure(String entry) throws Exception {
        UUID id=UUID.randomUUID(); String first="inputs/"+id+"/first", second="inputs/"+id+"/second";
        String files=json.writeValueAsString(List.of(Map.of("key",first,"size",10),Map.of("key",second,"size",10)));
        db.update("INSERT INTO room_uploads(id,owner,media,sealed,inputs_pinned,kind) VALUES(?,'owner',?,true,false,'capture')",id,files);
        db.update("UPDATE room_quota_owners SET initialized=false WHERE owner='owner'");
        when(storage.objects(anyString())).thenReturn(Map.of());
        var observer=new JdbcTemplate(db.getDataSource()); var seen=new java.util.concurrent.atomic.AtomicLong(-1);
        String destination=InputPinningService.snapshotKey(id,first);
        when(storage.snapshotOnce(eq(first),eq(10L),eq(destination))).thenAnswer(call -> {
            seen.set(independentAllocationCount(destination));
            return new ObjectStorage.Snapshot(destination,10,"a".repeat(64));
        });
        when(storage.snapshotOnce(eq(second),eq(10L),anyString())).thenThrow(software.amazon.awssdk.services.s3.model.S3Exception.builder().statusCode(503).build());
        if(entry.equals("backfill")) new InputPinningService(db,storage,json,manager,quota).run(null);
        else assertThrows(software.amazon.awssdk.services.s3.model.S3Exception.class,()-> {
            if(entry.equals("complete")) controller.complete(id,new RoomController.Completion(List.of()),request);
            else controller.create(new RoomController.JobRequest(id,"legacy","local","legacy"),request);
        });
        assertEquals(1L,seen.get(),"The first S3 copy must see a committed private allocation through a separate connection");
        assertEquals(4,observer.queryForObject("SELECT count(*) FROM room_storage_allocations WHERE owner='owner'",Integer.class));
        assertEquals(true,observer.queryForObject("SELECT initialized FROM room_quota_owners WHERE owner='owner'",Boolean.class));
        assertEquals(false,db.queryForObject("SELECT inputs_pinned FROM room_uploads WHERE id=?",Boolean.class,id));
    }
    @Test void deferredLegacyGatewayInventoryMustCommitBeforeAWriteThatFails() throws Exception {
        UUID id=UUID.randomUUID(); String key="inputs/"+id+"/file";
        db.update("INSERT INTO room_uploads(id,owner,media,sealed,inputs_pinned,kind) VALUES(?,'owner',?,false,false,'splat')",id,
                json.writeValueAsString(List.of(Map.of("key",key,"size",10))));
        db.update("UPDATE room_quota_owners SET initialized=false WHERE owner='owner'");
        when(storage.objects(anyString())).thenReturn(Map.of());
        var observer=new JdbcTemplate(db.getDataSource()); var seen=new java.util.concurrent.atomic.AtomicLong(-1);
        doAnswer(call -> {
            seen.set(independentAllocationCount(key));
            throw software.amazon.awssdk.services.s3.model.S3Exception.builder().statusCode(503).build();
        }).when(storage).putInput(eq(key),any(byte[].class));
        request.setContent(new byte[10]);
        var gateway=new RoomUploadTransferController(db,storage,json,manager,quota);
        assertThrows(software.amazon.awssdk.services.s3.model.S3Exception.class,()->gateway.single(id,0,request));
        assertEquals(1L,seen.get(),"The first S3 write must see its committed allocation");
        assertEquals(2,observer.queryForObject("SELECT count(*) FROM room_storage_allocations WHERE owner='owner'",Integer.class));
        assertEquals(true,observer.queryForObject("SELECT initialized FROM room_quota_owners WHERE owner='owner'",Boolean.class));
    }
    private long independentAllocationCount(String key) throws Exception {
        // Bypass JdbcTemplate/DataSourceUtils, which would reuse the caller's
        // thread-bound transaction even with a second JdbcTemplate instance.
        try(var connection=db.getDataSource().getConnection();
            var statement=connection.prepareStatement("SELECT count(*) FROM room_storage_allocations WHERE object_key=?")) {
            connection.setAutoCommit(true); statement.setString(1,key);
            try(var result=statement.executeQuery()) { assertTrue(result.next()); return result.getLong(1); }
        }
    }
}
