const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Localiza o executável yt-dlp ou usa fallback
function getYtDlpCommand() {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    return { cmd: process.env.YTDLP_PATH };
  }
  const defaultWinPath = 'C:\\Users\\marce\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe';
  if (process.platform === 'win32' && fs.existsSync(defaultWinPath)) {
    return { cmd: defaultWinPath };
  }
  return { cmd: 'yt-dlp' };
}

// Sanitização de ID do YouTube (padrão de 11 caracteres alfanuméricos, hífen e underscore)
function sanitizeVideoId(id) {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  const match = trimmed.match(/^[a-zA-Z0-9_-]{11}$/);
  return match ? match[0] : null;
}

// Sanitização de Query de busca (remove caracteres perigosos de injeção)
function sanitizeSearchQuery(query) {
  if (!query || typeof query !== 'string') return '';
  return query.replace(/[\r\n\0]/g, '').trim().slice(0, 100);
}

// Converte segundos para formato legível (MM:SS ou HH:MM:SS)
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const sec = Math.floor(seconds);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}:${remM.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Busca vídeos no YouTube retornando metadados formatados
 */
async function searchVideos(rawQuery, limit = 15) {
  const query = sanitizeSearchQuery(rawQuery);
  if (!query) {
    throw new Error('Termo de busca inválido');
  }

  const { cmd } = getYtDlpCommand();
  const maxResults = Math.min(Math.max(Number(limit) || 15, 1), 30);
  const searchArg = `ytsearch${maxResults}:${query}`;

  const args = [
    '--dump-single-json',
    '--flat-playlist',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    searchArg,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    child.on('error', (err) => {
      reject(new Error(`Falha ao executar yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0 && !stdoutData.trim()) {
        return reject(new Error(`yt-dlp retornou erro (código ${code}): ${stderrData || 'Sem saída de erro'}`));
      }

      try {
        const parsed = JSON.parse(stdoutData);
        const entries = parsed.entries || [parsed];

        const results = entries
          .filter((entry) => entry && entry.id)
          .map((entry) => {
            const bestThumb = Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
              ? entry.thumbnails[entry.thumbnails.length - 1].url
              : `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;

            return {
              id: entry.id,
              title: entry.title || 'Sem título',
              duration: entry.duration || 0,
              durationFormatted: formatDuration(entry.duration),
              thumbnail: bestThumb,
              channel: entry.uploader || entry.channel || 'Desconhecido',
              url: `https://www.youtube.com/watch?v=${entry.id}`,
            };
          });

        resolve(results);
      } catch (err) {
        reject(new Error(`Erro ao processar dados da busca: ${err.message}`));
      }
    });
  });
}

/**
 * Obtém metadados detalhados de um vídeo
 */
async function getVideoInfo(rawId) {
  const videoId = sanitizeVideoId(rawId);
  if (!videoId) {
    throw new Error('ID de vídeo inválido');
  }

  const { cmd } = getYtDlpCommand();
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--skip-download',
    url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    child.on('close', (code) => {
      if (code !== 0 && !stdoutData.trim()) {
        return reject(new Error(`Erro ao obter metadados: ${stderrData}`));
      }

      try {
        const entry = JSON.parse(stdoutData);
        resolve({
          id: entry.id,
          title: entry.title || 'Sem título',
          duration: entry.duration || 0,
          durationFormatted: formatDuration(entry.duration),
          thumbnail: entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
          channel: entry.uploader || entry.channel || 'Desconhecido',
        });
      } catch (err) {
        reject(new Error(`Erro ao processar JSON do vídeo: ${err.message}`));
      }
    });
  });
}

const os = require('os');

const CACHE_DIR = path.join(os.tmpdir(), 'music_extractor_cache');
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('[ytdlpService] Aviso ao inicializar pasta de cache temporário:', e.message);
}

// Detecção dinâmica de runtimes JavaScript compatíveis com yt-dlp
function getJsRuntimeArgs() {
  const nodeBin = process.execPath || 'node';
  if (process.platform === 'win32') {
    return ['--js-runtimes', `node:${nodeBin}`];
  }
  // Ambiente Linux (Container Alpine / Render)
  if (fs.existsSync('/usr/bin/quickjs')) {
    return ['--js-runtimes', 'quickjs:/usr/bin/quickjs'];
  }
  if (fs.existsSync('/usr/bin/qjs')) {
    return ['--js-runtimes', 'quickjs:/usr/bin/qjs'];
  }
  return ['--js-runtimes', 'quickjs'];
}

