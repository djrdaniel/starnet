/* Deterministic child-only provider/public-web adapter for an isolated station test. */
'use strict';
const fs=require('node:fs'),path=require('node:path'), original=globalThis.fetch;
const counts=new Map(),ws=process.env.STARNET_WORKSPACES;
require('node:dns').promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
require('undici').fetch=async(url,init)=>{
 fs.appendFileSync(path.join(ws,'test-web.jsonl'),JSON.stringify({url:String(url),method:(init||{}).method||'GET',headers:Object.keys((init||{}).headers||{})})+'\n');
 const html=String(url).includes('/tail-evidence') ? '<p>'+('x'.repeat(5940))+'PUBLIC_PAGE_TAIL_CURRENCY_USD</p>' : String(url).includes('mojeek.com') ? '<a class="title" href="https://example.com/market">Fixture product market title</a><p class="s">Fixture public search snippet about demand.</p>' : String(url).includes('duckduckgo.com') ? '<a class="result__a" href="https://example.com/market">Fixture product market title</a><div class="result__snippet">Fixture public search snippet about demand.</div>' : '<p>Fixture public evidence about a product market.</p>';
 return {status:200,headers:{get:k=>k==='content-type'?'text/html':''},text:async()=>html};
};
globalThis.fetch=async(url,init)=>{
 if(String(url).startsWith('https://chatgpt.com/backend-api/codex/')) {
  if(String(url).includes('/models'))return new Response(JSON.stringify({models:[]}));
  const body=JSON.parse(init.body), all=JSON.stringify(body), mode=all.includes('PROFILE_LIMIT')?'limit':all.includes('PROFILE_DENY')?'deny':all.includes('PROFILE_TAIL')?'tail':all.includes('PROFILE_SEARCH')?'search':all.includes('PROFILE_RESEARCH')?'research':'text';
  const n=counts.get(mode)||0;counts.set(mode,n+1);
  fs.appendFileSync(path.join(ws,'test-model.jsonl'),JSON.stringify({mode,tools:(body.tools||[]).map(t=>t.name),privateLeak:all.includes('PRIVATE_STATION_SENTINEL')})+'\n');
  const events=[], call=(name,args,i)=>{
   events.push({type:'response.output_item.added',output_index:i,item:{type:'function_call',call_id:'call_'+mode+'_'+n+'_'+i,name}});
   events.push({type:'response.function_call_arguments.delta',output_index:i,delta:JSON.stringify(args)});
   events.push({type:'response.output_item.done',output_index:i,item:{type:'function_call',call_id:'call_'+mode+'_'+n+'_'+i}});
  };
  if(n===0 && mode==='tail')call('web_fetch',{url:'https://example.com/tail-evidence'},0);
   else if(n===0 && mode==='search')call('web_search',{query:'public market evidence'},0);
   else if(n===0 && mode==='research')call('web_fetch',{url:'https://example.com/evidence'},0);
  else if(n===0 && mode==='deny')call('fs_write',{path:'MUST_NOT_WRITE.txt',content:'forbidden'},0);
  else if(n===0 && mode==='limit')for(let i=0;i<5;i++)call('web_fetch',{url:'https://example.com/evidence'+i},i);
  else events.push({type:'response.output_text.delta',output_index:0,delta:mode==='text'?'Supplied text result.':'Public evidence result: https://example.com/evidence'});
  events.push({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:5}}});
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }
 return original(url,init);
};
