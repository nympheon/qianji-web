import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({command})=>{
 if(command!=='serve')throw new Error('验收入口仅允许本机 dev，禁止构建或部署');
 return {
 resolve:{alias:{'@':fileURLToPath(new URL('../../src/web',import.meta.url))}},
 server:{host:'127.0.0.1',port:8791,strictPort:true,watch:{ignored:['**/.artifacts/**','**/dist/**']}},
 build:{outDir:'.artifacts/acceptance/dist'},
 plugins:[react(),tailwindcss(),cloudflare({
  configPath:'wrangler.jsonc',remoteBindings:false,inspectorPort:0,
  config:{main:fileURLToPath(new URL('./worker.mts',import.meta.url)),assets:{run_worker_first:['/__acceptance']}},
  viteEnvironment:{name:'worker'},persistState:{path:'.wrangler/state'},
 })],
};});
