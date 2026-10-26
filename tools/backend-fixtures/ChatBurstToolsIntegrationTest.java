package com.ubot.chat.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.ubot.PgvectorTestConfiguration;
import com.ubot.faq.dto.response.FaqSearchResponseDto;
import com.ubot.faq.enums.Intent;
import com.ubot.faq.retrieval.FaqSentenceFilterService;
import com.ubot.faq.service.FaqSearchMockSupport;
import com.ubot.faq.service.FaqVectorService;
import com.ubot.forbiddenword.service.ForbiddenWordFilterService;
import com.ubot.llm.client.LlmClient;
import com.ubot.llm.dto.response.LlmResponseDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.ObjectMapper;

// 실제 HTTP 회원가입·로그인·JWT·접수·DB/Redis 워커·수집 도구를 연결함. 검색 결과와 외부 LLM만 모의함
@EnabledIfEnvironmentVariable(named = "RUN_CHAT_BURST_SMOKE", matches = "true")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
		"faq.cache.enabled=true", "faq.retrieval.rerank.enabled=false", "CHAT_SUB_QUESTION_ENABLED=false",
		"CHAT_CONFIDENCE_THRESHOLD=0.75", "CHAT_TOP_K=3", "app.chat.worker.polling-enabled=true"})
@Import(PgvectorTestConfiguration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@ExtendWith(OutputCaptureExtension.class)
class ChatBurstToolsIntegrationTest {
	private static final GenericContainer<?> REDIS = new GenericContainer<>(DockerImageName.parse("redis:8-alpine"))
			.withExposedPorts(6379).withLabel("com.ubot.test-redis", "true").withReuse(false);

	// HTTP 서버·자동 Worker가 초기화되기 전에 전용 Redis 접속 정보를 확정함
	@DynamicPropertySource
	static void redisProperties(DynamicPropertyRegistry registry) {
		REDIS.start();
		registry.add("spring.data.redis.host", REDIS::getHost);
		registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
	}

	@LocalServerPort int port;
	@Autowired JdbcTemplate jdbc;
	@Autowired ForbiddenWordFilterService forbiddenWords;
	@MockitoBean FaqVectorService vectors;
	@MockitoBean FaqSentenceFilterService sentenceFilter;
	@MockitoBean LlmClient llm;

	@Test
	void toolsCreateRealMembersAndClassifyAllFourBackendPaths(CapturedOutput output) throws Exception {
		var json = new ObjectMapper();
		var directory = Files.createTempDirectory(Files.createDirectories(Path.of("build/chat-burst-backend")), "run-").toAbsolutePath();
		String cache = "이심이 어떤 건지 알려줘";
		String generated = "유심이 어떤 건지 알려줘";
		String threshold = "부하 시험 미지원 질문";
		String forbidden = "버스트금지표현";
		String answer = "유심은 통신망에서 가입자를 식별하는 카드입니다.";
		jdbc.update("INSERT INTO forbidden_words(word,status) VALUES (?,'ACTIVE')", forbidden);
		forbiddenWords.refreshForbiddenWordCache();
		Long category = jdbc.queryForObject("INSERT INTO faq_category(name) VALUES ('부하 도구 통합 테스트') RETURNING id", Long.class);
		Long cacheId = jdbc.queryForObject("INSERT INTO faq(category_id,question,answer,intent,cacheable) VALUES (?,? ,?,'GENERAL',true) RETURNING id",
				Long.class, category, cache, answer);
		Long generatedId = jdbc.queryForObject("INSERT INTO faq(category_id,question,answer,intent,cacheable) VALUES (?,? ,?,'GENERAL',false) RETURNING id",
				Long.class, category, generated, answer);
		FaqSearchMockSupport.bridgeSearch(vectors);
		FaqSearchMockSupport.passAnswers(sentenceFilter);
		when(vectors.getSimilarList(anyString(), anyInt())).thenAnswer(call -> {
			String question = call.getArgument(0);
			if (question.equals(cache)) return List.of(faq(cacheId, 1, true, answer), faq(generatedId, .5, false, answer));
			if (question.equals(generated)) return List.of(faq(generatedId, .9, false, answer), faq(cacheId, .5, true, answer));
			return List.of(faq(generatedId, .3, false, answer), faq(cacheId, .2, true, answer));
		});
		when(llm.getModelName()).thenReturn("burst-test-model");
		when(llm.generateAnswer(any())).thenReturn(new LlmResponseDto(answer));
		Path questions = directory.resolveSibling(directory.getFileName() + "-questions.json");
		Files.writeString(questions, json.writeValueAsString(java.util.Map.of(
				"forbidden", List.of(forbidden), "threshold", List.of(threshold),
				"cache", List.of(cache), "llm", List.of(generated))));

		run(directory, "prepare", "--run-id", "backend-smoke", "--base-url", "http://127.0.0.1:" + port,
				"--questions", questions.toString(), "--total", "10");
		// 10명 검증은 연결 준비 없이 전송해 cold connection 옵션도 검증함
		run(directory, "run", "--start-delay-seconds", "5", "--warm-connections", "false");
		// 이 전용 문맥에서는 실제 Worker 소비 루프를 켜 HTTP 접수 후 자동 처리까지 확인함
		for (int i = 0; i < 300; i++) {
			if (jdbc.queryForObject("SELECT count(*) FROM chat_jobs WHERE execution_status IN ('QUEUED','RUNNING')", Integer.class) == 0) break;
			Thread.sleep(50);
		}
		assertThat(jdbc.queryForObject("SELECT count(*) FROM users WHERE email LIKE 'load+backend-smoke.%@example.test'", Integer.class)).isEqualTo(10);
		assertThat(jdbc.queryForObject("SELECT count(*) FROM chat_jobs", Integer.class)).isEqualTo(8);
		run(directory, "collect", "--max-wait-seconds", "15");
		Path logs = directory.resolve("backend.log");
		Files.writeString(logs, output.getAll());
		// 도구가 생성한 운영용 읽기 전용 조회 SQL도 실제 마이그레이션 스키마에 실행함
		String evidenceSql = Files.readString(directory.resolve("evidence.sql"));
		String select = evidenceSql.substring(evidenceSql.indexOf("SELECT COALESCE"), evidenceSql.lastIndexOf("COMMIT;"));
		Path database = directory.resolve("db-evidence.json");
		Files.writeString(database, jdbc.queryForObject(select, String.class));
		run(directory, "report", "--log", logs.toString(), "--db-evidence", database.toString());
		var result = json.readTree(Files.readString(directory.resolve("report.json")));
		assertThat(result.path("passed").asBoolean()).isTrue();
		assertThat(result.path("actual").path("forbidden").asInt()).isEqualTo(2);
		assertThat(result.path("actual").path("threshold").asInt()).isEqualTo(2);
		assertThat(result.path("actual").path("cache").asInt()).isEqualTo(3);
		assertThat(result.path("actual").path("llm").asInt()).isEqualTo(3);
		assertThat(result.path("serverTimings").path("samples").asInt()).isEqualTo(8);
		verify(llm, times(3)).generateAnswer(any());
	}

	private FaqSearchResponseDto faq(Long id, double score, boolean cacheable, String answer) {
		return new FaqSearchResponseDto(id, "유심 안내", answer, score, Intent.GENERAL, id, "유심 안내", cacheable);
	}

	private void run(Path directory, String command, String... arguments) throws Exception {
		var args = new ArrayList<>(List.of(System.getenv().getOrDefault("NODE_BINARY", "node"),
				"tools/perf/chat-burst/cli.mjs", command, "--dir", directory.toString()));
		args.addAll(List.of(arguments));
		Path log = directory.resolveSibling(directory.getFileName() + "-" + command + "-command.log");
		var process = new ProcessBuilder(args).redirectErrorStream(true).redirectOutput(log.toFile()).start();
		if (!process.waitFor(60, TimeUnit.SECONDS)) {
			process.destroyForcibly();
			throw new AssertionError("부하 도구 실행 시간 초과: " + command);
		}
		assertThat(process.exitValue()).as(command + " 결과: " + log).isZero();
	}
}
