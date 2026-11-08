package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RoomPermissionsTest {
    final JdbcTemplate db = mock(JdbcTemplate.class);
    final ObjectStorage storage = mock(ObjectStorage.class);
    final PlatformTransactionManager manager = mock(PlatformTransactionManager.class);
    final UUID uploadId = UUID.randomUUID();
    final UUID accountId = UUID.randomUUID();
    RoomController controller;
    MockHttpServletRequest request;

    @BeforeEach void setup() {
        when(manager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        var json = new ObjectMapper();
        var quota=mock(RoomQuotaService.class);
        controller = new RoomController(db, storage, json, manager, new InputPinningService(db, storage, json, manager,quota),quota);
        request = new MockHttpServletRequest();
        request.setAttribute("roomOwner", accountId.toString());
        request.setAttribute("roomAccount", new AuthService.Account(accountId.toString(), "splat", Role.SPLAT_UPLOADER, false));
    }
    void uploadRow(String kind, boolean sealed) {
        when(db.queryForList(contains("room_uploads"), eq(uploadId), eq(accountId.toString())))
            .thenReturn(List.of(Map.of("kind", kind, "sealed", sealed, "media", "[]")));
    }
    void forbidden(Runnable call) {
        var error = assertThrows(ResponseStatusException.class, call::run);
        assertEquals(HttpStatus.FORBIDDEN, error.getStatusCode());
        verifyNoInteractions(storage);
    }
    @Test void splatOnlyCannotDeclareVideoUpload() {
        forbidden(() -> controller.upload(new RoomController.UploadRequest(
            List.of(new RoomController.Media("room.mp4", 100, "video/mp4")), "capture"), request));
    }
    @Test void downgradedAccountCannotResumeOldCaptureUpload() {
        uploadRow("capture", false);
        forbidden(() -> controller.resume(uploadId, request));
    }
    @Test void downgradedAccountCannotCompleteEvenAlreadySealedCapture() {
        uploadRow("capture", true);
        forbidden(() -> controller.complete(uploadId, new RoomController.Completion(List.of()), request));
    }
    @Test void downgradedAccountCannotQueueOldCapture() {
        uploadRow("capture", true);
        forbidden(() -> controller.create(new RoomController.JobRequest(uploadId, "room", "local", "key"), request));
    }
    @Test void splatOnlyCanDeclareOnePly() {
        when(storage.putUrl(anyString())).thenReturn("http://storage/upload");
        var result = controller.upload(new RoomController.UploadRequest(
            List.of(new RoomController.Media("scene.PLY", 100, "application/octet-stream")), "splat"), request);
        assertEquals("splat", result.get("kind"));
        verify(db).update(contains("kind"), any(UUID.class), eq(accountId.toString()), anyString(), eq("splat"),any(java.sql.Timestamp.class));
    }
    @Test void splatDeclarationRejectsWrongExtensionMultipleFilesAndExcessSize() {
        for (var files : List.of(
            List.of(new RoomController.Media("room.mp4", 100, "video/mp4")),
            List.of(new RoomController.Media("a.ply", 100, "application/octet-stream"), new RoomController.Media("b.ply", 100, "application/octet-stream")),
            List.of(new RoomController.Media("scene.ply", 1024L * 1024 * 1024 + 1, "application/octet-stream")))) {
            assertThrows(IllegalArgumentException.class, () -> controller.upload(new RoomController.UploadRequest(files, "splat"), request));
        }
        verifyNoInteractions(storage);
    }
    @Test void accountOwnershipStillPreventsForeignUploadAccess() {
        assertEquals(HttpStatus.NOT_FOUND, assertThrows(ResponseStatusException.class,
            () -> controller.resume(uploadId, request)).getStatusCode());
        verifyNoInteractions(storage);
    }
    @Test void sealedResumeNeverIssuesWritableOperations() {
        when(db.queryForList(contains("room_uploads"), eq(uploadId), eq(accountId.toString())))
            .thenReturn(List.of(Map.of("kind", "splat", "sealed", true, "media",
                    "[{\"key\":\"inputs/staging\",\"size\":100}]")));
        when(storage.putUrl(anyString())).thenReturn("http://storage/upload");
        var result = controller.resume(uploadId, request);
        assertEquals(List.of(), result.get("files"));
        verifyNoInteractions(storage);
    }
    @Test void importedScenesCannotBeReconstructedOrCalibrated() {
        request.setAttribute("roomAccount", new AuthService.Account(accountId.toString(), "admin", Role.ADMIN, false));
        when(db.queryForList(contains("room_jobs"), eq(uploadId), eq(accountId.toString())))
            .thenReturn(List.of(Map.of("kind", "splat", "state", "IMPORTED")));
        assertThrows(ResponseStatusException.class, () -> controller.reconstructAgain(uploadId, new RoomController.ReconstructionRequest("retry"), request));
        assertThrows(ResponseStatusException.class, () -> controller.calibrate(uploadId, null, request));
        verifyNoInteractions(storage);
    }
}
