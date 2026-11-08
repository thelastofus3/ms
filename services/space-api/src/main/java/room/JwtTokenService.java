package room;

import com.nimbusds.jose.*;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.text.ParseException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

/** Signed access tokens; no token or session records are stored. */
@Component
public class JwtTokenService {
    public record Identity(String accountId, long version) {}
    public static final long LIFETIME_SECONDS = 86400;
    private static final JOSEObjectType TYPE = new JOSEObjectType("at+jwt");
    private final byte[] secret;
    private final Clock clock;

    @Autowired
    public JwtTokenService(@Value("${ROOM_JWT_SECRET:}") String base64Secret) {
        this(base64Secret, Clock.systemUTC());
    }

    JwtTokenService(String base64Secret, Clock clock) {
        try {
            if (base64Secret == null || base64Secret.isBlank() || base64Secret.length() > 4096)
                throw new IllegalArgumentException();
            secret = Base64.getDecoder().decode(base64Secret);
            if (secret.length < 32) throw new IllegalArgumentException();
        } catch (IllegalArgumentException invalid) {
            throw new IllegalStateException("ROOM_JWT_SECRET must be Base64 encoding of at least 32 random bytes");
        }
        this.clock = Objects.requireNonNull(clock);
    }

    public String issue(String accountId, long version) {
        if (!canonicalUuid(accountId) || version < 0) throw new IllegalArgumentException("Invalid token identity");
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        var claims = new JWTClaimsSet.Builder().issuer("room-api").audience("room-app").subject(accountId)
                .claim("ver", version).jwtID(UUID.randomUUID().toString())
                .issueTime(Date.from(now)).notBeforeTime(Date.from(now))
                .expirationTime(Date.from(now.plusSeconds(LIFETIME_SECONDS))).build();
        var token = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.HS256).type(TYPE).build(), claims);
        try {
            token.sign(new MACSigner(secret));
            return token.serialize();
        } catch (JOSEException failure) {
            throw new IllegalStateException("Could not sign access token", failure);
        }
    }

    public Identity verify(String token) {
        if (!validFormat(token)) return null;
        try {
            var jwt = SignedJWT.parse(token);
            var header = jwt.getHeader();
            if (!JWSAlgorithm.HS256.equals(header.getAlgorithm()) || !TYPE.equals(header.getType())
                    || (header.getCriticalParams() != null && !header.getCriticalParams().isEmpty())
                    || !header.isBase64URLEncodePayload() || !jwt.verify(new MACVerifier(secret))) return null;
            var claims = jwt.getJWTClaimsSet();
            if (!"room-api".equals(claims.getIssuer()) || !List.of("room-app").equals(claims.getAudience())
                    || !canonicalUuid(claims.getSubject()) || !canonicalUuid(claims.getJWTID())) return null;
            Object version = claims.getClaim("ver");
            if (!(version instanceof Long || version instanceof Integer) || ((Number)version).longValue() < 0) return null;
            Date issued = claims.getIssueTime(), notBefore = claims.getNotBeforeTime(), expires = claims.getExpirationTime();
            if (issued == null || notBefore == null || expires == null) return null;
            Instant now = clock.instant();
            Instant start = issued.toInstant(), begins = notBefore.toInstant(), end = expires.toInstant();
            if (start.isBefore(Instant.EPOCH) || start.isAfter(now) || begins.isAfter(now) || !begins.equals(start)
                    || !end.isAfter(now) || !end.isAfter(start) || end.isAfter(start.plusSeconds(LIFETIME_SECONDS))) return null;
            return new Identity(claims.getSubject(), ((Number)version).longValue());
        } catch (ParseException | JOSEException | RuntimeException invalid) {
            // Malformed JOSE JSON can also trigger unchecked decoder exceptions.
            return null;
        }
    }

    public static boolean validFormat(String token) {
        return token != null && token.length() <= 8192
                && token.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+");
    }

    private static boolean canonicalUuid(String value) {
        try { return value != null && value.equals(UUID.fromString(value).toString()); }
        catch (IllegalArgumentException invalid) { return false; }
    }
}
