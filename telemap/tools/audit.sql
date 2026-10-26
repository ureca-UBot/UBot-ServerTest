BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
WITH own AS (
 SELECT q.* FROM question_log q JOIN users u ON u.user_id=q.user_id
 WHERE u.email LIKE 'load+retest-a3-20261026.%@example.test' OR u.email LIKE 'load+retest-b-20261026.%@example.test'
), linked AS (
 SELECT q.id,q.region question_region,sq.id surging_id,c.id cluster_id,c.region cluster_region,c.embedding_profile_id
 FROM own q LEFT JOIN surging_questions sq ON sq.question_log_id=q.id LEFT JOIN surging_clusters c ON c.id=sq.cluster_id
), rows AS (
 SELECT count(*) question_logs,count(*) FILTER(WHERE surging_id IS NOT NULL) registered_questions,
 count(distinct cluster_id) clusters,count(*) FILTER(WHERE question_region<>cluster_region) region_mismatches,
 count(*) FILTER(WHERE question_region IS NULL) missing_regions,
 (SELECT count(*) FROM (SELECT id FROM linked GROUP BY id HAVING count(*)>1) d) duplicate_question_links,
 (SELECT json_agg(t) FROM (SELECT question_region,count(*) questions FROM linked GROUP BY question_region) t) regions,
 (SELECT json_agg(t) FROM (SELECT embedding_profile_id,count(*) questions FROM linked WHERE surging_id IS NOT NULL GROUP BY embedding_profile_id) t) profiles
 FROM linked
)
SELECT json_build_object('loadQuestions',(SELECT row_to_json(rows) FROM rows),
 'alerts',(SELECT json_agg(t) FROM (SELECT id,region,subject,question_count,window_minutes,created_at,jsonb_array_length(question_snapshots::jsonb) snapshot_count FROM surging_alerts WHERE created_at>='2026-10-26' ORDER BY id) t),
 'selectedSnapshotOwnerCheck',(SELECT json_build_object('alert_id',a.id,'snapshots',jsonb_array_length(a.question_snapshots::jsonb),'synthetic_owners',count(*) FILTER(WHERE u.email LIKE 'load+%@example.test')) FROM surging_alerts a CROSS JOIN LATERAL jsonb_array_elements(a.question_snapshots::jsonb) s JOIN question_log q ON q.id=(s->>'questionLogId')::bigint JOIN users u ON u.user_id=q.user_id WHERE a.id=41 GROUP BY a.id));
COMMIT;
