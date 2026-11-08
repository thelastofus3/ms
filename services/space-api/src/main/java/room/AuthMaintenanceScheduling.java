package room;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
public class AuthMaintenanceScheduling {
    @Bean(name = "authMaintenanceScheduler")
    public ThreadPoolTaskScheduler authMaintenanceScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        // Database maintenance must never occupy the PLY import's lease heartbeat pool.
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("auth-maintenance-");
        return scheduler;
    }
}
