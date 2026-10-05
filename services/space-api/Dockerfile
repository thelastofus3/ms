FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -B dependency:go-offline
COPY src src
RUN mvn -B -DskipTests package
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /build/target/space-api-0.1.0.jar /app/service.jar
USER 10001
ENTRYPOINT ["java", "-jar", "/app/service.jar"]
