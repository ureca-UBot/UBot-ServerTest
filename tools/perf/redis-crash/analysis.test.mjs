import test from 'node:test';
import assert from 'node:assert/strict';
import { stateAtFault } from './analysis.mjs';

test('종료 뒤 snapshot 전 완료된 작업은 장애 당시 RUNNING으로 센다', () => {
  const result = stateAtFault({ at:'1970-01-01T00:00:03Z', rows:[
    {jobId:1,createdAtMs:500,startedAtMs:1000,finishedAtMs:2500,status:'SUCCEEDED'},
    {jobId:2,createdAtMs:500,startedAtMs:null,finishedAtMs:null,status:'QUEUED'},
    {jobId:3,createdAtMs:500,startedAtMs:1000,finishedAtMs:1500,status:'FAILED'},
    {jobId:4,createdAtMs:500,startedAtMs:2400,finishedAtMs:null,status:'RUNNING'}
  ]},2000);
  assert.deepEqual(result.statuses,{RUNNING:1,QUEUED:2,FAILED:1});
  assert.deepEqual(result.runningIds,[1]);
  assert.deepEqual(result.queuedIds,[2,4]);
});

test('장애보다 이른 snapshot과 중복 jobId는 거절한다', () => {
  assert.throws(()=>stateAtFault({at:'1970-01-01T00:00:01Z',rows:[]},2000));
  const row={jobId:1,createdAtMs:500,startedAtMs:null,finishedAtMs:null,status:'QUEUED'};
  assert.throws(()=>stateAtFault({at:'1970-01-01T00:00:03Z',rows:[row,row]},2000));
});
