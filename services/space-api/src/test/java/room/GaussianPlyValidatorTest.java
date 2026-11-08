package room;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class GaussianPlyValidatorTest {
    @TempDir Path temporary;
    static final List<String> REQUIRED = List.of("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3");

    static byte[] fixture(List<String> properties, float[][] vertices) {
        String header = "ply\nformat binary_little_endian 1.0\ncomment exported Gaussian\nelement vertex " + vertices.length + "\n";
        for (String property : properties) header += "property float " + property + "\n";
        header += "end_header\n";
        byte[] prefix = header.getBytes(StandardCharsets.US_ASCII);
        var bytes = ByteBuffer.allocate(prefix.length + properties.size() * vertices.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        bytes.put(prefix);
        for (float[] vertex : vertices) for (float value : vertex) bytes.putFloat(value);
        return bytes.array();
    }

    static float[] vertex(float x, float y, float z, int properties) {
        float[] result = new float[properties];
        result[0] = x; result[1] = y; result[2] = z; result[10] = 1;
        return result;
    }

    Path write(byte[] bytes) throws Exception {
        Path file = temporary.resolve("scene-" + System.nanoTime() + ".ply");
        Files.write(file, bytes);
        return file;
    }

    @Test void validatesEveryVertexAndReportsSnapshotChecksumAndBounds() throws Exception {
        byte[] bytes = fixture(REQUIRED, new float[][]{vertex(-2, 4, 7, 14), vertex(3, -5, 1, 14)});
        var summary = new GaussianPlyValidator().validate(write(bytes));
        assertEquals(2, summary.vertices());
        assertEquals(new GaussianPlyValidator.Vec3(-2, -5, 1), summary.bounds().min());
        assertEquals(new GaussianPlyValidator.Vec3(3, 4, 7), summary.bounds().max());
        assertEquals(bytes.length, summary.bytes());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)), summary.sha256());
    }

    @ParameterizedTest @ValueSource(ints = {0, 9, 24, 45})
    void acceptsOptionalNormalsAndCompleteSphericalHarmonics(int harmonics) throws Exception {
        var properties = new ArrayList<>(REQUIRED);
        properties.addAll(List.of("nx", "ny", "nz"));
        for (int i = 0; i < harmonics; i++) properties.add("f_rest_" + i);
        byte[] bytes = fixture(properties, new float[][]{vertex(1, 2, 3, properties.size())});
        // float32 is the supported PLY alias for float.
        byte[] prefix = new String(bytes, 0, bytes.length - properties.size() * 4, StandardCharsets.US_ASCII)
                .replace("property float ", "property float32 ").getBytes(StandardCharsets.US_ASCII);
        var combined = ByteBuffer.allocate(prefix.length + properties.size() * 4);
        combined.put(prefix).put(bytes, bytes.length - properties.size() * 4, properties.size() * 4);
        assertEquals(1, new GaussianPlyValidator().validate(write(combined.array())).vertices());
    }

    @ParameterizedTest @ValueSource(strings = {
        "format ascii 1.0", "format binary_big_endian 1.0", "format binary_little_endian 2.0",
        "element vertex 0", "element vertex 2500001", "element vertex -1",
        "property double x", "property list uchar float x", "property float invented",
        "property float x\nproperty float x", "element face 0\nproperty float x"
    })
    void rejectsUnsupportedHeaderForms(String replacement) throws Exception {
        byte[] valid = fixture(REQUIRED, new float[][]{vertex(1, 2, 3, 14)});
        int headerSize = valid.length - 56;
        String header = new String(valid, 0, headerSize, StandardCharsets.US_ASCII);
        if (replacement.startsWith("format")) header = header.replace("format binary_little_endian 1.0", replacement);
        else if (replacement.startsWith("element vertex")) header = header.replace("element vertex 1", replacement);
        else header = header.replace("property float x", replacement);
        var combined = ByteBuffer.allocate(header.getBytes(StandardCharsets.US_ASCII).length + 56);
        combined.put(header.getBytes(StandardCharsets.US_ASCII)).put(valid, headerSize, 56);
        assertThrows(GaussianPlyValidator.InvalidPly.class, () -> new GaussianPlyValidator().validate(write(combined.array())));
    }

    @Test void rejectsMissingGaussianPropertiesAndIncompleteOptionalGroups() throws Exception {
        for (List<String> properties : List.of(REQUIRED.subList(0, 13),
                java.util.stream.Stream.concat(REQUIRED.stream(), java.util.stream.Stream.of("nx")).toList(),
                java.util.stream.Stream.concat(REQUIRED.stream(), java.util.stream.Stream.of("f_rest_1")).toList())) {
            assertThrows(GaussianPlyValidator.InvalidPly.class,
                    () -> new GaussianPlyValidator().validate(write(fixture(properties, new float[][]{vertex(1, 2, 3, properties.size())}))));
        }
    }

    @Test void rejectsTruncatedAndTrailingBodies() throws Exception {
        byte[] bytes = fixture(REQUIRED, new float[][]{vertex(1, 2, 3, 14)});
        for (int length : new int[]{bytes.length - 1, bytes.length + 1}) {
            assertThrows(GaussianPlyValidator.InvalidPly.class,
                    () -> new GaussianPlyValidator().validate(write(java.util.Arrays.copyOf(bytes, length))));
        }
    }

    @Test void rejectsNonfiniteValuesInAnyPropertyAndZeroQuaternions() throws Exception {
        for (int property = 0; property < REQUIRED.size(); property++) {
            float[] vertex = vertex(1, 2, 3, 14); vertex[property] = Float.NaN;
            assertThrows(GaussianPlyValidator.InvalidPly.class,
                    () -> new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{vertex}))));
        }
        float[] vertex = vertex(1, 2, 3, 14); vertex[10] = 0;
        assertThrows(GaussianPlyValidator.InvalidPly.class,
                () -> new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{vertex}))));
        vertex[10] = Float.POSITIVE_INFINITY;
        assertThrows(GaussianPlyValidator.InvalidPly.class,
                () -> new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{vertex}))));
    }

    @Test void boundsHeaderAndFileSizeBeforeReadingThePayload() throws Exception {
        String header = "ply\nformat binary_little_endian 1.0\ncomment " + "a".repeat(65536) + "\nend_header\n";
        assertThrows(GaussianPlyValidator.InvalidPly.class,
                () -> new GaussianPlyValidator().validate(write(header.getBytes(StandardCharsets.US_ASCII))));
        Path huge = temporary.resolve("huge.ply");
        try (var file = new java.io.RandomAccessFile(huge.toFile(), "rw")) { file.setLength(1024L * 1024 * 1024 + 1); }
        assertThrows(GaussianPlyValidator.InvalidPly.class, () -> new GaussianPlyValidator().validate(huge));
    }

    @ParameterizedTest @ValueSource(floats = {Float.MIN_VALUE, Float.MAX_VALUE, 1e-23f, 2e19f})
    void rejectsQuaternionNormsThatOverflowOrUnderflowTheViewer(float value) throws Exception {
        float[] vertex = vertex(1, 2, 3, 14); vertex[10] = value;
        assertThrows(GaussianPlyValidator.InvalidPly.class,
                () -> new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{vertex}))));
    }

    @ParameterizedTest @ValueSource(floats = {1e-22f, 1e19f, -2f})
    void acceptsNonunitButSafelyNormalizableQuaternions(float value) throws Exception {
        float[] vertex = vertex(1, 2, 3, 14); vertex[10] = value;
        assertEquals(1, new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{vertex}))).vertices());
    }

    @ParameterizedTest @ValueSource(floats = {28f, 44f, 100f, -100f})
    void rejectsScalesThatOverflowOrUnderflowDecodedFloatCovariance(float value) throws Exception {
        float[] vertex = vertex(1, 2, 3, 14);
        vertex[7] = value; vertex[8] = value; vertex[9] = value;
        assertThrows(GaussianPlyValidator.InvalidPly.class,
                () -> new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{vertex}))));
    }

    @Test void acceptsSupportedScaleEnvelopeAndNormalizableRotationsAtLargeCoordinates() throws Exception {
        for (float logScale : new float[]{-20, 20}) {
            float[] left = vertex(-1e8f, 0, 0, 14), right = vertex(1e8f, 0, 0, 14);
            for (int property = 7; property <= 9; property++) { left[property] = logScale; right[property] = logScale; }
            assertEquals(2, new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{left, right}))).vertices());
        }
        float[] anisotropic = vertex(1, 2, 3, 14);
        anisotropic[7] = -20; anisotropic[8] = 0; anisotropic[9] = 20;
        assertEquals(1, new GaussianPlyValidator().validate(write(fixture(REQUIRED, new float[][]{anisotropic}))).vertices());
    }

    @Test void rejectsPositionsAndSpansThatOverflowViewerDistanceCalculations() throws Exception {
        for (float magnitude : new float[]{1e20f, Float.MAX_VALUE, 1e19f}) {
            assertThrows(GaussianPlyValidator.InvalidPly.class, () -> new GaussianPlyValidator().validate(write(fixture(REQUIRED,
                    new float[][]{vertex(-magnitude, 0, 0, 14), vertex(magnitude, 0, 0, 14)}))));
        }
    }

    @Test void checksCancellationDuringValidation() throws Exception {
        Path file = write(fixture(REQUIRED, new float[][]{vertex(1, 2, 3, 14)}));
        assertThrows(IllegalStateException.class,
                () -> new GaussianPlyValidator().validate(file, () -> { throw new IllegalStateException("cancelled"); }));
    }
}
