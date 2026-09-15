const crypto = require('crypto');

/**
 * Status possíveis:
 * - 'queued': Na fila aguardando worker disponível
 * - 'processing': Sendo processado pelo worker
 * - 'completed': Concluído com sucesso e arquivo validado em storage
 * - 'failed': Falha em qualquer etapa técnica
 *
 * Estágios (stages):
 * - 'queued': Na fila
 * - 'extractor': yt-dlp obtendo informações e stream de áudio
 * - 'ffmpeg': Transcodificando para MP3 192K
 * - 'validation': Executando ffprobe para validar áudio gerado
 * - 'completed': Finalizado com sucesso
 */

function createJob(videoId) {
  const now = new Date().toISOString();
  return {
    id: `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    videoId: String(videoId).trim(),
    status: 'queued',
    progress: 0,
    stage: 'queued',
    filename: `${videoId}.mp3`,
    storageKey: null,
    duration: null,
    bitrate: null,
    fileSize: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  createJob,
};
