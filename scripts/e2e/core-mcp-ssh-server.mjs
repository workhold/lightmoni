import { createRequire } from "node:module";
import { generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root=resolve(new URL("../..",import.meta.url).pathname),require=createRequire(join(root,"runtime","package.json"));
import { join } from "node:path";
const {Server}=require("ssh2"),port=Number(process.env.CORE_E2E_SSH_PORT),password=process.env.CORE_E2E_SSH_PASSWORD??"",container=process.env.CORE_E2E_AGENT_CONTAINER,dockerHost=process.env.CORE_E2E_DOCKER_HOST;
if(!port||!password||!container||!dockerHost)throw Error("missing isolated SSH configuration");
const key=process.env.CORE_E2E_SSH_HOST_KEY??generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs1",format:"pem"}}).privateKey;
const allowed=/^\/usr\/local\/bin\/lightmoni-agent task-once --job-id ([a-f0-9-]{36})$/;
const server=new Server({hostKeys:[key]},client=>{
 client.on("authentication",ctx=>{if(ctx.method==="password"&&ctx.username==="root"&&ctx.password&&timingSafeEqual(Buffer.from(ctx.password),Buffer.from(password)))ctx.accept();else ctx.reject();});
 client.on("ready",()=>client.on("session",acceptSession=>{const session=acceptSession();session.on("exec",(accept,reject,info)=>{
  const match=allowed.exec(info.command);if(!match){reject();return;}
  const channel=accept(),child=spawn("docker",["exec","-i",container,"/usr/local/bin/lightmoni-agent","task-once","--job-id",match[1]],{env:{...process.env,DOCKER_HOST:dockerHost}});
  child.stdout.pipe(channel);child.stderr.pipe(channel.stderr);child.on("error",()=>{channel.exit(1);channel.end();});child.on("close",code=>{channel.exit(code??1);channel.end();});
 });}));
 client.on("error",()=>{});
});
server.listen(port,"127.0.0.1",()=>console.log(`isolated SSH listening ${port}`));
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
