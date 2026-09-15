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
 * Endpoint de sugestões inteligentes ao digitar (Autocomplete)
 * GET /api/suggest?q={termo}
 */
async function suggest(req, res) {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);
    const response = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q.trim())}`);
    const data = await response.json();
    return res.json(data[1] || []);
  } catch (err) {
    return res.json([]);
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
/**
 * Endpoint de diagnóstico de download
 * GET /api/debug-download?id={videoId}
 */
async function debugDownload(req, res) {
  const { spawn } = require('child_process');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const url = `https://www.youtube.com/watch?v=${id}`;
  let ytdlpOutBytes = 0;
  let ytdlpErr = '';

  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio/ba/b', '-o', '-', url], { windowsHide: true });
  ytdlp.stdout.on('data', (d) => ytdlpOutBytes += d.length);
  ytdlp.stderr.on('data', (d) => ytdlpErr += d.toString());

  const timeout = setTimeout(() => {
    try { ytdlp.kill(); } catch (e) {}
    res.json({ status: 'timeout', ytdlpOutBytes, ytdlpErr: ytdlpErr.slice(-1000) });
  }, 10000);

  ytdlp.on('close', (code) => {
    clearTimeout(timeout);
    res.json({
      status: 'closed',
      code,
      ytdlpOutBytes,
      ytdlpErr: ytdlpErr.slice(-2000),
    });
  });
}

module.exports = {
  search,
  download,
  suggest,
  info,
  health,
  debugDownload,
};
