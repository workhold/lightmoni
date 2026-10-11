// Loopback-only developer preview against the real Docker API. Production
// Origin/CSRF verification must use the actual localhost:18380 application.
import {defineConfig} from 'vite';
export default defineConfig({server:{host:'127.0.0.1',port:15174,strictPort:true,proxy:{'/api':{target:'http://localhost:18380',changeOrigin:true,configure(proxy){proxy.on('proxyReq',(request,incoming)=>{if(incoming.headers.origin==='http://localhost:15174')request.setHeader('origin','http://localhost:18380')})}}}}});
