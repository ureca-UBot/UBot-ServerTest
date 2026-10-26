package com.ubot.embedding;

import static org.assertj.core.api.Assertions.assertThat;

import com.pgvector.PGvector;
import com.ubot.faq.enums.FaqVectorType;
import com.ubot.faq.enums.Intent;
import com.ubot.faq.dto.response.FaqSearchResponseDto;
import com.ubot.faq.repository.FaqVectorRepository;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.ObjectMapper;

// 실제 FAQ 저장소와 변경 전 exact SQL을 같은 전용 DB에서 비교함. 임베딩 생성·LLM 시간은 제외함
@EnabledIfEnvironmentVariable(named = "RUN_VECTOR_SEARCH_BENCHMARK", matches = "true")
class VectorSearchBenchmarkTest {
    private static final int DIMENSIONS = 1024;
    private static final int QUERIES = 40;
    private static final int REPEATS = 5;
    private static final long SEED = 20261021L;
    private static final ObjectMapper JSON = new ObjectMapper();
    // develop 43deb27의 FAQ 검색. 점수로 정렬해 HNSW를 쓰지 않는 기준선임
    private static final String EXACT_FAQ_SQL = """
            WITH scored AS (
                SELECT f.id AS faq_id, f.question AS faq_question, f.answer, f.intent, f.cacheable,
                       v.id AS variant_id, v.question AS variant_question, 1 - (fe.vector <=> ?) AS score
                FROM faq_embeddings fe
                JOIN faq_question_variants v ON v.id=fe.faq_question_variant_id
                JOIN faq f ON f.id=v.origin_faq_id
                WHERE f.deleted_at IS NULL AND fe.profile_id=? AND fe.vector_type='QUESTION'
                  AND fe.faq_version=f.version %s
            ), ranked AS (
                SELECT scored.*, ROW_NUMBER() OVER (PARTITION BY faq_id ORDER BY score DESC,variant_id) AS rank
                FROM scored
            )
            SELECT * FROM ranked WHERE rank=1 ORDER BY score DESC,faq_id LIMIT 3
            """;
    private record Hit(long id, double score) {}
    private record Statement(String sql, Object[] args) {}

    @Test
    void compareExactAndHnsw() throws Exception {
        Path output = Path.of(System.getenv().getOrDefault("VECTOR_BENCHMARK_OUTPUT", "build/vector-search-benchmark"));
        Files.createDirectories(output);
        var summaries = new ArrayList<Map<String, Object>>();
        var metadata = new LinkedHashMap<String, Object>();
        metadata.put("startedAt", Instant.now().toString());
        metadata.put("seed", SEED);
        metadata.put("dimensions", DIMENSIONS);
        metadata.put("dataset", "synthetic normalized dense vectors: 64 clusters, mixed profiles/types/versions, two variants per FAQ");
        metadata.put("efSearch", 200);
        metadata.put("iterativeScan", "strict_order");
        metadata.put("timing", "single-client repository elapsed time including JDBC, transactions and adaptive candidate expansion; no embedding/LLM");
        metadata.put("java", System.getProperty("java.version"));
        metadata.put("os", System.getProperty("os.name"));
        metadata.put("availableProcessors", Runtime.getRuntime().availableProcessors());
        metadata.put("results", summaries);
        var image = DockerImageName.parse("ubot-postgres:18-pgvector0.8.6-postgis3.6.4").asCompatibleSubstituteFor("postgres");
        try (var database = new PostgreSQLContainer(image).withDatabaseName("vector_benchmark")
                .withUsername("benchmark").withPassword(UUID.randomUUID().toString())
                .withLabel("com.ubot.vector-benchmark", "true").withReuse(false)) {
            database.start();
            var config = new HikariConfig();
            config.setJdbcUrl(database.getJdbcUrl());
            config.setUsername(database.getUsername());
            config.setPassword(database.getPassword());
            config.setMaximumPoolSize(2);
            config.setMinimumIdle(1);
            try (var source = new HikariDataSource(config)) {
                Flyway.configure().dataSource(source).load().migrate();
                var jdbc = new TracingJdbcTemplate(source);
                var manager = new DataSourceTransactionManager(source);
                var tx = new TransactionTemplate(manager);
                var faqs = transactional(new FaqVectorRepository(jdbc), manager);
                metadata.put("postgres", jdbc.queryForObject("SELECT version()", String.class));
                metadata.put("pgvector", jdbc.queryForObject("SELECT extversion FROM pg_extension WHERE extname='vector'", String.class));
                for (int size : new int[] {1000, 10000}) {
                    System.out.println("Preparing vector benchmark: " + size + " rows per vector table");
                    float[][] vectors = seed(jdbc, tx, size);
                    List<PGvector> queries = queries(vectors);
                    for (boolean byIntent : new boolean[] {false, true}) {
                        String domain = byIntent ? "faq-intent" : "faq";
                        String sql = EXACT_FAQ_SQL.formatted(byIntent ? "AND f.intent='GENERAL'" : "");
                        Function<PGvector, List<Hit>> exact = vector -> jdbc.query(sql,
                                (rs, row) -> new FaqSearchResponseDto(rs.getLong("faq_id"), rs.getString("faq_question"),
                                        rs.getString("answer"), rs.getDouble("score"), Intent.valueOf(rs.getString("intent")),
                                        rs.getLong("variant_id"), rs.getString("variant_question"), rs.getBoolean("cacheable")), vector, 1L)
                                .stream().map(faq -> new Hit(faq.faqId(), faq.similarityScore())).toList();
                        Function<PGvector, List<Hit>> hnsw = vector -> (byIntent
                                ? faqs.getSimilarListByIntent(vector, 1L, FaqVectorType.QUESTION, Intent.GENERAL, 3)
                                : faqs.getSimilarList(vector, 1L, FaqVectorType.QUESTION, 3)).stream()
                                .map(faq -> new Hit(faq.faqId(), faq.similarityScore())).toList();
                        summaries.add(measure(jdbc, tx, output, domain, size, queries, exact, hnsw,
                                new Statement(sql, new Object[] {queries.getFirst(), 1L}), "idx_faq_embeddings_vector_hnsw"));
                    }
                    write(output.resolve("summary.json"), metadata);
                }
            }
        } finally {
            metadata.put("finishedAt", Instant.now().toString());
            write(output.resolve("summary.json"), metadata);
        }
        assertThat(summaries).hasSize(4);
    }

