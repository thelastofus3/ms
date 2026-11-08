package room;

import com.nimbusds.jose.*;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.util.Base64URL;
import com.nimbusds.jwt.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.DynamicTest;
import java.time.*;
import java.util.*;
import java.util.stream.Stream;
import static org.junit.jupiter.api.Assertions.*;

class JwtTokenServiceTest {
    static final String SECRET = Base64.getEncoder().encodeToString("a signing key used exclusively for unit tests".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    private static final String ACCOUNT = "12345678-1234-4234-8234-123456789abc";
    private static final Instant NOW = Instant.parse("2026-10-11T12:00:00Z");
    private final JwtTokenService tokens = new JwtTokenService(SECRET, Clock.fixed(NOW, ZoneOffset.UTC));

    @Test void issuedTokensHaveVerifiedIdentityAndIndependentSignatures() throws Exception {
        String first = tokens.issue(ACCOUNT, 4);
        String second = tokens.issue(ACCOUNT, 4);
        assertNotEquals(first, second);
        assertEquals(new JwtTokenService.Identity(ACCOUNT, 4), tokens.verify(first));
        var parsed = SignedJWT.parse(first);
        assertEquals(JWSAlgorithm.HS256, parsed.getHeader().getAlgorithm());
        assertEquals(new JOSEObjectType("at+jwt"), parsed.getHeader().getType());
        var claims = parsed.getJWTClaimsSet();
        assertEquals("room-api", claims.getIssuer());
        assertEquals(List.of("room-app"), claims.getAudience());
        assertEquals(ACCOUNT, claims.getSubject());
        assertEquals(NOW, claims.getIssueTime().toInstant());
        assertEquals(NOW, claims.getNotBeforeTime().toInstant());
        assertEquals(NOW.plusSeconds(86400), claims.getExpirationTime().toInstant());
        assertNotNull(UUID.fromString(claims.getJWTID()));
        assertTrue(parsed.verify(new com.nimbusds.jose.crypto.MACVerifier(Base64.getDecoder().decode(SECRET))));
    }

    @Test void changingSignedClaimsOrUsingAnotherKeyRejectsTheToken() throws Exception {
        String original = tokens.issue(ACCOUNT, 4);
        String[] parts = original.split("\\.");
        var altered = new JWTClaimsSet.Builder(SignedJWT.parse(original).getJWTClaimsSet()).claim("ver", 5).build();
        parts[1] = Base64URL.encode(altered.toString()).toString();
        assertNull(tokens.verify(String.join(".", parts)));
        var other = new JwtTokenService(Base64.getEncoder().encodeToString(new byte[32]), Clock.fixed(NOW, ZoneOffset.UTC));
        assertNull(other.verify(original));
    }

    @Test void expiredTokensStopWorkingAtTheExactExpiryBoundary() {
        String token = tokens.issue(ACCOUNT, 4);
        var before = new JwtTokenService(SECRET, Clock.fixed(NOW.plusSeconds(86399), ZoneOffset.UTC));
        var expired = new JwtTokenService(SECRET, Clock.fixed(NOW.plusSeconds(86400), ZoneOffset.UTC));
        assertNotNull(before.verify(token));
        assertNull(expired.verify(token));
    }

    @Test void unsupportedAlgorithmUnsignedTokenAndWrongTypeAreRejected() throws Exception {
        assertNull(tokens.verify(signed(claims().build(), JWSAlgorithm.HS384, "at+jwt")));
        assertNull(tokens.verify(new PlainJWT(claims().build()).serialize()));
        assertNull(tokens.verify(signed(claims().build(), JWSAlgorithm.HS256, "JWT")));
    }

    @TestFactory Stream<DynamicTest> requiredClaimsCannotBeOmitted() {
        return Stream.of("iss", "aud", "sub", "ver", "jti", "iat", "nbf", "exp").map(name ->
                DynamicTest.dynamicTest("reject missing " + name, () ->
                        assertNull(tokens.verify(signed(claims().claim(name, null).build(), JWSAlgorithm.HS256, "at+jwt")))));
    }

    @TestFactory Stream<DynamicTest> invalidIdentitiesAndTimingFailClosed() {
        Map<String, Object> invalid = new LinkedHashMap<>();
        invalid.put("wrong issuer", claims().issuer("other-api").build());
        invalid.put("wrong audience", claims().audience("other-app").build());
        invalid.put("invalid subject", claims().subject("1-1-1-1-1").build());
        invalid.put("invalid token id", claims().jwtID("not-a-uuid").build());
        invalid.put("negative version", claims().claim("ver", -1).build());
        invalid.put("fractional version", claims().claim("ver", 4.5).build());
        invalid.put("string version", claims().claim("ver", "4").build());
        invalid.put("future issued time", claims().issueTime(Date.from(NOW.plusSeconds(1))).build());
        invalid.put("future not before", claims().notBeforeTime(Date.from(NOW.plusSeconds(1))).build());
        invalid.put("excessive lifetime", claims().expirationTime(Date.from(NOW.plusSeconds(86401))).build());
        invalid.put("expired", claims().expirationTime(Date.from(NOW.minusSeconds(1))).build());
        return invalid.entrySet().stream().map(item -> DynamicTest.dynamicTest(item.getKey(), () ->
                assertNull(tokens.verify(signed((JWTClaimsSet)item.getValue(), JWSAlgorithm.HS256, "at+jwt")))));
    }

    @Test void malformedAndOversizedTokensFailClosed() {
        for (String token : List.of("", "opaque-token", "a.b.c", "a.b.", "a.b.c.d", "a.b.c\r\n", "W10.e30.AA", "MQ.e30.AA", "Ingi.e30.AA", "dHJ1ZQ.e30.AA", "a".repeat(8192) + ".b.c"))
            assertNull(tokens.verify(token));
        assertNull(tokens.verify(null));
    }

    @Test void aJsonNullHeaderCannotCrashAuthentication() {
        // Header is literal JSON null; an attacker needs no signing secret.
        assertNull(assertDoesNotThrow(() -> tokens.verify("bnVsbA.e30.AA")));
    }

    @Test void missingMalformedAndShortSigningKeysFailStartup() {
        for (String secret : List.of("", "invalid base64!", Base64.getEncoder().encodeToString(new byte[31])))
            assertThrows(IllegalStateException.class, () -> new JwtTokenService(secret, Clock.systemUTC()));
        assertThrows(IllegalStateException.class, () -> new JwtTokenService(null, Clock.systemUTC()));
    }

    private JWTClaimsSet.Builder claims() {
        return new JWTClaimsSet.Builder().issuer("room-api").audience("room-app").subject(ACCOUNT)
                .jwtID("87654321-4321-4321-8321-cba987654321").claim("ver", 4L)
                .issueTime(Date.from(NOW)).notBeforeTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(86400)));
    }

    private String signed(JWTClaimsSet claims, JWSAlgorithm algorithm, String type) throws Exception {
        var jwt = new SignedJWT(new JWSHeader.Builder(algorithm).type(new JOSEObjectType(type)).build(), claims);
        // Use 64 bytes so the deliberately wrong HS384 fixture can be signed independently.
        byte[] secret = algorithm.equals(JWSAlgorithm.HS256) ? Base64.getDecoder().decode(SECRET) : new byte[64];
        jwt.sign(new MACSigner(secret));
        return jwt.serialize();
    }
}
