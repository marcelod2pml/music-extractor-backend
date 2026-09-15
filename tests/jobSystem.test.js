const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createJob } = require('../src/models/jobModel');
const { JobQueue } = require('../src/queue/jobQueue');
const { LocalStorageProvider } = require('../src/storage/storageService');
const { DownloadWorker } = require('../src/worker/downloadWorker');
const ytdlpService = require('../src/services/ytdlpService');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 INICIANDO BATERIA DE TESTES DO SISTEMA DE JOBS');
  console.log('====================================================');

  // Teste 1: Job Model
  console.log('\n[Teste 1] Validação da estrutura do Job Model...');
  const testJob = createJob('jNQXAC9IVRw');
  assert(testJob.id.startsWith('job_'), 'ID deve começar com job_');
  assert.strictEqual(testJob.videoId, 'jNQXAC9IVRw');
  assert.strictEqual(testJob.status, 'queued');
  assert.strictEqual(testJob.stage, 'queued');
  assert.strictEqual(testJob.progress, 0);
  assert(testJob.createdAt, 'Deve conter createdAt ISO');
  console.log('✅ Teste 1 passou: Job Model válido.');

  // Teste 2: Storage Service
  console.log('\n[Teste 2] Validação do Storage Service (salvar, verificar, stream, deletar)...');
  const testStorageDir = path.join(os.tmpdir(), `test_storage_${Date.now()}`);
  const storage = new LocalStorageProvider(testStorageDir);

  const dummySrc = path.join(os.tmpdir(), `dummy_src_${Date.now()}.txt`);
  fs.writeFileSync(dummySrc, 'conteúdo de teste de áudio');

  const saved = await storage.saveFile('test_dummy.txt', dummySrc);
  assert.strictEqual(saved.storageKey, 'test_dummy.txt');
  assert(await storage.fileExists('test_dummy.txt'), 'Arquivo deve existir no storage');

  const stream = storage.getFileStream('test_dummy.txt');
  assert(stream, 'Stream deve ser retornado');
  let data = '';
  for await (const chunk of stream) {
    data += chunk;
  }
  assert.strictEqual(data, 'conteúdo de teste de áudio');

  await storage.deleteFile('test_dummy.txt');
  assert(!(await storage.fileExists('test_dummy.txt')), 'Arquivo deve ter sido removido');

  try { fs.unlinkSync(dummySrc); } catch (e) { }
  try { fs.rmdirSync(testStorageDir); } catch (e) { }
  console.log('✅ Teste 2 passou: Storage Service operacional e isolado.');

  // Teste 3: Job Queue e Concorrência / Deduplicação
  console.log('\n[Teste 3] Fila de Jobs e Deduplicação de Concorrência...');
  const queue = new JobQueue({ concurrency: 2 });
  const { job: jobA, isExisting: isExistingA } = queue.enqueue('jNQXAC9IVRw');
  assert.strictEqual(isExistingA, false, 'Primeiro enqueue não deve ser existente');

  // Segundo enqueue simultâneo para o mesmo videoId
  const { job: jobB, isExisting: isExistingB } = queue.enqueue('jNQXAC9IVRw');
  assert.strictEqual(isExistingB, true, 'Segundo enqueue deve reutilizar job ativo existente');
  assert.strictEqual(jobA.id, jobB.id, 'IDs dos jobs devem ser idênticos');

  // Job inexistente
  const notFound = queue.getJob('job_inexistente_123');
  assert.strictEqual(notFound, null, 'Job inexistente deve retornar null');
  console.log('✅ Teste 3 passou: Fila deduplica requisições simultâneas e trata inexistentes.');

  // Teste 4: Execução End-to-End do Worker com vídeo público real e ffprobe
  console.log('\n[Teste 4] Execução End-to-End do Worker (yt-dlp -> FFmpeg -> ffprobe -> Storage)...');
  const e2eStorageDir = path.join(os.tmpdir(), `e2e_storage_${Date.now()}`);
  const e2eStorage = new LocalStorageProvider(e2eStorageDir);
  const e2eQueue = new JobQueue({ concurrency: 1 });
  const worker = new DownloadWorker(e2eQueue, e2eStorage);

  worker.start();

  const publicVideoId = 'jNQXAC9IVRw'; // "Me at the zoo" (19 segundos)
  const { job: runJob } = e2eQueue.enqueue(publicVideoId);

  console.log(`[Teste 4] Job enfileirado: ${runJob.id}. Aguardando processamento...`);

  const maxWaitMs = 40000;
  const startWait = Date.now();
  let finalJob = runJob;

  while (Date.now() - startWait < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1000));
    finalJob = e2eQueue.getJob(runJob.id);
    console.log(`  > Status atual: ${finalJob.status} | Estágio: ${finalJob.stage} | Progresso: ${finalJob.progress}%`);
    if (finalJob.status === 'completed' || finalJob.status === 'failed') {
      break;
    }
  }

  worker.stop();

  assert.strictEqual(finalJob.status, 'completed', `Job deveria ter concluído com sucesso, mas status é ${finalJob.status}: ${finalJob.error}`);
  assert.strictEqual(finalJob.stage, 'completed', 'Estágio final deve ser completed');
  assert.strictEqual(finalJob.progress, 100, 'Progresso final deve ser 100%');
  assert(finalJob.duration > 0, 'Duração validada deve ser maior que 0');
  assert(finalJob.bitrate > 0, 'Bitrate validado deve ser maior que 0');
  assert(await e2eStorage.fileExists(finalJob.storageKey), 'Arquivo final MP3 deve estar gravado no storage');

  // Validação ffprobe direta no arquivo final armazenado
  const storedFilePath = e2eStorage.getFilePath(finalJob.storageKey);
  const probeValidation = await ytdlpService.validateMp3File(storedFilePath);
  assert.strictEqual(probeValidation.valid, true, 'ffprobe deve atestar arquivo MP3 como válido');
  assert.strictEqual(probeValidation.formatName, 'mp3', 'Formato ffprobe deve ser mp3');

  console.log(`✅ Teste 4 passou: MP3 gerado e validado via ffprobe (duração: ${probeValidation.duration}s, bitrate: ${probeValidation.bitrate}bps).`);

  // Limpeza de arquivos de teste
  await e2eStorage.deleteFile(finalJob.storageKey);
  try { fs.rmdirSync(e2eStorageDir); } catch (e) { }

  // Teste 5: Tratamento de Falha do Worker com Vídeo Inexistente
  console.log('\n[Teste 5] Tratamento de Falha do Worker com ID Inválido/Inexistente...');
  const failStorage = new LocalStorageProvider(path.join(os.tmpdir(), `fail_storage_${Date.now()}`));
  const failQueue = new JobQueue({ concurrency: 1 });
  const failWorker = new DownloadWorker(failQueue, failStorage);

  failWorker.start();

  const invalidId = '00000000000'; // ID de vídeo não existente
  const { job: failJob } = failQueue.enqueue(invalidId);

  const maxFailWaitMs = 15000;
  const startFailWait = Date.now();
  let finalFailJob = failJob;

  while (Date.now() - startFailWait < maxFailWaitMs) {
    await new Promise((r) => setTimeout(r, 500));
    finalFailJob = failQueue.getJob(failJob.id);
    if (finalFailJob.status === 'failed') break;
  }

  failWorker.stop();

  assert.strictEqual(finalFailJob.status, 'failed', 'Status deve ser failed');
  assert(finalFailJob.error, 'Job deve conter mensagem técnica de erro');
  console.log(`✅ Teste 5 passou: Falha capturada no estágio '${finalFailJob.stage}' com erro registrado.`);

  console.log('\n====================================================');
  console.log('🎉 TODOS OS TESTES PASSARAM COM SUCESSO (100%)');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Falha nos testes:', err);
  process.exit(1);
});
