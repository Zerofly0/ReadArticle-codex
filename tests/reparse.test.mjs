import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { reparseDocument, parserNeedsUpdate } from '../lib/reparse.mjs';
import { startReader } from '../server.mjs';

const runtime = path.resolve('.reader-runtime');
const id = '1234567890abcdef1234';
const baseDoc = () => ({ id, title:'Reparse fixture', filename:'paper.pdf', pageCount:1, pages:[{page:1,width:600,height:800}], parser:{version:'0.1.0'}, sections:[], assets:[], mathAssets:[], paragraphs:[{id:'p1',page:1,kind:'paragraph',text:'Source text.',rawText:'Source text.',sentences:[{id:'s1',text:'Source text.'}],sourceBoxes:[{page:1,x0:50,y0:100,x1:300,y1:130}],translation:{text:'原文。',alignments:[]}}], answers:[{id:'a1',answer:'Existing answer.',citations:[]}], session:{status:'ready',threadId:'existing-paper-thread',fingerprint:'old-source'}, glossary:[] });
const quality = {version:'parse-quality-v1',issues:[],summary:{status:'ok',issueCount:0,errorCount:0,warningCount:0,infoCount:0,byCode:{},degradedPages:[]}};
async function temporary(t) {
  await fs.mkdir(runtime,{recursive:true});const root=await fs.mkdtemp(path.join(runtime,'reparse-test-'));
  t.after(async()=>{const rel=path.relative(runtime,root);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await fs.rm(root,{recursive:true,force:true});});
  const dir=path.join(root,'documents',id);await fs.mkdir(path.join(dir,'assets'),{recursive:true});
  await fs.writeFile(path.join(dir,'original.pdf'),'%PDF-fixture-original');await fs.writeFile(path.join(dir,'assets','math.png'),'OLD IMAGE');
  await fs.writeFile(path.join(dir,'document.json'),JSON.stringify(baseDoc()));return {root,dir};
}
async function generated({output,assetDir},doc=baseDoc()) {
  await fs.writeFile(path.join(assetDir,'math.png'),'NEW IMAGE');
  doc.parser.version='0.7.0';doc.mathAssets=[{id:'m1',token:'⟦MATH_m1⟧',page:1,url:`/api/documents/${doc.id}/assets/math.png`}];
  await fs.writeFile(output,JSON.stringify(doc));
}
test('parser version checks never recommend downgrading a newer paper',()=>{
  assert.equal(parserNeedsUpdate('0.6.1','0.7.0'),true);assert.equal(parserNeedsUpdate('0.7.0','0.7.0'),false);
  assert.equal(parserNeedsUpdate('0.10.0','0.7.0'),false);assert.equal(parserNeedsUpdate(null,'0.7.0'),true);
});
test('failed parsing never overwrites live images or the saved document',async t=>{
  const {dir}=await temporary(t),before=await fs.readFile(path.join(dir,'document.json'),'utf8');
  await assert.rejects(reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:async args=>{await generated(args);throw Error('parser failed');},commit:()=>assert.fail('must not commit')}),/parser failed/);
  assert.equal(await fs.readFile(path.join(dir,'assets','math.png'),'utf8'),'OLD IMAGE');
  assert.equal(await fs.readFile(path.join(dir,'document.json'),'utf8'),before);
  assert.ok(!(await fs.readdir(dir)).some(name=>name.startsWith('.reparse-')));
});
test('new asset URLs are immutable, source text remains exact, and a failed commit rolls back only newly published images',async t=>{
  const {dir}=await temporary(t);let ready;
  const doc=baseDoc();doc.paragraphs[0].text=`/api/documents/${id}/assets/math.png`;
  await reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:args=>generated(args,doc),commit:async fresh=>{
    ready=fresh;const name=fresh.mathAssets[0].url.split('/').at(-1);assert.match(name,/^r[a-f0-9]+-math\.png$/);
    assert.equal(await fs.readFile(path.join(dir,'assets',name),'utf8'),'NEW IMAGE');
    assert.equal(fresh.paragraphs[0].text,doc.paragraphs[0].text);return fresh;
  }});
  assert.equal(await fs.readFile(path.join(dir,'assets','math.png'),'utf8'),'OLD IMAGE');
  const files=await fs.readdir(path.join(dir,'assets'));
  await assert.rejects(reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:generated,commit:()=>{throw Error('cannot save');}}),/cannot save/);
  assert.deepEqual(await fs.readdir(path.join(dir,'assets')),files);
  assert.ok(ready.mathAssets[0].url.endsWith('-math.png'));
});
test('an incomplete image reference cannot publish a broken paper',async t=>{
  const {dir}=await temporary(t);const doc=baseDoc();doc.assets=[{url:`/api/documents/${id}/assets/missing.png`}];
  await assert.rejects(reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:args=>generated(args,doc),commit:()=>assert.fail('must not commit')}),/图片缺失/);
  assert.deepEqual(await fs.readdir(path.join(dir,'assets')),['math.png']);
});
test('hard integrity errors refuse publication while review warnings remain usable',async t=>{
  const {dir}=await temporary(t);const doc=baseDoc();doc.quality={...quality,summary:{...quality.summary,errorCount:1}};
  await assert.rejects(reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:args=>generated(args,doc),commit:()=>assert.fail('must not publish hard errors')}),/完整性/);
  doc.quality={...quality,summary:{...quality.summary,status:'review',warningCount:1}};
  let committed=false;await reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:args=>generated(args,doc),commit:()=>{committed=true;}});assert.equal(committed,true);
});
test('published images cannot point to another paper',async t=>{
  const {dir}=await temporary(t);const doc=baseDoc();doc.assets=[{url:'/api/documents/aaaaaaaaaaaaaaaaaaaa/assets/figure.png'}];
  await assert.rejects(reparseDocument({id,documentDir:dir,filename:'paper.pdf',parse:args=>generated(args,doc),commit:()=>assert.fail('must not publish foreign assets')}),/不属于当前论文/);
});
test('HTTP reparse excludes model submissions, preserves current data, and serves old pictures until commit',async t=>{
  const {root,dir}=await temporary(t);let entered=false,release;const hold=new Promise(resolve=>{release=resolve;});
  const app=await startReader({port:0,dataRoot:root,codexProbe:async()=>({available:true,authenticated:true}),auditDocument:async()=>quality,
    parsePDF:async args=>{await generated(args);entered=true;await hold;},sessionBridge:{createSession:()=>assert.fail('no model calls'),continueSession:()=>assert.fail('no model calls')}});
  t.after(async()=>{release();await app.close();});
  const request=async(route,body)=>{const r=await fetch(app.url+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const base='/api/documents/'+id;const pending=request(base+'/reparse',{});
  for(let i=0;!entered&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(entered);
  assert.equal((await request(base+'/quality')).body.busy,true);
  assert.equal((await request(base+'/reparse',{})).status,409);
  for(const action of ['ask','translate','session/prepare'])assert.equal((await request(base+'/'+action,{})).status,409);
  assert.equal(await(await fetch(app.url+base+'/assets/math.png')).text(),'OLD IMAGE');
  assert.ok((await request('/api/status')).body.activeJobs.some(j=>j.type==='reparse'));
  await request(base+'/progress',{paragraphId:'p1',scrollTop:123});release();
  const result=await pending;assert.equal(result.status,200);const d=result.body.document;
  assert.equal(d.progress.scrollTop,123);assert.equal(d.paragraphs[0].translation.text,'原文。');
  assert.equal(d.answers[0].answer,'Existing answer.');assert.equal(d.session.threadId,'existing-paper-thread');assert.equal(d.session.status,'unprepared');
  const backup=JSON.parse(await fs.readFile(path.join(dir,d.reparse.backupFile),'utf8'));assert.equal(backup.progress.scrollTop,123);
  assert.equal((await request(base+'/quality')).body.busy,false);
  const before=await fs.readFile(path.join(dir,'document.json'),'utf8');const checked=await request(base+'/quality');
  assert.deepEqual(checked.body.quality,quality);assert.equal(checked.body.parser.current,'0.7.0');
  assert.equal(await fs.readFile(path.join(dir,'document.json'),'utf8'),before,'quality checks must not edit saved content');
  assert.equal(await fs.readFile(path.join(dir,'original.pdf'),'utf8'),'%PDF-fixture-original');
});
test('reparse cannot race a question whose request body is still arriving',async t=>{
  const {root}=await temporary(t);let bodyControl;
  const app=await startReader({port:0,dataRoot:root,codexProbe:async()=>({available:true,authenticated:true}),auditDocument:async()=>quality,parsePDF:generated});
  t.after(async()=>{try{bodyControl?.close();}catch{}await app.close();});
  const base=app.url+'/api/documents/'+id;
  const stream=new ReadableStream({start(c){bodyControl=c;c.enqueue(new TextEncoder().encode('{"paragraphId":"not-current","question":'));}});
  const pending=fetch(base+'/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:stream,duplex:'half'});
  let busy=false;for(let i=0;i<100&&!busy;i++){busy=(await(await fetch(base+'/quality')).json()).busy;if(!busy)await new Promise(r=>setTimeout(r,10));}
  assert.ok(busy,'the receiving request reserves its source snapshot');
  const conflict=await fetch(base+'/reparse',{method:'POST'});assert.equal(conflict.status,409);
  bodyControl.enqueue(new TextEncoder().encode('"test"}'));bodyControl.close();bodyControl=null;
  assert.equal((await pending).status,400,'a stale selection fails before any model job starts');
  assert.equal((await(await fetch(base+'/quality')).json()).busy,false);
});
test('failed first import does not leave an apparently usable partial document',async t=>{
  const {root}=await temporary(t);const app=await startReader({port:0,dataRoot:root,codexProbe:async()=>({available:false}),parsePDF:async args=>{await generated(args,{...baseDoc(),id:args.id});throw Error('parser crash');}});
  t.after(()=>app.close());
  const imported=await fetch(app.url+'/api/import',{method:'POST',body:Buffer.from('%PDF-new-import-fixture')});assert.equal(imported.status,500);
  const docs=(await(await fetch(app.url+'/api/library')).json()).documents;assert.deepEqual(docs.map(d=>d.id),[id]);
});
test('first import publishes a complete document with immutable local picture references',async t=>{
  const {root}=await temporary(t);const app=await startReader({port:0,dataRoot:root,codexProbe:async()=>({available:false}),parsePDF:args=>generated(args,{...baseDoc(),id:args.id,session:undefined})});t.after(()=>app.close());
  const result=await fetch(app.url+'/api/import',{method:'POST',body:Buffer.from('%PDF-successful-import-fixture')});assert.equal(result.status,200);
  const {document:d}=await result.json();assert.notEqual(d.id,id);assert.deepEqual(d.answers,[]);assert.ok(d.importedAt);
  assert.match(d.mathAssets[0].url,new RegExp('^/api/documents/'+d.id+'/assets/r[a-f0-9]+-math\\.png$'));
  assert.equal(await(await fetch(app.url+d.mathAssets[0].url)).text(),'NEW IMAGE');
});
