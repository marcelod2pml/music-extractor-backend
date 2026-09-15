const fs = require('fs');
const path = require('path');

class LocalStorageProvider {
  constructor(baseDir) {
    this.baseDir = baseDir || process.env.STORAGE_DIR || path.join(__dirname, '../../storage_data');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  getFilePath(key) {
    // Sanitização para prevenir directory traversal
    const safeKey = path.basename(key);
    return path.join(this.baseDir, safeKey);
  }

  async saveFile(key, sourceFilePath) {
    const destPath = this.getFilePath(key);
    if (sourceFilePath !== destPath) {
      await fs.promises.copyFile(sourceFilePath, destPath);
    }
    const stat = await fs.promises.stat(destPath);
    return {
      storageKey: path.basename(key),
      sizeBytes: stat.size,
      path: destPath,
    };
  }

  async fileExists(key) {
    const destPath = this.getFilePath(key);
    try {
      await fs.promises.access(destPath, fs.constants.F_OK);
      const stat = await fs.promises.stat(destPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  getFileStream(key) {
    const destPath = this.getFilePath(key);
    if (!fs.existsSync(destPath)) {
      throw new Error(`Arquivo '${key}' não encontrado no storage`);
    }
    return fs.createReadStream(destPath);
  }

  async getFileStats(key) {
    const destPath = this.getFilePath(key);
    if (!fs.existsSync(destPath)) return null;
    return fs.promises.stat(destPath);
  }

  async deleteFile(key) {
    const destPath = this.getFilePath(key);
    try {
      if (fs.existsSync(destPath)) {
        await fs.promises.unlink(destPath);
        return true;
      }
    } catch (e) {
      console.warn(`[Storage] Erro ao deletar arquivo ${key}:`, e.message);
    }
    return false;
  }
}

// Instância singleton do serviço de storage
const storageService = new LocalStorageProvider();

module.exports = {
  storageService,
  LocalStorageProvider,
};
