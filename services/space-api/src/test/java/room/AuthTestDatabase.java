package room;

import org.h2.jdbcx.JdbcDataSource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import java.time.Clock;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

final class AuthTestDatabase {
    final JdbcTemplate db;
    final AuthService auth;
    final JwtTokenService tokens;
    final DataSourceTransactionManager transactions;
    static final String JWT_SECRET = Base64.getEncoder().encodeToString("0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.US_ASCII));

    AuthTestDatabase() { this(Clock.systemUTC()); }

    AuthTestDatabase(Clock clock) {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=PostgreSQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        db = new JdbcTemplate(source);
        transactions = new DataSourceTransactionManager(source);
        db.execute("CREATE DOMAIN timestamptz AS TIMESTAMP WITH TIME ZONE");
        new ResourceDatabasePopulator(new ClassPathResource("db/migration/V6__authentication.sql"),
                new ClassPathResource("db/migration/V8__jwt_authentication.sql"),
                new ClassPathResource("db/migration/V9__auth_rate_limits.sql")).execute(source);
        tokens = new JwtTokenService(JWT_SECRET, clock);
        auth = new AuthService(db, transactions, tokens);
    }

    AuthService.Account admin() {
        auth.bootstrap("admin", "a secure bootstrap password");
        return auth.login("admin", "a secure bootstrap password", "127.0.0.1").account();
    }
}
