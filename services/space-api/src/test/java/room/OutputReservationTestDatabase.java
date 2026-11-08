package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.*;
import java.util.UUID;

/** A durable H2 function double for consumer tests; PostgreSQL owns admission semantics. */
public final class OutputReservationTestDatabase {
    private OutputReservationTestDatabase() {}
    public static String reserve(Connection db, UUID job, UUID lease, String encoded) throws Exception {
        try (var query=db.prepareStatement("SELECT result FROM room_output_policy"); var result=query.executeQuery()) {
            result.next(); String status=result.getString(1);
            if(!status.equals("RESERVED")) return status;
        }
        var objects=new ObjectMapper().readTree(encoded);
        if(objects.isTextual()) objects=new ObjectMapper().readTree(objects.asText());
        for(var fields=objects.fields();fields.hasNext();) {
            var entry=fields.next();
            try(var insert=db.prepareStatement("MERGE INTO room_test_output_allocations(object_key,bytes) KEY(object_key) VALUES(?,?)")) {
                insert.setString(1,entry.getKey());insert.setLong(2,entry.getValue().asLong());insert.executeUpdate();
            }
            try(var insert=db.prepareStatement("MERGE INTO room_storage_allocations(object_key,owner,resource_kind,resource_id,maximum_bytes) KEY(object_key) VALUES(?,'owner','job',?,?)")) {
                insert.setString(1,entry.getKey());insert.setObject(2,job);insert.setLong(3,entry.getValue().asLong());insert.executeUpdate();
            }
        }
        return "RESERVED";
    }
}
