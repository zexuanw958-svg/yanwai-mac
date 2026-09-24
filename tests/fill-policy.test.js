const test=require('node:test');const assert=require('node:assert/strict');const {fillReply}=require('../fill-policy');
test('fill success, permission/nonwritable/error clipboard fallback and stale-session refusal',async()=>{
  for(const [native,copied,message] of [
    [{filled:true},false,'已填入'],[{filled:false,reason:'not-writable'},true,'已复制，请手动粘贴'],
    [{filled:false,reason:'no-permission',permission:'accessibility'},true,'辅助功能'],
    [{filled:false,reason:'stale-session'},false,'对话或目标窗口已变化'],
    [{filled:false,reason:'verify-failed'},true,'避免重复'],[null,true,'已复制，请手动粘贴']]){
    let copy='';const result=await fillReply({text:'候选',binding:{},accepts:()=>true,
      write:async()=>{if(!native)throw Error('missing tool');return native;},copy:async text=>{copy=text;}});
    assert.equal(Boolean(copy),copied);assert.equal(result.message.includes(message),true);
  }
});
test('binding is checked both before native dispatch and before clipboard fallback',async()=>{
  let writes=0,copies=0,current=false;
  const options={text:'旧建议',binding:{},accepts:()=>current,write:async()=>{writes++;current=false;return {filled:false};},copy:async()=>copies++};
  await fillReply(options);assert.equal(writes,0);assert.equal(copies,0);
  current=true;await fillReply(options);assert.equal(writes,1);assert.equal(copies,0);
});
