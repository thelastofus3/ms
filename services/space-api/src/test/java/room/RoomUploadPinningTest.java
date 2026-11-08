package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import software.amazon.awssdk.services.s3.model.S3Exception;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RoomUploadPinningTest {
    JdbcTemplate db = mock(JdbcTemplate.class);
    ObjectStorage storage = mock(ObjectStorage.class);
    PlatformTransactionManager manager = mock(PlatformTransactionManager.class);
    UUID id = UUID.randomUUID();
    MockHttpServletRequest request;
    RoomController controller;

    @BeforeEach void setup() {
        when(manager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        var json = new ObjectMapper();
        var quota=mock(RoomQuotaService.class);
        controller = new RoomController(db, storage, json, manager, new InputPinningService(db, storage, json, manager,quota),quota);
        request = new MockHttpServletRequest();
        request.setAttribute("roomOwner", "owner");
        request.setAttribute("roomAccount", new AuthService.Account("owner", "admin", Role.ADMIN, false));
    }

    void row(String media, boolean sealed) {
        when(db.queryForList(contains("room_uploads"), eq(id), eq("owner")))
            .thenReturn(List.of(Map.of("kind", "splat", "media", media, "sealed", sealed, "inputs_pinned", false,"owner","owner")));
    }

    @Test void completedUploadPersistsPrivateInputsAndPinnedFlagAtomically() {
        row("[{\"key\":\"inputs/first\",\"size\":100}]", false);
        when(storage.size("inputs/first")).thenReturn(100L);
        when(storage.snapshotOnce(eq("inputs/first"), eq(100L), anyString()))
            .thenAnswer(call -> new ObjectStorage.Snapshot(call.getArgument(2), 100, "a".repeat(64)));
        controller.complete(id, new RoomController.Completion(List.of(new RoomController.CompletedFile("inputs/first", List.of()))), request);
        verify(db).update(contains("inputs_pinned=true"), anyString(), eq(id));
    }

    @Test void unknownLaterFileCannotCompleteEarlierMultipartUpload() {
        row("[{\"key\":\"inputs/first\",\"size\":20000000,\"multipartId\":\"multipart\"}," +
            "{\"key\":\"inputs/second\",\"size\":100}]", false);
        when(storage.size("inputs/first")).thenThrow(S3Exception.builder().statusCode(404).build()).thenReturn(20000000L);
        var parts = List.of(new RoomController.Part(1, "etag1"), new RoomController.Part(2, "etag2"));
        var completion = new RoomController.Completion(List.of(new RoomController.CompletedFile("inputs/first", parts),
                new RoomController.CompletedFile("inputs/wrong", List.of())));
        assertThrows(IllegalArgumentException.class, () -> controller.complete(id, completion, request));
        verify(storage, never()).complete(anyString(), anyString(), anyList());
    }

    @Test void privateSnapshotKeysCannotBeSignedForPutOrParts() {
        var actual = new ObjectStorage();
        assertThrows(IllegalArgumentException.class, () -> actual.putUrl("sealed-inputs/secret"));
        assertThrows(IllegalArgumentException.class, () -> actual.partUrl("sealed-inputs/secret", "multipart", 1));
    }
}
