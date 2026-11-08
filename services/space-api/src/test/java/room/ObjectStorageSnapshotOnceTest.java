package room;

import org.junit.jupiter.api.Test;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ObjectStorageSnapshotOnceTest {
    final S3Client client=mock(S3Client.class);
    final ObjectStorage storage=new ObjectStorage("test",client,mock(S3Presigner.class));
    @Test void verifiedUncommittedCopyIsReusedWithoutBeingOverwritten() throws Exception {
        byte[] bytes={1,2,3};
        when(client.headObject(any(HeadObjectRequest.class))).thenReturn(HeadObjectResponse.builder().contentLength(3L).build());
        when(client.getObject(any(GetObjectRequest.class))).thenReturn(new ResponseInputStream<>(
                GetObjectResponse.builder().contentLength(3L).build(),new ByteArrayInputStream(bytes)));
        var result=storage.snapshotOnce("inputs/upload/file",3,"sealed-inputs/upload/private");
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),result.sha256());
        verify(client,never()).copyObject(any(CopyObjectRequest.class));
        verify(client,never()).deleteObject(any(DeleteObjectRequest.class));
    }
    @Test void existingWrongSizedOrTruncatedPrivateCopyIsNotPinnedOrOverwritten() {
        when(client.headObject(any(HeadObjectRequest.class))).thenReturn(HeadObjectResponse.builder().contentLength(2L).build());
        assertThrows(IllegalStateException.class,() -> storage.snapshotOnce("inputs/file",3,"sealed-inputs/private"));
        when(client.headObject(any(HeadObjectRequest.class))).thenReturn(HeadObjectResponse.builder().contentLength(3L).build());
        when(client.getObject(any(GetObjectRequest.class))).thenReturn(new ResponseInputStream<>(
                GetObjectResponse.builder().contentLength(2L).build(),new ByteArrayInputStream(new byte[2])));
        assertThrows(IllegalStateException.class,() -> storage.snapshotOnce("inputs/file",3,"sealed-inputs/private"));
        verify(client,never()).copyObject(any(CopyObjectRequest.class));
    }
}
