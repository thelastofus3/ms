package room;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UrlPathHelper;
import java.io.IOException;
import java.util.*;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {
    private static final UrlPathHelper PATHS = new UrlPathHelper();
    private final AuthService auth;
    private final Set<String> origins;
    public JwtAuthenticationFilter(AuthService auth) {
        this.auth = auth;
        this.origins = new HashSet<>();
        for (String origin : System.getenv().getOrDefault("ROOM_BROWSER_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")) {
            if (!origin.isBlank()) origins.add(origin.trim());
        }
    }
    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String path = PATHS.getPathWithinApplication(req);
        if (!path.equals("/v1/rooms") && !path.startsWith("/v1/rooms/")) { chain.doFilter(req, res); return; }
        res.setHeader("Cache-Control", "no-store");
        if (req.getMethod().equals("OPTIONS")) { chain.doFilter(req, res); return; }
        var token = accessToken(req);
        boolean bearer = req.getHeader("Authorization") != null && token != null;
        boolean issuesCookie = req.getMethod().equals("POST") && Set.of("/v1/rooms/auth/login", "/v1/rooms/auth/register").contains(path);
        var origin = req.getHeader("Origin");
        if (!Set.of("GET", "HEAD").contains(req.getMethod())
                && (origin == null ? issuesCookie || !bearer : !origins.contains(origin))) {
            res.setStatus(403); res.setContentType("application/json"); res.getWriter().write("{\"message\":\"Untrusted request origin\"}"); return;
        }
        var account = auth.resolve(token);
        if (account != null) {
            req.setAttribute("roomAccount", account);
            req.setAttribute("roomOwner", account.id());
        }
        boolean publicAuth = req.getMethod().equals("POST") && Set.of("/v1/rooms/auth/login", "/v1/rooms/auth/register", "/v1/rooms/auth/logout").contains(path);
        if (account == null && !publicAuth) {
            res.setStatus(401); res.setContentType("application/json"); res.getWriter().write("{\"message\":\"Authentication required\"}"); return;
        }
        chain.doFilter(req, res);
    }
    static String accessToken(HttpServletRequest request) {
        var authorization = request.getHeaders("Authorization");
        if (authorization != null && authorization.hasMoreElements()) {
            String header = authorization.nextElement();
            if (authorization.hasMoreElements() || header == null || header.length() > 8199
                    || !header.regionMatches(true, 0, "Bearer ", 0, 7)) return null;
            String token = header.substring(7);
            return JwtTokenService.validFormat(token) ? token : null;
        }
        if (request.getCookies() != null) for (Cookie cookie : request.getCookies())
            if (cookie.getName().equals("room_access_token") && JwtTokenService.validFormat(cookie.getValue())) return cookie.getValue();
        return null;
    }
    static void setAccessTokenCookie(HttpServletRequest req, HttpServletResponse res, String token) {
        res.addHeader("Set-Cookie", "room_access_token=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400" + (req.isSecure() ? "; Secure" : ""));
    }
}
