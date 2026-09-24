'use strict';
// All inputs are synthetic; --dry-run reads app/role metadata, never values or drafts.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const checks = [];
function run(name, args, verify) {
  const result = spawnSync(path.join(root, 'native', name), args, { encoding:'utf8', timeout:45000 });
  let rows = [];
  try { rows = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  const ok = result.status === 0 && verify(rows);
  checks.push({ command:[name,...args], ok, exit:result.status, rows, error:result.error?.message || result.stderr.trim() });
}
run('watch-chat',['--self-test-layout'],rows=>rows.at(-1)?.ok === true);
run('watch-chat',['--self-test',path.join(root,'tests/fixtures/chat-bubbles.png')],rows=> {
  const messages = rows.filter(r=>r.kind==='message');
  return messages.some(r=>r.from==='them' && r.text.includes('周末吃什么')) &&
    messages.some(r=>r.from==='me' && r.text.includes('这次我来安排')) &&
    messages.some(r=>r.from==='them' && r.text.includes('等你消息')) &&
    messages.some(r=>r.from==='unknown' && r.text.includes('12:00')) &&
    messages.every(r=>!r.text.includes('干扰项') && !r.text.includes('输入区')) &&
    rows.at(-1)?.title === '合成测试聊天';
});
for (const name of ['screenshot-crop.png','screenshot-crop-dark.png']) run('watch-chat',['--self-test-crop',path.join(root,'tests/fixtures',name)],rows=> {
  const m = rows[0]?.messages || [];
  return m.length === 4 && m[0].from === 'unknown' && m[1].from === 'them' && m[1].text.includes('很忙') &&
    m[2].from === 'me' && m[2].text.includes('项目收尾') && m[2].text.includes('\n') && m[3].from === 'them' && m[3].text.includes('吃饭');
});
run('fill-text',['--self-test'],rows=>rows.at(-1)?.ok === true);
run('fill-text',['--dry-run','合成候选文本，不写入'],rows=>rows.at(-1)?.dryRun === true);
console.log(JSON.stringify({ok:checks.every(c=>c.ok),checks},null,2));
process.exitCode = checks.every(c=>c.ok) ? 0 : 1;
