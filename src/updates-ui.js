function mountUpdates({ bridge, icons, confirm }) {
  const $ = id => document.getElementById(id);
  if (!bridge.updateStatus) { $('open-updates').hidden = true; return; }
  let state;
  let pending = false;
  let dirty = false;
  const dialog = $('updates-dialog');
  function render(next) {
    state = next;
    $('update-current').textContent = `当前版本 ${next.currentVersion}`;
    $('update-message').textContent = next.message;
    $('update-target').textContent = next.version ? `新版本 ${next.version}` : '';
    $('update-notes').textContent = next.notes || '';
    $('update-notes').hidden = !next.notes;
    $('update-progress').hidden = next.state !== 'downloading';
    $('update-progress').value = next.progress;
    $('update-percent').textContent = next.state === 'downloading' ? `${next.progress.toFixed(1)}%` : '';
    const busy = pending || ['checking', 'downloading', 'installing'].includes(next.state);
    $('update-repository').disabled = busy;
    $('update-auto').disabled = busy;
    $('update-save').disabled = busy;
    $('update-check').disabled = busy || !next.supported || !next.repository || next.state === 'downloaded';
    $('update-download').hidden = next.state !== 'available';
    $('update-download').disabled = busy;
    $('update-install').hidden = !['downloaded', 'installing'].includes(next.state);
    $('update-install').disabled = busy;
    const available = ['available', 'downloaded'].includes(next.state);
    $('open-updates').classList.toggle('has-update', available);
    $('open-updates').title = available ? `有新版本 ${next.version}` : '检查应用更新';
    $('open-updates').setAttribute('aria-label', $('open-updates').title);
    if (!dirty) {
      $('update-repository').value = next.repository;
      $('update-auto').checked = next.autoCheck;
    }
  }
  async function action(fn) {
    pending = true; if (state) render(state);
    $('update-feedback').textContent = '';
    try { render(await fn()); }
    catch (error) { $('update-feedback').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
    finally { pending = false; if (state) render(state); }
  }
  $('open-updates').onclick = async () => {
    dirty = false;
    dialog.showModal();
    await action(() => bridge.updateStatus());
  };
  $('close-updates').onclick = () => dialog.close();
  for (const id of ['update-repository', 'update-auto']) $(id).addEventListener('input', () => { dirty = true; });
  $('update-save').onclick = () => action(async () => {
    const repository = $('update-repository').value.trim();
    if (repository !== state.repository && !await confirm('更改更新来源', `之后将从 ${repository || '未配置仓库'} 下载应用安装包。请确认这是发布者的仓库。`)) return state;
    const result = await bridge.updateConfigure({ repository, autoCheck: $('update-auto').checked });
    dirty = false;
    return result;
  });
  $('update-check').onclick = () => action(() => bridge.updateCheck());
  $('update-download').onclick = () => action(() => bridge.updateDownload());
  $('update-install').onclick = () => action(() => bridge.updateInstall());
  bridge.onUpdateState(render);
  bridge.updateStatus().then(render).catch(() => { $('update-feedback').textContent = '无法读取更新状态，请重试。'; });
  icons();
}
module.exports = { mountUpdates };
