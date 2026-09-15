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

/**
 * Realiza o streaming direto do áudio convertido em MP3 para a resposta HTTP
 * Utiliza yt-dlp (-q para dados puros) e FFmpeg (-vn para áudio puro) gerando MP3 contínuo
 */
function streamAudio(rawId, res) {
  const videoId = sanitizeVideoId(rawId);
  if (!videoId) {
    return res.status(400).json({ error: 'ID de vídeo inválido (esperado 11 caracteres alfanuméricos)' });
  }

  const { cmd } = getYtDlpCommand();
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Headers adequados para streaming e download de áudio
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Accept-Ranges', 'bytes');

  // 1. Processo yt-dlp: -q silencia logs de texto para não corromper o pipe binário
  const ytdlpArgs = [
    '-q',
    '--no-warnings',
    '-f', 'bestaudio/ba/b',
    '-o', '-',
    url,
  ];
  const ytdlpProcess = spawn(cmd, ytdlpArgs, { windowsHide: true });

  // 2. Processo ffmpeg: -vn ignora qualquer faixa de vídeo e codifica áudio MP3 192k contínuo
  const ffmpegArgs = [
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', '192k',
    '-f', 'mp3',
    'pipe:1',
  ];
  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { windowsHide: true });

  // Pipe: yt-dlp -> ffmpeg -> res
  ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
  ffmpegProcess.stdout.pipe(res);

  let stderrLogged = '';
  ytdlpProcess.stderr.on('data', (data) => {
    stderrLogged += data.toString();
  });

  const cleanup = () => {
    if (!ytdlpProcess.killed) {
      try { ytdlpProcess.kill('SIGTERM'); } catch (e) {}
    }
    if (!ffmpegProcess.killed) {
      try { ffmpegProcess.kill('SIGTERM'); } catch (e) {}
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);

  ytdlpProcess.on('error', (err) => {
    console.error(`[ytdlpService] Erro no spawn yt-dlp:`, err);
    cleanup();
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[ytdlpService] Erro no spawn ffmpeg:`, err);
    cleanup();
  });

  ytdlpProcess.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[ytdlpService] yt-dlp finalizou com código ${code}. Stderr: ${stderrLogged.slice(-300)}`);
    }
  });
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
