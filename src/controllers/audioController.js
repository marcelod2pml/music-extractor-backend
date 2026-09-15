const ytdlpService = require('../services/ytdlpService');
const { jobQueue } = require('../queue/jobQueue');
const { storageService } = require('../storage/storageService');

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
      version: '2.5.0-clean-no-cookies',
      timestamp: new Date().toISOString(),
      dependencies: status,
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
}

/**
 * Endpoint de diagnóstico de download
 * GET /api/debug-download?id={videoId}
 * Retorna diagnóstico seguro com estágios de execução (validation, extractor, ffmpeg, validation-output, completed)
 */
async function debugDownload(req, res) {
  const { spawn } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { id } = req.query;

  // 1. Estágio: Validação do ID
  const cleanId = ytdlpService.sanitizeVideoId(id);
  if (!cleanId) {
    return res.status(400).json({
      success: false,
      videoId: id || null,
      stage: 'validation',
      error: 'ID de vídeo inválido. Esperado ID público do YouTube com 11 caracteres alfanuméricos.',
    });
  }

  const url = `https://www.youtube.com/watch?v=${cleanId}`;
  const tempFile = path.join(os.tmpdir(), `debug_test_${cleanId}_${Date.now()}.mp3`);
  const templatePath = path.join(os.tmpdir(), `debug_test_${cleanId}_${Date.now()}.%(ext)s`);

  const { cmd } = ytdlpService.getYtDlpCommand ? ytdlpService.getYtDlpCommand() : { cmd: 'yt-dlp' };
  const jsArgs = ytdlpService.getJsRuntimeArgs ? ytdlpService.getJsRuntimeArgs() : [];
  const clientArgs = req.query.client
    ? ['--extractor-args', `youtube:player_client=${req.query.client.trim()}`]
    : (ytdlpService.getPlayerClientArgs ? ytdlpService.getPlayerClientArgs() : []);

  const args = [
    '-v',
    '--no-playlist',
    ...jsArgs,
    ...clientArgs,
    '-f', 'ba/ba*/bestaudio/best',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '-o', templatePath,
    url,
  ];

  let ytdlpOut = '';
  let ytdlpErr = '';
  let selectedFormat = 'ba/bestaudio';
  let currentStage = 'extractor';

  const child = spawn(cmd, args, { windowsHide: true });

  child.stdout.on('data', (d) => {
    const text = d.toString();
    ytdlpOut += text;
    const matchFormat = text.match(/Downloading 1 format\(s\):\s*(\S+)/i);
    if (matchFormat) {
      selectedFormat = matchFormat[1];
      currentStage = 'format-selection';
    }
    if (text.includes('[ExtractAudio]')) {
      currentStage = 'ffmpeg';
    }
  });

  child.stderr.on('data', (d) => {
    ytdlpErr += d.toString();
  });

  const timeout = setTimeout(() => {
    try { child.kill(); } catch (e) { }
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        videoId: cleanId,
        stage: currentStage,
        format: selectedFormat,
        error: 'Tempo limite excedido na extração do vídeo (25s)',
        details: ytdlpErr.slice(-1500),
      });
    }
  }, 25000);

  child.on('close', async (code) => {
    clearTimeout(timeout);
    if (res.headersSent) return;

    if (code === 0 && fs.existsSync(tempFile)) {
      currentStage = 'validation-output';
      const validation = await ytdlpService.validateMp3File(tempFile);

      // Limpa arquivo de teste temporário do diagnóstico
      try { fs.unlinkSync(tempFile); } catch (e) { }

      if (!validation.valid) {
        return res.status(500).json({
          success: false,
          videoId: cleanId,
          stage: 'validation-output',
          format: selectedFormat,
          error: validation.error,
        });
      }

      return res.json({
        success: true,
        videoId: cleanId,
        stage: 'completed',
        format: selectedFormat,
        duration: validation.duration,
        bitrate: validation.bitrate,
        outputFormat: 'mp3',
        sizeBytes: validation.sizeBytes,
      });
    } else {
      // Remove arquivo se ficou inconsistente
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }

      const cleanMsg = ytdlpErr.trim().slice(-1500) || `Processo finalizou com código ${code}`;
      return res.status(500).json({
        success: false,
        videoId: cleanId,
        stage: currentStage,
        format: selectedFormat,
        error: 'Falha na extração de áudio pelo yt-dlp',
        details: cleanMsg,
      });
    }
  });

  child.on('error', (err) => {
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        videoId: cleanId,
        stage: currentStage,
        error: `Falha ao iniciar processo yt-dlp: ${err.message}`,
      });
    }
  });
}

/**
 * Criação de job assíncrono de download
 * POST /api/download { videoId: "..." }
 */
async function createDownloadJob(req, res) {
  try {
    const rawId = req.body?.videoId || req.body?.id || req.query?.id || req.query?.videoId;
    const cleanId = ytdlpService.sanitizeVideoId(rawId);

    if (!cleanId) {
      return res.status(400).json({
        success: false,
        error: 'ID de vídeo inválido. Esperado ID público do YouTube com 11 caracteres alfanuméricos.',
      });
    }

    const { job, isExisting } = jobQueue.enqueue(cleanId);

    return res.status(isExisting ? 200 : 202).json({
      success: true,
      jobId: job.id,
      videoId: job.videoId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      downloadUrl: job.status === 'completed' ? `/api/download/file/${job.id}` : null,
      message: isExisting ? 'Job existente retornado' : 'Job criado com sucesso na fila',
    });
  } catch (err) {
    console.error('[audioController] Erro ao criar job:', err.message);
    return res.status(500).json({ success: false, error: 'Falha ao enfileirar job de download' });
  }
}

/**
 * Consulta de status do job
 * GET /api/download/status/:jobId
 */
async function getJobStatus(req, res) {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ success: false, error: 'jobId é obrigatório' });
    }

    const job = jobQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job não encontrado' });
    }

    return res.json({
      success: true,
      jobId: job.id,
      videoId: job.videoId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      downloadUrl: job.status === 'completed' ? `/api/download/file/${job.id}` : null,
      duration: job.duration,
      bitrate: job.bitrate,
      fileSize: job.fileSize,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (err) {
    console.error('[audioController] Erro ao consultar status do job:', err.message);
    return res.status(500).json({ success: false, error: 'Falha interna ao consultar status do job' });
  }
}

/**
 * Entrega do arquivo MP3 final
 * GET /api/download/file/:jobId
 */
async function getJobFile(req, res) {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId é obrigatório' });
    }

    const job = jobQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job não encontrado' });
    }

    if (job.status !== 'completed') {
      return res.status(400).json({
        error: `O arquivo ainda não está pronto para download (status atual: ${job.status}, estágio: ${job.stage})`,
      });
    }

    const storageKey = job.storageKey || `${job.videoId}.mp3`;
    const exists = await storageService.fileExists(storageKey);

    if (!exists) {
      return res.status(404).json({ error: 'Arquivo MP3 não encontrado no storage persistente' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${job.videoId}.mp3"`);

    const stream = storageService.getFileStream(storageKey);
    stream.on('error', (streamErr) => {
      console.error('[audioController] Erro no stream do storage:', streamErr.message);
      if (!res.headersSent) res.status(500).json({ error: 'Falha ao transmitir arquivo de áudio' });
    });

    stream.pipe(res);
  } catch (err) {
    console.error('[audioController] Erro ao entregar arquivo do job:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Falha interna ao entregar arquivo do job' });
    }
  }
}

module.exports = {
  search,
  download,
  suggest,
  info,
  health,
  debugDownload,
  createDownloadJob,
  getJobStatus,
  getJobFile,
};
