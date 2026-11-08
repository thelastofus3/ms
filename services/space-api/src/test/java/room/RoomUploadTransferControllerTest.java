package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import java.util.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class RoomUploadTransferControllerTest {
    final UUID id=UUID.randomUUID();
    final String owner=UUID.randomUUID().toString();
    final JdbcTemplate db=mock(JdbcTemplate.class);
    final ObjectStorage storage=mock(ObjectStorage.class);
    final RoomQuotaService quota=mock(RoomQuotaService.class);
    final PlatformTransactionManager manager=mock(PlatformTransactionManager.class);
    final Map<String,Object> row=new LinkedHashMap<>();
    MockMvc mvc;

    @BeforeEach void setup() {
        when(manager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        row.put("id",id); row.put("owner",owner); row.put("kind","splat"); row.put("sealed",false);
        row.put("media","[{\"key\":\"inputs/"+id+"/file\",\"size\":100}]");
        when(db.queryForList(contains("room_uploads"),eq(id),eq(owner))).thenReturn(List.of(row));
        when(db.update(startsWith("UPDATE room_uploads SET media="),anyString(),eq(id)))
                .thenAnswer(call -> { row.put("media",call.getArgument(1)); return 1; });
        mvc=MockMvcBuilders.standaloneSetup(new RoomUploadTransferController(db,storage,new ObjectMapper(),manager,quota))
                .setControllerAdvice(new ApiErrors()).build();
    }
    MockHttpServletRequest account(MockHttpServletRequest request) {
        request.setAttribute("roomAccount",new AuthService.Account(owner,"owner",Role.SPLAT_UPLOADER,false));
        request.setAttribute("roomOwner",owner); return request;
    }
    String path() { return "/v1/rooms/uploads/"+id+"/files/0"; }
    @Test void newUploadOperationsReachAnAuthenticatedTransferRoute() throws Exception {
        mvc.perform(put(path()).with(this::account).contentType("application/octet-stream").content(new byte[100]))
                .andExpect(status().isOk());
        verify(storage).putInput(eq("inputs/"+id+"/file"),any(byte[].class));
        verify(quota).confirm(owner,"inputs/"+id+"/file",100);
    }
    @Test void missingAccountForeignOwnerAndSealedUploadCannotWrite() throws Exception {
        mvc.perform(put(path()).content(new byte[100])).andExpect(status().isUnauthorized());
        when(db.queryForList(contains("room_uploads"),eq(id),eq(owner))).thenReturn(List.of());
        mvc.perform(put(path()).with(this::account).content(new byte[100])).andExpect(status().isNotFound());
        when(db.queryForList(contains("room_uploads"),eq(id),eq(owner))).thenReturn(List.of(row)); row.put("sealed",true);
        mvc.perform(put(path()).with(this::account).content(new byte[100])).andExpect(status().isConflict());
        verifyNoInteractions(storage);
    }
    @Test void wrongLengthAndTruncatedBodyFailBeforeStorage() throws Exception {
        for(int length:List.of(99,101))
            mvc.perform(put(path()).with(this::account).content(new byte[length])).andExpect(status().isBadRequest());
        mvc.perform(put(path()).with(this::account).header("Content-Length","100").content(new byte[10]))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(storage);
    }
    @Test void roleDowngradeAndUnavailableSessionFailBeforeStorage() throws Exception {
        row.put("kind","capture");
        mvc.perform(put(path()).with(this::account).content(new byte[100])).andExpect(status().isForbidden());
        row.put("kind","splat");
        doThrow(new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.GONE,"Upload expired"))
                .when(quota).ensureAvailable(row);
        mvc.perform(put(path()).with(this::account).content(new byte[100])).andExpect(status().isGone());
        verifyNoInteractions(storage);
    }
    @Test void finalPartHasItsExactRemainderAndInitializationCommitsFirst() throws Exception {
        row.put("media","[{\"key\":\"inputs/"+id+"/file\",\"size\":16777221}]");
        mvc.perform(put(path()+"/parts/2").with(this::account).content(new byte[4])).andExpect(status().isBadRequest());
        verifyNoInteractions(storage);
        when(storage.start(anyString())).thenReturn("persisted-multipart");
        when(storage.uploadPart(anyString(),eq("persisted-multipart"),eq(2),any(byte[].class)))
                .thenAnswer(call -> { verify(manager,atLeastOnce()).commit(any()); return "\"part-etag\""; });
        mvc.perform(put(path()+"/parts/2").with(this::account).content(new byte[5]))
                .andExpect(status().isOk()).andExpect(header().string("ETag","\"part-etag\""));
        verify(storage).uploadPart(eq("inputs/"+id+"/file"),eq("persisted-multipart"),eq(2),argThat(bytes -> bytes.length==5));
    }
    @Test void invalidFileIndexAndPartNeverInitializeStorage() throws Exception {
        mvc.perform(put(path().replace("files/0","files/2")).with(this::account).content(new byte[100]))
                .andExpect(status().isNotFound());
        mvc.perform(put(path()+"/parts/1").with(this::account).content(new byte[100]))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(storage);
    }
}
