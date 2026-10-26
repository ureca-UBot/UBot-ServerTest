import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

const [baseUrl,outputPath]=process.argv.slice(2);
if(!baseUrl||!outputPath)throw Error('Usage: node provision.mjs BASE_URL PRIVATE_OUTPUT');
const stamp=Date.now().toString(36);
const account={email:`load+servertest-ui-${stamp}@example.test`,password:randomBytes(12).toString('base64url'),name:'서버검증관리자'};
async function call(path,body){
  const response=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
  const value=await response.json();
  if(!response.ok||!value.success)throw Error(`${path}: ${response.status} ${value.code}`);
  return value.data;
}
await call('/auth/signup',{...account,passwordConfirm:account.password,birthDate:'1995-01-01',gender:'MALE',residenceArea:'제주'});
const login=await call('/auth/login',{email:account.email,password:account.password});
const claims=JSON.parse(Buffer.from(login.accessToken.split('.')[1],'base64url').toString());
const userId=Number(claims.userId??claims.sub);
if(!Number.isSafeInteger(userId))throw Error('Missing user ID');
const path=resolve(outputPath);await mkdir(dirname(path),{recursive:true});
await writeFile(path,JSON.stringify({baseUrl,userId,...account,createdAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({userId,email:account.email,privateFile:path}));
