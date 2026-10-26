BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
WITH own AS (
 SELECT uq.* FROM unanswered_questions uq JOIN answer_attempts_history a ON a.attempt_id=uq.attempt_id JOIN users u ON u.user_id=a.user_id
 WHERE u.email LIKE 'load+retest-a3-20261026.%@example.test' OR u.email LIKE 'load+retest-b-20261026.%@example.test'
), selected AS (
 SELECT group_id,count(*) own_questions FROM own GROUP BY group_id
), groups AS (
 SELECT g.id,g.topic_name,g.representative_question,g.question_count,g.related_faq_id,g.status,s.own_questions,
 (SELECT count(*) FROM unanswered_questions uq WHERE uq.group_id=g.id) actual_questions,
 (SELECT count(*) FROM unanswered_questions uq JOIN answer_attempts_history a ON a.attempt_id=uq.attempt_id JOIN users u ON u.user_id=a.user_id WHERE uq.group_id=g.id AND u.email LIKE 'load+%@example.test') synthetic_questions
 FROM selected s JOIN unanswered_question_groups g ON g.id=s.group_id
)
SELECT json_build_object('questions',(SELECT count(*) FROM own),'groups',(SELECT count(*) FROM selected),
 'duplicate_attempt_subquestions',(SELECT count(*) FROM (SELECT attempt_id,sub_question_index FROM own GROUP BY attempt_id,sub_question_index HAVING count(*)>1) t),
 'count_mismatches',(SELECT count(*) FROM groups WHERE question_count<>actual_questions),
 'reasons',(SELECT json_agg(t) FROM (SELECT reason,count(*) FROM own GROUP BY reason) t),
 'sampleGroups',(SELECT json_agg(t) FROM (SELECT * FROM groups WHERE actual_questions=synthetic_questions ORDER BY own_questions DESC,id LIMIT 5) t));
COMMIT;
