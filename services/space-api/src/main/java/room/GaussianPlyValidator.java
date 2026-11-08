package room;

import org.springframework.stereotype.Component;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.*;
import java.security.*;
import java.util.*;

@Component
public class GaussianPlyValidator {
    public static final long MAX_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final int MAX_VERTICES = 2_500_000;
    private static final Set<String> REQUIRED = Set.of("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3");
    public record Vec3(double x, double y, double z) {}
    public record Bounds(Vec3 min, Vec3 max) {}
    public record Summary(int vertices, Bounds bounds, long bytes, String sha256) {}
    public static class InvalidPly extends IOException {
        public InvalidPly(String message) { super(message); }
    }
    public Summary validate(Path path) throws IOException { return validate(path, () -> {}); }
    public Summary validate(Path path, Runnable checkpoint) throws IOException {
        checkpoint.run();
        long bytes = Files.size(path);
        if (bytes == 0 || bytes > MAX_BYTES) throw new InvalidPly("Gaussian PLY must be at most 1 GiB");
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
        try (var input = new DigestInputStream(new BufferedInputStream(Files.newInputStream(path), 64 * 1024), digest)) {
            var header = readHeader(input);
            int stride = header.properties().size() * Float.BYTES;
            if (bytes != header.bytes() + (long) header.vertices() * stride)
                throw new InvalidPly("Gaussian PLY payload is truncated or has trailing bytes");
            var row = ByteBuffer.allocate(stride).order(ByteOrder.LITTLE_ENDIAN);
            double[] minimum = {Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY};
            double[] maximum = {Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY};
            int[] coordinates = {header.properties().indexOf("x"), header.properties().indexOf("y"), header.properties().indexOf("z")};
            int[] rotations = {header.properties().indexOf("rot_0"), header.properties().indexOf("rot_1"),
                    header.properties().indexOf("rot_2"), header.properties().indexOf("rot_3")};
            int[] scales = {header.properties().indexOf("scale_0"), header.properties().indexOf("scale_1"), header.properties().indexOf("scale_2")};
            for (int vertex = 0; vertex < header.vertices(); vertex++) {
                if ((vertex & 4095) == 0) checkpoint.run();
                if (input.readNBytes(row.array(), 0, stride) != stride) throw new InvalidPly("Gaussian PLY payload is truncated");
                for (int property = 0; property < header.properties().size(); property++)
                    if (!Float.isFinite(row.getFloat(property * 4))) throw new InvalidPly("Gaussian PLY contains nonfinite values");
                // Spark normalizes quaternions and constructs LoD in float32.
                // Finite source values can still underflow/overflow these operations.
                float rotationNorm = 0;
                for (int rotation : rotations) {
                    float value = row.getFloat(rotation * 4);
                    rotationNorm += value * value;
                }
                if (!Float.isFinite(rotationNorm) || rotationNorm <= 0)
                    throw new InvalidPly("Gaussian PLY rotation quaternion cannot be normalized safely in float32");
                float varianceSum = 0;
                for (int scale : scales) {
                    float logScale = row.getFloat(scale * 4);
                    // A supported rendering envelope also bounds native LoD calculations,
                    // whose intermediate operations are stricter than exp() alone.
                    if (logScale < -20 || logScale > 20)
                        throw new InvalidPly("Gaussian PLY log scales must be between -20 and 20 for the viewer");
                    float decoded = (float)Math.exp(logScale), variance = decoded * decoded;
                    if (!Float.isFinite(variance) || variance <= 0)
                        throw new InvalidPly("Gaussian PLY decoded scale is outside the float32 rendering range");
                    varianceSum += variance;
                }
                if (!Float.isFinite(varianceSum)) throw new InvalidPly("Gaussian PLY covariance exceeds the float32 rendering range");
                float positionNorm = 0;
                for (int axis = 0; axis < 3; axis++) {
                    float value = row.getFloat(coordinates[axis] * 4);
                    positionNorm += value * value;
                    minimum[axis] = Math.min(minimum[axis], value);
                    maximum[axis] = Math.max(maximum[axis], value);
                }
                if (!Float.isFinite(positionNorm)) throw new InvalidPly("Gaussian PLY positions exceed the float32 rendering range");
            }
            float spanNorm = 0;
            for (int axis = 0; axis < 3; axis++) {
                float span = (float)(maximum[axis] - minimum[axis]);
                spanNorm += span * span;
            }
            if (!Float.isFinite(spanNorm)) throw new InvalidPly("Gaussian PLY bounds exceed the float32 rendering range");
            if (input.read() != -1) throw new InvalidPly("Gaussian PLY payload has trailing bytes");
            checkpoint.run();
            return new Summary(header.vertices(), new Bounds(new Vec3(minimum[0], minimum[1], minimum[2]),
                    new Vec3(maximum[0], maximum[1], maximum[2])), bytes, HexFormat.of().formatHex(digest.digest()));
        }
    }

