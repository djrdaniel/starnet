/* Fixed Flo envelope: schema projection and execution share one allowlist/budget. */
'use strict';
const A = require('./_assert.js');
const P = require('../sidecar/flo-capability-profile.js');
const Recovery = require('../sidecar/run-recovery.js');
const all = { tools: ['fs.read', 'shell.exec', 'web_search', 'web_fetch', 'web_request', 'team.dispatch', 'mcp:private', 'brief.ask'],
  deferred: ['fs.read', 'web_fetch'], grants: [{tool:'fs.read'},{tool:'web_fetch'}],
  approvalRules: {'fs.read':{},'web_fetch':{}}, networkCaps: {'web_fetch':true, 'mcp:private':true} };
A.eq(P.resolve(undefined), null, 'omitted profile preserves legacy runs');
for (const id of ['',null,'full','flo-research ',{},'__proto__']) A.throws(() => P.resolve(id), 'unknown profile rejects before run');
A.eq(P.restrict(all, P.resolve('flo-text')).tools, [], 'text schema has zero tools');
const narrowed=P.restrict(all,P.resolve('flo-research'));
A.eq(narrowed.tools,['web_search','web_fetch'],'research schema has only two public readers');
A.eq(narrowed.deferred,['web_fetch'],'deferred schemas cannot restore another capability');
A.eq(narrowed.grants,[{tool:'web_fetch'}],'capability grant rows are narrowed too');
A.eq(narrowed.networkCaps,{'web_fetch':true},'network metadata contains only allowed tool');
A.eq(all.tools.length,8,'projection does not mutate shared grants');
const text=P.makeGuard(P.resolve('flo-text'));
A.eq(text.start('fs.write',{path:'outside'}).ok,false,'text execution cannot fabricate a write grant');
const guard=P.makeGuard(P.resolve('flo-research'));
for(const n of ['shell.exec','fs.read','web_request','team.dispatch','mcp:private','code.run']) A.eq(guard.start(n,{}).ok,false,'dispatch refuses '+n);
for(let i=0;i<4;i++) {
 const name=i===0?'web_search':'web_fetch', args=i===0?{query:'market evidence'}:{url:'https://example.com/p'+i};
 const call=guard.start(name,args); A.eq(call.ok,true,'budget admits call '+i);
 guard.finish(call.sequence,name,args,{ok:true,summary:i===0?'1 result(s) via mojeek':'20 chars via direct',content:i===0?'1. Evidence\n https://example.com/source\n Specific public market snippet.':'Actual public page evidence'});
}
A.eq(guard.start('web_fetch',{url:'https://example.com/extra'}).ok,false,'fifth dispatch is blocked even when schema remains visible');
const receipt=guard.receipt();
A.eq(receipt.tool_calls,4,'receipt counts actual admitted dispatch attempts');
A.eq(receipt.limit_reason,'max_tool_calls','receipt retains bounded stop cause');
A.eq(receipt.tools_ok,4,'receipt retains actual returned tool outcomes');
A.eq(receipt.public_web_evidence.length,4,'receipt records tool-proven sources');
A.eq(receipt.public_web_evidence[0].status,'search_result','snippet discovery is distinguished from page read');
A.eq(receipt.public_web_evidence[1].status,'read','fetched page evidence is labelled read');
A.ok(receipt.tool_trace[0].excerpt.includes('Specific public market snippet.'),'search receipt preserves actual public snippets');
A.ok(receipt.sources[0].excerpt.includes('Specific public market snippet.'),'source excerpt preserves the result title and snippet');
A.eq(receipt.tool_trace[1].excerpt,'Actual public page evidence','fetch receipt retains actual public page text');
const empty=P.makeGuard(P.resolve('flo-research'));
for(const result of [{summary:'engines throttled — no results',content:'No results; try https://example.com/advice'},
 {summary:'0 result(s) via mojeek',content:'No results.'}]) {
 const c=empty.start('web_search',{query:'evidence unavailable'});empty.finish(c.sequence,'web_search',{},Object.assign({ok:true},result));
}
A.ok(empty.receipt().tool_trace.every(r=>r.status==='search_no_results'),'throttled and empty searches are explicitly labelled');
A.eq(empty.receipt().tools_ok,0,'empty searches do not count as successful evidence');
A.eq(empty.receipt().sources,[],'engine advice URLs are never counted as result evidence');
A.ok(empty.receipt().tool_trace.every(r=>!r.excerpt),'empty searches carry no invented public excerpt');
const bounded=P.makeGuard(P.resolve('flo-research'));const bc=bounded.start('web_fetch',{url:'https://example.com/long'});
bounded.finish(bc.sequence,'web_fetch',{}, {ok:true,summary:'10000 chars via direct',content:'x'.repeat(10000)});
A.eq(bounded.receipt().tool_trace[0].excerpt.length,8000,'tool excerpt has a fixed 8000 character bound');
A.eq(bounded.receipt().sources[0].excerpt.length,1000,'source excerpt has a fixed 1000 character bound');
const fence=require('../sidecar/tools/fence.js');
const actualPage='x'.repeat(5940)+'PUBLIC_PAGE_TAIL_CURRENCY_USD';
const actualContent=fence.fenceExternal(actualPage,'page text from https://example.com/facts');
A.ok(actualContent.indexOf('PUBLIC_PAGE_TAIL_CURRENCY_USD')>6000,'real fence/header pushes the page tail beyond the old receipt bound');
const complete=P.makeGuard(P.resolve('flo-research'));const cc=complete.start('web_fetch',{url:'https://example.com/facts'});
complete.finish(cc.sequence,'web_fetch',{}, {ok:true,summary:actualPage.length+' chars via direct',content:actualContent});
A.eq(complete.receipt().tool_trace[0].excerpt,actualContent,'receipt retains the complete bounded tool result with its source framing');
A.ok(complete.receipt().tool_trace[0].excerpt.includes('PUBLIC_PAGE_TAIL_CURRENCY_USD'),'QA receipt retains actual facts at the end of a bounded page');


const failed=P.makeGuard(P.resolve('flo-research')); const call=failed.start('web_fetch',{url:'https://example.com/private'});
failed.finish(call.sequence,'web_fetch',{}, {ok:true,summary:'site declined (403)',content:'No readable content'});
A.eq(failed.receipt().sources,[],'HTTP refusal is never recorded as read page evidence');
A.eq(failed.receipt().tool_trace[0].status,'fetch_no_content','HTTP refusal has an explicit unsuccessful content outcome');
A.eq(failed.receipt().tools_ok,0,'HTTP refusal does not count as actual public evidence');
for(const url of ['file:///etc/passwd','http://127.0.0.1/x','https://name:password@example.com/x','http://169.254.169.254/x']) A.eq(P.publicEvidenceUrl(url),null,'private or credential URL is not evidence: '+url);
for(const fn of ['continuationPlan','automaticContinuationPlan']) A.throws(()=>Recovery[fn]({meta:{capabilityProfile:'flo-research'}}),'station recovery cannot widen Flo profile');
A.report('flo-capability-profile.test');
