const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { InputSources } = require('../input-sources');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness({ asyncClipboard = false, withScreenshots = false } = {}) {
  const output = [], statuses = [], children = [], timers = new Set(); let clipboard = '', now = 1, invalidated = 0;
  const spawnChild = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.kill = signal => { child.killed = signal; }; children.push(child); return child;
  };
  const source = new InputSources({
    spawnWatch: spawnChild, spawnPasteboard: withScreenshots ? spawnChild : null, readClipboard: () => asyncClipboard ? Promise.resolve(clipboard) : clipboard, onText: value => output.push(value), onStatus: value => statuses.push(value),
    onInvalidate: () => invalidated++, schedule: fn => { timers.add(fn); return fn; }, cancel: fn => timers.delete(fn), now: () => now,
  });
  function frame(messages, session = 'A', signature = JSON.stringify([session,messages])) {
    const rows = messages.map(([from,text]) => ({kind:'message',from,text,title:session,session,signature}));
    for (const row of rows) source.consume(row);
    source.consume({kind:'status',state:'watching',detail:'跟随中',title:session,session,signature,pid:10,windowID:1,count:rows.length});
  }
  return { source, output, statuses, children, timers, frame, clip: async value => { await settle(); clipboard = value; for (const timer of timers) timer(); await settle(); }, time: value => {now=value;}, get invalidated() {return invalidated;} };
}
test('three sources are exclusive, default off, stop closes stdin and terminates native worker; late events ignored', async () => {
  const h = harness(); assert.equal(h.source.source,'manual'); assert.equal(h.children.length,0);
  h.source.setSource('wechat'); const child=h.children[0];
  h.source.setSource('clipboard'); assert.equal(child.killed,'SIGTERM'); assert.equal(child.stdin.writableEnded,true);
  child.emit('exit'); assert.equal(h.source.source,'clipboard'); assert.equal(h.statuses.at(-1).detail.includes('复制'),true);
  await h.clip('新内容'); assert.equal(h.output.at(-1).source,'clipboard');
  h.source.setSource('wechat'); assert.equal(h.timers.size,0); assert.equal(h.children.length,2);
  h.source.setSource('manual'); assert.equal(h.children[1].killed,'SIGTERM');
  assert.throws(()=>h.source.setSource('other')); h.source.stop(); assert.equal(h.source.source,'manual');
});
test('message snapshots dedupe, keep five mixed messages, isolate titles and exclude unknown; own messages invalidate', () => {
  const h=harness();h.source.setSource('wechat');
  const messages=[['them','一'],['me','二'],['them','三'],['me','四'],['unknown','12:00'],['them','五'],['them','六']];
  h.frame(messages); assert.equal(h.output.length,1); assert.equal(h.output[0].text,'我：二\n对方：三\n我：四\n对方：五\n对方：六');
  const binding=h.source.binding();assert.equal(h.source.accepts(binding),true);
  h.frame(messages);assert.equal(h.output.length,1);
  h.frame([...messages,['me','我已经回复']]);assert.equal(h.output.at(-1).autoAnalyze,false);assert.equal(h.source.accepts(binding),false);
  h.frame([...messages,['me','我已经回复'],['them','又一条']]);assert.equal(h.output.at(-1).autoAnalyze,true);
  h.frame([['them','又一条']],'B');assert.equal(h.output.at(-1).text,'对方：又一条');assert.equal(h.output.at(-1).autoAnalyze,true);
  h.time(5001);assert.equal(h.source.accepts(h.source.binding()),false);
});
test('scrolling backwards and unknown last rows do not trigger analysis; permission/window loss revokes fill identity', () => {
  const h=harness();h.source.setSource('wechat');h.frame([['them','一'],['me','二'],['them','三']]);
  h.frame([['them','一'],['me','二']]);assert.equal(h.output.at(-1).autoAnalyze,false);
  h.frame([['them','一'],['me','二'],['unknown','看不清']]);assert.equal(h.output.at(-1).autoAnalyze,false);
  const binding=h.source.binding();h.source.consume({kind:'status',state:'no-permission',detail:'需要授权'});
  assert.equal(h.source.accepts(binding),false);assert.equal(h.output.at(-1).text,'');
  h.source.consume({kind:'status',state:'no-window',detail:'打开微信'});assert.equal(h.statuses.at(-1).state,'no-window');
});
test('JSONL split chunks cannot combine sessions and broken frames never analyze', () => {
  const h=harness();h.source.setSource('wechat');const stream=h.children[0].stdout;
  stream.write('{"kind":"status","state":"no-');stream.write('window","detail":"打开微信"}\n');
  assert.equal(h.statuses.at(-1).state,'no-window');
  h.source.consume({kind:'status',state:'watching',session:'A',signature:'bad',title:'A',pid:10,windowID:1,count:2});
  assert.equal(h.output.length,0);assert.equal(h.source.frame,null);
  h.source.stop();stream.write('{"kind":"status","state":"watching"}\n');assert.equal(h.source.source,'manual');
});

