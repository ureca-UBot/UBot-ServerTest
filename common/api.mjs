import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';

// 비밀번호와 토큰은 결과 파일에 기록하지 않음
export async function client(privatePath) {
  const account=JSON.parse(await readFile(resolve(privatePath),'utf8'));
  const base=account.baseUrl.replace(/\/$/,'');
  let token;
  async function call(path, {method='GET',body,anonymous=false}={}) {
    const headers={'Content-Type':'application/json'};
    if(token&&!anonymous)headers.Authorization=`Bearer ${token}`;
    const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
    const value=await response.json();
    return {httpStatus:response.status,...value};
  }
  const login=await call('/auth/login',{method:'POST',body:{email:account.email,password:account.password}});
  if(!login.success)throw Error(`Login: ${login.httpStatus} ${login.code}`);
  token=login.data.accessToken;
  return {call,base};
}
export async function save(path,value) {
  await mkdir(dirname(resolve(path)),{recursive:true});
  await writeFile(path,JSON.stringify(value,null,2)+'\n');
}
export async function pages(call,path,size=100) {
  const rows=[];
  for(let page=0;page<1000;page++){
    const r=await call(`${path}${path.includes('?')?'&':'?'}page=${page}&size=${size}`);
    if(!r.success)throw Error(`${path}: ${r.httpStatus} ${r.code}`);
    rows.push(...r.data.content);
    if(r.data.last)return rows;
  }
  throw Error('Pagination limit');
}
