package room;

import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.*;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.*;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.*;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import java.net.URI;
import java.io.InputStream;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;

@Component
public class ObjectStorage {
    public final String bucket;
    private final S3Client client;
    private final S3Presigner signer;
    public ObjectStorage() {
        bucket = env("ROOM_S3_BUCKET", "rooms");
        var credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create(env("ROOM_S3_ACCESS_KEY", "rooms-local"), env("ROOM_S3_SECRET_KEY", "rooms-local-secret")));
        var config = S3Configuration.builder().pathStyleAccessEnabled(true).checksumValidationEnabled(false).chunkedEncodingEnabled(false).build();
        client = S3Client.builder().endpointOverride(URI.create(env("ROOM_S3_ENDPOINT", "http://localhost:9000")))
                .region(Region.US_EAST_1).credentialsProvider(credentials).serviceConfiguration(config)
                .httpClientBuilder(UrlConnectionHttpClient.builder().connectionTimeout(Duration.ofSeconds(5)).socketTimeout(Duration.ofSeconds(60)))
                .overrideConfiguration(builder -> builder.apiCallTimeout(Duration.ofSeconds(120)).apiCallAttemptTimeout(Duration.ofSeconds(90)))
                .build();
        signer = S3Presigner.builder().endpointOverride(URI.create(env("ROOM_S3_PUBLIC_ENDPOINT", "http://127.0.0.1:9000"))).region(Region.US_EAST_1).credentialsProvider(credentials).serviceConfiguration(config).build();
    }
    ObjectStorage(String bucket, S3Client client, S3Presigner signer) {
        this.bucket=bucket; this.client=client; this.signer=signer;
    }
    private static String env(String name, String fallback) { return System.getenv().getOrDefault(name, fallback); }
    private static void staging(String key) {
        if(key==null || !key.startsWith("inputs/")) throw new IllegalArgumentException("Upload operations require a staging key");
    }
    public String start(String key) { staging(key); return client.createMultipartUpload(CreateMultipartUploadRequest.builder().bucket(bucket).key(key).build()).uploadId(); }
    public String partUrl(String key, String upload, int number) {
        staging(key);
        return signer.presignUploadPart(UploadPartPresignRequest.builder().signatureDuration(Duration.ofHours(2)).uploadPartRequest(UploadPartRequest.builder().bucket(bucket).key(key).uploadId(upload).partNumber(number).build()).build()).url().toString();
    }
    public String putUrl(String key) {
        staging(key);
        return signer.presignPutObject(PutObjectPresignRequest.builder().signatureDuration(Duration.ofHours(2)).putObjectRequest(PutObjectRequest.builder().bucket(bucket).key(key).build()).build()).url().toString();
    }
    public String getUrl(String key) {
        return signer.presignGetObject(GetObjectPresignRequest.builder().signatureDuration(Duration.ofHours(1)).getObjectRequest(GetObjectRequest.builder().bucket(bucket).key(key).build()).build()).url().toString();
    }
    public void complete(String key, String upload, List<CompletedPart> parts) {
        staging(key);
        client.completeMultipartUpload(CompleteMultipartUploadRequest.builder().bucket(bucket).key(key).uploadId(upload).multipartUpload(CompletedMultipartUpload.builder().parts(parts).build()).build());
    }
    public void putInput(String key, byte[] bytes) {
        staging(key); bounded(bytes);
        client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentLength((long)bytes.length).build(), RequestBody.fromBytes(bytes));
    }
    public String uploadPart(String key, String upload, int number, byte[] bytes) {
        staging(key); bounded(bytes);
        if(upload==null || upload.isBlank() || number<1) throw new IllegalArgumentException("Invalid multipart operation");
        String etag=client.uploadPart(UploadPartRequest.builder().bucket(bucket).key(key).uploadId(upload)
                .partNumber(number).contentLength((long)bytes.length).build(),RequestBody.fromBytes(bytes)).eTag();
        if(etag==null || etag.isBlank()) throw new IllegalStateException("Storage did not return an upload ETag");
        return etag;
    }
    private static void bounded(byte[] bytes) {
        if(bytes==null || bytes.length<1 || bytes.length>16*1024*1024) throw new IllegalArgumentException("Transfer must contain 1 byte to 16 MiB");
    }
    public Map<String,Long> objects(String prefix) {
        var result=new LinkedHashMap<String,Long>();
        for(var page:client.listObjectsV2Paginator(ListObjectsV2Request.builder().bucket(bucket).prefix(prefix).build()))
            for(var object:page.contents()) result.put(object.key(),object.size());
        return result;
    }
    private static void uploadPrefix(String prefix) {
        if(prefix==null || !prefix.matches("inputs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/"))
            throw new IllegalArgumentException("Cleanup requires one exact upload prefix");
    }
    public void abortMultipartUploads(String prefix) {
        uploadPrefix(prefix);
        for(var page:client.listMultipartUploadsPaginator(ListMultipartUploadsRequest.builder().bucket(bucket).prefix(prefix).build()))
            for(var upload:page.uploads()) {
                if(!upload.key().startsWith(prefix)) throw new IllegalStateException("Storage returned an unrelated upload");
                try { client.abortMultipartUpload(AbortMultipartUploadRequest.builder().bucket(bucket)
                        .key(upload.key()).uploadId(upload.uploadId()).build()); }
                catch(S3Exception error) { if(error.statusCode()!=404) throw error; }
            }
    }
    public boolean hasMultipartUploads(String prefix) {
        uploadPrefix(prefix);
        for(var page:client.listMultipartUploadsPaginator(ListMultipartUploadsRequest.builder().bucket(bucket).prefix(prefix).build()))
            if(!page.uploads().isEmpty()) return true;
        return false;
    }
    public boolean exists(String key) {
        try { size(key); return true; }
        catch(S3Exception error) { if(error.statusCode()==404) return false; throw error; }
    }
    public Snapshot snapshotOnce(String source,long expected,String destination) {
        staging(source);
        if(!destination.startsWith("sealed-inputs/")) throw new IllegalArgumentException("Snapshot requires a private key");
        try {
            long size=size(destination);
            if(size!=expected) throw new IllegalStateException("Existing private snapshot size does not match");
            return hashSnapshot(destination,expected);
        } catch(S3Exception error) { if(error.statusCode()!=404) throw error; }
        return snapshot(source,expected,destination);
    }
    public record Snapshot(String key, long size, String sha256) {}
    public Snapshot snapshot(String source, long expected, String destination) {
        staging(source);
        if(!destination.startsWith("sealed-inputs/")) throw new IllegalArgumentException("Snapshot requires a private key");
        var head=client.headObject(HeadObjectRequest.builder().bucket(bucket).key(source).build());
        if(head.contentLength()!=expected) throw new IllegalArgumentException("Uploaded file size does not match");
        if(head.eTag()==null || head.eTag().isBlank()) throw new IllegalStateException("Source identity is unavailable");
        String copySource=URLEncoder.encode(bucket+"/"+source, StandardCharsets.UTF_8).replace("+","%20");
        if(head.versionId()!=null && !head.versionId().equals("null"))
            copySource+="?versionId="+URLEncoder.encode(head.versionId(),StandardCharsets.UTF_8).replace("+","%20");
        client.copyObject(CopyObjectRequest.builder().bucket(bucket).key(destination)
                .copySource(copySource).copySourceIfMatch(head.eTag()).build());
        return hashSnapshot(destination,expected);
    }
    private Snapshot hashSnapshot(String destination,long expected) {
        try(var input=client.getObject(GetObjectRequest.builder().bucket(bucket).key(destination).build())) {
            var checksum=MessageDigest.getInstance("SHA-256");
            byte[] buffer=new byte[64*1024]; long bytes=0; int count;
            while((count=input.read(buffer))!=-1) {
                bytes+=count;
                if(bytes>expected) throw new IllegalStateException("Snapshot size does not match");
                checksum.update(buffer,0,count);
            }
            if(bytes!=expected) throw new IllegalStateException("Snapshot size does not match");
            return new Snapshot(destination,bytes,HexFormat.of().formatHex(checksum.digest()));
        } catch(IOException | NoSuchAlgorithmException e) {
            // Retain snapshots on uncertain storage/database outcomes; a committed pin
            // must never be deleted by failure cleanup.
            throw new IllegalStateException("Could not verify private input snapshot",e);
        }
    }
    public long size(String key) { return client.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build()).contentLength(); }
    public String read(String key) { return client.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build()).asUtf8String(); }
    public InputStream open(String key) { return client.getObject(GetObjectRequest.builder().bucket(bucket).key(key).build()); }
    public void uploadFile(String key, Path path, String contentType) {
        client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType(contentType).build(), RequestBody.fromFile(path));
    }
    public void write(String key, String json) { client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType("application/json").build(), RequestBody.fromString(json)); }
    public void writeJpeg(String key,byte[] bytes) { client.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType("image/jpeg").build(),RequestBody.fromBytes(bytes)); }
    public void delete(String key) { client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build()); }
}
