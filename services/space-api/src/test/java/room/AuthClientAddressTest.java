package room;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.filter.ForwardedHeaderFilter;
import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;

class AuthClientAddressTest {
    @Test void trustIsExplicitAndStandardForwardingDoesNotSupplyClientIdentity() {
        var direct = new AuthClientAddress("");
        var request = request("192.0.2.10", "198.51.100.7");
        request.addHeader("Forwarded", "for=203.0.113.1");
        request.addHeader("X-Forwarded-For", "203.0.113.2");
        assertEquals("192.0.2.10", direct.resolve(request));
        assertEquals("198.51.100.7", new AuthClientAddress("192.0.2.10").resolve(request));
        assertEquals("192.0.2.10", new AuthClientAddress("192.0.2.11").resolve(request));
    }

    @Test void onlyOneNumericAddressIsAcceptedFromATrustedProxy() {
        var resolver = new AuthClientAddress("192.0.2.10");
        for (String invalid : new String[]{"", "localhost", "198.51.100.1, 198.51.100.2", "198.51.100.1:8080",
                "[2001:db8::1]", "fe80::1%eth0", "999.1.1.1", "127.1", "0127.0.0.1", "198.51.100.1\n"})
            assertEquals("192.0.2.10", resolver.resolve(request("192.0.2.10", invalid)), invalid);
        var duplicate = request("192.0.2.10", "198.51.100.1");
        duplicate.addHeader(AuthClientAddress.HEADER, "198.51.100.2");
        assertEquals("192.0.2.10", resolver.resolve(duplicate));
        assertEquals("192.0.2.10", resolver.resolve(request("192.0.2.10", null)));
    }

    @Test void numericAddressesNeverTriggerDnsAndEquivalentAddressesCanonicalize() {
        var resolver = new AuthClientAddress("192.0.2.10", host -> { fail("Numeric addresses must not use DNS"); return null; }, Clock.systemUTC());
        assertEquals("198.51.100.7", resolver.resolve(request("192.0.2.10", "::ffff:198.51.100.7")));
        assertEquals(resolver.resolve(request("192.0.2.10", "2001:db8::1")),
                resolver.resolve(request("192.0.2.10", "2001:0DB8:0000:0:0:0:0:1")));
        assertEquals("192.0.2.10", resolver.resolve(request("::ffff:192.0.2.10", null)));
    }

    @Test void springForwardedWrappersCannotChangeTheTrustDecision() throws Exception {
        var resolver = new AuthClientAddress("192.0.2.10");
        var original = request("192.0.2.11", "198.51.100.7");
        original.addHeader("Forwarded", "for=192.0.2.10;proto=https");
        var captured = new AtomicReference<HttpServletRequest>();
        new ForwardedHeaderFilter().doFilter(original, new org.springframework.mock.web.MockHttpServletResponse(),
                (request, response) -> captured.set((HttpServletRequest) request));
        assertTrue(captured.get().isSecure());
        assertEquals("192.0.2.11", resolver.resolve(captured.get()));
    }

    @Test void hostnamesResolveLazilyRefreshAndDropTrustOnFailure() throws Exception {
        var clock = new MutableClock();
        var calls = new AtomicInteger();
        var addresses = new AtomicReference<>(new InetAddress[]{InetAddress.getByName("192.0.2.10")});
        var resolver = new AuthClientAddress("web", host -> {
            calls.incrementAndGet();
            var result = addresses.get();
            if (result == null) throw new UnknownHostException(host);
            return result;
        }, clock);
        assertEquals(0, calls.get(), "API starts before the web service");
        assertEquals("198.51.100.7", resolver.resolve(request("192.0.2.10", "198.51.100.7")));
        assertEquals("198.51.100.7", resolver.resolve(request("192.0.2.10", "198.51.100.7")));
        assertEquals(1, calls.get());
        addresses.set(new InetAddress[]{InetAddress.getByName("192.0.2.12")});
        clock.now = clock.now.plusSeconds(11);
        assertEquals("192.0.2.10", resolver.resolve(request("192.0.2.10", "198.51.100.7")));
        assertEquals("198.51.100.7", resolver.resolve(request("192.0.2.12", "198.51.100.7")));
        addresses.set(null);
        clock.now = clock.now.plusSeconds(11);
        assertEquals("192.0.2.12", resolver.resolve(request("192.0.2.12", "198.51.100.7")));
    }

    private MockHttpServletRequest request(String peer, String header) {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr(peer);
        if (header != null) request.addHeader(AuthClientAddress.HEADER, header);
        return request;
    }

    private static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-10-11T12:00:00Z");
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
}
