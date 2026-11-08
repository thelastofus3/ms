package room;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.filter.ForwardedHeaderFilter;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AuthControllerTest {
    private AuthTestDatabase fixture;
    private MockMvc http;
    private AuthService.Account administrator;

    @BeforeEach void setup() {
        fixture = new AuthTestDatabase(); administrator = fixture.admin();
        http = MockMvcBuilders.standaloneSetup(new AuthController(fixture.auth, new AuthClientAddress("192.0.2.10")))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new ObjectMapper()
                        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)))
                .setControllerAdvice(new ApiErrors()).addFilters(new ForwardedHeaderFilter(), new JwtAuthenticationFilter(fixture.auth)).build();
    }

    @Test void anonymousRegistrationSignsInAsAPlyUploader() throws Exception {
        var response = http.perform(post("/v1/rooms/auth/register").secure(true).header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"username\":\"New.User\",\"password\":\"a secure registration password\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse();
        var result = new ObjectMapper().readTree(response.getContentAsString());
        assertEquals("new.user", result.get("account").get("username").asText());
        assertEquals("SPLAT_UPLOADER", result.get("account").get("role").asText());
        assertFalse(result.get("account").get("disabled").asBoolean());
        assertEquals("Bearer", result.get("tokenType").asText());
        assertEquals(86400, result.get("expiresIn").asLong());
        var header = response.getHeader("Set-Cookie");
        assertNotNull(header);
        assertTrue(header.contains("HttpOnly")); assertTrue(header.contains("SameSite=Strict"));
        assertTrue(header.contains("Path=/")); assertTrue(header.contains("Secure")); assertTrue(header.contains("Max-Age=86400"));
        assertEquals(cookie(header).getValue(), result.get("accessToken").asText());
        http.perform(get("/v1/rooms/auth/me").cookie(cookie(header))).andExpect(status().isOk())
                .andExpect(content().json(result.get("account").toString()));
        http.perform(get("/v1/rooms/auth/me").header("Authorization", "Bearer " + result.get("accessToken").asText()))
                .andExpect(status().isOk()).andExpect(content().json(result.get("account").toString()));
    }

    @Test void registrationIgnoresRoleInjectionAndOnlyAdministratorsCanAssignRoles() throws Exception {
        var result = http.perform(post("/v1/rooms/auth/register").header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"uploader\",\"password\":\"a secure registration password\",\"role\":\"ADMIN\",\"disabled\":false}"))
                .andExpect(status().isCreated()).andReturn().getResponse();
        var registration = new ObjectMapper().readTree(result.getContentAsString());
        assertEquals("SPLAT_UPLOADER", registration.get("account").get("role").asText());
        var token = cookie(result.getHeader("Set-Cookie"));
        var id = registration.get("account").get("id").asText();
        http.perform(get("/v1/rooms/auth/users").cookie(token)).andExpect(status().isForbidden());
        http.perform(patch("/v1/rooms/auth/users/" + id).cookie(token).header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"ADMIN\"}"))
                .andExpect(status().isForbidden());
        var adminCookie = loginCookie("admin", "a secure bootstrap password");
        http.perform(patch("/v1/rooms/auth/users/" + id).cookie(adminCookie).header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"RECONSTRUCTOR\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.role").value("RECONSTRUCTOR"));
        http.perform(get("/v1/rooms/auth/me").cookie(token)).andExpect(status().isUnauthorized());
        http.perform(get("/v1/rooms/auth/me").cookie(loginCookie("uploader", "a secure registration password")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.role").value("RECONSTRUCTOR"));
    }

    @Test void ignoringRegistrationRoleFieldsDoesNotLoosenTheLoginContract() throws Exception {
        http.perform(post("/v1/rooms/auth/login").header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"a secure bootstrap password\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isBadRequest()).andExpect(header().doesNotExist("Set-Cookie"));
        assertNotNull(loginCookie("admin", "a secure bootstrap password"));
    }

    @Test void registrationRejectsNormalizedDuplicatesAndInvalidCredentialsWithoutIssuingCookies() throws Exception {
        http.perform(post("/v1/rooms/auth/register").header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"username\":\"Builder\",\"password\":\"a secure registration password\"}"))
                .andExpect(status().isCreated());
        http.perform(post("/v1/rooms/auth/register").header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"username\":\" BUILDER \",\"password\":\"a secure other password\"}"))
                .andExpect(status().isConflict()).andExpect(header().doesNotExist("Set-Cookie"));
        for (String body : new String[]{"{}", "{\"username\":\"ab\",\"password\":\"a secure registration password\"}",
                "{\"username\":\"valid-user\",\"password\":\"short\"}", "{\"username\":\"valid-user\",\"password\":\"            \"}"}) {
            http.perform(post("/v1/rooms/auth/register").header("Origin", "http://localhost:5173")
                            .contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isBadRequest()).andExpect(header().doesNotExist("Set-Cookie"));
        }
        assertEquals(2, fixture.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void registrationRequiresATrustedOriginEvenWithAnExistingBearerToken() throws Exception {
        var token = fixture.auth.login("admin", "a secure bootstrap password", "10.0.0.1").token();
        for (String origin : new String[]{"", "https://untrusted.example"}) {
            var request = post("/v1/rooms/auth/register").header("Authorization", "Bearer " + token)
                    .contentType(MediaType.APPLICATION_JSON).content("{\"username\":\"visitor\",\"password\":\"a secure registration password\"}");
            if (!origin.isEmpty()) request.header("Origin", origin);
            http.perform(request).andExpect(status().isForbidden()).andExpect(header().doesNotExist("Set-Cookie"));
        }
        assertEquals(1, fixture.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void excessiveRegistrationRequestsReturn429WithoutCreatingAnAccountOrCookie() throws Exception {
        for (int i = 0; i < 10; i++) {
            http.perform(post("/v1/rooms/auth/register").header("Origin", "http://localhost:5173")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"admin\",\"password\":\"a secure registration password\"}"))
                    .andExpect(status().isConflict());
        }
        http.perform(post("/v1/rooms/auth/register").header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"visitor\",\"password\":\"a secure registration password\"}"))
                .andExpect(status().isTooManyRequests()).andExpect(header().doesNotExist("Set-Cookie"));
        assertEquals(1, fixture.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
        assertNotNull(loginCookie("admin", "a secure bootstrap password"));
    }

    @Test void clientsBehindOneTrustedProxyHaveIndependentRegistrationBudgets() throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            http.perform(post("/v1/rooms/auth/register").with(raw -> { raw.setRemoteAddr("192.0.2.10"); return raw; })
                            .header("Origin", "http://localhost:5173").header("X-Room-Client-IP", "198.51.100.1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"admin\",\"password\":\"a secure registration password\"}"))
                    .andExpect(status().isConflict());
        }
        http.perform(post("/v1/rooms/auth/register").with(raw -> { raw.setRemoteAddr("192.0.2.10"); return raw; })
                        .header("Origin", "http://localhost:5173").header("X-Room-Client-IP", "198.51.100.2")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"a secure registration password\"}"))
                .andExpect(status().isConflict());
        var limited = http.perform(post("/v1/rooms/auth/register").with(raw -> { raw.setRemoteAddr("192.0.2.10"); return raw; })
                        .header("Origin", "http://localhost:5173").header("X-Room-Client-IP", "198.51.100.1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"a secure registration password\"}"))
                .andExpect(status().isTooManyRequests()).andExpect(header().exists("Retry-After"))
                .andReturn().getResponse();
        assertTrue(Long.parseLong(limited.getHeader("Retry-After")) > 0);
    }

    @Test void anUntrustedPeerCannotRotatePrivateClientHeadersToResetItsBudget() throws Exception {
        for (int attempt = 1; attempt <= 11; attempt++) {
            http.perform(post("/v1/rooms/auth/register").with(raw -> { raw.setRemoteAddr("192.0.2.14"); return raw; })
                            .header("Origin", "http://localhost:5173")
                            .header("X-Room-Client-IP", "198.51.100." + attempt)
                            .header("Forwarded", "for=192.0.2.10;proto=https")
                            .header("X-Forwarded-For", "192.0.2.10")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"username\":\"admin\",\"password\":\"a secure registration password\"}"))
                    .andExpect(attempt <= 10 ? status().isConflict() : status().isTooManyRequests());
        }
    }

    @Test void forwardedClientAddressesCannotResetTheRegistrationBudgetOfOnePeer() throws Exception {
        for (String forwardedHeader : new String[]{"Forwarded", "X-Forwarded-For"}) {
            String peer = forwardedHeader.equals("Forwarded") ? "192.0.2.10" : "192.0.2.11";
            for (int attempt = 1; attempt <= 11; attempt++) {
                var request = post("/v1/rooms/auth/register").with(raw -> { raw.setRemoteAddr(peer); return raw; })
                        .header("Origin", "http://localhost:5173")
                        .header(forwardedHeader, (forwardedHeader.equals("Forwarded") ? "for=" : "") + "203.0.113." + attempt)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"a secure registration password\"}");
                http.perform(request).andExpect(attempt <= 10 ? status().isConflict() : status().isTooManyRequests());
            }
        }
        assertEquals(1, fixture.db.queryForObject("SELECT count(*) FROM room_accounts", Integer.class));
    }

    @Test void forwardedClientAddressesCannotResetTheLoginBudgetOfOnePeer() throws Exception {
        for (int attempt = 1; attempt <= 31; attempt++) {
            var request = post("/v1/rooms/auth/login").with(raw -> { raw.setRemoteAddr("192.0.2.12"); return raw; })
                    .header("Origin", "http://localhost:5173").header("Forwarded", "for=203.0.113." + attempt)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"missing-user-" + attempt + "\",\"password\":\"a secure registration password\"}");
            http.perform(request).andExpect(attempt <= 30 ? status().isUnauthorized() : status().isTooManyRequests());
        }
    }

    @Test void loginIssuesAHardenedCookieAndMeReturnsOnlyTheAccountShape() throws Exception {
        var response = http.perform(post("/v1/rooms/auth/login").secure(true).header("Origin", "http://localhost:5173")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"username\":\"ADMIN\",\"password\":\"a secure bootstrap password\"}"))
                .andExpect(status().isOk()).andReturn().getResponse();
        var header = response.getHeader("Set-Cookie");
        assertNotNull(header);
        assertTrue(header.contains("HttpOnly")); assertTrue(header.contains("SameSite=Strict"));
        assertTrue(header.contains("Path=/")); assertTrue(header.contains("Secure")); assertTrue(header.contains("Max-Age=86400"));
        var login = new ObjectMapper().readTree(response.getContentAsString());
        assertEquals(4, login.size());
        var account = login.get("account");
        assertEquals("Bearer", login.get("tokenType").asText());
        assertEquals(86400, login.get("expiresIn").asLong());
        assertEquals(cookie(header).getValue(), login.get("accessToken").asText());
        assertEquals(3, login.get("accessToken").asText().split("\\.").length);
        assertEquals(4, account.size()); assertEquals(administrator.id(), account.get("id").asText());
        assertEquals("admin", account.get("username").asText()); assertEquals("ADMIN", account.get("role").asText());
        assertFalse(account.get("disabled").asBoolean());
        http.perform(get("/v1/rooms/auth/me").cookie(cookie(header))).andExpect(status().isOk())
                .andExpect(content().json(account.toString()));
        http.perform(get("/v1/rooms/auth/me").header("Authorization", "Bearer " + login.get("accessToken").asText()))
                .andExpect(status().isOk()).andExpect(content().json(account.toString()));
    }

    @Test void logoutRevokesTheTokenAndUnsafeRequestsKeepTheOriginGuard() throws Exception {
        var cookie = loginCookie("admin", "a secure bootstrap password");
        http.perform(post("/v1/rooms/auth/logout").cookie(cookie).header("Origin", "https://untrusted.example"))
                .andExpect(status().isForbidden());
        http.perform(get("/v1/rooms/auth/me").cookie(cookie)).andExpect(status().isOk());
        http.perform(post("/v1/rooms/auth/logout").cookie(cookie).header("Origin", "http://localhost:5173"))
                .andExpect(status().isOk()).andExpect(header().doesNotExist("Set-Cookie"));
        http.perform(get("/v1/rooms/auth/me").cookie(cookie)).andExpect(status().isUnauthorized());
        http.perform(post("/v1/rooms/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"admin\",\"password\":\"a secure bootstrap password\"}"))
                .andExpect(status().isForbidden());
    }

    @Test void currentRoleAndDisabledStatusAreEnforcedAtTheHttpBoundary() throws Exception {
        var user = fixture.auth.createUser(administrator, "uploader", "a secure uploader password", Role.SPLAT_UPLOADER);
        var cookie = loginCookie("uploader", "a secure uploader password");
        http.perform(get("/v1/rooms/auth/users").cookie(cookie)).andExpect(status().isForbidden());
        http.perform(post("/v1/rooms/auth/users").cookie(cookie).header("Origin", "http://localhost:5173")
                .contentType(MediaType.APPLICATION_JSON).content("{\"username\":\"extra-admin\",\"password\":\"a long extra admin password\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isForbidden());
        fixture.auth.updateUser(administrator, user.id(), null, null, true);
        http.perform(get("/v1/rooms/auth/me").cookie(cookie)).andExpect(status().isUnauthorized());
    }

    @Test void delayedAndReplayedLogoutResponsesCannotEraseANewLoginCookie() throws Exception {
        var first = loginCookie("admin", "a secure bootstrap password");
        var second = loginCookie("admin", "a secure bootstrap password");
        var delayedLogout = http.perform(post("/v1/rooms/auth/logout").cookie(first).header("Origin", "http://localhost:5173"))
                .andExpect(status().isOk()).andReturn().getResponse();
        http.perform(get("/v1/rooms/auth/me").cookie(first)).andExpect(status().isUnauthorized());
        http.perform(get("/v1/rooms/auth/me").cookie(second)).andExpect(status().isUnauthorized());

        var fresh = loginCookie("admin", "a secure bootstrap password");
        var replayedLogout = http.perform(post("/v1/rooms/auth/logout").cookie(fresh)
                        .header("Authorization", "Bearer " + first.getValue()).header("Origin", "http://localhost:5173"))
                .andExpect(status().isOk()).andReturn().getResponse();
        http.perform(get("/v1/rooms/auth/me").cookie(fresh)).andExpect(status().isOk());
        assertNull(delayedLogout.getHeader("Set-Cookie"), "A delayed logout response must not overwrite a newer login cookie");
        assertNull(replayedLogout.getHeader("Set-Cookie"), "A replayed logout response must not overwrite a newer login cookie");
    }

    private Cookie loginCookie(String username, String password) throws Exception {
        var body = new ObjectMapper().writeValueAsString(new AuthController.Credentials(username, password));
        var header = http.perform(post("/v1/rooms/auth/login").header("Origin", "http://localhost:5173")
                .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk()).andReturn().getResponse().getHeader("Set-Cookie");
        return cookie(header);
    }
    private Cookie cookie(String header) { return new Cookie("room_access_token", header.substring("room_access_token=".length(), header.indexOf(';'))); }
}
