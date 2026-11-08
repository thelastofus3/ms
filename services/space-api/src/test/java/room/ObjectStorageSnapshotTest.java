package room;

import org.junit.jupiter.api.Test;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import org.mockito.ArgumentCaptor;
import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ObjectStorageSnapshotTest {
    final S3Client client=mock(S3Client.class);
    final S3Presigner signer=mock(S3Presigner.class);
    final ObjectStorage storage=new ObjectStorage("test",client,signer);

    void source(long size) {
        when(client.headObject(any(HeadObjectRequest.class))).thenReturn(HeadObjectResponse.builder()
                .contentLength(size).eTag("\"source-etag\"").versionId("version id").build());
    }
    void bytes(byte[] bytes) {
        when(client.getObject(any(GetObjectRequest.class))).thenReturn(new ResponseInputStream<>(
                GetObjectResponse.builder().contentLength((long)bytes.length).build(),new ByteArrayInputStream(bytes)));
    }

    @Test void snapshotConditionsCopyOnSourceIdentityAndHashesThePrivateBytes() throws Exception {
        byte[] original="actual snapshot bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        source(original.length); bytes(original);
        var snapshot=storage.snapshot("inputs/upload/file",original.length,"sealed-inputs/upload/private");
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(original)),snapshot.sha256());
        assertEquals(original.length,snapshot.size());
        var copy=ArgumentCaptor.forClass(CopyObjectRequest.class);
        verify(client).copyObject(copy.capture());
        assertEquals("\"source-etag\"",copy.getValue().copySourceIfMatch());
        assertTrue(copy.getValue().copySource().endsWith("?versionId=version%20id"));
        assertEquals(snapshot.key(),copy.getValue().key());
        var read=ArgumentCaptor.forClass(GetObjectRequest.class);
        verify(client).getObject(read.capture());
        assertEquals(snapshot.key(),read.getValue().key());
        verify(client,never()).deleteObject(any(DeleteObjectRequest.class));
    }

    @Test void staleCopyIdentityCannotReturnAPin() {
        source(3);
        when(client.copyObject(any(CopyObjectRequest.class))).thenThrow(S3Exception.builder().statusCode(412).build());
        assertThrows(S3Exception.class,()->storage.snapshot("inputs/source",3,"sealed-inputs/private"));
        verify(client,never()).getObject(any(GetObjectRequest.class));
        verify(client,never()).deleteObject(any(DeleteObjectRequest.class));
    }

    @Test void sourceLengthMismatchCannotCopyAndShortPrivateStreamCannotPin() {
        source(3);
        assertThrows(IllegalArgumentException.class,()->storage.snapshot("inputs/source",4,"sealed-inputs/private"));
        verify(client,never()).copyObject(any(CopyObjectRequest.class));
        bytes(new byte[]{1,2});
        assertThrows(IllegalStateException.class,()->storage.snapshot("inputs/source",3,"sealed-inputs/private"));
    }

    @Test void privateNamespaceCannotBeUsedForAnyUploadOperation() {
        assertThrows(IllegalArgumentException.class,()->storage.start("sealed-inputs/private"));
        assertThrows(IllegalArgumentException.class,()->storage.putUrl("sealed-inputs/private"));
        assertThrows(IllegalArgumentException.class,()->storage.partUrl("sealed-inputs/private","upload",1));
        assertThrows(IllegalArgumentException.class,()->storage.complete("sealed-inputs/private","upload",java.util.List.of()));
        verifyNoInteractions(client,signer);
    }
}