test('clipboard following works with Electron 44 async readText and ignores unchanged text', async () => {
  const h = harness({ asyncClipboard: true });
  h.source.setSource('clipboard');
  await h.clip('');
  assert.equal(h.output.length, 0);
  await h.clip('对方：周末吃什么？');
  assert.equal(h.output.length, 1);
  assert.equal(h.output[0].text, '对方：周末吃什么？');
  await h.clip('对方：周末吃什么？');
  assert.equal(h.output.length, 1);
  h.source.setSource('manual');
  await h.clip('切走之后的内容');
  assert.equal(h.output.length, 1);
});

test('a blocked WeChat capture is reported to the panel as its own state', () => {
  const h = harness(); h.source.setSource('wechat');
  h.source.consume({ kind: 'status', state: 'blocked', detail: '微信开启了防截屏' });
  assert.equal(h.statuses.at(-1).state, 'blocked');
  assert.match(h.statuses.at(-1).detail, /防截屏/);
});

test('copy-or-screenshot: WeChat screenshots are OCR-ed into context, empty text from an image is ignored, stop kills helper', async () => {
  const h=harness({withScreenshots:true});h.source.setSource('clipboard');
  const helper=h.children[0];assert.ok(helper);assert.equal(h.statuses.at(-1).detail.includes('截图'),true);
  await h.clip('');assert.equal(h.output.length,0);
  helper.stdout.write(JSON.stringify({kind:'status',state:'reading',detail:'正在识别截图里的文字…'})+'\n');
  assert.equal(h.statuses.at(-1).state,'reading');
  helper.stdout.write(JSON.stringify({kind:'screenshot',messages:[{from:'unknown',text:'21:40'},{from:'them',text:'忙吗'},{from:'me',text:'还好'},{from:'them',text:'周末吃饭？'},{from:'bogus',text:'x'}]})+'\n');
  const event=h.output.at(-1);
  assert.equal(event.source,'clipboard');assert.equal(event.via,'screenshot');assert.equal(event.autoAnalyze,true);
  assert.equal(event.text,'对方：忙吗\n我：还好\n对方：周末吃饭？');assert.equal(event.revision,h.source.revision);
  helper.stdout.write(JSON.stringify({kind:'screenshot',messages:[{from:'unknown',text:'only time'}]})+'\n');
  assert.equal(h.output.length,1);
  await h.clip('复制的文字');assert.equal(h.output.at(-1).text,'复制的文字');assert.equal(h.output.at(-1).via,undefined);
  h.source.setSource('manual');assert.equal(helper.killed,'SIGTERM');
  helper.stdout.write(JSON.stringify({kind:'screenshot',messages:[{from:'them',text:'迟到'}]})+'\n');
  assert.equal(h.output.at(-1).text,'复制的文字');
});
