import { defineConfig } from 'vite';
export default defineConfig({server:{port:5173,proxy:{'/api':process.env.LIGHTMONI_DEV_API_URL??'http://127.0.0.1:8080','/v1':process.env.LIGHTMONI_DEV_API_URL??'http://127.0.0.1:8080','/downloads':process.env.LIGHTMONI_DEV_API_URL??'http://127.0.0.1:8080'}},build:{outDir:'../runtime/public',emptyOutDir:true}});
