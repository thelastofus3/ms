package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Only an explicitly supplied disposable PostgreSQL URL is used. */
class RoomQuotaPostgresTest {
    JdbcTemplate admin,db;
    String schema,owner;
    RoomQuotaService quota;
    RoomController controller;
    DataSourceTransactionManager manager;
    ObjectStorage storage;
    @BeforeEach void setup() throws Exception {
        String url=System.getProperty("quota.test.jdbc-url");
        Assumptions.assumeTrue(url!=null && !url.isBlank(),"Explicit disposable PostgreSQL URL required");
        String user=System.getProperty("quota.test.user","quota_test"), password=System.getProperty("quota.test.password","disposable_quota_check");
        admin=new JdbcTemplate(new DriverManagerDataSource(url,user,password));
        schema="quota_check_"+UUID.randomUUID().toString().replace("-","");
        admin.execute("CREATE SCHEMA "+schema);
        var source=new DriverManagerDataSource(url+(url.contains("?") ? "&":"?")+"currentSchema="+schema,user,password);
        db=new JdbcTemplate(source); manager=new DataSourceTransactionManager(source);
        new ResourceDatabasePopulator(new ClassPathResource("db/migration/V1__rooms.sql"),
                new ClassPathResource("db/migration/V7__room_upload_kinds.sql"),
                new ClassPathResource("db/migration/V10__immutable_upload_inputs.sql"),
                new ClassPathResource("db/migration/V11__account_storage_quotas.sql")).execute(source);
        db.execute(new ClassPathResource("db/migration/V12__reserve_fenced_job_outputs.sql")
                .getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
        db.update("UPDATE room_quota_defaults SET storage_limit_bytes=100,pending_upload_limit=1,active_job_limit=1");
        owner=UUID.randomUUID().toString(); db.update("INSERT INTO room_quota_owners(owner,initialized) VALUES(?,true)",owner);
        storage=mock(ObjectStorage.class); when(storage.objects(anyString())).thenReturn(Map.of());
        var json=new ObjectMapper(); quota=new RoomQuotaService(db,storage,json,manager);
        controller=new RoomController(db,storage,json,manager,new InputPinningService(db,storage,json,manager,quota),quota);
    }
    @AfterEach void cleanup() { if(schema!=null) admin.execute("DROP SCHEMA "+schema+" CASCADE"); }
    MockHttpServletRequest request() {
        var request=new MockHttpServletRequest(); request.setAttribute("roomOwner",owner);
        request.setAttribute("roomAccount",new AuthService.Account(owner,"admin",Role.ADMIN,false)); return request;
    }
    UUID upload() {
        UUID id=UUID.randomUUID(); db.update("INSERT INTO room_uploads(id,owner,media,sealed,inputs_pinned,kind) VALUES(?,?,'[]',true,true,'splat')",id,owner); return id;
    }
    List<Boolean> race(Runnable first,Runnable second) throws Exception {
        var gate=new CountDownLatch(1);
        try(var executor=Executors.newFixedThreadPool(2)) {
            var results=new ArrayList<Future<Boolean>>();
            for(var task:List.of(first,second)) results.add(executor.submit(()-> {
                gate.await();
                try { task.run(); return true; } catch(RoomQuotaService.QuotaExceeded denied) { return false; }
            }));
            gate.countDown();
            return List.of(results.get(0).get(15,TimeUnit.SECONDS),results.get(1).get(15,TimeUnit.SECONDS));
        }
    }
    @Test void twoStorageReservationsCannotBothConsumeTheLastBytes() throws Exception {
        UUID a=UUID.randomUUID(),b=UUID.randomUUID();
        var results=race(()->quota.reserve(owner,"upload",a,Map.of("inputs/"+a+"/file",60L)),
                ()->quota.reserve(owner,"upload",b,Map.of("inputs/"+b+"/file",60L)));
        assertEquals(1,results.stream().filter(Boolean::booleanValue).count());
        assertEquals(60L,quota.usage(owner).get("storageChargedBytes"));
    }
    @Test void twoDeclarationsCannotBothConsumeTheLastPendingSlot() throws Exception {
        Runnable declare=()->controller.upload(new RoomController.UploadRequest(List.of(new RoomController.Media("scene.ply",10,"application/octet-stream")),"splat"),request());
        var results=race(declare,declare);
        assertEquals(1,results.stream().filter(Boolean::booleanValue).count());
        assertEquals(1L,quota.usage(owner).get("pendingUploads"));
        assertEquals(20L,quota.usage(owner).get("storageChargedBytes"));
        verifyNoInteractions(storage);
    }
    @Test void twoJobsCannotBothConsumeTheLastActiveSlot() throws Exception {
        UUID a=upload(),b=upload();
        var results=race(()->controller.create(new RoomController.JobRequest(a,"a","local","a"),request()),
                ()->controller.create(new RoomController.JobRequest(b,"b","local","b"),request()));
        assertEquals(1,results.stream().filter(Boolean::booleanValue).count());
        assertEquals(1L,quota.usage(owner).get("activeJobs"));
    }
    @Test void concurrentIdempotentCreatesAtFullLimitHaveOneJobAndConflictsConsumeNothing() throws Exception {
        UUID id=upload(); var body=new RoomController.JobRequest(id,"scene","local","same");
        var results=race(()->controller.create(body,request()),()->controller.create(body,request()));
        assertEquals(List.of(true,true),results);
        assertEquals(1L,quota.usage(owner).get("activeJobs"));
        var error=assertThrows(org.springframework.web.server.ResponseStatusException.class,()->controller.create(new RoomController.JobRequest(id,"changed","local","same"),request()));
        assertEquals(409,error.getStatusCode().value());
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_jobs",Integer.class));
    }
    @Test void commonOutputFunctionFencesLeaseAndAtomicallyEnforcesStorage() {
        UUID upload=upload(),job=UUID.randomUUID(),lease=UUID.randomUUID();
        db.update("INSERT INTO room_jobs(id,owner,upload_id,name,profile,idempotency_key,state,lease_token,lease_until) VALUES(?,?,?,'scene','local','output','RUNNING',?,now()+interval '120 seconds')",job,owner,upload,lease);
        Map<String,Long> objects=Map.of("outputs/"+job+"/attempt/asset",60L);
        quota.reserveJobOutputs(job,lease,objects); quota.reserveJobOutputs(job,lease,objects);
        assertEquals(60L,quota.usage(owner).get("storageChargedBytes"));
        assertThrows(RoomQuotaService.QuotaExceeded.class,()->quota.reserveJobOutputs(job,lease,Map.of("outputs/"+job+"/attempt/second",41L)));
        assertThrows(RoomQuotaService.OutputLeaseLost.class,()->quota.reserveJobOutputs(job,UUID.randomUUID(),objects));
        db.update("UPDATE room_jobs SET cancel_requested=true WHERE id=?",job);
        assertThrows(RoomQuotaService.OutputLeaseLost.class,()->quota.reserveJobOutputs(job,lease,objects));
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_storage_allocations",Integer.class));
    }
    @Test void ownerIsolationAndTransferRejectOverCapacityWithoutMovingRows() {
        String target=UUID.randomUUID().toString(); db.update("INSERT INTO room_quota_owners(owner,initialized) VALUES(?,true)",target);
        UUID a=UUID.randomUUID(),b=UUID.randomUUID();
        quota.reserve(owner,"upload",a,Map.of("inputs/"+a+"/file",60L));
        quota.reserve(target,"upload",b,Map.of("inputs/"+b+"/file",60L));
        var transaction=new TransactionTemplate(manager);
        assertThrows(RoomQuotaService.QuotaExceeded.class,()->transaction.executeWithoutResult(status -> {
            for(String value:new TreeSet<>(List.of(owner,target))) quota.lockOwner(value);
            quota.transferLocked(owner,target);
        }));
        assertEquals(60L,quota.usage(owner).get("storageChargedBytes")); assertEquals(60L,quota.usage(target).get("storageChargedBytes"));
        quota.updateLimits(target,200L,null,null);
        transaction.executeWithoutResult(status -> {
            for(String value:new TreeSet<>(List.of(owner,target))) quota.lockOwner(value);
            quota.transferLocked(owner,target);
        });
        assertEquals(0L,quota.usage(owner).get("storageChargedBytes")); assertEquals(120L,quota.usage(target).get("storageChargedBytes"));
    }
}
