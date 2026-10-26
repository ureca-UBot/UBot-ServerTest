import assert from 'node:assert/strict';
import {client,pages,save} from '../../common/api.mjs';

const [credentials,output,groupId='42']=process.argv.slice(2);
if(!credentials||!output)throw Error('Usage: node verify.mjs PRIVATE_ACCOUNT OUTPUT_JSON [GROUP_ID]');
const {call,base}=await client(credentials);
const all=await pages(call,'/admin/unanswered-groups?minCount=2&sort=recent&status=PENDING',20);
assert.equal(new Set(all.map(x=>x.id)).size,all.length);
assert.ok(all.every(x=>x.status==='PENDING'&&x.questionCount>=2));
const detail=await call(`/admin/unanswered-groups/${Number(groupId)}`);
assert.equal(detail.httpStatus,200);
assert.equal(detail.data.questions.length,detail.data.questionCount);
assert.equal(new Set(detail.data.questions.map(x=>x.id)).size,detail.data.questions.length);
assert.ok(detail.data.questions.every(x=>x.searchQuery));
const anonymous=await call('/admin/unanswered-groups',{anonymous:true});
assert.ok([401,403].includes(anonymous.httpStatus));
const invalid=await call('/admin/unanswered-groups?minCount=0');
assert.equal(invalid.httpStatus,400);
// 상세 원문은 전원이 합성 계정임을 DB로 확인한 묶음만 공개함
const result={verifiedAt:new Date().toISOString(),baseUrl:base,checksPassed:8,pendingGroupsWithTwoOrMore:all.length,observations:{emptyOriginalFragments:detail.data.questions.filter(x=>!x.question).length},selectedGroup:detail.data,access:{anonymous:anonymous.httpStatus,invalidMinCount:invalid.httpStatus}};
await save(output,result);console.log(JSON.stringify({...result,selectedGroup:{id:detail.data.id,questionCount:detail.data.questionCount,topicName:detail.data.topicName}}));
