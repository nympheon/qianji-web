interface OpsEnv {OPS_BRIDGE_KEY:string;OPS_BRIDGE_ID:string;TARGET:DurableObjectNamespace}
/** Temporary wrangler remote-dev bridge, excluded from the product Worker import graph. */
export default {
 async fetch(request:Request,env:OpsEnv):Promise<Response>{
  if(request.method==='GET'&&new URL(request.url).pathname==='/__ops/ping'&&request.headers.get('Authorization')===`Bearer ${env.OPS_BRIDGE_KEY}`)return Response.json({bridgeId:env.OPS_BRIDGE_ID});
  if(request.method!=='POST'||new URL(request.url).pathname!=='/__ops'||request.headers.get('Authorization')!==`Bearer ${env.OPS_BRIDGE_KEY}`)return new Response(null,{status:404});
  const body=await request.text();if(body.length>2048)return new Response(null,{status:413});
  try{const command=JSON.parse(body) as unknown,target=env.TARGET.getByName('personal') as unknown as {operate(command:unknown):Promise<unknown>};return Response.json(await target.operate(command),{headers:{'cache-control':'no-store'}});}
  catch{return Response.json({error:{code:'MAINTENANCE_REQUEST_FAILED',message:'受控运维请求尚未完成；请核对暂停状态及原恢复批次'}},{status:409,headers:{'cache-control':'no-store'}});}
 }
} satisfies ExportedHandler<OpsEnv>;
