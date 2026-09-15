require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const audioRoutes = require('./routes/audioRoutes');
const audioController = require('./controllers/audioController');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3333;

// Middlewares de segurança e utilitários
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(express.json());

// Limitador de taxa global para a API (máximo 60 requisições por minuto por IP)
const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições enviadas. Aguarde alguns instantes antes de tentar novamente.' },
});

// Limitador estrito para streaming e extração de áudio (máximo 15 downloads por minuto por IP)
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de downloads simultâneos atingido para este IP. Aguarde um minuto.' },
});

// Log simples de requisições
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Rota de Health Check
app.get('/health', audioController.health);

// Rotas da API protegidas por Rate Limiting
app.use('/api/download', downloadLimiter);
app.use('/api', globalApiLimiter, audioRoutes);

// Rota raiz de boas-vindas e status da API
app.get('/', (req, res) => {
  res.json({
    name: 'Music Offline Extractor API',
    version: '1.0.0',
    status: 'online',
    endpoints: {
      health: 'GET /health',
      search: 'GET /api/search?q={termo}&limit=15',
      download: 'GET /api/download?id={videoId}',
      info: 'GET /api/info?id={videoId}',
    },
  });
});

// Handler 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

// Error handling global
app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: 'Erro interno no servidor' });
});

// Inicialização do Servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 Music Extractor API rodando na porta ${PORT}`);
  console.log(`🔗 Health Check: http://localhost:${PORT}/health`);
  console.log(`🔍 Exemplo Busca: http://localhost:${PORT}/api/search?q=lofi`);
  console.log(`=========================================`);
});
