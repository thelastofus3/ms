package room;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;

@Service
public class PlyImportService {
    private static final Logger log = LoggerFactory.getLogger(PlyImportService.class);
    private final PlyImportRepository repository;
    private final ObjectStorage storage;
    private final ObjectMapper json;
    private final GaussianPlyValidator validator;
    private final AtomicReference<Attempt> active = new AtomicReference<>();

    private static class Stopped extends RuntimeException {}
    private static class Attempt {
        final PlyImportRepository.Job job;
        volatile boolean stopped;
        Attempt(PlyImportRepository.Job job) { this.job = job; }
        void check() { if (stopped || Thread.currentThread().isInterrupted()) throw new Stopped(); }
    }
    private static final String UUID_KEY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private record Source(String key, long bytes, String sha256) {}

    public PlyImportService(PlyImportRepository repository, ObjectStorage storage, ObjectMapper json, GaussianPlyValidator validator) {
        this.repository = repository; this.storage = storage; this.json = json; this.validator = validator;
    }

    @Scheduled(fixedDelayString = "${room.ply-import.poll-ms:2000}", scheduler = "plyImportScheduler")
    public synchronized void processOne() {
        var job = repository.claim();
        if (job == null) return;
        var attempt = new Attempt(job);
        active.set(attempt);
        Path snapshot = null;
        String prefix = "outputs/" + job.id() + "/" + job.leaseToken() + "/" + UUID.randomUUID() + "/";
        String assetKey = prefix + "room.ply", manifestKey = prefix + "manifest.json";
        boolean outputStarted = false, published = false, publicationAttempted = false;
        try {
            Source source = source(job.media());
            snapshot = Files.createTempFile("room-ply-import-", ".ply");
            copySnapshot(source, snapshot, attempt);
            stage(attempt, "validation", 40);
            var summary = validator.validate(snapshot, attempt::check);
            if (!summary.sha256().equals(source.sha256()))
                throw new GaussianPlyValidator.InvalidPly("Pinned PLY SHA-256 checksum does not match completed upload");
            String encodedManifest=json.writeValueAsString(manifest(job, summary));
            repository.reserveOutputs(job, Map.of(assetKey, summary.bytes(),
                    manifestKey, (long)encodedManifest.getBytes(StandardCharsets.UTF_8).length));
            stage(attempt, "publication", 90);
            outputStarted = true;
            storage.uploadFile(assetKey, snapshot, "application/octet-stream");
            repository.confirmOutput(job,assetKey,summary.bytes());
            attempt.check();
            storage.write(manifestKey, encodedManifest);
            repository.confirmOutput(job,manifestKey,encodedManifest.getBytes(StandardCharsets.UTF_8).length);
            attempt.check();
            // A commit failure can have an uncertain outcome. Retain these immutable
            // objects until publication is known to have been refused, so a committed
            // manifest can never lose its assets during cleanup.
            publicationAttempted = true;
            published = repository.publish(job, manifestKey, json.writeValueAsString(Map.of(
                    "sourceType", "gaussian-ply", "vertices", summary.vertices(), "bounds", summary.bounds(),
                    "bytes", summary.bytes(), "sha256", summary.sha256())));
            if (!published) { publicationAttempted = false; throw new Stopped(); }
        } catch (Exception error) {
            boolean interrupted = error instanceof Stopped || error instanceof RoomQuotaService.OutputLeaseLost;
            boolean permanent = error instanceof GaussianPlyValidator.InvalidPly || error instanceof RoomQuotaService.QuotaExceeded;
            String message = permanent ? error.getMessage() : "PLY import could not complete";
            try { repository.fail(job, message, permanent, interrupted); }
            catch (Exception settleError) { log.warn("Could not settle PLY import {}: {}", job.id(), settleError.toString()); }
            if (!interrupted) log.warn("PLY import {} attempt {} failed: {}", job.id(), job.attempts(), error.toString());
        } finally {
            active.compareAndSet(attempt, null);
            if (outputStarted && !published && !publicationAttempted) {
                deleteOutput(manifestKey); deleteOutput(assetKey);
            }
            if (snapshot != null) {
                try { Files.deleteIfExists(snapshot); }
                catch (IOException error) { log.warn("Could not remove PLY temporary snapshot: {}", error.toString()); }
            }
        }
    }

