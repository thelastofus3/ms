package room;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ObjectStorageTransferTest {
    final S3Client client=mock(S3Client.class);
    final S3Presigner signer=mock(S3Presigner.class);
    final ObjectStorage storage=new ObjectStorage("test",client,signer);
    @Test void boundedInputsAndPartsUseServerSideExactLengths() throws Exception {
        byte[] bytes={1,2,3}; storage.putInput("inputs/upload/file",bytes);
        var put=ArgumentCaptor.forClass(PutObjectRequest.class); var body=ArgumentCaptor.forClass(RequestBody.class);
        verify(client).putObject(put.capture(),body.capture());
        assertEquals(3L,put.getValue().contentLength());
        assertArrayEquals(bytes,body.getValue().contentStreamProvider().newStream().readAllBytes());
        when(client.uploadPart(any(UploadPartRequest.class),any(RequestBody.class))).thenReturn(UploadPartResponse.builder().eTag("\"etag\"").build());
        assertEquals("\"etag\"",storage.uploadPart("inputs/upload/file","multipart",2,bytes));
        var part=ArgumentCaptor.forClass(UploadPartRequest.class);
        verify(client).uploadPart(part.capture(),any(RequestBody.class)); assertEquals(3L,part.getValue().contentLength());
        verifyNoInteractions(signer);
    }
    @Test void privateKeysInvalidPartsAndBodiesCannotReachStorage() {
        assertThrows(IllegalArgumentException.class,() -> storage.putInput("sealed-inputs/private",new byte[1]));
        assertThrows(IllegalArgumentException.class,() -> storage.putInput("inputs/file",new byte[0]));
        assertThrows(IllegalArgumentException.class,() -> storage.putInput("inputs/file",new byte[16*1024*1024+1]));
        assertThrows(IllegalArgumentException.class,() -> storage.uploadPart("inputs/file","multipart",0,new byte[1]));
        assertThrows(IllegalArgumentException.class,() -> storage.abortMultipartUploads("inputs/"));
        verifyNoInteractions(client,signer);
    }
}
