import { mkdir,writeFile } from 'node:fs/promises';
import { caseNames } from './contract.mts';
const name=process.argv[2];
if(!name||!caseNames.includes(name as typeof caseNames[number]))throw new Error('选择验收用例：'+caseNames.join(', '));
let report:{state:string;error?:unknown;[key:string]:unknown};
try{
 const response=await fetch('http://127.0.0.1:8791/__acceptance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({case:name}),signal:AbortSignal.timeout(180000)});
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('NON_JSON_RESPONSE');
 report=await response.json() as typeof report;
}catch{
 report={case:name,state:'error',error:{code:'ACCEPTANCE_RUNNER_UNAVAILABLE',message:'本地验收入口不可用，本次没有取得业务结果'}};
}
report.startedAt=new Date().toISOString();
await mkdir('.artifacts/acceptance',{recursive:true});
await writeFile(`.artifacts/acceptance/${name}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(report.state!=='ready')process.exitCode=1;
