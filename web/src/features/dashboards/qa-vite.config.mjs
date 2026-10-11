import {defineConfig} from 'vite';
// Isolated browser QA: current sources against the running Docker API, without
// hot updates interrupting long edit/drag/save interactions from parallel work.
const target='http://127.0.0.1:18380';
const proxy={target,changeOrigin:true,configure(server){server.on('proxyReq',request=>{if(request.getHeader('Origin'))request.setHeader('Origin','http://127.0.0.1:5173');});}};
export default defineConfig({server:{host:'127.0.0.1',port:5174,strictPort:true,hmr:false,proxy:{'/api':proxy,'/v1':proxy}}});
