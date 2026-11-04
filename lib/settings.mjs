import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { isModelIdentifier, reasoningEfforts } from './config.mjs';

const defaultTranslationPresets = [
  { id:'fast',label:'快速',model:'gpt-6-luna',reasoningEffort:'low',description:'轻量模型与低推理等级，适合日常按段翻译。',contextChars:12000,contextItems:12 },
  { id:'balanced',label:'稳妥',model:'gpt-6.1-sol',reasoningEffort:'low',description:'更强模型与低推理等级，适合术语较多的论文。',contextChars:18000,contextItems:16 },
  { id:'careful',label:'深入',model:'gpt-6-astra',reasoningEffort:'medium',description:'较深入地核对复杂语义，等待时间更长。',contextChars:24000,contextItems:20 }
];
/** Only the local process configuration may override the available models.
 * HTTP settings continue to select one of the validated preset IDs. */
export function createTranslationPresets(env = process.env) {
  return defaultTranslationPresets.map(preset => {
    const suffix = preset.id.toUpperCase();
    const readOverride = (name, fallback, valid) => {
      const value = env[name]?.trim();
      if (!value) return fallback;
      if (value === 'inherit') return null;
      if (!valid(value)) throw new Error(`${name} 配置无效，请使用模型标识、有效推理等级或 inherit。`);
      return value;
    };
    return { ...preset,
      model: readOverride(`READER_MODEL_${suffix}`, preset.model, isModelIdentifier),
      reasoningEffort: readOverride(`READER_EFFORT_${suffix}`, preset.reasoningEffort, value => reasoningEfforts.includes(value)),
    };
  });
}
export const translationPresets = createTranslationPresets();
export function resolveTranslationSettings(input={}, presets=translationPresets) {
  const preset=presets.find(p=>p.id===input.translationPreset);
  if(input.translationPreset&&!preset)throw Object.assign(new Error('请选择已有的翻译档位。'),{status:400});
  const p=preset||presets[0];
  return {translationPreset:p.id,model:p.model,reasoningEffort:p.reasoningEffort,contextChars:p.contextChars,contextItems:p.contextItems};
}
export async function readCodexDefaults() {
  const home=process.env.CODEX_HOME||path.join(process.env.USERPROFILE||process.env.HOME||os.homedir(), '.codex');
  try {
    const raw=await fs.readFile(path.join(home,'config.toml'),'utf8');
    const top=raw.split(/^\s*\[/m)[0];
    const read=key=>top.match(new RegExp('^\\s*'+key+'\\s*=\\s*"([^"]+)"','m'))?.[1]||null;
    return {model:read('model'),reasoningEffort:read('model_reasoning_effort')};
  } catch { return {model:null,reasoningEffort:null}; }
}

export function mergeReparsedDocument(previous,fresh) {
  const signature=m=>JSON.stringify([m.page,m.sourceBox,m.rawText||m.textHint||'']);
  const freshMath=new Map((fresh.mathAssets||[]).map(m=>[signature(m),m.token]));
  const tokenMap=new Map((previous.mathAssets||[]).flatMap(m=>freshMath.has(signature(m))?[[m.token,freshMath.get(signature(m))]]:[]));
  const rewriteMath=text=>String(text||'').replace(/⟦MATH_[A-Za-z0-9_-]+⟧/g,t=>tokenMap.get(t)||t);
  const oldBlocks=[...previous.paragraphs,...(previous.peripheralBlocks||[])];
  const byText=new Map(oldBlocks.map(p=>[rewriteMath(p.text),p]));
  const byPageText=new Map(oldBlocks.map(p=>[`${p.page}:${rewriteMath(p.text)}`,p]));
  const byId=new Map(oldBlocks.map(p=>[p.id,p]));
  const byRaw=new Map(oldBlocks.map(p=>[p.rawText||p.text,p]));
  const aliases=new Map(),keptOld=new Set();let kept=0;
  for(const p of [...fresh.paragraphs,...(fresh.peripheralBlocks||[])]){
    const old=byPageText.get(`${p.page}:${p.text}`)||byId.get(p.id)||byText.get(p.text)||byRaw.get(p.rawText||p.text);
    if(old)aliases.set(old.id,p.id);
    if(old?.translation&&rewriteMath(old.text)===p.text&&!['metadata','equation','header','footer','publication','footnote'].includes(p.kind)){
      const sentenceIds=new Map();
      const available=[...(p.sentences||[])];
      for(const s of old.sentences||[]){const at=available.findIndex(n=>n.text===rewriteMath(s.text));if(at>=0)sentenceIds.set(s.id,available.splice(at,1)[0].id);}
      const t={...old.translation,text:rewriteMath(old.translation.text)};
      if(t.alignments?.length){
        const valid=t.alignments.every(g=>(g.sourceIds||[]).every(id=>sentenceIds.has(id)));
        t.alignments=valid?t.alignments.map(g=>({...g,sourceIds:g.sourceIds.map(id=>sentenceIds.get(id)),targetText:rewriteMath(g.targetText)})):[{sourceIds:(p.sentences||[]).map(s=>s.id),targetText:t.text}];
        if(!valid){t.status='paragraph-only';t.notes=[...(t.notes||[]),'段落分句已更新，当前使用整段联动高亮。'];}
      }
      if(old.text!==p.text)t.sourceHash=createHash('sha256').update(p.text).digest('hex');
      p.translation=t;keptOld.add(old.id);kept++;
    }
  }
  const removed=previous.paragraphs.filter(p=>p.translation&&!keptOld.has(p.id)).map(p=>({paragraphId:p.id,text:p.text,translation:p.translation,page:p.page,reason:'原文重排或公式保真更新，需要重新翻译。'}));
  fresh.archivedTranslations=[...(previous.archivedTranslations||[]),...removed];
  const remap=id=>aliases.get(id)||id;
  const replaceIds=text=>{let out=rewriteMath(text);for(const [oldId,newId] of aliases)out=out.replaceAll(oldId,newId);return out;};
  fresh.answers=(previous.answers||[]).map(a=>({...a,paragraphId:remap(a.paragraphId),selectedText:rewriteMath(a.selectedText),answer:replaceIds(a.answer),citations:(a.citations||[]).map(c=>{const id=remap(c.paragraphId);return {...c,paragraphId:id,quote:rewriteMath(c.quote),page:[...fresh.paragraphs,...(fresh.peripheralBlocks||[])].find(p=>p.id===id)?.page||c.page};})}));fresh.glossary=previous.glossary||[];fresh.importedAt=previous.importedAt;
  fresh.progress=previous.progress?{...previous.progress,paragraphId:aliases.get(previous.progress.paragraphId)||fresh.paragraphs.find(p=>p.page===previous.paragraphs.find(x=>x.id===previous.progress.paragraphId)?.page)?.id||fresh.paragraphs[0]?.id}:undefined;
  fresh.reparse={at:new Date().toISOString(),keptTranslations:kept,archivedTranslations:removed.length};
  if(previous.session)fresh.session={...previous.session,status:'unprepared',error:null};
  return fresh;
}
