#!/bin/sh
set -eu
docker exec -i ubot-state-postgres-1 sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -v ON_ERROR_STOP=1' <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
WITH selected AS (
SELECT split_part(u.email,'.',1) run,u.user_id,j.job_id,j.attempt_id,j.execution_status,a.error_code,a.attempt_count,
       j.created_at,j.started_at,j.finished_at,
       extract(epoch FROM j.finished_at-j.created_at) total_seconds,
       extract(epoch FROM j.started_at-j.created_at) queue_seconds,
       extract(epoch FROM j.finished_at-j.started_at) execution_seconds
FROM chat_jobs j JOIN answer_attempts_history a ON a.attempt_id=j.attempt_id JOIN users u ON u.user_id=a.user_id
WHERE u.email LIKE 'load+retest-a3-20261026.%@example.test' OR u.email LIKE 'load+retest-b-20261026.%@example.test'
), stats AS (
SELECT run,count(*) jobs,count(distinct user_id) users,count(distinct attempt_id) attempts,
count(*) FILTER(WHERE execution_status='SUCCEEDED') answered,
count(*) FILTER(WHERE error_code IN('FW-003','CHAT-012','CHAT-013','CHAT-021','CHAT-022','CHAT-023','LLM-006','LLM-008')) normal_rejections,
count(*) FILTER(WHERE execution_status='FAILED' AND coalesce(error_code,'') NOT IN('FW-003','CHAT-012','CHAT-013','CHAT-021','CHAT-022','CHAT-023','LLM-006','LLM-008')) system_errors,
count(*) FILTER(WHERE execution_status IN('QUEUED','RUNNING')) pending,
count(*) FILTER(WHERE error_code='CHAT-016') chat_timeouts,
count(*) FILTER(WHERE error_code='LLM-003') model_unavailable,
count(*) FILTER(WHERE attempt_count<>1) unexpected_attempt_counts,
min(created_at) first_created_at,max(finished_at) last_finished_at,
percentile_cont(0.5) WITHIN GROUP(ORDER BY total_seconds) total_p50_seconds,
percentile_cont(0.95) WITHIN GROUP(ORDER BY total_seconds) total_p95_seconds,
max(total_seconds) total_max_seconds,
percentile_cont(0.95) WITHIN GROUP(ORDER BY queue_seconds) queue_p95_seconds,
percentile_cont(0.95) WITHIN GROUP(ORDER BY execution_seconds) execution_p95_seconds
FROM selected GROUP BY run
)
SELECT coalesce(json_agg(stats ORDER BY run),'[]'::json) FROM stats;
COMMIT;
SQL
