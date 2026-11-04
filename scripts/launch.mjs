import { spawn } from 'node:child_process';
import { mkdir, open, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT||4317);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 必须是有效端口。');
const url=`http://127.0.0.1:${port}`;
async function status(){try{const response=await fetch(url+'/api/status',{signal:AbortSignal.timeout(1800)});const body=await response.json();return response.ok&&body.runtime?.version?body:null;}catch{return null;}}
let ready=await status();
if(ready&&process.argv.includes('--restart')){
  if(ready.activeJobs?.length)throw new Error('请等待翻译或回答完成后再重启，已完成内容会保留。');
  const savedPid=Number(await readFile(path.join(root,'.reader-runtime','server.pid'),'utf8').catch(()=>''));
  if(!savedPid||savedPid!==ready.runtime.pid)throw new Error('当前服务不是由此启动器启动，请在原终端停止后重试。');
  process.kill(savedPid,'SIGTERM');
  for(let attempt=0;attempt<20;attempt++){
    await new Promise(resolve=>setTimeout(resolve,200));ready=await status();if(!ready)break;
  }
  if(ready)throw new Error('原阅读器尚未退出，请稍后重试。');
}
if(!ready){
  const runtime=path.join(root,'.reader-runtime');await mkdir(runtime,{recursive:true});
  const log=await open(path.join(runtime,'reader.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,CODEX_THREAD_ID:'',READER_THREAD_ID:''},detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();await log.close();
  await writeFile(path.join(runtime,'server.pid'),String(child.pid),'utf8');
  for(let attempt=0;attempt<35&&!ready;attempt++){
    await new Promise(resolve=>setTimeout(resolve,300));ready=await status();
  }
}
if(!ready)throw new Error('阅读器启动未完成，请查看 .reader-runtime/reader.log。');
console.log(`READ 已启动：${url}`);
if(process.argv.includes('--no-open')){
  // Used by service checks and by an already-open reader tab.
}else if(process.platform==='win32'){
  const browser=spawn('cmd.exe',['/d','/s','/c','start','""',url],{windowsHide:true,stdio:'ignore'});browser.unref();
}else{
  const browser=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore',detached:true});browser.on('error',()=>{});browser.unref();
}
