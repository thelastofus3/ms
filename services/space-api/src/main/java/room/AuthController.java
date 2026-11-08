package room;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/v1/rooms/auth")
public class AuthController {
    private final AuthService auth;
    private final AuthClientAddress clients;
    public AuthController(AuthService auth, AuthClientAddress clients) { this.auth = auth; this.clients = clients; }
    public record Credentials(@NotBlank @Size(max=64) String username, @NotBlank @Size(max=1024) String password) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record RegistrationCredentials(@NotBlank @Size(max=64) String username, @NotBlank @Size(max=1024) String password) {}
    public record CreateUser(@NotBlank @Size(max=64) String username, @NotBlank @Size(min=12,max=1024) String password, @NotNull Role role) {}
    public record UpdateUser(@Size(min=12,max=1024) String password, Role role, Boolean disabled) {}
    public record LoginResponse(AuthService.Account account, String accessToken, String tokenType, long expiresIn) {}

    @GetMapping("/me") public AuthService.Account me(HttpServletRequest request) { return AuthService.current(request); }
    @PostMapping("/login") public LoginResponse login(@Valid @RequestBody Credentials body, HttpServletRequest request, HttpServletResponse response) {
        var login = auth.login(body.username(), body.password(), clients.resolve(request));
        JwtAuthenticationFilter.setAccessTokenCookie(request, response, login.token());
        return new LoginResponse(login.account(), login.token(), "Bearer", 86400);
    }
    @PostMapping("/register") @ResponseStatus(HttpStatus.CREATED)
    public LoginResponse register(@Valid @RequestBody RegistrationCredentials body, HttpServletRequest request, HttpServletResponse response) {
        var login = auth.register(body.username(), body.password(), clients.resolve(request));
        JwtAuthenticationFilter.setAccessTokenCookie(request, response, login.token());
        return new LoginResponse(login.account(), login.token(), "Bearer", 86400);
    }
    @PostMapping("/logout") public AuthService.Account logout(HttpServletRequest request) {
        var account = request.getAttribute("roomAccount") instanceof AuthService.Account actor ? actor : null;
        auth.logout(JwtAuthenticationFilter.accessToken(request));
        return account;
    }
    @GetMapping("/users") public List<AuthService.Account> users(HttpServletRequest request) { return auth.users(AuthService.current(request)); }
    @PostMapping("/users") public AuthService.Account create(@Valid @RequestBody CreateUser body, HttpServletRequest request) {
        return auth.createUser(AuthService.current(request), body.username(), body.password(), body.role());
    }
    @PatchMapping("/users/{id}") public AuthService.Account update(@PathVariable String id, @Valid @RequestBody UpdateUser body, HttpServletRequest request) {
        return auth.updateUser(AuthService.current(request), id, body.password(), body.role(), body.disabled());
    }

}
