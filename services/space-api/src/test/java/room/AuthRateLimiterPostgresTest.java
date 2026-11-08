package room;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

import java.util.UUID;

/** Opt-in genuine PostgreSQL checks: explicitly supply an isolated database URL/user/password. */
class AuthRateLimiterPostgresTest extends AuthRateLimiterTest {
    private JdbcTemplate admin;
    private String schema;

    @Override protected AuthRateLimiter fixture() {
        String url = System.getProperty("auth.limiter.test.jdbc-url");
        Assumptions.assumeTrue(url != null && !url.isBlank(), "Disposable PostgreSQL URL must be explicitly supplied");
        String user = System.getProperty("auth.limiter.test.user", "auth_test");
        String password = System.getProperty("auth.limiter.test.password", "disposable_auth_check");
        var root = new DriverManagerDataSource(url, user, password);
        admin = new JdbcTemplate(root);
        schema = "auth_limiter_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE SCHEMA " + schema);
        var source = new DriverManagerDataSource(url + (url.contains("?") ? "&" : "?") + "currentSchema=" + schema, user, password);
        db = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        new ResourceDatabasePopulator(new ClassPathResource("db/migration/V9__auth_rate_limits.sql")).execute(source);
        return new AuthRateLimiter(db, manager);
    }

    @AfterEach void dropTemporarySchema() {
        if (schema != null) admin.execute("DROP SCHEMA " + schema + " CASCADE");
    }
}
