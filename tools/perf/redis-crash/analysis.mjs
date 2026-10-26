import assert from 'node:assert/strict';

// 종료 명령 뒤 DB snapshot을 얻기까지 완료된 작업을 장애 시점의 완료로 오인하지 않음
// 실행 토큰이 바뀌기 전의 snapshot에 저장된 시작/완료 시각으로 직전 상태를 복원함
export function stateAtFault(snapshot, atMs) {
  assert.ok(Number.isFinite(atMs) && Date.parse(snapshot.at) >= atMs);
  const result = { atMs, snapshotAt: snapshot.at, statuses: {}, runningIds: [], queuedIds: [], completedIds: [] };
  const seen = new Set();
  for (const row of snapshot.rows) {
    assert.ok(Number.isSafeInteger(row.jobId) && !seen.has(row.jobId));
    seen.add(row.jobId);
    assert.ok(row.createdAtMs <= atMs, '장애 이후 접수된 작업입니다.');
    const finished = row.finishedAtMs !== null && row.finishedAtMs <= atMs;
    const running = row.startedAtMs !== null && row.startedAtMs <= atMs;
    const status = finished ? row.status : running ? 'RUNNING' : 'QUEUED';
    result.statuses[status] = (result.statuses[status] ?? 0) + 1;
    result[finished ? 'completedIds' : running ? 'runningIds' : 'queuedIds'].push(row.jobId);
  }
  return result;
}
