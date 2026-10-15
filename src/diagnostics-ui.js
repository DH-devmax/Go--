const NAMES = { app: '应用', capture: '画面采集', crop: '裁切', audio: '音频', stream: '推流', record: '录制', meeting: '百佳会共享', camera: '虚拟摄像头', viewer: '观众端', settings: '设置', logs: '日志', update: '在线更新' };
const LEVELS = { error: '错误', warn: '警告', info: '信息' };
function mountDiagnostics({ bridge, confirm, icons }) {
  const $ = id => document.getElementById(id);
  let report = { entries: [] };
  let page = 0;
  let request = 0;
  let refreshTimer;
  const expanded = new Set();
  const pageSize = 50;
  function render() {
    const query = $('log-search').value.trim().toLowerCase();
    const level = $('log-level').value;
    const module = $('log-module').value;
    const entries = [...report.entries].reverse().filter(entry =>
      (!level || level === entry.level) && (!module || module === entry.module) &&
      (!query || JSON.stringify(entry).toLowerCase().includes(query) || NAMES[entry.module]?.includes(query)));
    page = Math.min(page, Math.max(0, Math.ceil(entries.length / pageSize) - 1));
    const body = $('log-entries');
    body.replaceChildren();
    for (const entry of entries.slice(page * pageSize, (page + 1) * pageSize)) {
      const row = document.createElement('tr');
      for (const value of [new Date(entry.time).toLocaleString(), LEVELS[entry.level], NAMES[entry.module]]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      row.dataset.level = entry.level;
      const content = document.createElement('td');
      const title = document.createElement('div'); title.textContent = entry.message || entry.action;
      if (entry.count > 1) title.append(` ×${entry.count}`);
      const details = document.createElement('details');
      details.open = expanded.has(entry.id);
      details.ontoggle = () => details.open ? expanded.add(entry.id) : expanded.delete(entry.id);
      const summary = document.createElement('summary'); summary.textContent = '详情';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify({ action: entry.action, origin: entry.origin, sessionId: entry.sessionId, lastTime: entry.lastTime, ...entry.details }, null, 2);
      details.append(summary, pre); content.append(title, details); row.append(content); body.append(row);
    }
    $('log-empty').hidden = entries.length !== 0;
    $('log-page').textContent = `${entries.length} 条 · 第 ${page + 1} / ${Math.max(1, Math.ceil(entries.length / pageSize))} 页`;
    $('log-prev').disabled = page === 0;
    $('log-next').disabled = (page + 1) * pageSize >= entries.length;
    const errors = report.entries.filter(entry => entry.level === 'error').reduce((sum, entry) => sum + (entry.count || 1), 0);
    $('log-tab-status').textContent = errors ? `${errors} 个错误` : '暂无错误';
    $('log-storage').textContent = report.storageError || '本机保存 · 最近 1000 条 · 导出已脱敏';
    $('log-storage').classList.toggle('log-failure', !!report.storageError);
    $('log-environment').textContent = report.metadata
      ? `${report.metadata.appVersion || ''} · ${report.metadata.platform || ''} ${report.metadata.arch || ''} · Electron ${report.metadata.electron || ''}` : '';
  }
  async function refresh() {
    if (!bridge.logsSnapshot) { $('log-storage').textContent = '请在桌面应用中查看日志。'; return; }
    const generation = ++request;
    try {
      const result = await bridge.logsSnapshot();
      if (generation !== request) return;
      report = result; render();
    } catch { $('log-storage').textContent = '无法读取日志，请重试。'; }
  }
  for (const [id, name] of Object.entries(NAMES)) $('log-module').add(new Option(name, id));
  for (const id of ['log-search', 'log-level', 'log-module']) $(id).addEventListener(id === 'log-search' ? 'input' : 'change', () => { page = 0; render(); });
  $('log-prev').onclick = () => { page--; render(); };
  $('log-next').onclick = () => { page++; render(); };
  $('log-refresh').onclick = refresh;
  for (const [id, operation, message] of [
    ['log-copy', 'logsCopy', '诊断报告已复制。'],
    ['log-export', 'logsExport', '诊断报告已导出。'],
    ['log-export-text', 'logsExportText', '错误日志.txt 已导出。'],
  ]) $(id).onclick = async () => {
    $(id).disabled = true;
    try {
      if (!bridge[operation]) throw new Error();
      const result = await bridge[operation]();
      $('log-feedback').textContent = result?.canceled ? '已取消导出。' : message;
    } catch { $('log-feedback').textContent = '操作失败，请检查权限后重试。'; }
    finally { $(id).disabled = false; refresh(); }
  };
  $('log-clear').onclick = async () => {
    if (!await confirm('清空错误日志', '将删除本机保留的日志，已导出的文件不受影响。确认清空？')) return;
    try { await bridge.logsClear(); page = 0; $('log-feedback').textContent = '日志已清空。'; }
    catch { $('log-feedback').textContent = '清空失败，请检查文件权限。'; }
    refresh();
  };
  bridge.onLogsChanged?.(() => {
    if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 250);
  });
  render(); icons(); refresh();
  return { refresh };
}
module.exports = { mountDiagnostics };
