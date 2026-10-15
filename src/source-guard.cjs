function allowedSources(sources, windows) {
  const ownIds = new Set([...windows].filter(win => !win.isDestroyed()).map(win => win.getMediaSourceId()));
  return sources.filter(source => !ownIds.has(source.id));
}
function requireSource(id, sources, windows) {
  const owned = [...windows].filter(win => !win.isDestroyed()).some(win => win.getMediaSourceId() === id);
  if (owned) throw Object.assign(new Error('[SOURCE_SELF] 不能采集双播台自身窗口。请在主界面选择原始素材窗口。'), { code: 'SOURCE_SELF' });
  const source = sources.find(item => item.id === id);
  if (!source) throw Object.assign(new Error('[SOURCE_UNAVAILABLE] 原画面窗口当前不可采集，可能已关闭、最小化或重建。请恢复原窗口后重新选择画面。'), { code: 'SOURCE_UNAVAILABLE' });
  return source;
}
module.exports = { allowedSources, requireSource };