    private Map<String, Object> measure(TracingJdbcTemplate jdbc, TransactionTemplate tx, Path output,
            String domain, int size, List<PGvector> queries, Function<PGvector, List<Hit>> exact,
            Function<PGvector, List<Hit>> hnsw, Statement exactStatement, String index) throws Exception {
        for (int i = 0; i < 10; i++) { exact.apply(queries.get(i)); hnsw.apply(queries.get(i)); }
        var samples = new ArrayList<Map<String, Object>>();
        double[] exactTimes = new double[QUERIES * REPEATS];
        double[] hnswTimes = new double[exactTimes.length];
        double recall = 0;
        int top1 = 0, underfilled = 0;
        for (int i = 0; i < exactTimes.length; i++) {
            PGvector vector = queries.get(i % QUERIES);
            List<Hit> expected, actual;
            long started = System.nanoTime();
            // 실행 순서를 번갈아 바꿔 먼저 실행한 쿼리가 캐시를 데우는 편향을 줄임
            if (i % 2 == 0) {
                expected = exact.apply(vector);
                exactTimes[i] = millis(started);
                started = System.nanoTime();
                actual = hnsw.apply(vector);
                hnswTimes[i] = millis(started);
            } else {
                actual = hnsw.apply(vector);
                hnswTimes[i] = millis(started);
                started = System.nanoTime();
                expected = exact.apply(vector);
                exactTimes[i] = millis(started);
            }
            Set<Long> found = actual.stream().map(Hit::id).collect(Collectors.toSet());
            double matched = expected.stream().filter(hit -> found.contains(hit.id())).count() / (double) expected.size();
            recall += matched;
            if (!actual.isEmpty() && actual.getFirst().id() == expected.getFirst().id()) top1++;
            if (actual.size() < expected.size()) underfilled++;
            samples.add(Map.of("query", i % QUERIES, "repeat", i / QUERIES,
                    "exactMs", exactTimes[i], "hnswMs", hnswTimes[i], "recallAt3", matched,
                    "exactIds", expected.stream().map(Hit::id).toList(), "hnswIds", actual.stream().map(Hit::id).toList()));
        }
        hnsw.apply(queries.getFirst());
        Statement hnswStatement = jdbc.last;
        String hnswPlan = tx.execute(status -> {
            jdbc.execute(FaqVectorRepository.HNSW_SEARCH_SETTINGS_SQL);
            return jdbc.queryForObject("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + hnswStatement.sql(), String.class, hnswStatement.args());
        });
        String exactPlan = jdbc.queryForObject("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + exactStatement.sql(), String.class, exactStatement.args());
        write(output.resolve(domain + "-" + size + "-samples.json"), samples);
        Files.writeString(output.resolve(domain + "-" + size + "-hnsw-plan.json"), hnswPlan);
        Files.writeString(output.resolve(domain + "-" + size + "-exact-plan.json"), exactPlan);
        var result = new LinkedHashMap<String, Object>();
        result.put("domain", domain);
        result.put("vectorRows", size);
        result.put("uniqueQueries", QUERIES);
        result.put("warmupQueriesPerMethod", 10);
        result.put("samplesPerMethod", exactTimes.length);
        result.put("exactP50Ms", percentile(exactTimes, .5));
        result.put("exactP95Ms", percentile(exactTimes, .95));
        result.put("hnswP50Ms", percentile(hnswTimes, .5));
        result.put("hnswP95Ms", percentile(hnswTimes, .95));
        result.put("p50Speedup", percentile(exactTimes, .5) / percentile(hnswTimes, .5));
        result.put("recallAt3", recall / exactTimes.length);
        result.put("top1Agreement", top1 / (double) exactTimes.length);
        result.put("underfilledQueries", underfilled);
        result.put("hnswIndexUsed", hnswPlan.contains(index));
        result.put("indexBytes", jdbc.queryForObject("SELECT pg_relation_size(?::regclass)", Long.class, index));
        System.out.println(JSON.writeValueAsString(result));
        assertThat(exactPlan).doesNotContain("\"Index Name\": \"" + index + "\"");
        if (size >= 10000) assertThat(hnswPlan).contains(index);
        assertThat(underfilled).isZero();
        return result;
    }

    private float[][] seed(JdbcTemplate jdbc, TransactionTemplate tx, int size) {
        jdbc.execute("TRUNCATE faq CASCADE");
        jdbc.update("DELETE FROM embedding_profiles");
        jdbc.update("INSERT INTO faq_category(id,name) VALUES (1,'benchmark') ON CONFLICT (id) DO NOTHING");
        for (int id : new int[] {1, 2}) {
            jdbc.update("INSERT INTO embedding_profiles(profile_id,provider,model_name,dimensions,profile_version) VALUES (?,'openai-compatible',?,1024,1)", id, "benchmark-" + id);
        }
        jdbc.update("""
                INSERT INTO faq(id,category_id,question,answer,intent,deleted_at)
                SELECT i,1,'질문 '||i,'답변 '||i,CASE WHEN i%3=0 THEN 'STORE_DATA' ELSE 'GENERAL' END,
                       CASE WHEN i%41=0 THEN now() END FROM generate_series(1,?) i
                """, size / 2);
        jdbc.update("INSERT INTO faq_question_variants(id,origin_faq_id,question) SELECT i,(i+1)/2,'표현 '||i FROM generate_series(1,?) i", size);
        var random = new Random(SEED);
        float[][] centers = new float[64][];
        for (int i = 0; i < centers.length; i++) centers[i] = randomUnit(random);
        float[][] vectors = new float[size][];
        for (int i = 0; i < size; i++) vectors[i] = perturb(centers[(i / 2) % centers.length], random, .02);
        for (int start = 0; start < size; start += 250) {
            var faqRows = new ArrayList<Object[]>();
            for (int i = start; i < Math.min(size, start + 250); i++) {
                int id = i + 1;
                int profile = id % 5 == 0 ? 2 : 1;
                faqRows.add(new Object[] {id, profile, id % 7 == 0 ? "QUESTION_ANSWER" : "QUESTION", id % 29 == 0 ? 0 : 1,
                        new PGvector(vectors[i])});
            }
            tx.executeWithoutResult(status -> jdbc.batchUpdate(
                    "INSERT INTO faq_embeddings(faq_question_variant_id,profile_id,vector_type,faq_version,vector) VALUES (?,?,?,?,?)", faqRows));
        }
        jdbc.execute("VACUUM ANALYZE faq_embeddings");
        jdbc.execute("VACUUM ANALYZE faq_question_variants");
        jdbc.execute("VACUUM ANALYZE faq");
        return vectors;
    }

    private List<PGvector> queries(float[][] vectors) {
        var random = new Random(SEED + 1);
        var queries = new ArrayList<PGvector>();
        for (int i = 0; i < QUERIES; i++) {
            double noise = switch (i % 4) { case 0 -> .005; case 1 -> .0103; case 2 -> .02; default -> .04; };
            queries.add(new PGvector(perturb(vectors[random.nextInt(vectors.length)], random, noise)));
        }
        return queries;
    }

    private float[] randomUnit(Random random) {
        float[] vector = new float[DIMENSIONS];
        for (int i = 0; i < vector.length; i++) vector[i] = (float) random.nextGaussian();
        return normalize(vector);
    }

    private float[] perturb(float[] base, Random random, double noise) {
        float[] vector = new float[DIMENSIONS];
        for (int i = 0; i < vector.length; i++) vector[i] = base[i] + (float) (random.nextGaussian() * noise);
        return normalize(vector);
    }

    private float[] normalize(float[] vector) {
        double norm = 0;
        for (float value : vector) norm += value * value;
        norm = Math.sqrt(norm);
        for (int i = 0; i < vector.length; i++) vector[i] /= (float) norm;
        return vector;
    }

    @SuppressWarnings("unchecked")
    private <T> T transactional(T target, DataSourceTransactionManager manager) {
        var proxy = new ProxyFactory(target);
        proxy.setProxyTargetClass(true);
        proxy.addAdvice(new TransactionInterceptor(manager, new AnnotationTransactionAttributeSource()));
        return (T) proxy.getProxy();
    }

    private static double millis(long started) { return (System.nanoTime() - started) / 1_000_000.0; }
    private static double percentile(double[] values, double percentile) {
        double[] sorted = values.clone();
        Arrays.sort(sorted);
        return sorted[(int) Math.ceil(sorted.length * percentile) - 1];
    }
    private static void write(Path path, Object value) throws Exception {
        Files.writeString(path, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(value));
    }

    private static final class TracingJdbcTemplate extends JdbcTemplate {
        Statement last;
        TracingJdbcTemplate(HikariDataSource source) { super(source); }
        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (sql.startsWith("WITH")) last = new Statement(sql, args.clone());
            return super.query(sql, mapper, args);
        }
    }
}
