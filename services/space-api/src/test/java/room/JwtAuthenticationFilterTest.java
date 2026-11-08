package room;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import java.util.concurrent.atomic.AtomicBoolean;
import jakarta.servlet.http.Cookie;
import static org.junit.jupiter.api.Assertions.*;

class JwtAuthenticationFilterTest {
    @Test void registrationIsPublicOnlyForTheExactPostRouteAndATrustedOrigin() throws Exception {
        var filter = new JwtAuthenticationFilter(new AuthTestDatabase().auth);
        var registration = new MockHttpServletRequest("POST", "/v1/rooms/auth/register");
        registration.addHeader("Origin", "http://localhost:5173");
        var called = new AtomicBoolean();
        filter.doFilter(registration, new MockHttpServletResponse(), (req, res) -> called.set(true));
        assertTrue(called.get());
        for (String path : new String[]{"/v1/rooms/auth/register/", "/v1/rooms/auth/register-extra", "/v1/rooms/auth/users"}) {
            var request = new MockHttpServletRequest("POST", path);
            request.addHeader("Origin", "http://localhost:5173");
            var response = new MockHttpServletResponse();
            filter.doFilter(request, response, (req, res) -> fail("Anonymous access granted: " + path));
            assertEquals(401, response.getStatus(), path);
        }
        var response = new MockHttpServletResponse();
        filter.doFilter(new MockHttpServletRequest("GET", "/v1/rooms/auth/register"), response, (req, res) -> fail("Anonymous GET registration allowed"));
        assertEquals(401, response.getStatus());
    }

