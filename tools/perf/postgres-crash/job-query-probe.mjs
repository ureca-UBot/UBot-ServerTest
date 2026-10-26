import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as wait } from 'node:timers/promises';
import { request } from '../chat-burst/cli.mjs';

// Docker CLI를 기다리는 메인 스레드와 HTTP 응답 시간 측정을 분리함
const { apiUrl, jobId, token } = workerData;
let running = true;
parentPort.on('message', message => { if (message === 'stop') running = false; });
async function observe(timeoutMs, bearer = token) {
  const began = Date.now();
  const value = { at: new Date().toISOString(), jobId, clientTimeoutMs: timeoutMs };
  try {
    const response = await request(apiUrl, 'GET', `/chat/jobs/${jobId}`, undefined, bearer, timeoutMs);
    value.httpStatus = response.status;
    value.status = response.body?.data?.status;
    value.errorCode = response.body?.code ?? response.body?.errorCode;
    value.answerPresent = Boolean(response.body?.data?.answer?.trim());
  } catch { value.httpStatus = 0; value.status = 'CLIENT_REQUEST_FAILED'; }
  value.completedAt = new Date().toISOString();
  value.elapsedMs = Date.now() - began;
  return value;
}
await Promise.all([
  (async () => {
    while (running) {
      parentPort.postMessage({ kind: 'short', value: await observe(2000) });
      await wait(500);
    }
  })(),
  observe(45000).then(value => parentPort.postMessage({ kind: 'long', value })),
  (async () => {
    const parts = token.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    const value = await observe(2000, parts.join('.'));
    parentPort.postMessage({ kind: 'invalid', value: { ...value, name: 'invalid-signature', expectedStatus: 401 } });
  })()
]);
parentPort.postMessage({ kind: 'done' });
parentPort.close();
