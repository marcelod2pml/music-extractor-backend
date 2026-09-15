const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Localiza o executável yt-dlp ou usa fallback para o Python Script/PATH
function getYtDlpCommand() {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    return { cmd: process.env.YTDLP_PATH, baseArgs: [] };
  }
  const defaultWinPath = 'C:\\Users\\marce\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe';
  if (process.platform === 'win32' && fs.existsSync(defaultWinPath)) {
    return { cmd: defaultWinPath, baseArgs: [] };
  }
  return { cmd: 'yt-dlp', baseArgs: [] };
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
 * @param {string} rawQuery
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function searchVideos(rawQuery, limit = 15) {
  const query = sanitizeSearchQuery(rawQuery);
  if (!query) {
    throw new Error('Termo de busca inválido');
  }

  const { cmd, baseArgs } = getYtDlpCommand();
  const maxResults = Math.min(Math.max(Number(limit) || 15, 1), 30);
  const searchArg = `ytsearch${maxResults}:${query}`;

  const args = [
    ...baseArgs,
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
              : (entry.thumbnail || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`);

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
        reject(new Error(`Erro ao processar JSON da busca: ${err.message}`));
      }
    });
  });
}

/**
 * Obtém informações detalhadas de um vídeo específico
 * @param {string} rawId
 * @returns {Promise<Object>}
 */
async function getVideoInfo(rawId) {
  const videoId = sanitizeVideoId(rawId);
  if (!videoId) {
    throw new Error('ID de vídeo inválido');
  }

  const { cmd, baseArgs } = getYtDlpCommand();
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    ...baseArgs,
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
 * @param {string} rawId
 * @param {import('express').Response} res
 */
function streamAudio(rawId, res) {
  const videoId = sanitizeVideoId(rawId);
  if (!videoId) {
    return res.status(400).json({ error: 'ID de vídeo inválido (esperado 11 caracteres alfanuméricos)' });
  }

  const { cmd, baseArgs } = getYtDlpCommand();
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Headers adequados para streaming e download de áudio
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Accept-Ranges', 'bytes');

  // Spawn seguro com argumentos separados (sem passar por shell/exec)
  // Utiliza yt-dlp para extrair o melhor áudio e FFmpeg para converter para MP3 direto no stdout (-)
  const args = [
    ...baseArgs,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', '-',
    '--no-playlist',
    '--no-warnings',
    url,
  ];

  const ytdlpProcess = spawn(cmd, args, { windowsHide: true });

  // Pipe direto do stdout do processo para a resposta HTTP
  ytdlpProcess.stdout.pipe(res);

  let stderrLogged = '';
  ytdlpProcess.stderr.on('data', (data) => {
    stderrLogged += data.toString();
  });

  // Cleanup garantido quando a conexão for finalizada ou interrompida pelo cliente
  const cleanup = () => {
    if (!ytdlpProcess.killed) {
      try {
        ytdlpProcess.kill('SIGTERM');
      } catch (e) {
        // Ignora se o processo já tiver encerrado
      }
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);

  ytdlpProcess.on('error', (err) => {
    console.error(`[ytdlpService] Erro no spawn do processo:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Falha ao iniciar extração de áudio' });
    }
    cleanup();
  });

  ytdlpProcess.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[ytdlpService] yt-dlp finalizou com código ${code}. Stderr: ${stderrLogged.slice(-300)}`);
    }
    cleanup();
  });
}

/**
 * Checa a saúde e disponibilidade do yt-dlp e ffmpeg no ambiente
 */
async function checkHealth() {
  const { cmd, baseArgs } = getYtDlpCommand();

  const checkCommand = (executable, args) =>
    new Promise((resolve) => {
      const p = spawn(executable, args, { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve({ available: false, version: null }));
      p.on('close', (code) => resolve({ available: code === 0, version: out.trim().split('\n')[0] }));
    });

  const [ytdlpStatus, ffmpegStatus] = await Promise.all([
    checkCommand(cmd, [...baseArgs, '--version']),
    checkCommand('ffmpeg', ['-version']),
  ]);

  return {
    ytdlp: ytdlpStatus,
    ffmpeg: ffmpegStatus,
  };
}

module.exports = {
  searchVideos,
  getVideoInfo,
  streamAudio,
  checkHealth,
  sanitizeVideoId,
  sanitizeSearchQuery,
};
