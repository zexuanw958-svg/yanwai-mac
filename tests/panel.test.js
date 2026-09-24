const test = require('node:test');
const assert = require('node:assert/strict');
const { boundsFor, RequestGate, validateText, demoResult } = require('../panel-policy');
const display = { bounds: { x: -1440, y: -900, width: 1440, height: 900 }, workArea: { x: -1440, y: -870, width: 1440, height: 850 } };
test('panels stay on the active display and right expanded avoids system bars', () => {
  for (const mode of ['collapsed','expanded']) for (const placement of ['top','right']) {
    const r = boundsFor(display,mode,placement), a = display.workArea;
    assert(r.x >= display.bounds.x && r.y >= display.bounds.y);
    assert(r.x+r.width<=display.bounds.x+display.bounds.width); assert(r.y+r.height<=a.y+a.height);
    if (mode === 'expanded' && placement === 'right') assert(r.y >= a.y);
  }
});
test('small screen never receives the desktop-width panel', () => {
  const d={bounds:{x:0,y:0,width:640,height:480},workArea:{x:0,y:24,width:640,height:432}};
  assert.equal(boundsFor(d,'expanded').width,616); assert.equal(boundsFor(d,'expanded').height,444);
});
test('real 185x32 cutout absorbs collapsed window without adding workspace height', () => {
  const d={bounds:{x:0,y:0,width:1728,height:1117},workArea:{x:0,y:38,width:1728,height:1000},notch:{offsetX:771,width:185,height:32}};
  for (const placement of ['top','right']) {
    const r=boundsFor(d,'collapsed',placement);
    assert.deepEqual(r,{x:771,y:0,width:185,height:32});
    assert(r.y+r.height <= d.workArea.y);
  }
});
test('new input invalidates prior inference', () => {
  const g=new RequestGate();const first=g.invalidate();g.invalidate();assert.equal(g.accepts(first),false);
});
test('empty or oversized content cannot reach the local model', () => {
  assert.throws(()=>validateText(' '));assert.throws(()=>validateText('x'.repeat(8001)));assert.equal(validateText(' 你好 '),'你好');
});
test('fixture results carry no fake timing or real-model attribution', () => {
  const r=demoResult('work');assert.equal(r.kind,'demo');assert.equal(r.latencyMs,null);assert.equal(r.replies.length,3);assert.throws(()=>demoResult('unknown'));
});
