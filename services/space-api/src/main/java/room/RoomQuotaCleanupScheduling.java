package room;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
public class RoomQuotaCleanupScheduling {
    @Bean(name="roomQuotaCleanupScheduler")
    public ThreadPoolTaskScheduler scheduler() {
        var scheduler=new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1); scheduler.setThreadNamePrefix("upload-cleanup-");
        return scheduler;
    }
}