    @Scheduled(fixedDelay = 20_000, scheduler = "plyImportScheduler")
    public void heartbeat() {
        Attempt attempt = active.get();
        if (attempt == null) return;
        try { if (!repository.heartbeat(attempt.job)) attempt.stopped = true; }
        catch (Exception error) {
            attempt.stopped = true;
            log.warn("PLY import {} heartbeat failed: {}", attempt.job.id(), error.toString());
        }
    }

    @PreDestroy public void shutdown() {
        Attempt attempt = active.get();
        if (attempt != null) attempt.stopped = true;
    }

    private Source source(String media) throws IOException {
        var files = json.readTree(media);
        if (!files.isArray() || files.size() != 1) throw new GaussianPlyValidator.InvalidPly("Import exactly one Gaussian PLY file");
        var file = files.get(0);
        if (!file.path("name").asText().toLowerCase(Locale.ROOT).endsWith(".ply"))
            throw new GaussianPlyValidator.InvalidPly("Import exactly one Gaussian PLY file");
        var key = file.path("key");
        var sha256 = file.path("sha256");
        if (!key.isTextual() || !key.asText().matches("sealed-inputs/" + UUID_KEY + "/" + UUID_KEY)
                || !sha256.isTextual() || !sha256.asText().matches("[0-9a-f]{64}"))
            throw new GaussianPlyValidator.InvalidPly("Gaussian PLY requires a pinned snapshot and lowercase SHA-256 checksum");
        var size = file.path("size");
        if (!size.isIntegralNumber() || !size.canConvertToLong() || size.asLong() < 1 || size.asLong() > GaussianPlyValidator.MAX_BYTES)
            throw new GaussianPlyValidator.InvalidPly("Gaussian PLY must be at most 1 GiB");
        return new Source(key.asText(), size.asLong(), sha256.asText());
    }

    private void copySnapshot(Source source, Path snapshot, Attempt attempt) throws IOException {
        attempt.check();
        try (InputStream input = storage.open(source.key()); OutputStream output = Files.newOutputStream(snapshot)) {
            byte[] buffer = new byte[64 * 1024];
            long bytes = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                attempt.check();
                bytes += count;
                if (bytes > source.bytes()) throw new GaussianPlyValidator.InvalidPly("Uploaded PLY size changed before import");
                output.write(buffer, 0, count);
            }
            if (bytes != source.bytes()) throw new GaussianPlyValidator.InvalidPly("Uploaded PLY size changed before import");
        }
        attempt.check();
    }

    private void stage(Attempt attempt, String name, int progress) {
        attempt.check();
        if (!repository.stage(attempt.job, name, progress)) throw new Stopped();
    }

    private Map<String, Object> manifest(PlyImportRepository.Job job, GaussianPlyValidator.Summary summary) {
        return Map.ofEntries(
                Map.entry("schemaVersion", 1), Map.entry("sceneId", job.id().toString()), Map.entry("version", 1),
                Map.entry("sourceType", "gaussian-ply"), Map.entry("ready", false), Map.entry("collisionReviewed", false),
                Map.entry("units", "uncalibrated"), Map.entry("axes", "right-handed-y-up"),
                Map.entry("worldFromReconstruction", List.of(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)),
                Map.entry("assets", Map.of("splats", Map.of("path", "room.ply", "sha256", summary.sha256(), "bytes", summary.bytes()))),
                Map.entry("bounds", summary.bounds()), Map.entry("previewCamera", previewCamera(summary.bounds())),
                Map.entry("scaleProvenance", Map.of("method", "unknown")), Map.entry("generator", Map.of("gaussianPlyImporter", "1")));
    }

    private List<Double> previewCamera(GaussianPlyValidator.Bounds bounds) {
        var min = bounds.min(); var max = bounds.max();
        double x = (min.x() + max.x()) / 2, y = (min.y() + max.y()) / 2, z = (min.z() + max.z()) / 2;
        double dx = max.x() - min.x(), dy = max.y() - min.y(), dz = max.z() - min.z();
        double radius = Math.max(.5, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2);
        double backwardY = 1 / Math.sqrt(17), backwardZ = 4 / Math.sqrt(17);
        return List.of(1.,0.,0.,0., 0.,backwardZ,-backwardY,0., 0.,backwardY,backwardZ,0.,
                x,y + radius * .5,z + radius * 2,1.);
    }

    private void deleteOutput(String key) {
        try { storage.delete(key); }
        catch (Exception error) { log.warn("Could not remove unpublished PLY output: {}", error.toString()); }
    }
}