// Configuração de cliente do YouTube (padrão resiliente do yt-dlp sem forçar web/tv)
function getPlayerClientArgs() {
  if (process.env.YTDLP_PLAYER_CLIENT && process.env.YTDLP_PLAYER_CLIENT.trim()) {
    return ['--extractor-args', `youtube:player_client=${process.env.YTDLP_PLAYER_CLIENT.trim()}`];
  }
  return [];
}

// Validação técnica e integridade do MP3 gerado via ffprobe
async function validateMp3File(filePath) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: 'Arquivo MP3 não foi encontrado no disco' };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { valid: false, error: 'Arquivo gerado possui 0 bytes' };
  }

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration,bit_rate',
      '-show_entries', 'stream=codec_name,bit_rate',
      '-of', 'json',
      filePath,
    ];

    const child = spawn('ffprobe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          valid: false,
          error: `ffprobe falhou com código ${code}: ${stderr.trim()}`,
        });
      }

      try {
        const parsed = JSON.parse(stdout);
        const formatName = parsed.format?.format_name || '';
        const duration = parseFloat(parsed.format?.duration || 0);
        const bitrate = parseInt(parsed.format?.bit_rate || 0, 10);
        const hasAudioStream = parsed.streams && parsed.streams.length > 0;

        const isMp3 = formatName.split(',').includes('mp3');

        if (!isMp3 && !hasAudioStream) {
          return resolve({
            valid: false,
            error: `Formato de áudio inválido retornado pelo ffprobe: ${formatName}`,
          });
        }

        if (duration <= 0) {
          return resolve({
            valid: false,
            error: 'Duração do áudio é zero ou inválida',
          });
        }

        resolve({
          valid: true,
          duration,
          bitrate,
          formatName,
          sizeBytes: stat.size,
        });
      } catch (err) {
        resolve({
          valid: false,
          error: `Falha ao processar metadados do ffprobe: ${err.message}`,
        });
      }
    });

    child.on('error', (err) => {
      resolve({
        valid: false,
        error: `Falha ao iniciar ffprobe: ${err.message}`,
      });
    });
  });
}

// Mapa para gerenciar requisições simultâneas para o mesmo vídeo
const inFlightDownloads = new Map();

function pruneCacheIfNeeded() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    if (files.length > 50) {
      const fileStats = files.map((f) => {
        const fp = path.join(CACHE_DIR, f);
        return { path: fp, time: fs.statSync(fp).mtimeMs };
      }).sort((a, b) => a.time - b.time);

      for (let i = 0; i < 15; i++) {
        try { fs.unlinkSync(fileStats[i].path); } catch (e) { }
      }
    }
  } catch (e) { }
}

/**
 * Realiza o streaming e download do áudio convertido em MP3
 * Converte diretamente com yt-dlp -x para MP3 no disco, valida com ffprobe e entrega via res.sendFile
 */
