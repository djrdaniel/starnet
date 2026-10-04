'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {makeFloNativeCommerce,ENDPOINT,MAX_BYTES}=require('../sidecar/flo-native-commerce');
const record={object:'flo.native.commerce_context',read_only:true,schema_version:1,source:{kind:'saved_local_flo_state',live_store_request:false},stores:{etsy:{verified:true,scope:'read only'}},products:[]};
test('Commerce reads only the fixed Flo endpoint with host authentication and no redirect',async()=>{
  const calls=[];
  const reader=makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(record));}});
  const read=await reader.read();assert.equal(read.ok,true);assert.deepEqual(JSON.parse(read.content),record);
  assert.equal(calls.length,1);assert.equal(calls[0].url,ENDPOINT);assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'error');assert.match(calls[0].options.headers.Authorization,/^Bearer /);
  assert.equal(read.content.includes('synthetic-test-bearer'),false);
});
test('Unverified, malformed, oversized and failed replies report unavailable without exposing their bytes or credentials',async()=>{
  for(const response of [new Response('private-response-bytes',{status:403}),new Response('private-response-bytes'),new Response(JSON.stringify({...record,read_only:false})),new Response('x'.repeat(MAX_BYTES+1))]){
    const read=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',fetch:async()=>response}).read();
    assert.equal(read.ok,false);assert.equal(read.content.includes('private-response-bytes'),false);assert.equal(read.content.includes('synthetic-test-bearer'),false);
  }
});
test('No credential means no request; thrown local transport errors remain unavailable and never imply store authority',async()=>{
  let calls=0;
  assert.equal((await makeFloNativeCommerce({key:()=>'',fetch:async()=>{calls++;}}).read()).ok,false);assert.equal(calls,0);
  const read=await makeFloNativeCommerce({key:()=> 'synthetic-test-bearer-not-live',fetch:async()=>{throw Error('secret-transport-detail');}}).read();
  assert.equal(read.ok,false);assert.equal(read.content.includes('secret-transport-detail'),false);
});