    @Test void registrationCannotBypassTheOriginGuardWithBearerOrEncodedRoutes() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        var filter = new JwtAuthenticationFilter(f.auth);
        for (String path : new String[]{"/v1/rooms/auth/register", "/v1/r%6foms/auth/register", "/v1/rooms;ignored/auth/register", "/application/v1/rooms/auth/register"}) {
            var request = new MockHttpServletRequest("POST", path);
            if (path.startsWith("/application/")) request.setContextPath("/application");
            request.addHeader("Authorization", "Bearer " + login.token());
            var response = new MockHttpServletResponse();
            filter.doFilter(request, response, (req, res) -> fail("Registration bypassed Origin guard: " + path));
            assertEquals(403, response.getStatus(), path);
        }
    }

    @Test void anonymousRequestsCannotObtainAnOwnerOrAuthenticationCookie() throws Exception {
        var request = new MockHttpServletRequest("GET", "/v1/rooms/jobs");
        var response = new MockHttpServletResponse();
        var called = new AtomicBoolean();
        new JwtAuthenticationFilter(new AuthTestDatabase().auth).doFilter(request, response, (req, res) -> called.set(true));
        assertEquals(401, response.getStatus());
        assertFalse(called.get());
        assertNull(request.getAttribute("roomOwner"));
        assertNull(response.getHeader("Set-Cookie"));
    }

    @Test void authenticatedRequestsUseTheAccountUuidRatherThanTheBearerToken() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        var request = new MockHttpServletRequest("GET", "/v1/rooms/jobs");
        request.setCookies(new Cookie("room_access_token", login.token()));
        var response = new MockHttpServletResponse(); var called = new AtomicBoolean();
        new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> called.set(true));
        assertTrue(called.get());
        assertEquals(login.account().id(), request.getAttribute("roomOwner"));
        assertEquals(login.account(), request.getAttribute("roomAccount"));
    }

    @Test void splatOnlyAccountsCannotUseCapturePermissionChecks() {
        var request = new MockHttpServletRequest();
        request.setAttribute("roomAccount", new AuthService.Account("f2ab45ef-d40c-4ae4-a6c9-03b46d8a107f", "uploader", Role.SPLAT_UPLOADER, false));
        assertEquals(403, assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> AuthService.requireCaptureUpload(request)).getStatusCode().value());
        for (var role : new Role[]{Role.ADMIN, Role.RECONSTRUCTOR}) {
            request.setAttribute("roomAccount", new AuthService.Account("f2ab45ef-d40c-4ae4-a6c9-03b46d8a107f", "uploader", role, false));
            assertDoesNotThrow(() -> AuthService.requireCaptureUpload(request));
        }
    }

    @Test void encodedAndContextPrefixedRoutesCannotBypassTheOriginGuard() throws Exception {
        var filter = new JwtAuthenticationFilter(new AuthTestDatabase().auth);
        for (String path : new String[]{"/v1/r%6foms/auth/login", "/v1/rooms;ignored/auth/login", "/application/v1/rooms/auth/login"}) {
            var request = new MockHttpServletRequest("POST", path);
            if (path.startsWith("/application/")) request.setContextPath("/application");
            var response = new MockHttpServletResponse(); var called = new AtomicBoolean();
            filter.doFilter(request, response, (req, res) -> called.set(true));
            assertEquals(403, response.getStatus(), path);
            assertFalse(called.get(), path);
        }
    }

    @Test void bearerAuthenticationSupportsReadsAndWritesWithoutAnOrigin() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        for (String method : new String[]{"GET", "POST"}) {
            var request = new MockHttpServletRequest(method, "/v1/rooms/jobs");
            request.addHeader("Authorization", "bEaReR " + login.token());
            var response = new MockHttpServletResponse(); var called = new AtomicBoolean();
            new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> called.set(true));
            assertTrue(called.get(), method);
            assertEquals(login.account().id(), request.getAttribute("roomOwner"));
            assertEquals("no-store", response.getHeader("Cache-Control"));
        }
    }

    @Test void invalidOrDuplicateAuthorizationCannotFallBackToAValidCookie() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        for (String header : new String[]{"", "Basic credentials", "Bearer ", "Bearer invalid.jwt.token", "Bearer  " + login.token(), "Bearer " + "a".repeat(8193)}) {
            var request = new MockHttpServletRequest("GET", "/v1/rooms/jobs");
            request.setCookies(new Cookie("room_access_token", login.token()));
            request.addHeader("Authorization", header);
            var response = new MockHttpServletResponse(); var called = new AtomicBoolean();
            new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> called.set(true));
            assertEquals(401, response.getStatus());
            assertFalse(called.get());
            assertNull(request.getAttribute("roomAccount"));
        }
        var request = new MockHttpServletRequest("GET", "/v1/rooms/jobs");
        request.setCookies(new Cookie("room_access_token", login.token()));
        request.addHeader("Authorization", "Bearer " + login.token());
        request.addHeader("Authorization", "Bearer " + login.token());
        var response = new MockHttpServletResponse();
        new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> fail("Duplicate authorization authenticated"));
        assertEquals(401, response.getStatus());
    }

    @Test void cookieWritesRequireAnAllowedOriginAndBearerWritesRejectUntrustedOrigins() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        for (boolean bearer : new boolean[]{false, true}) {
            var request = new MockHttpServletRequest("POST", "/v1/rooms/jobs");
            if (bearer) request.addHeader("Authorization", "Bearer " + login.token());
            else request.setCookies(new Cookie("room_access_token", login.token()));
            if (bearer) request.addHeader("Origin", "https://untrusted.example");
            var response = new MockHttpServletResponse();
            new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> fail("Untrusted origin accepted"));
            assertEquals(403, response.getStatus());
        }
        var request = new MockHttpServletRequest("POST", "/v1/rooms/jobs");
        request.setCookies(new Cookie("room_access_token", login.token()));
        request.addHeader("Origin", "http://localhost:5173");
        var called = new AtomicBoolean();
        new JwtAuthenticationFilter(f.auth).doFilter(request, new MockHttpServletResponse(), (req, res) -> called.set(true));
        assertTrue(called.get());
    }

    @Test void loginRequiresAnAllowedOriginEvenWithABearerToken() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        var request = new MockHttpServletRequest("POST", "/v1/rooms/auth/login");
        request.addHeader("Authorization", "Bearer " + login.token());
        var response = new MockHttpServletResponse();
        new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> fail("Login bypassed origin guard"));
        assertEquals(403, response.getStatus());
    }

    @Test void legacySessionCookiesDoNotAuthenticateAfterMigration() throws Exception {
        var f = new AuthTestDatabase(); f.admin();
        var login = f.auth.login("admin", "a secure bootstrap password", "127.0.0.1");
        var request = new MockHttpServletRequest("GET", "/v1/rooms/jobs");
        request.setCookies(new Cookie("room_session", login.token()));
        var response = new MockHttpServletResponse();
        new JwtAuthenticationFilter(f.auth).doFilter(request, response, (req, res) -> fail("Legacy cookie authenticated"));
        assertEquals(401, response.getStatus());
    }
}