    private record Header(int vertices, List<String> properties, int bytes) {}

    private Header readHeader(InputStream input) throws IOException {
        int consumed = 0, vertices = 0;
        boolean magic = false, format = false, element = false;
        var properties = new ArrayList<String>();
        while (true) {
            var line = new StringBuilder();
            int next;
            do {
                if (++consumed > MAX_HEADER_BYTES) throw new InvalidPly("Gaussian PLY header exceeds 64 KiB");
                next = input.read();
                if (next == -1) throw new InvalidPly("Gaussian PLY header is incomplete");
                if (next != '\n' && next != '\r' && (next < 32 || next > 126)) throw new InvalidPly("Gaussian PLY header must be ASCII");
                if (next != '\n') line.append((char)next);
            } while (next != '\n');
            String value = line.toString();
            if (value.endsWith("\r")) value = value.substring(0, value.length() - 1);
            if (!magic) {
                if (!value.equals("ply")) throw new InvalidPly("File is not a PLY 1.0 Gaussian scene");
                magic = true;
                continue;
            }
            if (value.startsWith("comment ") || value.equals("comment") || value.startsWith("obj_info ")) continue;
            String[] words = value.trim().split("\\s+");
            if (words[0].equals("format")) {
                if (format || element || !value.equals("format binary_little_endian 1.0"))
                    throw new InvalidPly("Use PLY 1.0 binary_little_endian encoding");
                format = true;
            } else if (words[0].equals("element")) {
                if (!format || element || words.length != 3 || !words[1].equals("vertex"))
                    throw new InvalidPly("Gaussian PLY must contain only one vertex element");
                try {
                    if (!words[2].matches("[0-9]{1,7}")) throw new NumberFormatException();
                    vertices = Integer.parseInt(words[2]);
                } catch (NumberFormatException e) { throw new InvalidPly("Gaussian PLY vertex count is invalid"); }
                if (vertices < 1 || vertices > MAX_VERTICES) throw new InvalidPly("Gaussian PLY supports 1 to 2,500,000 vertices");
                element = true;
            } else if (words[0].equals("property")) {
                if (!element || words.length != 3 || !Set.of("float", "float32").contains(words[1]))
                    throw new InvalidPly("Gaussian PLY properties must be scalar float or float32");
                String name = words[2];
                boolean supported = REQUIRED.contains(name) || Set.of("nx", "ny", "nz").contains(name) || name.matches("f_rest_([0-9]|[1-3][0-9]|4[0-4])");
                if (!supported || properties.contains(name)) throw new InvalidPly("Gaussian PLY has duplicate or unsupported properties");
                properties.add(name);
            } else if (value.equals("end_header")) {
                if (!element || !properties.containsAll(REQUIRED)) throw new InvalidPly("Gaussian PLY is missing required Gaussian properties");
                long normals = properties.stream().filter(Set.of("nx", "ny", "nz")::contains).count();
                if (normals != 0 && normals != 3) throw new InvalidPly("Gaussian PLY normals require nx, ny and nz");
                int harmonics = (int)properties.stream().filter(name -> name.startsWith("f_rest_")).count();
                if (!Set.of(0, 9, 24, 45).contains(harmonics)) throw new InvalidPly("Gaussian PLY spherical harmonics require 9, 24 or 45 properties");
                for (int i = 0; i < harmonics; i++)
                    if (!properties.contains("f_rest_" + i)) throw new InvalidPly("Gaussian PLY spherical harmonics must be contiguous");
                return new Header(vertices, List.copyOf(properties), consumed);
            } else throw new InvalidPly("Gaussian PLY header contains an unsupported declaration");
        }
    }
}
