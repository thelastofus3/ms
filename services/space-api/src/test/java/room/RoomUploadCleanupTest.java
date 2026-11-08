package room;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.server.ResponseStatusException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class RoomUploadCleanupTest {
    final UUID id=UUID.randomUUID();
    final String owner=UUID.randomUUID().toString();
    final String source="inputs/"+id+"/file", snapshot="sealed-inputs/"+id+"/snapshot";
    final JdbcTemplate db=mock(JdbcTemplate.class);
    final ObjectStorage storage=mock(ObjectStorage.class);
    final RoomQuotaService quota=mock(RoomQuotaService.class);
    final PlatformTransactionManager manager=mock(PlatformTransactionManager.class);
    final Map<String,Object> upload=new LinkedHashMap<>();
    final Set<String> released=new HashSet<>();
    int activeTransactions;
    RoomUploadCleanup cleanup;
    @BeforeEach void setup() {
        when(manager.getTransaction(any())).thenAnswer(call -> { activeTransactions++; return new SimpleTransactionStatus(); });
        doAnswer(call -> { activeTransactions--; return null; }).when(manager).commit(any());
        doAnswer(call -> { activeTransactions--; return null; }).when(manager).rollback(any());
        cleanup=new RoomUploadCleanup(db,storage,quota,manager);
        upload.put("id",id); upload.put("owner",owner); upload.put("api_upload",true);
        upload.put("expires_at",Timestamp.from(Instant.now().plusSeconds(3600)));
        when(db.queryForList(contains("room_uploads"),eq(id),eq(owner))).thenReturn(List.of(upload));
        when(db.queryForObject(contains("room_jobs"),eq(Integer.class),eq(id))).thenReturn(0);
        when(db.update(startsWith("UPDATE room_uploads SET discarded_at="),eq(id)))
                .thenAnswer(call -> { upload.put("discarded_at",Timestamp.from(Instant.now())); return 1; });
        when(db.update(startsWith("UPDATE room_uploads SET cleaned_at="),eq(id)))
                .thenAnswer(call -> { upload.put("cleaned_at",Timestamp.from(Instant.now())); return 1; });
        when(db.queryForList(contains("room_storage_allocations"),eq(owner),eq(id),anyString(),anyString()))
                .thenAnswer(call -> List.of(source,snapshot).stream().filter(key -> !released.contains(key))
                        .map(key -> Map.<String,Object>of("object_key",key)).toList());
        when(db.queryForObject(contains("room_storage_allocations"),eq(Integer.class),eq(owner),eq(id),anyString(),anyString()))
                .thenAnswer(call -> 2-released.size());
        doAnswer(call -> {
            assertEquals(0,activeTransactions,"Release must run after the resource transaction commits");
            released.add(call.getArgument(1)); return null;
        }).when(quota).releaseVerifiedAbsent(eq(owner),anyString());
    }
    MockHttpServletRequest account(MockHttpServletRequest request) {
        request.setAttribute("roomAccount",new AuthService.Account(owner,"owner",Role.SPLAT_UPLOADER,false)); return request;
    }
    @Test void ownerCanCloseAnUnattachedUploadThroughTheApi() throws Exception {
        var mvc=MockMvcBuilders.standaloneSetup(new RoomUploadCleanupController(cleanup)).setControllerAdvice(new ApiErrors()).build();
        mvc.perform(delete("/v1/rooms/uploads/"+id).with(this::account)).andExpect(status().isAccepted());
        assertNotNull(upload.get("discarded_at")); assertNull(upload.get("cleaned_at"));
        verifyNoInteractions(storage); assertTrue(released.isEmpty());
        mvc.perform(delete("/v1/rooms/uploads/"+id)).andExpect(status().isUnauthorized());
    }
    @Test void exactVerifiedDeletionReleasesOnceAndRetainsTombstone() {
        cleanup.discard(id,owner); cleanup.cleanup(id,owner); cleanup.cleanup(id,owner);
        assertNotNull(upload.get("cleaned_at")); assertEquals(Set.of(source,snapshot),released);
        verify(storage).abortMultipartUploads("inputs/"+id+"/");
        verify(storage).delete(source); verify(storage).delete(snapshot);
        verify(quota).releaseVerifiedAbsent(owner,source); verify(quota).releaseVerifiedAbsent(owner,snapshot);
    }
    @Test void expirationClosureCommitsEvenWhenStorageDeletionFails() {
        upload.put("expires_at",Timestamp.from(Instant.now().minusSeconds(60)));
        doThrow(new IllegalStateException("storage unavailable")).when(storage).delete(snapshot);
        assertThrows(IllegalStateException.class,() -> cleanup.cleanup(id,owner));
        assertNotNull(upload.get("discarded_at")); assertNull(upload.get("cleaned_at")); assertTrue(released.isEmpty());
        doNothing().when(storage).delete(snapshot); cleanup.cleanup(id,owner);
        assertNotNull(upload.get("cleaned_at")); assertEquals(2,released.size());
    }
    @Test void attachedAndLegacyInputsArePreserved() {
        when(db.queryForObject(contains("room_jobs"),eq(Integer.class),eq(id))).thenReturn(1);
        assertEquals(HttpStatus.CONFLICT,assertThrows(ResponseStatusException.class,() -> cleanup.discard(id,owner)).getStatusCode());
        cleanup.cleanup(id,owner);
        when(db.queryForObject(contains("room_jobs"),eq(Integer.class),eq(id))).thenReturn(0); upload.put("api_upload",false);
        assertEquals(HttpStatus.CONFLICT,assertThrows(ResponseStatusException.class,() -> cleanup.discard(id,owner)).getStatusCode());
        cleanup.cleanup(id,owner);
        assertNull(upload.get("discarded_at")); assertTrue(released.isEmpty()); verifyNoInteractions(storage);
    }
    @Test void remainingObjectOrMultipartSessionRetainsEveryCharge() {
        cleanup.discard(id,owner);
        when(storage.hasMultipartUploads(anyString())).thenReturn(true);
        assertThrows(IllegalStateException.class,() -> cleanup.cleanup(id,owner));
        verify(storage,never()).delete(anyString()); assertTrue(released.isEmpty());
        when(storage.hasMultipartUploads(anyString())).thenReturn(false); when(storage.exists(snapshot)).thenReturn(true);
        assertThrows(IllegalStateException.class,() -> cleanup.cleanup(id,owner));
        assertNull(upload.get("cleaned_at")); assertTrue(released.isEmpty());
    }
}
