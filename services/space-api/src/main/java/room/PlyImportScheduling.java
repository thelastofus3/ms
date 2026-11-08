package room;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
@EnableScheduling
public class PlyImportScheduling {
    @Bean(name = "plyImportScheduler")
    public ThreadPoolTaskScheduler plyImportScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        // The heartbeat must keep running while the other thread copies or uploads a file.
        scheduler.setPoolSize(2);
        scheduler.setThreadNamePrefix("ply-import-");
        return scheduler;
    }
}
