package room;

import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class RoomUploadCleanupSweepTest {
    @Test void failuresOnTheFirstPageDoNotStarveLaterExpiredSessions() {
        var source=new JdbcDataSource(); source.setURL("jdbc:h2:mem:"+UUID.randomUUID()+";MODE=PostgreSQL;DB_CLOSE_DELAY=-1");
        var db=new JdbcTemplate(source);
        db.execute("CREATE TABLE room_uploads(id uuid PRIMARY KEY,owner text,api_upload boolean,cleaned_at timestamp,discarded_at timestamp,expires_at timestamp,created_at timestamp,cleanup_retry_at timestamp)");
        db.execute("CREATE TABLE room_jobs(upload_id uuid)");
        var blocked=new HashSet<UUID>(); var visited=new HashSet<UUID>();
        for(int index=0;index<31;index++) {
            UUID id=UUID.randomUUID(); if(index<25) blocked.add(id);
            db.update("INSERT INTO room_uploads(id,owner,api_upload,expires_at,created_at) VALUES(?,?,true,?,?)",
                    id,"owner",Timestamp.from(Instant.now().minusSeconds(100)),Timestamp.from(Instant.now().minusSeconds(500-index)));
        }
        var cleanup=new RoomUploadCleanup(db,mock(ObjectStorage.class),mock(RoomQuotaService.class),new DataSourceTransactionManager(source)) {
            @Override public void cleanup(UUID id,String owner) {
                if(blocked.contains(id)) throw new IllegalStateException("blocked fixture");
                visited.add(id);
            }
        };
        cleanup.sweep(); cleanup.sweep();
        assertEquals(6,visited.size(),"A failing first page must defer retries so later sessions can be cleaned");
    }
}
