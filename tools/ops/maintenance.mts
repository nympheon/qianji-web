import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),action=args.shift();
const usage='pnpm ops <status|pause|verify|resume|bookmark|restore|restart> --account-id <32hex> --script <explicit-worker> [--review-digest <sha256>] [--bookmark <bookmark>] [--restore-id <new-run-id>] [--at <ISO-time>]';
if(!action||action==='--help'){console.log(usage);process.exit(0);}
const values:Record<string,string>={};for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!name?.startsWith('--')||!value||Object.hasOwn(values,name))throw new Error(usage);values[name]=value;}
const account=values['--account-id'],script=values['--script'];
if(!account||!/^[a-fA-F0-9]{32}$/.test(account)||!script||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(script)||!['status','pause','verify','resume','bookmark','restore','restart'].includes(action))throw new Error(usage);
if(Object.keys(values).some(key=>!['--account-id','--script','--review-digest','--bookmark','--restore-id','--at'].includes(key)))throw new Error(usage);
const command:Record<string,string>={action};for(const [flag,key]of [['--review-digest','reviewDigest'],['--bookmark','bookmark'],['--restore-id','restoreId'],['--at','at']])if(values[flag!])command[key!]=values[flag!]!;
if(action==='resume'&&!/^[a-f0-9]{64}$/.test(command.reviewDigest??'')||action==='restore'&&(!command.bookmark||!command.restoreId)||action==='restart'&&!command.restoreId)throw new Error(usage);
const taskDir=resolve('.artifacts/ops',randomUUID()),key=randomBytes(32).toString('hex'),bridgeId=randomUUID();await mkdir(taskDir,{recursive:true});
const config={name:'qianji-maintenance-'+randomUUID().slice(0,8),account_id:account,main:fileURLToPath(new URL('./worker.mts',import.meta.url)),compatibility_date:'2026-10-18',workers_dev:false,preview_urls:false,vars:{OPS_BRIDGE_KEY:key,OPS_BRIDGE_ID:bridgeId},durable_objects:{bindings:[{name:'TARGET',class_name:'QianjiState',script_name:script}]}};
await writeFile(resolve(taskDir,'wrangler.json'),JSON.stringify(config,null,2));
const require=createRequire(import.meta.url),wrangler=resolve(dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js');
const child=spawn(process.execPath,[wrangler,'dev','--remote','--config',resolve(taskDir,'wrangler.json'),'--ip','127.0.0.1','--port','8792'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(taskDir,'wrangler.log')}});
child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let exited=false;child.on('exit',()=>{exited=true;});child.on('error',()=>{exited=true;});
try{
 let ready=false;for(let attempt=0;attempt<120&&!exited;attempt++){try{const response=await fetch('http://127.0.0.1:8792/__ops/ping',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.json() as {bridgeId?:string}).bridgeId===bridgeId){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}
 if(!ready)throw new Error('运维代理未启动。请先完成 wrangler login，并核对明确的账号和Worker名称。');
 const response=await fetch('http://127.0.0.1:8792/__ops',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(600000)});
 const result=await response.json() as unknown;await writeFile(resolve(taskDir,'result.json'),JSON.stringify({action,script,at:new Date().toISOString(),result},null,2));console.log(JSON.stringify(result,null,2));if(!response.ok)process.exitCode=1;
}catch(error){console.error(error instanceof Error&&error.message.startsWith('运维代理')?error.message:'运维结果未确认；保持暂停并使用 status 核查，不能重发业务操作。');process.exitCode=1;}
finally{child.kill('SIGINT');await new Promise(resolve=>setTimeout(resolve,500));if(!exited)child.kill('SIGTERM');}
