/* Public-only URL credentials and redirect checks supplement the shared SSRF guard. */
'use strict';
const A=require('./_assert'),{makeWebTools}=require('../sidecar/tools/builtin/web');
(async()=>{
 let calls=[];
 const make=redirect=>makeWebTools({publicOnly:true,lookup:null,fetchImpl:async(url,opts)=>{calls.push({url,opts});return {status:redirect?302:200,headers:{get:k=>k==='location'?redirect:k==='content-type'?'text/plain':''},text:async()=> 'public evidence'};}});
 async function rejects(p,label){try{await p;A.ok(false,label);}catch(_){A.ok(true,label);}}
 await rejects(make().webFetch('https://user:password@example.com/x'),'URL credentials rejected before request');A.eq(calls.length,0,'credential request never leaves host');
 for(const target of ['http://127.0.0.1/x','http://169.254.169.254/x','https://user:password@example.com/x']){calls=[];await rejects(make(target).webFetch('https://example.com/x'),'unsafe redirect refused: '+target);A.eq(calls.length,1,'unsafe redirect is never sent');}
 const got=await make().webFetch('https://example.com/evidence');A.eq(got.source,'direct','public-only reader uses direct public GET');
 const description=make().fetchTool.description;
 A.ok(description.includes('direct, keyless HTTP(S) GET'),'public-only tool description states its actual read mechanism');
 A.ok(description.includes('may be unavailable'),'public-only tool description admits blocked or JavaScript-only pages');
 A.ok(!/browser|automatically retried/.test(description),'public-only tool description never promises reader fallback');
 A.ok(makeWebTools({lookup:null,fetchImpl:async()=>{}}).fetchTool.description.includes('own browser'),'legacy tool description remains unchanged');
 // The real Node 20 socket asks all:true. A scalar-only callback makes every
 // direct page fail with ERR_INVALID_IP_ADDRESS before any HTTP response exists.
 for(const address of [{address:'93.184.216.34',family:4},{address:'2606:4700:4700::1111',family:6}]) {
  const pinned=makeWebTools({publicOnly:true,lookup:async()=>[address],agentFactory:options=>({connect:options.connect,close:async()=>{}}),
   fetchImpl:async(url,opts)=>{
    const lookup=opts.dispatcher.connect.lookup;
    lookup('example.com',{all:true},(error,addresses,family)=>{
     A.eq(error,null,'all-address lookup succeeds with vetted public address');
     A.eq(addresses,[address],'all-address callback returns exactly one vetted public address');
     A.eq(family,undefined,'all-address callback does not use scalar family slot');
    });
    lookup('example.com',{all:false},(error,ip,family)=>{
     A.eq(error,null,'scalar lookup succeeds with vetted public address');
     A.eq(ip,address.address,'scalar callback returns the same pinned IP');
     A.eq(family,address.family,'scalar callback retains address family');
    });
    return {status:200,headers:{get:()=> 'text/plain'},text:async()=> 'actual public evidence'};
   }});
  A.eq((await pinned.webFetch('https://example.com/evidence')).source,'direct','both DNS callback forms retain direct public fetching');
 }
 A.report('web.public-only.test');
})().catch(e=>{console.error(e);process.exitCode=1;});
