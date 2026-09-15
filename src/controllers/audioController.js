const ytdlpService = require('../services/ytdlpService');

/**
 * Endpoint de busca de músicas / vídeos
 * GET /api/search?q={termo}&limit=15
 */
async function search(req, res) {
  try {
    const { q, limit } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'Parâmetro de busca "q" é obrigatório' });
    }

    const results = await ytdlpService.searchVideos(q, limit ? parseInt(limit, 10) : 15);
    return res.json({
      query: q,
      total: results.length,
      results,
    });
  } catch (err) {
    console.error('[audioController] Erro na busca:', err.message);
    return res.status(500).json({ error: err.message || 'Falha interna ao realizar busca' });
  }
}

/**
 * Endpoint de download e streaming de áudio
 * GET /api/download?id={videoId}
 */
async function download(req, res) {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Parâmetro "id" é obrigatório' });
    }

    return ytdlpService.streamAudio(id, res);
  } catch (err) {
    console.error('[audioController] Erro no download:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Falha ao iniciar streaming do áudio' });
    }
  }
}

/**
 * Endpoint de metadados detalhados
 * GET /api/info?id={videoId}
 */
async function info(req, res) {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: 'Parâmetro "id" é obrigatório' });
    }

    const videoInfo = await ytdlpService.getVideoInfo(id);
    return res.json(videoInfo);
  } catch (err) {
    console.error('[audioController] Erro ao obter info:', err.message);
    return res.status(500).json({ error: err.message || 'Falha ao carregar metadados' });
  }
}

/**
 * Endpoint de status do sistema
 * GET /health
 */
async function health(req, res) {
  try {
    const status = await ytdlpService.checkHealth();
    const isHealthy = status.ytdlp.available && status.ffmpeg.available;

    return res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: status,
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
}

module.exports = {
  search,
  download,
  info,
  health,
};
