const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { jobQueue } = require('../queue/jobQueue');
const { storageService } = require('../storage/storageService');
const ytdlpService = require('../services/ytdlpService');

class DownloadWorker {
  constructor(queue = jobQueue, storage = storageService) {
    this.queue = queue;
    this.storage = storage;
    this.isRunning = false;
    this.boundProcessHandler = this.handleJobProcess.bind(this);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.queue.on('job:process', this.boundProcessHandler);
    console.log('[Worker] Worker de download inicializado e pronto para processar jobs.');
    // Aciona processamento caso já existam jobs pendentes
    this.queue.processNext();
  }

  stop() {
    this.isRunning = false;
    this.queue.off('job:process', this.boundProcessHandler);
    console.log('[Worker] Worker de download pausado.');
  }

  async handleJobProcess(job) {
    try {
      await this.processJob(job);
    } catch (err) {
      console.error(`[Worker] Erro não capturado ao processar job ${job.id}:`, err);
    } finally {
      this.queue.workerFinished(job.id);
    }
  }

  /**
   * Executa todo o pipeline isolado de extração, conversão e validação
   */
  async processJob(job) {
    const videoId = job.videoId;
    console.log(`[Worker] Iniciando processamento do Job ${job.id} (videoId: ${videoId})`);

    this.queue.updateJob(job.id, {
      status: 'processing',
      stage: 'extractor',
      progress: 10,
    });

    // 1. Verifica se o arquivo já existe no storage de longo prazo
    const storageKey = `${videoId}.mp3`;
    if (await this.storage.fileExists(storageKey)) {
      console.log(`[Worker] Arquivo já existente no storage para ${videoId}`);
      const stats = await this.storage.getFileStats(storageKey);
      this.queue.updateJob(job.id, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        storageKey,
        fileSize: stats ? stats.size : null,
      });
      return;
    }

    // 2. Diretório e arquivos de trabalho temporário
    const tempDir = path.join(os.tmpdir(), 'worker_scratch');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempOutputFile = path.join(tempDir, `${job.id}_${videoId}.mp3`);
    const templatePath = path.join(tempDir, `${job.id}_${videoId}.%(ext)s`);

    const { cmd } = ytdlpService.getYtDlpCommand ? ytdlpService.getYtDlpCommand() : { cmd: 'yt-dlp' };
    const jsArgs = ytdlpService.getJsRuntimeArgs ? ytdlpService.getJsRuntimeArgs() : [];
    const clientArgs = ytdlpService.getPlayerClientArgs ? ytdlpService.getPlayerClientArgs() : [];

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--no-warnings',
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

    try {
      // 3. Execução do yt-dlp + FFmpeg
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let stderrData = '';

        child.stdout.on('data', (d) => {
          const text = d.toString();
          if (text.includes('[download]')) {
            this.queue.updateJob(job.id, { stage: 'extractor', progress: 30 });
          }
          if (text.includes('[ExtractAudio]')) {
            this.queue.updateJob(job.id, { stage: 'ffmpeg', progress: 65 });
          }
        });

        child.stderr.on('data', (d) => {
          stderrData += d.toString();
        });

        child.on('error', (err) => {
          reject({ stage: 'extractor', message: `Falha ao iniciar processo yt-dlp: ${err.message}` });
        });

        child.on('close', (code) => {
          if (code === 0 && fs.existsSync(tempOutputFile)) {
            resolve();
          } else {
            const cleanErr = stderrData.trim().slice(-500) || `Processo finalizou com código ${code}`;
            reject({ stage: 'extractor', message: cleanErr });
          }
        });
      });

      // 4. Validação técnica do MP3 com ffprobe
      this.queue.updateJob(job.id, { stage: 'validation', progress: 85 });
      const validation = await ytdlpService.validateMp3File(tempOutputFile);

      if (!validation.valid) {
        try { fs.unlinkSync(tempOutputFile); } catch (e) { }
        throw { stage: 'validation', message: validation.error };
      }

      // 5. Transferência segura para o Storage de Longo Prazo
      const saved = await this.storage.saveFile(storageKey, tempOutputFile);

      // Limpeza do arquivo scratch temporário
      try { fs.unlinkSync(tempOutputFile); } catch (e) { }

      // 6. Conclusão do Job com sucesso
      this.queue.updateJob(job.id, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        storageKey: saved.storageKey,
        duration: validation.duration,
        bitrate: validation.bitrate,
        fileSize: saved.sizeBytes,
        error: null,
      });

      console.log(`[Worker] Job ${job.id} concluído com sucesso: ${saved.storageKey} (${saved.sizeBytes} bytes)`);
    } catch (err) {
      // Limpa temporários em caso de erro
      try { if (fs.existsSync(tempOutputFile)) fs.unlinkSync(tempOutputFile); } catch (e) { }

      const errMsg = err.message || 'Falha desconhecida no processamento do áudio';
      const failedStage = err.stage || 'extractor';

      this.queue.updateJob(job.id, {
        status: 'failed',
        stage: failedStage,
        error: errMsg,
      });

      console.error(`[Worker] Job ${job.id} falhou no estágio '${failedStage}': ${errMsg}`);
    }
  }
}

// Instância singleton do worker
const downloadWorker = new DownloadWorker();

module.exports = {
  downloadWorker,
  DownloadWorker,
};
