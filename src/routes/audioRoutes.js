const express = require('express');
const audioController = require('../controllers/audioController');

const router = express.Router();

// GET /api/search?q={termo}&limit=15
router.get('/search', audioController.search);

// GET /api/download?id={videoId}
router.get('/download', audioController.download);

// GET /api/suggest?q={termo}
router.get('/suggest', audioController.suggest);

// GET /api/info?id={videoId}
router.get('/info', audioController.info);

// GET /api/debug-download?id={videoId}
router.get('/debug-download', audioController.debugDownload);

module.exports = router;
