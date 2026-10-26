import assert from 'node:assert/strict';
import {client,pages,save} from '../../common/api.mjs';

const [credentials,output,detailId='41']=process.argv.slice(2);
if(!credentials||!output)throw Error('Usage: node verify.mjs PRIVATE_ACCOUNT OUTPUT_JSON [ALERT_ID]');
const {call,base}=await client(credentials);
const all=await pages(call,'/admin/telemap/alerts');
const incheon=await pages(call,'/admin/telemap/alerts?region=INCHEON');
assert.equal(incheon.length,all.filter(x=>x.region==='INCHEON').length);
assert.ok(incheon.every(x=>x.region==='INCHEON'));
assert.equal(new Set(all.map(x=>x.alertId)).size,all.length);
const detail=await call(`/admin/telemap/alerts/${Number(detailId)}`);
assert.equal(detail.httpStatus,200);
assert.equal(detail.data.questionSnapshots.length,detail.data.questionCount);
assert.equal(new Set(detail.data.questionSnapshots.map(x=>x.questionLogId)).size,detail.data.questionSnapshots.length);
const anonymous=await call('/admin/telemap/alerts',{anonymous:true});
assert.ok([401,403].includes(anonymous.httpStatus));
const invalid=await call('/admin/telemap/alerts?size=101');
assert.equal(invalid.httpStatus,400);
const counts={};const subjects=new Set();
for(const x of all){counts[x.region]??={alerts:0,questions:0};counts[x.region].alerts++;counts[x.region].questions+=x.questionCount;subjects.add(`${x.region}:${x.subject}`);}
// 상세 원문은 운영 데이터가 섞일 수 있어 ID·개수만 저장함
const result={verifiedAt:new Date().toISOString(),baseUrl:base,checksPassed:8,totalAlerts:all.length,totalQuestions:all.reduce((s,x)=>s+x.questionCount,0),regionSubjectGroups:subjects.size,regions:counts,selectedDetail:{alertId:Number(detailId),region:detail.data.region,subject:detail.data.subject,questionCount:detail.data.questionCount,windowMinutes:detail.data.windowMinutes,snapshotIds:detail.data.questionSnapshots.map(x=>x.questionLogId),createdAt:detail.data.createdAt},access:{anonymous:anonymous.httpStatus,invalidSize:invalid.httpStatus}};
await save(output,result);console.log(JSON.stringify(result));
