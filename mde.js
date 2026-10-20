// Sends exported lessons to the MDE lessons panel (as drafts): reserve the
// upload with an idempotency key, push the file straight to Bunny over TUS
// (resumable), confirm, then follow the processing status. Everything needed to
// resume lives in the lesson's projeto.json under "mde" (never the temporary
// TUS headers, never the API key).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Upload } = require('tus-js-client');

const TERMINAL = new Set(['ready', 'failed', 'superseded']);
const FATAL = new Set([
  'INVALID_API_KEY', 'INSTRUCTOR_NOT_LINKED', 'UNSUPPORTED_VIDEO_TYPE', 'INVALID_FIELDS', 'UPLOAD_NOT_FOUND', 'IDEMPOTENCY_CONFLICT',
]);
const MESSAGES = {
  INVALID_API_KEY: 'Chave de API inválida, expirada ou revogada. Cadastre uma nova em Configurações → Comunidade MDE.',
  INSTRUCTOR_NOT_LINKED: 'Sua conta não está vinculada a um instrutor no painel do MDE.',
  UNSUPPORTED_VIDEO_TYPE: 'O MDE não aceitou o tipo do arquivo.',
  INVALID_FIELDS: 'O MDE recusou os dados enviados.',
  UPLOAD_NOT_FOUND: 'O envio não existe mais no MDE (ou é de outra conta).',
  IDEMPOTENCY_CONFLICT: 'Conflito com um envio anterior desta gravação.',
  UPLOAD_LIMIT_REACHED: 'Limite diário de envios do MDE atingido. Tente mais tarde.',
  VIDEO_PROCESSING_FAILED: 'O MDE não conseguiu processar o vídeo.',
  UPLOAD_EXPIRED: 'O envio expirou (7 dias sem concluir). Envie de novo.',
  PROVISIONING_UNCONFIRMED: 'O MDE não confirmou a criação do envio. Envie de novo.',
  NETWORK: 'Sem conexão com o MDE. Vou tentar de novo.',
  NOT_API: 'O endereço da API não respondeu como a API do MDE. Confira em Configurações → Comunidade MDE.',
};

