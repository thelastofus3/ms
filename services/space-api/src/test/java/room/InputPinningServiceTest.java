package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import software.amazon.awssdk.services.s3.model.S3Exception;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class InputPinningServiceTest {
    JdbcTemplate db;
    TransactionTemplate tx;
    ObjectStorage storage;
    InputPinningService service;
    ObjectMapper json=new ObjectMapper();

    @BeforeEach void setup() {
        var source=new JdbcDataSource();
        source.setURL("jdbc:h2:mem:pin-"+UUID.randomUUID()+";MODE=PostgreSQL;DB_CLOSE_DELAY=-1");
        db=new JdbcTemplate(source);
        db.execute("CREATE TABLE room_uploads(id uuid PRIMARY KEY,owner text DEFAULT 'owner',media text,sealed boolean,inputs_pinned boolean DEFAULT false,created_at timestamp DEFAULT now())");
        var manager=new DataSourceTransactionManager(source); tx=new TransactionTemplate(manager);
        storage=mock(ObjectStorage.class);
        service=new InputPinningService(db,storage,json,manager,mock(RoomQuotaService.class));
        when(storage.snapshotOnce(anyString(),anyLong(),anyString())).thenAnswer(call ->
                new ObjectStorage.Snapshot(call.getArgument(2),call.getArgument(1),"a".repeat(64)));
    }
    UUID upload(boolean sealed,String... keys) throws Exception {
        UUID id=UUID.randomUUID(); var files=new ArrayList<Map<String,Object>>();
        for(var key:keys) files.add(Map.of("key",key,"size",100,"multipartId","old","name","scene.ply"));
        db.update("INSERT INTO room_uploads(id,media,sealed) VALUES(?,?,?)",id,json.writeValueAsString(files),sealed);
        return id;
    }
    Map<String,Object> row(UUID id) { return db.queryForMap("SELECT * FROM room_uploads WHERE id=?",id); }
    void pin(UUID id) { tx.executeWithoutResult(status -> service.pinLocked(id,db.queryForMap("SELECT * FROM room_uploads WHERE id=? FOR UPDATE",id))); }

    @Test void pinsCanonicalMetadataAndRepeatedPinDoesNotCopy() throws Exception {
        UUID id=upload(false,"inputs/source"); pin(id);
        var row=row(id);
        assertEquals(true,row.get("sealed")); assertEquals(true,row.get("inputs_pinned"));
        var file=service.media(row.get("media")).getFirst();
        assertTrue(file.get("key").toString().startsWith("sealed-inputs/"+id+"/"));
        assertEquals("inputs/source",file.get("stagingKey")); assertEquals("a".repeat(64),file.get("sha256"));
        assertFalse(file.containsKey("multipartId")); pin(id);
        verify(storage,times(1)).snapshotOnce(anyString(),anyLong(),anyString());
    }

    @Test void laterSnapshotFailureLeavesAllOriginalMediaAndSealState() throws Exception {
        UUID id=upload(false,"inputs/one","inputs/two");
        String before=row(id).get("media").toString();
        when(storage.snapshotOnce(eq("inputs/two"),anyLong(),anyString())).thenThrow(S3Exception.builder().statusCode(503).build());
        assertThrows(S3Exception.class,()->pin(id));
        assertEquals(before,row(id).get("media")); assertEquals(false,row(id).get("sealed"));
        assertEquals(false,row(id).get("inputs_pinned"));
        verify(storage,never()).delete(anyString());
        when(storage.snapshotOnce(eq("inputs/two"),anyLong(),anyString())).thenAnswer(call ->
                new ObjectStorage.Snapshot(call.getArgument(2),100,"a".repeat(64)));
        pin(id); assertEquals(true,row(id).get("inputs_pinned"));
    }

    @Test void startupBackfillContinuesMissingObjectsAndPreservesLegacyRowsForRetry() throws Exception {
        UUID missing=upload(true,"inputs/missing"), available=upload(true,"inputs/available");
        when(storage.snapshotOnce(eq("inputs/missing"),anyLong(),anyString())).thenThrow(S3Exception.builder().statusCode(404).build());
        service.run(null);
        assertEquals(true,row(available).get("inputs_pinned"));
        assertEquals(true,row(missing).get("sealed")); assertEquals(false,row(missing).get("inputs_pinned"));
        assertEquals("inputs/missing",service.media(row(missing).get("media")).getFirst().get("key"));
        when(storage.snapshotOnce(eq("inputs/missing"),anyLong(),anyString())).thenAnswer(call ->
                new ObjectStorage.Snapshot(call.getArgument(2),100,"a".repeat(64)));
        pin(missing); assertEquals(true,row(missing).get("inputs_pinned"));
    }

    @Test void databaseRollbackRetainsCopiesAndRestoresUnpinnedMetadata() throws Exception {
        UUID id=upload(false,"inputs/source");
        assertThrows(IllegalStateException.class,()->tx.executeWithoutResult(status -> {
            service.pinLocked(id,db.queryForMap("SELECT * FROM room_uploads WHERE id=? FOR UPDATE",id));
            throw new IllegalStateException("force rollback");
        }));
        assertEquals(false,row(id).get("inputs_pinned"));
        assertEquals("inputs/source",service.media(row(id).get("media")).getFirst().get("key"));
        verify(storage,never()).delete(anyString());
    }
}
