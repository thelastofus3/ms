package room;

import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.*;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.*;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.*;
import software.amazon.awssdk.core.sync.RequestBody;
import java.net.URI;
import java.time.Duration;
import java.util.*;

@Component
public class ObjectStorage {
    public final String bucket = env("ROOM_S3_BUCKET", "rooms");
    private final S3Client client;
    private final S3Presigner signer;
    public ObjectStorage() {
        var credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create(env("ROOM_S3_ACCESS_KEY", "rooms-local"), env("ROOM_S3_SECRET_KEY", "rooms-local-secret")));
        var config = S3Configuration.builder().pathStyleAccessEnabled(true).checksumValidationEnabled(false).chunkedEncodingEnabled(false).build();
        client = S3Client.builder().endpointOverride(URI.create(env("ROOM_S3_ENDPOINT", "http://localhost:9000"))).region(Region.US_EAST_1).credentialsProvider(credentials).serviceConfiguration(config).build();
        signer = S3Presigner.builder().endpointOverride(URI.create(env("ROOM_S3_PUBLIC_ENDPOINT", "http://127.0.0.1:9000"))).region(Region.US_EAST_1).credentialsProvider(credentials).serviceConfiguration(config).build();
    }
    private static String env(String name, String fallback) { return System.getenv().getOrDefault(name, fallback); }
    public String start(String key) { return client.createMultipartUpload(CreateMultipartUploadRequest.builder().bucket(bucket).key(key).build()).uploadId(); }
    public String partUrl(String key, String upload, int number) {
        return signer.presignUploadPart(UploadPartPresignRequest.builder().signatureDuration(Duration.ofHours(2)).uploadPartRequest(UploadPartRequest.builder().bucket(bucket).key(key).uploadId(upload).partNumber(number).build()).build()).url().toString();
    }
    public String putUrl(String key) {
        return signer.presignPutObject(PutObjectPresignRequest.builder().signatureDuration(Duration.ofHours(2)).putObjectRequest(PutObjectRequest.builder().bucket(bucket).key(key).build()).build()).url().toString();
    }
    public String getUrl(String key) {
        return signer.presignGetObject(GetObjectPresignRequest.builder().signatureDuration(Duration.ofHours(1)).getObjectRequest(GetObjectRequest.builder().bucket(bucket).key(key).build()).build()).url().toString();
    }
    public void complete(String key, String upload, List<CompletedPart> parts) {
        client.completeMultipartUpload(CompleteMultipartUploadRequest.builder().bucket(bucket).key(key).uploadId(upload).multipartUpload(CompletedMultipartUpload.builder().parts(parts).build()).build());
    }
    public long size(String key) { return client.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()).contentLength(); }
    public String read(String key) { return client.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build()).asUtf8String(); }
    public void write(String key, String json) { client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType("application/json").build(), RequestBody.fromString(json)); }
    public void writeJpeg(String key,byte[] bytes) { client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType("image/jpeg").build(),RequestBody.fromBytes(bytes)); }
    public void delete(String key) { client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build()); }
}
