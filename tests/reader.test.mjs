import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, validateTranslation, validateAnswer, threadMessage } from '../lib/reader.mjs';
const document = { id:'d',title:'Paper',sections:[{id:'sec',title:'Method'}],paragraphs:[
  {id:'p1',page:1,sectionId:'sec',text:'Let the gate denote a confidence weight.',sentences:[{id:'p1s1',text:'Let the gate denote a confidence weight.'}]},
  {id:'p2',page:2,sectionId:'sec',text:'The gate may reduce error by 12%. It does not guarantee convergence.',sentences:[{id:'p2s1',text:'The gate may reduce error by 12%.'},{id:'p2s2',text:'It does not guarantee convergence.'}]}
]};
test('retrieval includes selected source and its definition with page provenance',()=>{
  const c=buildContext(document,['p2']);
  assert.equal(c.selected[0].id,'p2'); assert.ok(c.evidence.some(p=>p.id==='p1'));assert.equal(c.selected[0].page,2);
});
test('many-to-one alignment is valid',()=>{
  const t=validateTranslation(document.paragraphs[1],{paragraphId:'p2',text:'该门控可能将误差降低12%，但不保证收敛。',alignments:[{sourceIds:['p2s1','p2s2'],targetText:'该门控可能将误差降低12%，但不保证收敛。'}],notes:[]});
  assert.equal(t.status,'aligned');assert.equal(t.notes.length,0);
});
test('unknown or duplicated source IDs cause explicit paragraph fallback',()=>{
  const t=validateTranslation(document.paragraphs[1],{paragraphId:'p2',text:'译文',alignments:[{sourceIds:['p2s1','unknown'],targetText:'译文'}],notes:[]});
  assert.equal(t.status,'paragraph-only');assert.deepEqual(t.alignments[0].sourceIds,['p2s1','p2s2']);
});
test('translated text omitted from alignment cannot masquerade as sentence alignment',()=>{
  const t=validateTranslation(document.paragraphs[1],{paragraphId:'p2',text:'完整译文',alignments:[{sourceIds:['p2s1','p2s2'],targetText:'部分'}],notes:[]});
  assert.equal(t.status,'paragraph-only');
});
test('fabricated citations are removed, real verbatim evidence is retained',()=>{
  const c=buildContext(document,['p2']);
  const a=validateAnswer(document,c,{answer:'解释',uncertainty:'',citations:[{paragraphId:'p2',quote:'does not guarantee convergence'},{paragraphId:'p2',quote:'always converges'},{paragraphId:'fake',quote:'x'}]});
  assert.equal(a.citations.length,1);assert.equal(a.citations[0].page,2);assert.match(a.uncertainty,/引用/);
});
test('native chat context stays below Windows command line limits',()=>{
  const c=buildContext(document,['p2']);
  c.selected[0].text='a'.repeat(100000);c.selected[0].translation='译'.repeat(100000);c.selectedText='x'.repeat(100000);
  c.evidence=Array.from({length:30},(_,i)=>({id:'p'+i,page:i+1,text:'b'.repeat(10000)}));
  assert.ok(threadMessage(document,c,'q'.repeat(10000)).length<26000);
});
test('math image placeholders must survive translation without loss or invention',()=>{
  const p={id:'math',text:'The input is ⟦MATH_m001⟧.',sentences:[{id:'ms1',text:'The input is ⟦MATH_m001⟧.'}]};
  const candidate={paragraphId:'math',text:'输入为⟦MATH_m001⟧。',alignments:[{sourceIds:['ms1'],targetText:'输入为⟦MATH_m001⟧。'}],notes:[]};
  assert.equal(validateTranslation(p,candidate).status,'aligned');
  assert.throws(()=>validateTranslation(p,{...candidate,text:'输入为X。'}),/公式标记/);
  assert.throws(()=>validateTranslation(p,{...candidate,text:'输入为⟦MATH_m002⟧。'}),/公式标记/);
});
test('native paper questions carry formula image provenance instead of orphan tokens',()=>{
  const c={title:'Math paper',documentId:'d',selected:[{id:'p',page:5,text:'Weights ⟦MATH_m001⟧.'}],evidence:[],math:[{token:'⟦MATH_m001⟧',page:5,localPath:'E:/paper/assets/math-m001.png'}]};
  assert.match(threadMessage({title:'Math paper',id:'d'},c,'Explain the dimensions'),/math-m001\.png/);
});
test('author metadata does not consume model context and math references remain traceable',()=>{
  const c=buildContext({...document,paragraphs:[{id:'authors',kind:'metadata',text:'Some University'},...document.paragraphs],mathAssets:[{id:'m1',token:'⟦MATH_m1⟧',url:'/assets/math.png',page:2}]},['p2']);
  assert.ok(!c.evidence.some(p=>p.id==='authors'));
  assert.deepEqual(c.math,[]);
});
