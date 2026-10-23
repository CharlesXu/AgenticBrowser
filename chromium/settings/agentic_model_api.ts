// Agentic Browser model protocols. No credentials or browser permissions live here.
export interface Provider {id: string; name: string; url: string; protocol: string;}
export const providers: Provider[] = [
  {id:'openai', name:'OpenAI', url:'https://api.openai.com/v1/', protocol:'responses'},
  {id:'anthropic', name:'Anthropic', url:'https://api.anthropic.com/v1/', protocol:'anthropic'},
  {id:'google', name:'Google Gemini', url:'https://generativelanguage.googleapis.com/v1beta/', protocol:'gemini'},
  {id:'openrouter', name:'OpenRouter', url:'https://openrouter.ai/api/v1/', protocol:'openai'},
  {id:'deepseek', name:'DeepSeek', url:'https://api.deepseek.com/v1/', protocol:'openai'},
  {id:'xai', name:'xAI', url:'https://api.x.ai/v1/', protocol:'responses'},
  {id:'mistral', name:'Mistral AI', url:'https://api.mistral.ai/v1/', protocol:'openai'},
  {id:'groq', name:'Groq', url:'https://api.groq.com/openai/v1/', protocol:'openai'},
  {id:'together', name:'Together AI', url:'https://api.together.ai/v1/', protocol:'openai'},
  {id:'fireworks', name:'Fireworks AI', url:'https://api.fireworks.ai/inference/v1/', protocol:'openai'},
  {id:'cerebras', name:'Cerebras', url:'https://api.cerebras.ai/v1/', protocol:'openai'},
  {id:'qwen', name:'Alibaba Cloud · Qwen', url:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/', protocol:'openai'},
  {id:'moonshot', name:'Moonshot · Kimi', url:'https://api.moonshot.ai/v1/', protocol:'openai'},
  {id:'zai', name:'Z.ai · GLM', url:'https://api.z.ai/api/paas/v4/', protocol:'openai'},
  {id:'siliconflow', name:'SiliconFlow', url:'https://api.siliconflow.com/v1/', protocol:'openai'},
  {id:'qwen-cn', name:'Alibaba Cloud · Qwen (China)', url:'https://dashscope.aliyuncs.com/compatible-mode/v1/', protocol:'openai'},
  {id:'moonshot-cn', name:'Moonshot · Kimi (China)', url:'https://api.moonshot.cn/v1/', protocol:'openai'},
  {id:'zhipu', name:'Zhipu · GLM (China)', url:'https://open.bigmodel.cn/api/paas/v4/', protocol:'openai'},
  {id:'siliconflow-cn', name:'SiliconFlow (China)', url:'https://api.siliconflow.cn/v1/', protocol:'openai'},
  {id:'minimax', name:'MiniMax', url:'https://api.minimax.io/v1/', protocol:'openai'},
  {id:'minimax-cn', name:'MiniMax (China)', url:'https://api.minimaxi.com/v1/', protocol:'openai'},
  {id:'stepfun', name:'StepFun', url:'https://api.stepfun.com/v1/', protocol:'openai'},
  {id:'nvidia', name:'NVIDIA NIM', url:'https://integrate.api.nvidia.com/v1/', protocol:'openai'},
  {id:'doubao', name:'ByteDance · Doubao', url:'https://ark.cn-beijing.volces.com/api/v3/', protocol:'openai'},
  {id:'baidu', name:'Baidu Qianfan', url:'https://qianfan.baidubce.com/v2/', protocol:'openai'},
  {id:'tencent', name:'Tencent TokenHub', url:'https://tokenhub.tencentmaas.com/v1/', protocol:'openai'},
  {id:'xiaomi', name:'Xiaomi MiMo', url:'https://api.xiaomimimo.com/v1/', protocol:'openai'},
  {id:'modelscope', name:'ModelScope', url:'https://api-inference.modelscope.cn/v1/', protocol:'openai'},
  {id:'huggingface', name:'Hugging Face', url:'https://router.huggingface.co/v1/', protocol:'responses'},
  {id:'aihubmix', name:'AiHubMix', url:'https://aihubmix.com/v1/', protocol:'openai'},
  {id:'poe', name:'Poe', url:'https://api.poe.com/v1/', protocol:'responses'},
  {id:'typesafe', name:'TypeSafe · Jev', url:'https://api.typesafe.ai/v1/', protocol:'typesafe'},
];
export function normalizeUrl(input: string): string {
  let value=input.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value='https://'+value;
  const url=new URL(value);
  if (!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash) throw Error('invalid_url');
  if (url.pathname==='/'||!url.pathname) url.pathname='/v1/';
  else url.pathname=url.pathname.replace(/\/+$/,'')+'/';
  return url.href;
}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function modelPage(protocol: string, input: unknown): {models:string[], next:string} {
  const body=object(input);
  const items=protocol==='gemini'||protocol==='typesafe'?body['models']:body['data'];
  if (!Array.isArray(items)) throw Error('invalid_model_list');
  const models=items.map(item=>{
    const x=object(item), id=protocol==='gemini'||protocol==='typesafe'?x['name']:x['id'];
    if(typeof id!=='string'||!id||id.length>256)throw Error('invalid_model_list');
    return protocol==='gemini'?id.replace(/^models\//,''):id;
  });
  let next='';
  if (typeof body['nextPageToken']==='string'&&body['nextPageToken']) next='models?pageSize=1000&pageToken='+encodeURIComponent(body['nextPageToken']);
  else if (body['has_more']===true) {
    const last=body['last_id']||models.at(-1);
    if (typeof last!=='string'||!last) throw Error('invalid_pagination');
    next='models?limit=100&after_id='+encodeURIComponent(last);
  }
  return {models,next};
}
export function textRequest(protocol:string, model:string, prompt:string) {
  const message={role:'user',content:prompt};
  if (protocol==='responses') return {path:'responses',body:{model,input:[message],max_output_tokens:1024}};
  if (protocol==='anthropic') return {path:'messages',body:{model,messages:[message],max_tokens:1024}};
  if (protocol==='gemini') return {path:`models/${encodeURIComponent(model)}:generateContent`,body:{contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:1024}}};
  if (protocol==='openai') return {path:'chat/completions',body:{model,messages:[message],max_tokens:1024}};
  throw Error('text_model_required');
}
export function textResponse(protocol:string, input:unknown):string {
  const body=object(input);
  let value:unknown;
  if (protocol==='responses') value=array(body['output']).flatMap(x=>array(object(x)['content'])).filter(x=>object(x)['type']==='output_text').map(x=>object(x)['text']).join('');
  else if (protocol==='anthropic') value=array(body['content']).filter(x=>object(x)['type']==='text').map(x=>object(x)['text']).join('');
  else if (protocol==='gemini') value=array(object(object(array(body['candidates'])[0])['content'])['parts']).map(x=>object(x)['text']||'').join('');
  else value=object(object(array(body['choices'])[0])['message'])['content'];
  if (typeof value!=='string'||!value.trim()) throw Error('invalid_model_response');
  return value.trim();
}
export function validateChoice(input:unknown, ids:string[]):string {
  const answer=object(input),p=object(answer['probabilities']),choice=answer['choice'];
  if (typeof choice!=='string'||!ids.includes(choice)||Object.keys(p).length!==ids.length||!ids.every(id=>Object.hasOwn(p,id))) throw Error('invalid_decision');
  const numbers=[...ids.map(id=>p[id]),answer['confidence']];
  if(!numbers.every((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))throw Error('invalid_decision');
  const values=numbers.slice(0,-1);
  if(Math.abs(values.reduce((a,b)=>a+b,0)-1)>.02||Number(p[choice])<Math.max(...values)-1e-6)throw Error('invalid_decision');
  return choice;
}
