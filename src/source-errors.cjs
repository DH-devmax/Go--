function sourceFailure(error) {
  const message = String(error?.message || error || '');
  const match = message.match(/\[(SOURCE_SELF|SOURCE_UNAVAILABLE|SOURCE_CHECK_FAILED)\]\s*(.*)/s);
  if (!match) return null;
  return { code: match[1], invalidate: match[1] !== 'SOURCE_CHECK_FAILED', message: match[2].trim() };
}
module.exports = { sourceFailure };