class MdeError extends Error {
  constructor(code, status, retryAfter) {
    super(MESSAGES[code] || `Erro do MDE (${code || status}).`);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Mde {
  constructor({ getConfig, readProject, writeProject, notify }) {
    this.getConfig = getConfig; // () => ({ baseUrl, apiKey })
    this.readProject = readProject;
    this.writeProject = writeProject;
    this.notify = notify; // (status) => void
    this.jobs = new Map(); // folder -> { cancelled, uploader }
  }

  // ---------------------------------------------------------------- HTTP

  async request(method, p, body, headers = {}) {
    const { baseUrl, apiKey } = this.getConfig();
    if (!apiKey) throw new MdeError('INVALID_API_KEY', 401);
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}${p}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new MdeError('NETWORK', 0);
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const type = res.headers.get('content-type') || '';
    let data = null;
    if (type.includes('json')) data = await res.json().catch(() => null);
    if (res.ok && data) return { status: res.status, data };
    if (!type.includes('json')) throw new MdeError('NOT_API', res.status, retryAfter);
    const code = (data && data.error && data.error.code) || `HTTP_${res.status}`;
    throw new MdeError(code, res.status, retryAfter);
  }

  // Retries what is worth retrying (network, 5xx, 429) with growing delays.
  async call(job, method, p, body, headers) {
    const delays = [1000, 3000, 5000, 10000, 30000, 60000, 60000, 120000];
    for (let i = 0; ; i++) {
      if (job && job.cancelled) throw new MdeError('CANCELLED', 0);
      try {
        return await this.request(method, p, body, headers);
      } catch (err) {
        const retryable = err.code === 'NETWORK' || err.status >= 500 || err.status === 429 || err.code === 'RATE_LIMITED';
        if (!retryable || err.code === 'UPLOAD_LIMIT_REACHED' || i >= delays.length) throw err;
        await sleep(Math.max(err.retryAfter * 1000, delays[i]));
      }
    }
  }

  // Valid key: a lookup of a made-up upload answers 404 UPLOAD_NOT_FOUND.
  async test() {
    try {
      await this.request('GET', '/uploads/00000000-0000-4000-8000-000000000000');
      return { ok: true };
    } catch (err) {
      if (err.code === 'UPLOAD_NOT_FOUND') return { ok: true };
      return { ok: false, code: err.code, message: err.message };
    }
  }

  // ---------------------------------------------------------------- state

  async state(folder) {
    const proj = (await this.readProject(folder)) || {};
    return proj.mde || null;
  }

  async save(folder, patch) {
    const cur = (await this.state(folder)) || {};
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await this.writeProject(folder, { mde: next });
    this.notify({ folder, ...publicState(next) });
    return next;
  }

  // ---------------------------------------------------------------- jobs

  // Starts (or resumes) sending `file` with `title`. `fresh` forces a new lesson.
  async send(folder, { file, title, fresh = false }) {
    if (this.jobs.has(folder)) return publicState(await this.state(folder));
    const stat = fs.statSync(file);
    let st = await this.state(folder);
    const sameFile = st && st.file === file && st.size === stat.size && st.mtimeMs === Math.round(stat.mtimeMs);
    if (fresh || !st || !sameFile || ['failed', 'superseded'].includes(st.status) || st.phase === 'error') {
      // A new recording/file gets a new identifier (and a new draft lesson).
      if (!fresh && st && sameFile && st.status === 'ready') return publicState(st);
      st = await this.save(folder, {
        idempotencyKey: crypto.randomUUID(),
        title: String(title || path.basename(file, path.extname(file))).trim().slice(0, 180) || 'Aula',
        filename: path.basename(file),
        file,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        uploadId: null,
        lessonId: null,
        uploadUrl: null,
        status: null,
        phase: 'reserving',
        sentPct: 0,
        encodeProgress: 0,
        errorCode: null,
        adminUrl: null,
      });
    }
    this.run(folder);
    return publicState(st);
  }

  cancel(folder) {
    const job = this.jobs.get(folder);
    if (!job) return;
    job.cancelled = true;
    if (job.uploader) job.uploader.abort().catch(() => {});
  }

  async resumeAll(folders) {
    for (const folder of folders) {
      const st = await this.state(folder).catch(() => null);
      if (st && st.phase && !['done', 'error'].includes(st.phase) && fs.existsSync(st.file || '')) this.run(folder);
    }
  }

  async run(folder) {
    if (this.jobs.has(folder)) return;
    const job = { cancelled: false };
    this.jobs.set(folder, job);
    try {
      let st = await this.state(folder);
      // 1. reservation
      let reservation = null;
      if (!st.uploadId) {
        await this.save(folder, { phase: 'reserving' });
        const { data } = await this.call(job, 'POST', '/uploads', {
          title: st.title, filename: st.filename, content_type: 'video/mp4', size_bytes: st.size,
        }, { 'Idempotency-Key': st.idempotencyKey });
        st = await this.save(folder, fromApi(data));
        reservation = data;
      } else {
        const { data } = await this.call(job, 'GET', `/uploads/${st.uploadId}`);
        st = await this.save(folder, fromApi(data));
      }
      // provisioning: wait until the draft is ready to receive the file
      while (st.status === 'provisioning') {
        await sleep(10000);
        const { data } = await this.call(job, 'GET', `/uploads/${st.uploadId}`);
        st = await this.save(folder, fromApi(data));
        reservation = null;
      }
      // 2. upload (unless the file was already received)
      if (st.status === 'awaiting_upload') {
        if (!reservation || !reservation.upload) {
          ({ data: reservation } = await this.call(job, 'POST', `/uploads/${st.uploadId}/upload-authorization`));
        }
        await this.save(folder, { phase: 'uploading' });
        await this.tus(job, folder, st, reservation.upload);
        const { data } = await this.call(job, 'POST', `/uploads/${st.uploadId}/complete`);
        st = await this.save(folder, { ...fromApi(data), sentPct: 1 });
      }
      // 3. follow processing until it is final
      await this.save(folder, { phase: TERMINAL.has(st.status) ? 'done' : 'processing' });
      while (!TERMINAL.has(st.status)) {
        await sleep(12000);
        const { data, retryAfter } = await this.call(job, 'GET', `/uploads/${st.uploadId}`);
        if (retryAfter) await sleep(retryAfter * 1000);
        st = await this.save(folder, fromApi(data));
      }
      await this.save(folder, { phase: 'done' });
    } catch (err) {
      if (err.code !== 'CANCELLED') {
        await this.save(folder, { phase: 'error', errorCode: err.code || 'ERROR', message: err.message }).catch(() => {});
      }
    } finally {
      this.jobs.delete(folder);
    }
  }

  // Straight to Bunny with the temporary headers; resumable across restarts.
  tus(job, folder, st, firstAuth) {
    return new Promise((resolve, reject) => {
      let auth = firstAuth;
      let lastSaved = 0;
      let restarted = false;
      const start = (uploadUrl) => {
        const uploader = new Upload(fs.createReadStream(st.file), {
          endpoint: auth.endpoint,
          uploadUrl: uploadUrl || undefined,
          uploadSize: st.size,
          chunkSize: 8 * 1024 * 1024,
          retryDelays: [0, 1000, 3000, 5000, 10000, 30000],
          headers: auth.headers,
          metadata: auth.metadata,
          onBeforeRequest: async (req) => {
            if (Date.now() > Date.parse(auth.expires_at) - 120000) {
              const { data } = await this.call(job, 'POST', `/uploads/${st.uploadId}/upload-authorization`);
              auth = data.upload;
            }
            for (const [name, value] of Object.entries(auth.headers)) req.setHeader(name, value);
          },
          onUploadUrlAvailable: () => {
            this.save(folder, { uploadUrl: uploader.url }).catch(() => {});
          },
          onProgress: (sent, total) => {
            const now = Date.now();
            if (now - lastSaved > 1500) {
              lastSaved = now;
              this.save(folder, { sentPct: total ? sent / total : 0 }).catch(() => {});
            }
          },
          onError: async (error) => {
            if (job.cancelled) { reject(new MdeError('CANCELLED', 0)); return; }
            const status = error.originalResponse ? error.originalResponse.getStatus() : 0;
            // The saved TUS URL is gone: new authorization for the same upload, start over.
            if (!restarted && (status === 404 || status === 410) && uploadUrl) {
              restarted = true;
              try {
                const { data } = await this.call(job, 'POST', `/uploads/${st.uploadId}/upload-authorization`);
                auth = data.upload;
                await this.save(folder, { uploadUrl: null });
                start(null);
              } catch (err) { reject(err); }
              return;
            }
            reject(new MdeError('NETWORK', status));
          },
          onSuccess: () => resolve(),
        });
        job.uploader = uploader;
        uploader.start();
      };
      // Only reuse a saved TUS URL for this very file.
      start(st.uploadUrl && st.file && fs.existsSync(st.file) ? st.uploadUrl : null);
    });
  }
}

function fromApi(d) {
  return {
    uploadId: d.upload_id,
    lessonId: d.lesson_id || null,
    status: d.status,
    encodeProgress: Number(d.encode_progress) || 0,
    errorCode: d.error_code || null,
    adminUrl: /^https:\/\//.test(d.admin_url || '') ? d.admin_url : null,
  };
}

function publicState(st) {
  if (!st) return null;
  const { phase, status, sentPct, encodeProgress, errorCode, adminUrl, title, message } = st;
  return { phase, status, sentPct, encodeProgress, errorCode, adminUrl, title, message: message || (errorCode && MESSAGES[errorCode]) || null };
}

module.exports = { Mde, publicState };
