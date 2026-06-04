export function errorHandler(err, req, res, next) {
  console.error('[erro]', err.stack || err.message);
  res.status(err.status || 500).json({ error: err.message || 'erro interno' });
}

export function notFound(req, res) {
  res.status(404).json({ error: 'rota não encontrada' });
}
