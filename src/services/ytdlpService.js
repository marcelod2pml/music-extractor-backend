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
        try { fs.unlinkSync(fileStats[i].path); } catch (e) {}
      }
    }
  } catch (e) {}
}

/**
 * Realiza o streaming e download do áudio convertido em MP3
 * Converte diretamente com yt-dlp -x para MP3 no disco e entrega via res.sendFile
 * Isso garante compatibilidade total com formatos DASH do YouTube e fornece cache de 0ms
 */
async function streamAudio(rawId, res) {
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
        console.error('[ytdlpService] Erro no sendFile:', err.message);
      }
    });
  };

  // 1. Se o arquivo já existe em cache e tem tamanho válido (> 10KB), entrega instantaneamente!
  if (fs.existsSync(cachedFile)) {
    try {
      const stat = fs.statSync(cachedFile);
      if (stat.size > 10240) {
        return sendCachedFile();
      } else {
        try { fs.unlinkSync(cachedFile); } catch (e) {}
      }
    } catch (e) {}
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

  // 3. Inicia extração do áudio
  pruneCacheIfNeeded();
  const { cmd } = getYtDlpCommand();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const templatePath = path.join(CACHE_DIR, `${videoId}.%(ext)s`);

  const downloadPromise = new Promise((resolve, reject) => {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', templatePath,
      url,
    ];

    const child = spawn(cmd, args, { windowsHide: true });
    let stderrData = '';

    child.stderr.on('data', (d) => {
      stderrData += d.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Falha ao iniciar yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(cachedFile)) {
        resolve(cachedFile);
      } else {
        reject(new Error(`yt-dlp finalizou com código ${code}: ${stderrData.slice(-300)}`));
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
    console.error(`[ytdlpService] Falha na extração de ${videoId}:`, err.message);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Não foi possível extrair o áudio desta música.',
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
};
