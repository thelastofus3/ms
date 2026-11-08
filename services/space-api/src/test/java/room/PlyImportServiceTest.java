package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class PlyImportServiceTest {
    JdbcTemplate db;
    PlyImportService importer;
    ObjectStorage storage;
    ObjectMapper json = new ObjectMapper();
    UUID id;
    byte[][] source;
    byte[] original;
    Map<String, byte[]> objects;
    String pinnedKey;

    @BeforeEach void setUp() throws Exception {
        var data = new JdbcDataSource();
        data.setURL("jdbc:h2:mem:import-" + UUID.randomUUID() + ";MODE=PostgreSQL;DB_CLOSE_DELAY=-1");
        db = new JdbcTemplate(data);
        db.execute("CREATE TABLE room_uploads(id uuid PRIMARY KEY,owner text,kind text,media text,sealed boolean,inputs_pinned boolean)");
        db.execute("CREATE TABLE room_jobs(id uuid PRIMARY KEY,owner text,upload_id uuid,kind text,state text DEFAULT 'QUEUED'," +
                "stage text DEFAULT 'queued',progress integer DEFAULT 0,cancel_requested boolean DEFAULT false," +
                "attempts integer DEFAULT 0,lease_token uuid,lease_until timestamp with time zone,error text,diagnostics jsonb DEFAULT '{}'," +
                "created_at timestamp with time zone DEFAULT now(),updated_at timestamp with time zone DEFAULT now())");
        db.execute("CREATE TABLE room_versions(job_id uuid,version integer,manifest_key text,ready boolean,PRIMARY KEY(job_id,version))");
        db.execute("CREATE TABLE room_quota_owners(owner text PRIMARY KEY,initialized boolean)");
        db.update("INSERT INTO room_quota_owners VALUES('owner',true)");
        db.execute("CREATE TABLE room_output_policy(result text)");
        db.update("INSERT INTO room_output_policy VALUES('RESERVED')");
        db.execute("CREATE TABLE room_test_output_allocations(object_key text PRIMARY KEY,bytes bigint)");
        db.execute("CREATE TABLE room_storage_allocations(object_key text PRIMARY KEY,owner text,resource_kind text,resource_id uuid,maximum_bytes bigint,confirmed_bytes bigint,released_at timestamp,updated_at timestamp)");
        db.execute("CREATE ALIAS room_reserve_job_outputs FOR 'room.OutputReservationTestDatabase.reserve'");
        original = GaussianPlyValidatorTest.fixture(GaussianPlyValidatorTest.REQUIRED, new float[][]{
                GaussianPlyValidatorTest.vertex(-2, 4, 7, 14), GaussianPlyValidatorTest.vertex(3, -5, 1, 14)});
        source = new byte[][]{original}; objects = new HashMap<>();
        id = UUID.randomUUID(); UUID upload = UUID.randomUUID();
        pinnedKey = "sealed-inputs/" + upload + "/" + UUID.randomUUID();
        db.update("INSERT INTO room_uploads VALUES(?,'owner','splat',?,true,true)", upload,
                json.writeValueAsString(List.of(Map.of("name", "room.ply", "key", pinnedKey,
                        "stagingKey", "inputs/source", "sha256", sha256(original), "size", original.length))));
        db.update("INSERT INTO room_jobs(id,owner,upload_id,kind) VALUES(?,'owner',?,'splat')", id, upload);
        storage = mock(ObjectStorage.class);
        when(storage.open(pinnedKey)).thenAnswer(invocation -> new ByteArrayInputStream(source[0]) {
            @Override public void close() { source[0] = new byte[]{1, 2, 3}; }
        });
        doAnswer(invocation -> {
            objects.put(invocation.getArgument(0), Files.readAllBytes(invocation.getArgument(1, Path.class)));
            return null;
        }).when(storage).uploadFile(anyString(), any(Path.class), eq("application/octet-stream"));
        doAnswer(invocation -> { objects.put(invocation.getArgument(0), invocation.<String>getArgument(1).getBytes(java.nio.charset.StandardCharsets.UTF_8)); return null; })
                .when(storage).write(anyString(), anyString());
        doAnswer(invocation -> { objects.remove(invocation.getArgument(0)); return null; }).when(storage).delete(anyString());
        importer = new PlyImportService(new PlyImportRepository(db, new DataSourceTransactionManager(data)), storage, json, new GaussianPlyValidator());
    }

    String state() { return db.queryForObject("SELECT state FROM room_jobs WHERE id=?", String.class, id); }
    int versions() { return db.queryForObject("SELECT count(*) FROM room_versions", Integer.class); }
    String sha256(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }

    @Test void publishesThePinnedSnapshotDespiteAnOverwrittenStagingInputAndBuildsOrbitManifest() throws Exception {
        when(storage.open("inputs/source")).thenReturn(new ByteArrayInputStream(new byte[]{1, 2, 3}));
        importer.processOne();
        assertEquals("IMPORTED", state());
        assertEquals(1, versions());
        String manifestKey = db.queryForObject("SELECT manifest_key FROM room_versions", String.class);
        var manifest = json.readTree(objects.get(manifestKey));
        var asset = manifest.path("assets").path("splats");
        String assetKey = manifestKey.substring(0, manifestKey.lastIndexOf('/') + 1) + asset.path("path").asText();
        assertArrayEquals(original, objects.get(assetKey));
        assertNotEquals("inputs/source", assetKey);
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(original)), asset.path("sha256").asText());
        assertEquals(original.length, asset.path("bytes").asLong());
        assertEquals("gaussian-ply", manifest.path("sourceType").asText());
        assertEquals(id.toString(), manifest.path("sceneId").asText());
        assertEquals(1, manifest.path("version").asInt());
        assertEquals(1, manifest.path("schemaVersion").asInt());
        assertFalse(manifest.path("ready").asBoolean());
        assertFalse(manifest.path("collisionReviewed").asBoolean());
        assertEquals("uncalibrated", manifest.path("units").asText());
        assertEquals(1, manifest.path("assets").size());
        assertEquals(-2, manifest.path("bounds").path("min").path("x").asDouble());
        assertEquals(7, manifest.path("bounds").path("max").path("z").asDouble());
        assertEquals(16, manifest.path("previewCamera").size());
        for (var number : manifest.path("previewCamera")) assertTrue(Double.isFinite(number.asDouble()));
        assertEquals(.5, manifest.path("previewCamera").get(12).asDouble());
        assertEquals(List.of(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1), json.convertValue(manifest.path("worldFromReconstruction"), List.class));
    }

    @Test void rejectsAnOversizedSnapshotBeforePublishingAnything() {
        source[0] = Arrays.copyOf(original, original.length + 1);
        importer.processOne();
        assertEquals("FAILED", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
    }

    @Test void rejectsEqualSizeValidPlyWithWrongCompletedHashBeforePublication() {
        source[0] = GaussianPlyValidatorTest.fixture(GaussianPlyValidatorTest.REQUIRED, new float[][]{
                GaussianPlyValidatorTest.vertex(-1, 4, 7, 14), GaussianPlyValidatorTest.vertex(3, -5, 1, 14)});
        assertEquals(original.length, source[0].length);
        importer.processOne();
        assertEquals("FAILED", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
        assertTrue(db.queryForObject("SELECT error FROM room_jobs WHERE id=?", String.class, id).contains("SHA-256"));
    }

    @Test void rejectsMissingOrMalformedPinnedIdentityPermanently() throws Exception {
        for (var metadata : List.of(
                Map.of("name", "room.ply", "key", "inputs/source", "size", original.length, "sha256", sha256(original)),
                Map.of("name", "room.ply", "key", pinnedKey, "size", original.length),
                Map.of("name", "room.ply", "key", pinnedKey, "size", original.length, "sha256", "A".repeat(64)),
                Map.of("name", "room.ply", "key", "sealed-inputs/a/b", "size", original.length, "sha256", sha256(original)))) {
            db.update("UPDATE room_uploads SET media=?", json.writeValueAsString(List.of(metadata)));
            db.update("UPDATE room_jobs SET state='QUEUED', attempts=0");
            importer.processOne();
            assertEquals("FAILED", state());
            assertEquals(0, versions());
            assertTrue(objects.isEmpty());
        }
    }

    @Test void missingPinnedSnapshotDoesNotFallBackToStaging() {
        when(storage.open(pinnedKey)).thenThrow(S3Exception.builder().statusCode(404).message("missing").build());
        when(storage.open("inputs/source")).thenReturn(new ByteArrayInputStream(original));
        importer.processOne();
        assertEquals("QUEUED", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
    }

    @Test void invalidGaussianValuesFailWithoutPublishingAnything() {
        float[] vertex = GaussianPlyValidatorTest.vertex(1, 2, 3, 14); vertex[5] = Float.NaN;
        source[0] = GaussianPlyValidatorTest.fixture(GaussianPlyValidatorTest.REQUIRED, new float[][]{vertex, vertex});
        importer.processOne();
        assertEquals("FAILED", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
    }

    @Test void cancellationDuringAssetUploadPreventsPublicationAndCleansUniqueOutputs() throws Exception {
        doAnswer(invocation -> {
            objects.put(invocation.getArgument(0), Files.readAllBytes(invocation.getArgument(1, Path.class)));
            db.update("UPDATE room_jobs SET cancel_requested=true WHERE id=?", id);
            return null;
        }).when(storage).uploadFile(anyString(), any(Path.class), anyString());
        importer.processOne();
        assertEquals("CANCELLED", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
    }

    @Test void aLostHeartbeatCannotPublishOrFailTheReplacementAttempt() {
        when(storage.open(pinnedKey)).thenAnswer(invocation -> {
            db.update("UPDATE room_jobs SET lease_token=? WHERE id=?", UUID.randomUUID(), id);
            importer.heartbeat();
            return new ByteArrayInputStream(original);
        });
        importer.processOne();
        assertEquals("RUNNING", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
    }

    @Test void transientStorageErrorsRequeueAndASecondAttemptCanImport() {
        when(storage.open(pinnedKey)).thenThrow(S3Exception.builder().statusCode(503).message("temporary").build())
                .thenAnswer(invocation -> new ByteArrayInputStream(original));
        importer.processOne();
        assertEquals("QUEUED", state());
        importer.processOne();
        assertEquals("IMPORTED", state());
        assertEquals(2, db.queryForObject("SELECT attempts FROM room_jobs WHERE id=?", Integer.class, id));
    }

    @Test void storageQuotaRefusalPermanentlyFailsBeforeWritingAnyOutput() {
        db.update("UPDATE room_output_policy SET result='QUOTA_EXCEEDED'");
        importer.processOne();
        assertEquals("FAILED", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
        assertTrue(db.queryForObject("SELECT error FROM room_jobs WHERE id=?", String.class, id).toLowerCase().contains("quota"));
        assertEquals(0, db.queryForObject("SELECT count(*) FROM room_test_output_allocations", Integer.class));
    }

    @Test void lostReservationLeasePreventsOutputsAndLeavesAttemptForRecovery() {
        db.update("UPDATE room_output_policy SET result='LEASE_LOST'");
        importer.processOne();
        assertEquals("RUNNING", state());
        assertEquals(0, versions());
        assertTrue(objects.isEmpty());
    }

    @Test void reservesExactEncodedManifestAndAssetBytesInACommittedPhase() {
        doAnswer(invocation -> {
            // Separate connection can observe the reservation before the first S3 write.
            try(var connection=db.getDataSource().getConnection(); var select=connection.prepareStatement(
                    "SELECT bytes FROM room_test_output_allocations WHERE object_key=?")) {
                select.setString(1,invocation.getArgument(0));
                try(var row=select.executeQuery()) { assertTrue(row.next()); assertEquals(original.length,row.getLong(1)); }
            }
            objects.put(invocation.getArgument(0), Files.readAllBytes(invocation.getArgument(1, Path.class)));
            return null;
        }).when(storage).uploadFile(anyString(), any(Path.class), anyString());
        importer.processOne();
        assertEquals("IMPORTED",state());
        assertEquals(2,db.queryForObject("SELECT count(*) FROM room_test_output_allocations",Integer.class));
        for(var entry:objects.entrySet())
            assertEquals(entry.getValue().length,db.queryForObject("SELECT bytes FROM room_test_output_allocations WHERE object_key=?",Long.class,entry.getKey()));
    }

    @Test void partialOutputFailureRetainsCommittedAllocations() {
        doThrow(S3Exception.builder().statusCode(503).message("uncertain output write").build()).when(storage).write(anyString(),anyString());
        importer.processOne();
        assertEquals("QUEUED",state());
        assertEquals(0,versions());
        assertEquals(2,db.queryForObject("SELECT count(*) FROM room_test_output_allocations",Integer.class));
    }

    @Test void successfulOutputWritesConfirmStoredBytesWithoutLoweringReservedCeilings() {
        importer.processOne();
        assertEquals("IMPORTED",state());
        for(var entry:objects.entrySet()) {
            var allocation=db.queryForMap("SELECT * FROM room_storage_allocations WHERE object_key=?",entry.getKey());
            assertEquals((long)entry.getValue().length,allocation.get("maximum_bytes"));
            assertEquals((long)entry.getValue().length,allocation.get("confirmed_bytes"));
            assertNull(allocation.get("released_at"));
        }
    }

    @Test void uncertainManifestWriteKeepsItsReservationUnconfirmedAndPreservesKnownAssetConfirmation() {
        doThrow(S3Exception.builder().statusCode(503).message("Uncertain manifest write").build()).when(storage).write(anyString(),anyString());
        importer.processOne();
        assertEquals("QUEUED",state());
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_storage_allocations WHERE confirmed_bytes=maximum_bytes",Integer.class));
        assertEquals(1,db.queryForObject("SELECT count(*) FROM room_storage_allocations WHERE confirmed_bytes IS NULL",Integer.class));
        assertEquals(2,db.queryForObject("SELECT count(*) FROM room_storage_allocations WHERE released_at IS NULL",Integer.class));
    }
}
