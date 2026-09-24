'use strict';
async function fillReply({ text, binding, accepts, write, copy }) {
  if (!accepts(binding)) return { filled: false, copied: false, message: '对话或目标窗口已变化，请重新分析后再填入。' };
  let result;
  try { result = await write(); } catch { result = { filled: false, reason: 'unavailable' }; }
  if (result.filled) return { filled: true, copied: false, message: '已填入，发送由你决定。' };
  if (['stale-session', 'stale-target'].includes(result.reason) || !accepts(binding)) {
    return { filled: false, copied: false, message: '对话或目标窗口已变化，请重新分析后再填入。' };
  }
  await copy(text);
  const permission = result.permission === 'accessibility' ? 'accessibility' : null;
  return { filled: false, copied: true, permission,
    message: permission ? '已复制，请手动粘贴。直接填入需要辅助功能权限。' :
      result.reason === 'verify-failed' ? '填入结果未能确认。已复制，请检查草稿后手动粘贴，避免重复。' : '已复制，请手动粘贴。' };
}
module.exports = { fillReply };
