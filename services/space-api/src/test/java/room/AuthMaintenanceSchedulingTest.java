package room;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.ClassPathBeanDefinitionScanner;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.type.filter.RegexPatternTypeFilter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import static org.junit.jupiter.api.Assertions.*;

class AuthMaintenanceSchedulingTest {
    @Test void blockedAuthMaintenanceCannotStarveThePlyHeartbeatDuringAnImport() throws Exception {
        var fixture = new AuthTestDatabase();
        var maintenanceStarted = new CountDownLatch(1);
        var importStarted = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var jdbc = new JdbcTemplate(fixture.db.getDataSource()) {
            @Override public <T> T queryForObject(String sql, Class<T> requiredType) {
                if (sql.equals("SELECT CURRENT_TIMESTAMP")) {
                    maintenanceStarted.countDown();
                    awaitRelease(release);
                }
                return super.queryForObject(sql, requiredType);
            }
        };
        var context = new AnnotationConfigApplicationContext();
        try {
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.of(
                    "room.auth.maintenance.initial-delay-ms", "1", "room.auth.maintenance.delay-ms", "60000")));
            context.register(PlyImportScheduling.class);
            var scanner = new ClassPathBeanDefinitionScanner(context, false);
            scanner.addIncludeFilter(new RegexPatternTypeFilter(Pattern.compile("room\\.AuthMaintenanceScheduling")));
            scanner.scan("room");
            context.registerBean(AuthRateLimiter.class, () -> new AuthRateLimiter(jdbc, fixture.transactions));
            context.refresh();
            var ply = context.getBean("plyImportScheduler", ThreadPoolTaskScheduler.class);
            ply.execute(() -> { importStarted.countDown(); awaitRelease(release); });
            assertTrue(importStarted.await(5, TimeUnit.SECONDS));
            assertTrue(maintenanceStarted.await(5, TimeUnit.SECONDS));
            var heartbeat = new CountDownLatch(1);
            var future = ply.scheduleAtFixedRate(heartbeat::countDown, Duration.ofMillis(20));
            try { assertTrue(heartbeat.await(1, TimeUnit.SECONDS), "Auth maintenance must leave a PLY heartbeat thread available"); }
            finally { future.cancel(true); }
        } finally {
            release.countDown();
            context.close();
        }
    }

    private static void awaitRelease(CountDownLatch release) {
        try { release.await(10, TimeUnit.SECONDS); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    }
}