async function streamAudio(rawId, res) {
  const startTime = Date.now();
  const videoId = sanitizeVideoId(rawId);
  if (!videoId) {
    return res.status(400).json({ error: 'ID de vídeo inválido (esperado 11 caracteres alfanuméricos)' });
  }

  const cachedFile = path.join(CACHE_DIR, `${videoId}.mp3`);

  const sendCachedFile = () => {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
    res.sendFile(cachedFile, (err) => {
      if (err && !res.headersSent) {
        console.error(`[YouTube] Erro no sendFile para ${videoId}:`, err.message);
      }
    });
  };

  // 1. Se o arquivo já existe em cache e tem tamanho válido (> 10KB), entrega instantaneamente
  if (fs.existsSync(cachedFile)) {
    try {
      const stat = fs.statSync(cachedFile);
      if (stat.size > 10240) {
        console.log(`[YouTube] Arquivo em cache entregue para video ID: ${videoId} (${stat.size} bytes)`);
        return sendCachedFile();
      } else {
        try { fs.unlinkSync(cachedFile); } catch (e) { }
      }
    } catch (e) { }
  }

  // 2. Se já existe uma extração em andamento para este mesmo videoId, aguarda
  if (inFlightDownloads.has(videoId)) {
    try {
      await inFlightDownloads.get(videoId);
      if (fs.existsSync(cachedFile)) {
        return sendCachedFile();
      }
    } catch (e) {
      // Tenta nova extração se a anterior falhou
    }
  }

  // 3. Inicia extração do áudio com logs estruturados
  console.log(`[YouTube] início: ${videoId}`);
  console.log(`[YouTube] video ID: ${videoId}`);
  console.log(`[YouTube] extração iniciada: https://www.youtube.com/watch?v=${videoId}`);

  pruneCacheIfNeeded();
  const { cmd } = getYtDlpCommand();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const templatePath = path.join(CACHE_DIR, `${videoId}.%(ext)s`);

  const downloadPromise = new Promise((resolve, reject) => {
    const jsArgs = getJsRuntimeArgs();
    const clientArgs = getPlayerClientArgs();
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--force-ipv4',
      ...jsArgs,
      ...clientArgs,
      '-f', 'ba/ba*/bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', templatePath,
      url,
    ];

    const child = spawn(cmd, args, { windowsHide: true });
    let stderrData = '';
    let selectedFormat = 'ba/bestaudio';

    child.stdout.on('data', (d) => {
      const text = d.toString();
      const matchFormat = text.match(/Downloading 1 format\(s\):\s*(\S+)/i);
      if (matchFormat) {
        selectedFormat = matchFormat[1];
        console.log(`[YouTube] formato selecionado: ${selectedFormat}`);
      }
      if (text.includes('[ExtractAudio]')) {
        console.log(`[YouTube] FFmpeg iniciado: convertendo áudio extraído para MP3 192K`);
      }
    });

    child.stderr.on('data', (d) => {
      stderrData += d.toString();
    });

    child.on('error', (err) => {
      reject({ stage: 'extractor', message: `Falha ao iniciar yt-dlp: ${err.message}` });
    });

    child.on('close', async (code) => {
      if (code === 0 && fs.existsSync(cachedFile)) {
        console.log(`[YouTube] conversão concluída: gerado ${cachedFile}`);
        // Etapa 8: Validação do MP3 com ffprobe
        const validation = await validateMp3File(cachedFile);
        if (!validation.valid) {
          try { fs.unlinkSync(cachedFile); } catch (e) { }
          return reject({ stage: 'validation-output', message: validation.error });
        }
        console.log(`[YouTube] arquivo validado: duração=${validation.duration}s, bitrate=${validation.bitrate}bps`);
        console.log(`[YouTube] tempo total: ${Date.now() - startTime}ms`);
        resolve({ cachedFile, validation, format: selectedFormat });
      } else {
        const cleanErr = stderrData.trim().slice(-400) || `Código de saída ${code}`;
        reject({ stage: 'extractor', message: cleanErr });
      }
    });
  });

  inFlightDownloads.set(videoId, downloadPromise);

  try {
    await downloadPromise;
    inFlightDownloads.delete(videoId);
    return sendCachedFile();
  } catch (err) {
    inFlightDownloads.delete(videoId);
    console.error(`[YouTube] Erro na etapa '${err.stage || 'processamento'}' para ${videoId}:`, err.message);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Não foi possível extrair o áudio desta música.',
        stage: err.stage || 'extractor',
        details: err.message,
      });
    }
  }
}

/**
 * Verifica integridade das dependências do sistema
 */
async function checkHealth() {
  const { cmd } = getYtDlpCommand();

  const checkYtDlp = new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => {
      resolve({ available: code === 0, version: out.trim() });
    });
    child.on('error', () => resolve({ available: false, version: null }));
  });

  const checkFFmpeg = new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const firstLine = out.split('\n')[0] || '';
      resolve({ available: code === 0, version: firstLine.trim() });
    });
    child.on('error', () => resolve({ available: false, version: null }));
  });

  const [ytdlp, ffmpeg] = await Promise.all([checkYtDlp, checkFFmpeg]);
  return { ytdlp, ffmpeg };
}

module.exports = {
  searchVideos,
  getVideoInfo,
  streamAudio,
  checkHealth,
  validateMp3File,
  getJsRuntimeArgs,
  getPlayerClientArgs,
  sanitizeVideoId,
  getYtDlpCommand,
};
