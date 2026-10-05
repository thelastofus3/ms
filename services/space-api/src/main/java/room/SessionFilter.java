package room;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.*;

@Component
public class SessionFilter extends OncePerRequestFilter {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final Set<String> origins = Set.of(System.getenv().getOrDefault("ROOM_BROWSER_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(","));
    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        if (!req.getRequestURI().startsWith("/v1/rooms")) { chain.doFilter(req, res); return; }
        if (!Set.of("GET", "HEAD", "OPTIONS").contains(req.getMethod()) && !origins.contains(req.getHeader("Origin"))) {
            res.setStatus(403); res.setContentType("application/json"); res.getWriter().write("{\"message\":\"Untrusted request origin\"}"); return;
        }
        String session = null;
        if (req.getCookies() != null) for (Cookie cookie : req.getCookies())
            if (cookie.getName().equals("room_session") && cookie.getValue().matches("[A-Za-z0-9_-]{43}")) session = cookie.getValue();
        if (session == null) {
            byte[] bytes = new byte[32]; RANDOM.nextBytes(bytes);
            session = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
            setSessionCookie(req, res, session);
        }
        req.setAttribute("roomOwner", session);
        res.setHeader("Cache-Control", "no-store");
        chain.doFilter(req, res);
    }
    static void setSessionCookie(HttpServletRequest req, HttpServletResponse res, String session) {
        res.addHeader("Set-Cookie", "room_session=" + session + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000" + (req.isSecure() ? "; Secure" : ""));
    }
}
