import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs, existsSync, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { translationPresets,resolveTranslationSettings,readCodexDefaults,mergeReparsedDocument } from './lib/settings.mjs';
import { probeCodex } from './lib/codex.mjs';
import * as sessionCodex from './lib/session-codex.mjs';
import { PaperSessions, sessionAnswerPrompt, normalizeSessionAnswer, historyPage } from './lib/paper-sessions.mjs';
import { researchPolicyVersion } from './lib/research-policy.mjs';
import { reparseDocument, parserNeedsUpdate } from './lib/reparse.mjs';
import { resolvePython } from './lib/config.mjs';
import { hash, buildContext, translationSchema, validateTranslation,
  persistentTranslationPrompt } from './lib/reader.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD = 40 * 1024 * 1024;
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.svg':'image/svg+xml','.pdf':'application/pdf','.json':'application/json; charset=utf-8' };
const docIdOK = id => /^[a-f0-9]{20}$/.test(id);

function processCommand(exe, args, { timeout=120000, signal, maxOutput=2000000, input }={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd:ROOT,windowsHide:true,shell:false,env:{...process.env,PYTHONUTF8:'1'}});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    let stdout='',stderr='',finished=false;
    const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{child.kill();finish(new Error('任务已取消。'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('PDF 处理超时，请尝试较小的文件。'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',v=>{stdout+=v;if(stdout.length>maxOutput)abort();});
    child.stderr.on('data',v=>{stderr=(stderr+v).slice(-12000);});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('error',e=>finish(new Error(`无法启动本地程序 ${path.basename(exe)}：${e.message}`)));
    child.on('close',code=>finish(code===0?null:new Error(stderr.trim()||`本地处理失败（${code}）。`),stdout));
    if(signal?.aborted)abort();
  });
}

export async function startReader(options={}) {
  const dataRoot=path.resolve(options.dataRoot || process.env.READER_DATA || path.join(ROOT,'.reader-data'));
  const documentsRoot=path.join(dataRoot,'documents');
  await fs.mkdir(documentsRoot,{recursive:true});
  const settingsFile=path.join(dataRoot,'settings.json'),jobsFile=path.join(dataRoot,'jobs.json');
  const settings=resolveTranslationSettings(await fs.readFile(settingsFile,'utf8').then(JSON.parse).catch(()=>({})));
  const defaults=await readCodexDefaults();
  const python=options.python || resolvePython();
  const bridge=options.sessionBridge || sessionCodex;
  const jobs=new Map(), waiting=[], clients=new Set(), saves=new Map(), renders=new Map(), imports=new Map(), reparses=new Map(), qualityChecks=new Map(), submissions=new Map();
  const layoutVersion=(await fs.readFile(path.join(ROOT,'scripts','parse_pdf.py'),'utf8')).match(/^VERSION\s*=\s*"([^"]+)"/m)?.[1]||null;
  const oldJobs=await fs.readFile(jobsFile,'utf8').then(JSON.parse).catch(()=>[]);
  for(const old of oldJobs){if(['queued','running'].includes(old.status)){old.status='failed';old.error='服务已重启，已完成译文保留，请重试未完成部分。';}jobs.set(old.id,old);}
  let historySave=Promise.resolve();
  let busy=false,closing=false,codexState={available:false,authenticated:false,queueAvailable:false,detail:'正在检查 Codex…'};
  let parserState={available:false,name:'pdfplumber',detail:'正在检查 PDF 组件…'};
  const codexProbe=options.codexProbe||probeCodex;
  const codexReady=codexProbe().then(s=>codexState=s).catch(e=>codexState={available:false,authenticated:false,queueAvailable:false,detail:e.message});
  const parserReady=processCommand(python,['-X','utf8','-c','import pdfplumber,pypdfium2; print(pdfplumber.__version__)'],{timeout:15000})
    .then(v=>parserState={available:true,name:'pdfplumber',version:v.trim(),layoutVersion}).catch(e=>parserState={available:false,name:'pdfplumber',detail:e.message,layoutVersion});
  const documentDir=id=>{if(!docIdOK(id))throw Object.assign(new Error('论文编号无效。'),{status:400});return path.join(documentsRoot,id);};
  async function readDoc(id){try{return JSON.parse(await fs.readFile(path.join(documentDir(id),'document.json'),'utf8'));}catch(e){if(e.code==='ENOENT')throw Object.assign(new Error('论文不存在。'),{status:404});throw e;}}
  const assertNotReparsing=id=>{if(reparses.has(id))throw Object.assign(new Error('本篇论文正在重新解析，请完成后再翻译或提问。'),{status:409});};
  const activePaperJobs=id=>[...jobs.values()].some(j=>j.documentId===id&&['queued','running'].includes(j.status));
  async function withSubmission(id,run){
    assertNotReparsing(id);submissions.set(id,(submissions.get(id)||0)+1);
    try{return await run(await readDoc(id));}
    finally{const remaining=submissions.get(id)-1;if(remaining)submissions.set(id,remaining);else submissions.delete(id);}
  }
  const parseDocument=options.parsePDF||(({source,output,id,filename,assetDir})=>processCommand(python,['-X','utf8',path.join(ROOT,'scripts','parse_pdf.py'),'--input',source,'--output',output,'--id',id,'--filename',filename,'--asset-dir',assetDir],{timeout:180000}));
  async function auditDocument(doc){
    const id=doc.id,key=id+':'+hash(JSON.stringify([doc.parser,doc.pages,doc.paragraphs.map(p=>[p.id,p.text,p.sourceBoxes]),doc.assets,doc.mathAssets,doc.peripheralBlocks]));
    if(qualityChecks.has(key))return qualityChecks.get(key);
    const pending=(async()=>options.auditDocument?options.auditDocument(doc,documentDir(id)):JSON.parse(await processCommand(python,['-X','utf8',path.join(ROOT,'scripts','parse_quality.py'),'--document','-','--asset-dir',path.join(documentDir(id),'assets')],{timeout:30000,input:JSON.stringify(doc)})))();
    qualityChecks.set(key,pending);try{return await pending;}finally{if(qualityChecks.get(key)===pending)qualityChecks.delete(key);}
  }
  async function mutateDoc(id,mutator){
    const previous=saves.get(id)||Promise.resolve();
    const current=previous.catch(()=>{}).then(async()=>{
      const doc=await readDoc(id);await mutator(doc);for(const a of doc.answers||[])a.id ||= randomUUID();doc.updatedAt=new Date().toISOString();
      const dest=path.join(documentDir(id),'document.json'),tmp=dest+'.'+randomUUID()+'.tmp';
      await fs.writeFile(tmp,JSON.stringify(doc,null,2),'utf8');await fs.rename(tmp,dest);return doc;
    });
    saves.set(id,current);try{return await current;}finally{if(saves.get(id)===current)saves.delete(id);}
  }
  const paperSessions=new PaperSessions({bridge,readDoc,mutateDoc,documentDir,workspace:ROOT,event,prepareResources:options.prepareResources});
  function event(value){for(const res of clients){try{res.write(`data: ${JSON.stringify(value)}\n\n`);}catch{clients.delete(res);}}}
  const publicJob=j=>({id:j.id,type:j.type,documentId:j.documentId,status:j.status,message:j.message,createdAt:j.createdAt,updatedAt:j.updatedAt,result:j.result,error:j.error,model:j.model,reasoningEffort:j.reasoningEffort,requestedModel:j.requestedModel,requestedReasoningEffort:j.requestedReasoningEffort,executionMode:j.executionMode,configurationSource:j.configurationSource,webSearch:j.webSearch,requestedWebSearch:j.requestedWebSearch,searchConfigurationSource:j.searchConfigurationSource,researchPolicyVersion:j.researchPolicyVersion,threadId:j.threadId,usage:j.usage,question:j.question,selectedText:j.selectedText,paragraphId:j.paragraphId,target:j.target,elapsedMs:j.startedAt?Math.max(0,(j.finishedAt||Date.now())-j.startedAt):(j.elapsedMs||0)});
  function persistJobs(){const snapshot=JSON.stringify([...jobs.values()].slice(-150).map(publicJob));historySave=historySave.catch(()=>{}).then(async()=>{const temp=jobsFile+'.tmp';await fs.writeFile(temp,snapshot,'utf8');await fs.rename(temp,jobsFile);}).catch(e=>console.error('任务记录保存失败：'+e.message));}
  function updateJob(j,values){Object.assign(j,values,{updatedAt:new Date().toISOString()});if(values.status==='running')j.startedAt=Date.now();if(['completed','failed','cancelled'].includes(values.status))j.finishedAt=Date.now();event({type:'job-updated',jobId:j.id,job:publicJob(j)});persistJobs();}
  async function pump(){
    if(busy||closing)return;
    const job=waiting.shift();if(!job)return;
    if(job.status==='cancelled'){setImmediate(pump);return;}
    busy=true;updateJob(job,{status:'running',message:'Codex 正在处理…'});
    try{const result=await job.run(job);if(job.status!=='cancelled')updateJob(job,{status:'completed',result,message:'已完成'});}
    catch(e){if(job.status!=='cancelled')updateJob(job,{status:'failed',error:e.message,message:'处理未完成，可重试。'});}
    finally{busy=false;setImmediate(pump);}
  }
  function addJob(type,documentId,run,immediate=false){
    const j={id:randomUUID(),type,documentId,status:'queued',createdAt:new Date().toISOString(),message:'等待 Codex…',run,controller:new AbortController()};
    jobs.set(j.id,j);event({type:'job-updated',jobId:j.id,job:publicJob(j)});persistJobs();
    if(immediate)setImmediate(async()=>{
      updateJob(j,{status:'running',message:'正在交给 Codex 对话…'});
      try{const result=await run(j);if(j.status!=='cancelled')updateJob(j,{status:'completed',result,message:'已完成'});}
      catch(e){if(j.status!=='cancelled')updateJob(j,{status:'failed',error:e.message,message:'未能连接对话，可在阅读器中提问。'});}
    });else{waiting.push(j);setImmediate(pump);}
    // Keep bounded session metadata; completed content is persisted in documents.
    if(jobs.size>300){for(const [id,old] of jobs){if(['completed','failed','cancelled'].includes(old.status)){jobs.delete(id);if(jobs.size<=200)break;}}}
    return j;
  }
  async function assertCodex(){await codexReady;if(!codexState.available||!codexState.authenticated)throw Object.assign(new Error(codexState.detail||'请先在 Codex 登录后重试。'),{status:503});}
  function workerOptions(j,doc,context,preferences=settings){
    j.model=preferences.model;j.reasoningEffort=preferences.reasoningEffort;j.requestedModel=preferences.model;j.requestedReasoningEffort=preferences.reasoningEffort;persistJobs();
    return {model:preferences.model,reasoningEffort:preferences.reasoningEffort,onProgress:v=>{let changed=false;if(v.threadId&&j.threadId!==v.threadId){j.threadId=v.threadId;changed=true;}if(v.usage){j.usage=v.usage;changed=true;}if(v.mode){j.executionMode=v.mode;changed=true;}if(v.configurationSource){j.configurationSource=v.configurationSource;changed=true;}for(const key of ['model','reasoningEffort','webSearch','requestedWebSearch','searchConfigurationSource']){if(Object.hasOwn(v,key)){j[key]=v[key];changed=true;}}if(v.message)updateJob(j,{message:v.message});else if(changed)persistJobs();}};
  }
  function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
  async function readBody(req,max=MAX_UPLOAD){const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Object.assign(new Error('文件超过 40 MB 限制。'),{status:413});buffers.push(chunk);}return Buffer.concat(buffers);}
  async function readJSON(req){const buffer=await readBody(req,1000000);try{return JSON.parse(buffer.toString('utf8')||'{}');}catch{throw Object.assign(new Error('请求内容不是有效 JSON。'),{status:400});}}
  async function sendFile(req,res,file,extra={}){
    let stat;try{stat=await fs.stat(file);}catch{throw Object.assign(new Error('文件不存在。'),{status:404});}
    if(!stat.isFile())throw Object.assign(new Error('文件不存在。'),{status:404});
    const headers={'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','X-Content-Type-Options':'nosniff',...extra};
    const range=req.headers.range;
    if(range&&path.extname(file)==='.pdf'){
      const m=/^bytes=(\d+)-(\d*)$/.exec(range);
      if(!m){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),stat.size-1):stat.size-1;
      if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      res.writeHead(206,{...headers,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1});createReadStream(file,{start,end}).pipe(res);return;
    }
    res.writeHead(200,{...headers,'Content-Length':stat.size,'Accept-Ranges':'bytes'});
    if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }
  async function importPDF(buffer,filename){
    if(!buffer.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Object.assign(new Error('请选择有效的 PDF 文件。'),{status:400});
    const id=hash(buffer).slice(0,20);const existing=await readDoc(id).catch(()=>null);if(existing)return existing;
    if(imports.has(id))return imports.get(id);
    const pending=(async()=>{
      const dir=documentDir(id);await fs.mkdir(path.join(dir,'assets'),{recursive:true});
      await fs.writeFile(path.join(dir,'original.pdf'),buffer);
      const doc=await reparseDocument({id,documentDir:dir,filename,parse:parseDocument,commit:async fresh=>{
        fresh.importedAt=new Date().toISOString();fresh.answers=[];fresh.glossary=[];fresh.updatedAt=fresh.importedAt;
        const dest=path.join(dir,'document.json'),temp=dest+'.'+randomUUID()+'.tmp';
        await fs.writeFile(temp,JSON.stringify(fresh,null,2),'utf8');await fs.rename(temp,dest);return fresh;
      }});
      event({type:'document-updated',documentId:id});return doc;
    })();imports.set(id,pending);try{return await pending;}finally{imports.delete(id);}
  }
  async function handle(req,res){
    const host=req.headers.host||'';
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return json(res,403,{error:'只允许本机访问。'});
    if(req.headers.origin&&req.headers.origin!==`http://${host}`)return json(res,403,{error:'请求来源不受支持。'});
    const url=new URL(req.url,`http://${host}`),route=url.pathname;
    if(route==='/api/settings'&&req.method==='GET')return json(res,200,{settings,presets:translationPresets,defaults,execution:'persistent-per-paper'});
    if(route==='/api/settings'&&req.method==='POST'){
      const next=resolveTranslationSettings(await readJSON(req));await fs.writeFile(settingsFile,JSON.stringify(next,null,2),'utf8');Object.assign(settings,next);event({type:'settings-updated'});return json(res,200,{settings});
    }
    if(route==='/api/jobs'&&req.method==='GET')return json(res,200,{jobs:[...jobs.values()].reverse().slice(0,100).map(publicJob)});
    if(route==='/api/status'&&req.method==='GET'){
      await Promise.all([codexReady,parserReady]);codexState=await codexProbe();return json(res,200,{codex:codexState,parser:parserState,settings,runtime:{pid:process.pid,version:'0.6.0',standalone:true},research:{automatic:true,policyVersion:researchPolicyVersion,requestedWebSearch:'live'},thread:{mode:'per-paper',id:null,queueAvailable:false},activeJobs:[...[...jobs.values()].filter(j=>['running','queued'].includes(j.status)),...reparses.values()].map(publicJob)});
    }
    if(route==='/api/events'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': connected\n\n');clients.add(res);
      const heartbeat=setInterval(()=>res.write(': ping\n\n'),20000);heartbeat.unref();req.on('close',()=>{clients.delete(res);clearInterval(heartbeat);});return;
    }
    if(route==='/api/library'&&req.method==='GET'){
      const entries=await fs.readdir(documentsRoot,{withFileTypes:true});
      const docs=(await Promise.all(entries.filter(e=>e.isDirectory()&&docIdOK(e.name)).map(e=>readDoc(e.name).catch(()=>null)))).filter(Boolean);
      return json(res,200,{documents:docs.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).map(d=>({id:d.id,title:d.title,filename:d.filename,pageCount:d.pageCount,paragraphCount:d.paragraphs.length,translatedCount:d.paragraphs.filter(p=>p.translation).length,updatedAt:d.updatedAt,progress:d.progress}))});
    }
    if(route==='/api/import'&&req.method==='POST'){
      await parserReady;if(!parserState.available)throw Object.assign(new Error(parserState.detail),{status:503});
      let filename='paper.pdf';try{filename=path.basename(decodeURIComponent(req.headers['x-filename']||'paper.pdf'));}catch{}
      return json(res,200,{document:await importPDF(await readBody(req),filename.slice(0,240))});
    }
    let m=/^\/api\/jobs\/([a-f0-9-]+)(\/cancel)?$/.exec(route);
    if(m){const job=jobs.get(m[1]);if(!job)throw Object.assign(new Error('任务不存在或服务已重新启动。'),{status:404});
      if(req.method==='GET'&&!m[2])return json(res,200,publicJob(job));
      if(req.method==='POST'&&m[2]){if(['running','queued'].includes(job.status)){updateJob(job,{status:'cancelled',message:job.executionMode==='queue-owner'?'已停止等待；已提交的 Codex 任务仍可能继续完成。':'已取消'});job.controller.abort();}return json(res,200,publicJob(job));}
    }
    m=/^\/api\/documents\/([a-f0-9]{20})(?:\/(.*))?$/.exec(route);
    if(m){
      const id=m[1],action=m[2]||'',doc=await readDoc(id),dir=documentDir(id);
      if(!action&&req.method==='GET')return json(res,200,{document:{...doc,session:doc.session||{status:'unprepared'}}});
      if(action==='quality'&&req.method==='GET'){
        const quality=await auditDocument(doc);
        const documentBusy=reparses.has(id)||submissions.has(id)||activePaperJobs(id);
        return json(res,200,{quality,parser:{current:doc.parser?.version||null,latest:layoutVersion,updateAvailable:parserNeedsUpdate(doc.parser?.version,layoutVersion)},busy:documentBusy,busyMessage:reparses.has(id)?'正在重新解析本篇论文。':documentBusy?'本篇论文仍有翻译或问答任务。':''});
      }
      if(['session/prepare','translate','ask'].includes(action)&&req.method==='POST')assertNotReparsing(id);
      if(action==='session/prepare'&&req.method==='POST'){
        return withSubmission(id,async doc=>{
        await assertCodex();
        const pending=[...jobs.values()].find(j=>j.type==='session'&&j.documentId===id&&['queued','running'].includes(j.status));
        if(pending)return json(res,202,{jobId:pending.id,session:doc.session||{status:'preparing'}});
        if(doc.session?.status==='ready'&&doc.session.threadId){
          const resources=await paperSessions.prepareResources(doc,{documentDir:dir});
          if(resources.fingerprint===doc.session.fingerprint)return json(res,200,{jobId:null,session:doc.session});
        }
        const preferences={...settings};
        assertNotReparsing(id);
        const job=addJob('session',id,async j=>{
          const result=await paperSessions.prepare(id,{signal:j.controller.signal,...workerOptions(j,doc,{selected:[]},preferences)});
          return {documentId:id,session:result.session};
        },true);
        return json(res,202,{jobId:job.id,session:doc.session||{status:'preparing'}});
        });
      }
      if(action==='session/history'&&req.method==='GET'){
        const sync=await paperSessions.sync(id);
        const current=await readDoc(id);
        return json(res,200,{...historyPage(current,{cursor:url.searchParams.get('cursor'),limit:url.searchParams.get('limit')}),...sync});
      }
      if(action==='reparse'&&req.method==='POST'){
        assertNotReparsing(id);
        if(submissions.has(id)||activePaperJobs(id))throw Object.assign(new Error('请先等待当前任务完成或取消后重新解析。'),{status:409});
        reparses.set(id,{id:randomUUID(),documentId:id,type:'reparse',status:'running',message:'正在检查并重新解析论文…',startedAt:Date.now(),createdAt:new Date().toISOString()});
        try{
          const updated=await reparseDocument({id,documentDir:dir,filename:doc.filename,parse:parseDocument,commit:fresh=>mutateDoc(id,async current=>{
            const backupFile=`document-backup-${Date.now()}-${randomUUID().slice(0,8)}.json`;
            await fs.writeFile(path.join(dir,backupFile),JSON.stringify(current,null,2),'utf8');
            const merged=mergeReparsedDocument(current,fresh);merged.reparse.backupFile=backupFile;
            for(const key of Object.keys(current))delete current[key];Object.assign(current,merged);
          })});
          event({type:'document-updated',documentId:id});return json(res,200,{document:updated});
        }finally{reparses.delete(id);}
      }
      if(action==='file'&&['GET','HEAD'].includes(req.method))return sendFile(req,res,path.join(dir,'original.pdf'),{'Content-Disposition':`inline; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`});
      const asset=/^assets\/([a-zA-Z0-9_.-]+)$/.exec(action);
      if(asset&&req.method==='GET')return sendFile(req,res,path.join(dir,'assets',asset[1]),{'Cache-Control':'no-cache'});
      const page=/^pages\/(\d+)\.png$/.exec(action);
      if(page&&req.method==='GET'){
        const number=Number(page[1]);if(number<1||number>doc.pageCount)throw Object.assign(new Error('页码超出范围。'),{status:400});
        const dest=path.join(dir,'assets','pages',number+'.png');
        if(!existsSync(dest)){
          const key=id+':'+number;
          if(!renders.has(key)){await fs.mkdir(path.dirname(dest),{recursive:true});renders.set(key,processCommand(python,['-X','utf8',path.join(ROOT,'scripts','parse_pdf.py'),'--input',path.join(dir,'original.pdf'),'--output',dest,'--render-page',String(number)],{timeout:45000}).finally(()=>renders.delete(key)));}
          await renders.get(key);
        }return sendFile(req,res,dest);
      }
      if(action==='progress'&&req.method==='POST'){
        const body=await readJSON(req);const paragraph=doc.paragraphs.find(p=>p.id===body.paragraphId);
        await mutateDoc(id,d=>{d.progress={paragraphId:paragraph?.id||d.progress?.paragraphId||d.paragraphs[0]?.id,scrollTop:Math.max(0,Math.min(10000000,Number(body.scrollTop)||0)),updatedAt:new Date().toISOString()};});return json(res,200,{ok:true});
      }
      if(action==='translate'&&req.method==='POST'){
        return withSubmission(id,async doc=>{
        await assertCodex();const body=await readJSON(req);
        const ids=[...new Set(Array.isArray(body.paragraphIds)?body.paragraphIds:[])];
        if(!ids.length||ids.length>80||ids.some(pid=>!doc.paragraphs.some(p=>p.id===pid)))throw Object.assign(new Error('请选择 1–80 个有效段落。'),{status:400});
        if(ids.some(pid=>['metadata','equation'].includes(doc.paragraphs.find(p=>p.id===pid)?.kind)))throw Object.assign(new Error('作者单位与公式保留原貌，无需翻译。'),{status:400});
        const preferences={...settings};
        const existing=[...jobs.values()].find(j=>j.type==='translate'&&j.documentId===id&&['running','queued'].includes(j.status));
        if(existing)throw Object.assign(new Error('这篇论文已有翻译任务，请等待完成或取消后重试。'),{status:409});
        const job=addJob('translate',id,async j=>{
          let translated=0;
          j.requestedModel=preferences.model;j.requestedReasoningEffort=preferences.reasoningEffort;
          let recovered=0;
          if(!body.force){
            const restored=await paperSessions.recoverTranslations(id,ids);
            recovered=restored.recovered;translated+=recovered;
            if(recovered)updateJob(j,{message:`已从 Codex 对话恢复 ${recovered} 段译文。`,configurationSource:'thread',executionMode:'recovered',model:null,reasoningEffort:null});
          }
          // Small batches preserve context without paying repeated whole-paper input costs.
          const latest=await readDoc(id);
          const pending=ids.filter(pid=>body.force||!latest.paragraphs.find(p=>p.id===pid)?.translation);
          for(let offset=0;offset<pending.length;offset+=3){
            if(j.controller.signal.aborted)throw new Error('任务已取消。');
            const current=await readDoc(id),batch=pending.slice(offset,offset+3),context=buildContext(current,batch,'',{maxChars:preferences.contextChars,maxItems:preferences.contextItems});
            updateJob(j,{message:`Codex 正在翻译 ${offset+1}–${Math.min(offset+3,pending.length)} / ${pending.length} 段…`});
            const batchStarted=Date.now();
            const response=await paperSessions.turn(id,{kind:'translation',historyMeta:{paragraphIds:batch,sourceHashes:Object.fromEntries(batch.map(pid=>[pid,hash(current.paragraphs.find(p=>p.id===pid).text)])),jobId:j.id},prompt:({resources})=>persistentTranslationPrompt(current,batch,resources),schema:translationSchema,signal:j.controller.signal,...workerOptions(j,current,context,preferences)});
            const result=response.result;
            const candidates=result.translations;
            if(!Array.isArray(candidates))throw new Error('Codex 返回格式不完整，请重试。');
            const validated=batch.map(pid=>{const p=current.paragraphs.find(p=>p.id===pid);return [pid,{...validateTranslation(p,candidates.find(t=>t.paragraphId===pid),hash(context)),model:j.model,reasoningEffort:j.reasoningEffort,configurationSource:j.configurationSource||'reader',elapsedMs:Date.now()-batchStarted}];});
            await mutateDoc(id,d=>{for(const [pid,t] of validated){const p=d.paragraphs.find(p=>p.id===pid);if(hash(p.text)!==t.sourceHash)throw new Error('原文已修改，请重新翻译。');p.translation=t;}});
            translated+=validated.length;event({type:'document-updated',documentId:id});
          }return {documentId:id,translated,recovered,paragraphIds:ids,cached:ids.length-pending.length-recovered};
        });return json(res,202,{jobId:job.id});
        });
      }
      if(action==='ask'&&req.method==='POST'){
        return withSubmission(id,async doc=>{
        await assertCodex();const body=await readJSON(req);
        if([...jobs.values()].some(j=>j.type==='ask'&&j.documentId===id&&['queued','running'].includes(j.status)))throw Object.assign(new Error('上一条回答仍在生成，请稍候再发送。'),{status:409});
        const question=String(body.question||'请结合上下文解释这段内容。').trim().slice(0,6000);
        const preferences={...settings};
        const explicit=doc.paragraphs.find(p=>p.id===body.paragraphId&&p.kind!=='metadata'&&!p.isFootnote);
        if(body.paragraphId&&!explicit)throw Object.assign(new Error('所选段落已更新，请重新选择。'),{status:400});
        const anchor=explicit||doc.paragraphs.find(p=>p.id===doc.progress?.paragraphId&&p.kind==='paragraph'&&!p.isFootnote)||doc.paragraphs.find(p=>p.kind==='paragraph'&&!p.isFootnote)||doc.paragraphs[0];
        if(!anchor)throw Object.assign(new Error('论文尚无可用于问答的内容。'),{status:400});
        const selectedText=explicit?String(body.selectedText||explicit.text).slice(0,8000):'';
        const job=addJob('ask',id,async j=>{
          const response=await paperSessions.turn(id,{kind:'ask',historyMeta:{question,selectedText,paragraphId:explicit?.id||null,jobId:j.id,researchPolicyVersion},prompt:({resources})=>sessionAnswerPrompt(doc,question,{paragraphId:explicit?.id,selectedText,resources}),signal:j.controller.signal,...workerOptions(j,doc,{selected:[]},preferences)});
          const result=normalizeSessionAnswer(await readDoc(id),response.result);
          await mutateDoc(id,d=>{const prior=(d.answers||[]).find(a=>response.turnId&&a.nativeTurnId===response.turnId);const answer={...result,id:prior?.id||randomUUID(),jobId:j.id,nativeTurnId:response.turnId,threadId:response.threadId,question,selectedText,paragraphId:explicit?.id||null,researchPolicyVersion};if(prior)Object.assign(prior,answer);else d.answers=[...(d.answers||[]),answer];});
          event({type:'document-updated',documentId:id});return {...result,target:'reader',question,documentId:id};
        },true);
        Object.assign(job,{question,selectedText,paragraphId:explicit?.id||null,target:'reader',researchPolicyVersion});persistJobs();
        return json(res,202,{jobId:job.id});
        });
      }
      if(action==='export'&&req.method==='GET'){
        const lines=[`# ${doc.title}`,''];for(const p of doc.paragraphs){lines.push(p.kind==='heading'?`## ${p.text}`:p.text,'');if(p.translation)lines.push(p.translation.text,'');}
        res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':"attachment; filename=paper-bilingual.md"});res.end(lines.join('\n'));return;
      }
    }
    if(route.startsWith('/api/'))return json(res,404,{error:'接口不存在。'});
    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持此操作。'});
    const publicFile=route==='/'?'index.html':decodeURIComponent(route.slice(1));
    const dest=path.resolve(ROOT,'public',publicFile);
    if(!dest.startsWith(path.join(ROOT,'public')+path.sep))throw Object.assign(new Error('路径无效。'),{status:400});
    return sendFile(req,res,dest,{'Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"});
  }
  const server=http.createServer((req,res)=>handle(req,res).catch(e=>{if(!res.headersSent)json(res,e.status||500,{error:e.message||'服务处理失败。'});else res.end();}));
  server.requestTimeout=240000;
  const port=options.port ?? Number(process.env.PORT||4317);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const actualPort=server.address().port,url=`http://127.0.0.1:${actualPort}`;
  console.log(`READ: ${url}`);
  console.log(`论文与译文保存在 ${dataRoot}`);
  return {server,url,dataRoot,ready:Promise.all([codexReady,parserReady]),importPDF,
    close:async()=>{closing=true;for(const j of jobs.values())j.controller?.abort();for(const res of clients)res.end();await historySave;await new Promise(resolve=>server.close(resolve));}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  startReader().then(app=>{
    process.on('SIGINT',()=>app.close().then(()=>process.exit(0)));
    process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
  }).catch(e=>{console.error(e.code==='EADDRINUSE'?'4317 端口已在使用，可能阅读器已启动。请打开 http://127.0.0.1:4317，或设置 PORT 使用其他端口。':e.message);process.exitCode=1;});
}
