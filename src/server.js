import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { URL } from 'node:url';
import { WebSocket } from 'ws';

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return BOOL_TRUE.has(String(raw).trim().toLowerCase());
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const val = Number.parseInt(raw, 10);
  return Number.isFinite(val) ? val : fallback;
}

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 8787),
  proxyApiKey: process.env.PROXY_API_KEY || '',
  volcAppKey: process.env.VOLC_APP_KEY || '',
  volcAccessKey: process.env.VOLC_ACCESS_KEY || '',
  volcResourceId: process.env.VOLC_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  volcWsUrl: process.env.VOLC_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
  volcModelName: process.env.VOLC_MODEL_NAME || 'bigmodel',
  segmentDurationMs: Math.max(100, intEnv('SEGMENT_DURATION_MS', 200)),
  sendIntervalMs: Math.max(0, intEnv('SEND_INTERVAL_MS', 0)),
  bodyReadTimeoutMs: Math.max(1000, intEnv('BODY_READ_TIMEOUT_MS', 30000)),
  requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 90000),
  shutdownTimeoutMs: Math.max(1000, intEnv('SHUTDOWN_TIMEOUT_MS', 8000)),
  maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
  enableItn: boolEnv('ENABLE_ITN', true),
  enablePunc: boolEnv('ENABLE_PUNC', true),
  enableDdc: boolEnv('ENABLE_DDC', false),
  showUtterances: boolEnv('SHOW_UTTERANCES', false),
  resultType: process.env.RESULT_TYPE || 'full'
};

const MSG_TYPE = {
  CLIENT_FULL_REQUEST: 0b0001,
  CLIENT_AUDIO_ONLY_REQUEST: 0b0010,
  SERVER_FULL_RESPONSE: 0b1001,
  SERVER_ERROR_RESPONSE: 0b1111
};

const FLAGS = {
  NO_SEQUENCE: 0b0000,
  POS_SEQUENCE: 0b0001,
  NEG_SEQUENCE: 0b0010,
  NEG_WITH_SEQUENCE: 0b0011
};

const SERIALIZATION = {
  NONE: 0b0000,
  JSON: 0b0001
};

const COMPRESSION = {
  NONE: 0b0000,
  GZIP: 0b0001
};

const VERSION = 0b0001;

function now() {
  return new Date().toISOString();
}

function logInfo(msg, extra = null) {
  if (extra == null) {
    console.log(`[${now()}] INFO ${msg}`);
    return;
  }
  console.log(`[${now()}] INFO ${msg}`, extra);
}

function logError(msg, extra = null) {
  if (extra == null) {
    console.error(`[${now()}] ERROR ${msg}`);
    return;
  }
  console.error(`[${now()}] ERROR ${msg}`, extra);
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length)
  });
  res.end(body);
}

function parseBearer(req) {
  const auth = req.headers.authorization;
  if (!auth) return '';
  const [scheme, token] = auth.split(' ');
  if (!scheme || !token) return '';
  if (scheme.toLowerCase() !== 'bearer') return '';
  return token.trim();
}

function assertProxyAuth(req) {
  if (!config.proxyApiKey) return { ok: true };
  const got = parseBearer(req);
  if (!got || got !== config.proxyApiKey) {
    return { ok: false, code: 401, message: 'Invalid proxy API key.' };
  }
  return { ok: true };
}

function validateRuntimeConfig() {
  if (!config.volcAppKey) {
    throw new Error('VOLC_APP_KEY is required.');
  }
  if (!config.volcAccessKey) {
    throw new Error('VOLC_ACCESS_KEY is required.');
  }
  if (config.volcModelName !== 'bigmodel') {
    throw new Error('VOLC_MODEL_NAME must be bigmodel for this proxy.');
  }
}

function getBoundary(contentType) {
  if (!contentType) return '';
  const parts = contentType.split(';').map((s) => s.trim());
  for (const part of parts) {
    if (part.startsWith('boundary=')) {
      const raw = part.slice('boundary='.length);
      return raw.startsWith('"') ? raw.slice(1, -1) : raw;
    }
  }
  return '';
}

function parseContentDisposition(headerValue) {
  const out = { name: '', filename: '' };
  const chunks = headerValue.split(';').map((s) => s.trim());
  for (const chunk of chunks) {
    if (chunk.startsWith('name=')) {
      out.name = chunk.slice(5).replace(/^"|"$/g, '');
    }
    if (chunk.startsWith('filename=')) {
      out.filename = chunk.slice(9).replace(/^"|"$/g, '');
    }
  }
  return out;
}

function isValidBoundaryMarker(body, markerStart, boundaryBuf) {
  if (markerStart < 0) return false;
  const atLineStart = markerStart === 0
    || (markerStart >= 2 && body[markerStart - 2] === 13 && body[markerStart - 1] === 10);
  if (!atLineStart) return false;
  const markerEnd = markerStart + boundaryBuf.length;
  const b0 = body[markerEnd];
  const b1 = body[markerEnd + 1];
  return (b0 === 13 && b1 === 10) || (b0 === 45 && b1 === 45);
}

function findBoundaryMarker(body, boundaryBuf, fromIndex) {
  let markerStart = body.indexOf(boundaryBuf, fromIndex);
  while (markerStart >= 0) {
    if (isValidBoundaryMarker(body, markerStart, boundaryBuf)) {
      return markerStart;
    }
    markerStart = body.indexOf(boundaryBuf, markerStart + 1);
  }
  return -1;
}

function parseMultipart(body, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const headerDelimiter = Buffer.from('\r\n\r\n');
  const parts = [];
  let markerStart = findBoundaryMarker(body, boundaryBuf, 0);

  while (markerStart >= 0) {
    const markerEnd = markerStart + boundaryBuf.length;
    const isFinal = body[markerEnd] === 45 && body[markerEnd + 1] === 45;
    if (isFinal) break;
    if (!(body[markerEnd] === 13 && body[markerEnd + 1] === 10)) {
      markerStart = findBoundaryMarker(body, boundaryBuf, markerEnd);
      continue;
    }

    const partStart = markerEnd + 2;
    const nextMarker = findBoundaryMarker(body, boundaryBuf, partStart);
    if (nextMarker < 0) break;

    let partEnd = nextMarker;
    if (body[partEnd - 2] === 13 && body[partEnd - 1] === 10) {
      partEnd -= 2;
    }

    const rawPart = body.subarray(partStart, partEnd);
    const headerEnd = rawPart.indexOf(headerDelimiter);
    if (headerEnd >= 0) {
      const rawHeaders = rawPart.subarray(0, headerEnd).toString('utf8');
      const content = rawPart.subarray(headerEnd + 4);
      const headerLines = rawHeaders.split('\r\n');
      const headers = {};
      for (const line of headerLines) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        headers[k] = v;
      }
      const disp = parseContentDisposition(headers['content-disposition'] || '');
      parts.push({
        headers,
        name: disp.name,
        filename: disp.filename,
        content
      });
    }

    markerStart = nextMarker;
  }

  return parts;
}

function parseFields(parts) {
  const fields = {};
  let filePart = null;

  for (const part of parts) {
    if (part.filename) {
      if (!filePart) filePart = part;
      continue;
    }
    if (!part.name) continue;
    fields[part.name] = part.content.toString('utf8');
  }

  return { fields, filePart };
}

function mapBodyReadError(err) {
  if (err && err.code === 'BODY_TIMEOUT') {
    return { statusCode: 408, message: err.message, closeConnection: true };
  }
  if (err && err.code === 'BODY_TOO_LARGE') {
    return { statusCode: 413, message: err.message, closeConnection: true };
  }
  if (err && (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED')) {
    return {
      statusCode: 400,
      message: 'Client disconnected while uploading request body.',
      closeConnection: false
    };
  }
  return {
    statusCode: 500,
    message: err && err.message ? err.message : 'Failed to read request body.',
    closeConnection: false
  };
}

function getTranscriptionClientMessage(err) {
  const msg = String((err && err.message) || '');
  if (msg.includes('ffmpeg')) {
    return 'Audio preprocessing failed before ASR.';
  }
  if (msg.includes('ASR timeout')) {
    return 'ASR request timed out.';
  }
  if (err && err.errorCode) {
    return 'Upstream ASR returned an error.';
  }
  if (msg.includes('WebSocket')) {
    return 'Failed to communicate with upstream ASR.';
  }
  return 'Transcription failed.';
}

function readBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const refreshTimeout = () => {
      if (timeoutMs <= 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error(`Request body timeout after ${timeoutMs}ms.`);
        err.code = 'BODY_TIMEOUT';
        rejectOnce(err);
      }, timeoutMs);
      timer.unref();
    };

    const onData = (chunk) => {
      refreshTimeout();
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error(`Request body too large. Max ${maxBytes} bytes.`);
        err.code = 'BODY_TOO_LARGE';
        rejectOnce(err);
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      resolveOnce(Buffer.concat(chunks));
    };

    const onError = (err) => {
      rejectOnce(err);
    };

    refreshTimeout();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function transcodeToPcm16kMono(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', '16000',
      'pipe:1'
    ]);

    const stdoutChunks = [];
    const stderrChunks = [];

    ffmpeg.stdout.on('data', (d) => stdoutChunks.push(d));
    ffmpeg.stderr.on('data', (d) => stderrChunks.push(d));
    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to run ffmpeg: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}. ${stderr}`.trim()));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });

    ffmpeg.stdin.end(inputBuffer);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendWsFrame(ws, frame) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`WebSocket is not open. state=${ws.readyState}`));
      return;
    }
    ws.send(frame, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function buildHeader(messageType, messageTypeSpecificFlags, serialization, compression) {
  const header = Buffer.alloc(4);
  header[0] = (VERSION << 4) | 0b0001;
  header[1] = (messageType << 4) | messageTypeSpecificFlags;
  header[2] = (serialization << 4) | compression;
  header[3] = 0x00;
  return header;
}

function buildFullClientRequest(seq, payloadObj) {
  const payloadBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const compressed = gzipSync(payloadBuf);
  const header = buildHeader(
    MSG_TYPE.CLIENT_FULL_REQUEST,
    FLAGS.POS_SEQUENCE,
    SERIALIZATION.JSON,
    COMPRESSION.GZIP
  );

  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);

  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(compressed.length, 0);

  return Buffer.concat([header, seqBuf, sizeBuf, compressed]);
}

function buildAudioOnlyRequest(seq, audioChunk, isLast) {
  const flags = isLast ? FLAGS.NEG_WITH_SEQUENCE : FLAGS.POS_SEQUENCE;
  const actualSeq = isLast ? -seq : seq;
  const compressed = gzipSync(audioChunk);

  const header = buildHeader(
    MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST,
    flags,
    SERIALIZATION.NONE,
    COMPRESSION.GZIP
  );

  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(actualSeq, 0);

  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(compressed.length, 0);

  return Buffer.concat([header, seqBuf, sizeBuf, compressed]);
}

function decodePayload(serialization, compression, payload) {
  let decoded = payload;
  if (compression === COMPRESSION.GZIP && payload.length > 0) {
    decoded = gunzipSync(payload);
  }
  if (serialization === SERIALIZATION.JSON && decoded.length > 0) {
    const text = decoded.toString('utf8');
    return JSON.parse(text);
  }
  return decoded;
}

function parseServerFrame(frame, options = {}) {
  const decodeFullPayload = options.decodeFullPayload !== false;
  const msg = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (msg.length < 4) {
    throw new Error('Invalid frame: header too short.');
  }

  const headerSize = msg[0] & 0x0f;
  const messageType = msg[1] >> 4;
  const flags = msg[1] & 0x0f;
  const serialization = msg[2] >> 4;
  const compression = msg[2] & 0x0f;
  let offset = headerSize * 4;

  let sequence = null;
  let isLast = false;

  if (flags & 0x01) {
    sequence = msg.readInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x02) {
    isLast = true;
  }

  if (messageType === MSG_TYPE.SERVER_FULL_RESPONSE) {
    const payloadSize = msg.readUInt32BE(offset);
    offset += 4;
    const payload = msg.slice(offset, offset + payloadSize);
    const decoded = decodeFullPayload ? decodePayload(serialization, compression, payload) : null;
    return {
      messageType,
      sequence,
      isLast,
      payload: decoded
    };
  }

  if (messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
    const errorCode = msg.readInt32BE(offset);
    offset += 4;
    const payloadSize = msg.readUInt32BE(offset);
    offset += 4;
    const payload = msg.slice(offset, offset + payloadSize);

    let detail;
    try {
      detail = decodePayload(serialization, compression, payload);
    } catch {
      detail = payload.toString('utf8');
    }

    return {
      messageType,
      sequence,
      isLast,
      errorCode,
      error: detail
    };
  }

  return {
    messageType,
    sequence,
    isLast,
    payload: null
  };
}

function extractText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.result && typeof payload.result.text === 'string') {
    return payload.result.text;
  }
  return '';
}

function isNostreamWsUrl(wsUrl) {
  return String(wsUrl || '').toLowerCase().includes('/bigmodel_nostream');
}

async function runDoubaoAsr(pcmBuffer, options = {}) {
  const connectId = randomUUID();
  const wsUrl = config.volcWsUrl;
  const asrStartedAt = Date.now();

  const headers = {
    'X-Api-App-Key': config.volcAppKey,
    'X-Api-Access-Key': config.volcAccessKey,
    'X-Api-Resource-Id': config.volcResourceId,
    'X-Api-Connect-Id': connectId
  };

  const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 15000 });

  let seq = 1;
  let finalText = '';
  let wsClosed = false;
  let seenLast = false;
  let responseLogId = '';
  let sendFinished = false;
  let openMs = 0;
  let sendMs = 0;
  let waitMs = 0;
  let packetCount = 0;

  ws.on('upgrade', (res) => {
    responseLogId = String(res.headers['x-tt-logid'] || '');
    if (responseLogId) {
      logInfo('Connected to Doubao ASR 2.0', { connectId, logid: responseLogId });
    } else {
      logInfo('Connected to Doubao ASR 2.0', { connectId });
    }
  });

  const completion = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      rejectOnce(new Error(`ASR timeout after ${config.requestTimeoutMs}ms.`));
      try {
        ws.close();
      } catch {
        // ignore
      }
    }, config.requestTimeoutMs);
    timer.unref();

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onMessage = (data) => {
      try {
        // While we are still uploading audio packets, skip heavy payload decoding
        // for intermediate responses so packet sending is not blocked by JSON parsing.
        let parsed = parseServerFrame(data, { decodeFullPayload: sendFinished });
        if (parsed.messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
          const err = new Error('Doubao returned protocol error frame.');
          err.detail = parsed.error;
          err.errorCode = parsed.errorCode;
          err.connectId = connectId;
          err.logid = responseLogId;
          rejectOnce(err);
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }

        if (parsed.messageType === MSG_TYPE.SERVER_FULL_RESPONSE && parsed.payload == null && parsed.isLast) {
          parsed = parseServerFrame(data, { decodeFullPayload: true });
        }

        const text = extractText(parsed.payload);
        if (text) {
          finalText = text;
        }

        if (parsed.isLast) {
          seenLast = true;
          resolveOnce({ text: finalText, connectId, logid: responseLogId });
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      } catch (err) {
        rejectOnce(err);
      }
    };

    const onError = (err) => {
      rejectOnce(err);
    };

    const onClose = (code, reasonBuf) => {
      wsClosed = true;
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
      if (!seenLast) {
        rejectOnce(new Error(`WebSocket closed before final response. code=${code} reason=${reason}`));
      }
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
  completion.catch(() => {});

  const openStartAt = Date.now();
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  openMs = Date.now() - openStartAt;

  const allowLanguage = isNostreamWsUrl(wsUrl);
  if (options.language && !allowLanguage) {
    logInfo('Ignore language for non-nostream endpoint', {
      wsUrl,
      language: options.language
    });
  }

  const audioPayload = {
    format: 'pcm',
    codec: 'raw',
    rate: 16000,
    bits: 16,
    channel: 1
  };
  if (allowLanguage && options.language) {
    audioPayload.language = options.language;
  }

  const fullPayload = {
    user: {
      uid: options.uid || 'spokenly-proxy'
    },
    audio: audioPayload,
    request: {
      model_name: config.volcModelName,
      enable_itn: config.enableItn,
      enable_punc: config.enablePunc,
      enable_ddc: config.enableDdc,
      show_utterances: config.showUtterances,
      result_type: config.resultType,
      ...(options.prompt ? { corpus: { context: options.prompt } } : {})
    }
  };

  const sendStartAt = Date.now();
  await sendWsFrame(ws, buildFullClientRequest(seq, fullPayload));
  seq += 1;

  const bytesPerMs = 16000 * 2 / 1000;
  const segmentSize = Math.max(1, Math.floor(bytesPerMs * config.segmentDurationMs));
  if (pcmBuffer.length === 0) {
    const frame = buildAudioOnlyRequest(seq, Buffer.alloc(0), true);
    await sendWsFrame(ws, frame);
    packetCount = 1;
  } else {
    let offset = 0;
    while (offset < pcmBuffer.length) {
      const end = Math.min(offset + segmentSize, pcmBuffer.length);
      const isLast = end >= pcmBuffer.length;
      const chunk = pcmBuffer.slice(offset, end);
      const frame = buildAudioOnlyRequest(seq, chunk, isLast);
      await sendWsFrame(ws, frame);
      packetCount += 1;
      if (!isLast) {
        seq += 1;
      }
      offset = end;
      if (config.sendIntervalMs > 0 && !isLast) {
        await sleep(config.sendIntervalMs);
      }
    }
  }
  sendMs = Date.now() - sendStartAt;
  sendFinished = true;

  const waitStartAt = Date.now();
  const result = await completion;
  waitMs = Date.now() - waitStartAt;
  if (!wsClosed) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  const bytesPerMsForLog = 16000 * 2 / 1000;
  const audioMs = Math.round(pcmBuffer.length / bytesPerMsForLog);
  logInfo('ASR timing', {
    connectId,
    logid: responseLogId,
    wsUrl,
    audioMs,
    openMs,
    sendMs,
    waitMs,
    totalMs: Date.now() - asrStartedAt,
    packets: packetCount,
    segmentDurationMs: config.segmentDurationMs,
    sendIntervalMs: config.sendIntervalMs
  });
  return result;
}

function isTranscribePath(pathname) {
  return pathname === '/v1/audio/transcriptions' || pathname === '/doubao/v1/audio/transcriptions';
}

async function handleTranscribe(req, res) {
  const reqStartedAt = Date.now();
  let readBodyMs = 0;
  let parseMs = 0;
  let transcodeMs = 0;
  let asrMs = 0;
  let uploadBytes = 0;
  let fileBytes = 0;

  const auth = assertProxyAuth(req);
  if (!auth.ok) {
    sendJson(res, auth.code, { error: { message: auth.message, type: 'invalid_request_error' } });
    return;
  }

  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) {
    sendJson(res, 400, { error: { message: 'Expected multipart/form-data.' } });
    return;
  }

  const boundary = getBoundary(ct);
  if (!boundary) {
    sendJson(res, 400, { error: { message: 'Missing multipart boundary.' } });
    return;
  }

  let body;
  try {
    const readBodyStartAt = Date.now();
    body = await readBody(req, config.maxUploadBytes, config.bodyReadTimeoutMs);
    readBodyMs = Date.now() - readBodyStartAt;
    uploadBytes = body.length;
  } catch (err) {
    const mapped = mapBodyReadError(err);
    if (mapped.closeConnection) {
      res.setHeader('Connection', 'close');
    }
    sendJson(res, mapped.statusCode, { error: { message: mapped.message } });
    if (mapped.closeConnection && req.socket && !req.socket.destroyed) {
      res.once('finish', () => {
        try {
          req.socket.destroy();
        } catch {
          // ignore
        }
      });
    }
    return;
  }

  const parseStartAt = Date.now();
  const parts = parseMultipart(body, boundary);
  const { fields, filePart } = parseFields(parts);
  parseMs = Date.now() - parseStartAt;

  if (!filePart || !filePart.content || filePart.content.length === 0) {
    sendJson(res, 400, { error: { message: 'Missing audio file part.' } });
    return;
  }
  fileBytes = filePart.content.length;

  const language = fields.language ? String(fields.language).trim() : '';
  const prompt = fields.prompt ? String(fields.prompt).trim() : '';
  const responseFormat = fields.response_format ? String(fields.response_format).trim() : 'json';

  try {
    const transcodeStartAt = Date.now();
    const pcm = await transcodeToPcm16kMono(filePart.content);
    transcodeMs = Date.now() - transcodeStartAt;
    const asrStartAt = Date.now();
    const asrResult = await runDoubaoAsr(pcm, { language, prompt });
    asrMs = Date.now() - asrStartAt;

    logInfo('Transcription timing', {
      uploadBytes,
      fileBytes,
      readBodyMs,
      parseMs,
      transcodeMs,
      asrMs,
      totalMs: Date.now() - reqStartedAt
    });

    if (responseFormat === 'text') {
      sendText(res, 200, asrResult.text || '');
      return;
    }

    sendJson(res, 200, {
      text: asrResult.text || ''
    });
  } catch (err) {
    const detail = {
      message: err.message || 'ASR request failed.',
      errorCode: err.errorCode || null,
      connectId: err.connectId || null,
      logid: err.logid || null,
      detail: err.detail || null
    };

    logInfo('Transcription timing', {
      uploadBytes,
      fileBytes,
      readBodyMs,
      parseMs,
      transcodeMs,
      asrMs,
      totalMs: Date.now() - reqStartedAt,
      failed: true
    });
    logError('Transcription failed', detail);

    sendJson(res, 502, {
      error: {
        message: getTranscriptionClientMessage(err),
        type: 'api_error',
        detail
      }
    });
  }
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    service: 'volcengine-doubao-asr2-openai-proxy',
    model: config.volcModelName,
    resource_id: config.volcResourceId,
    ws_url: config.volcWsUrl
  });
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
    handleHealth(req, res);
    return;
  }

  if (req.method === 'POST' && isTranscribePath(url.pathname)) {
    await handleTranscribe(req, res);
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found.' } });
}

function start() {
  validateRuntimeConfig();

  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((err) => {
      logError('Unhandled request error', err);
      sendJson(res, 500, { error: { message: 'Internal server error.' } });
    });
  });

  server.listen(config.port, config.host, () => {
    logInfo('Server started', {
      host: config.host,
      port: config.port,
      model: config.volcModelName,
      resourceId: config.volcResourceId,
      wsUrl: config.volcWsUrl
    });
  });

  const sockets = new Set();
  let shuttingDown = false;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo('Shutdown signal received', { signal });

    server.close((err) => {
      if (err) {
        logError('Server close failed', { signal, message: err.message });
        process.exit(1);
        return;
      }
      logInfo('Server closed gracefully', { signal });
      process.exit(0);
    });

    setTimeout(() => {
      logError('Shutdown timeout reached, force closing sockets', {
        signal,
        timeoutMs: config.shutdownTimeoutMs,
        openSockets: sockets.size
      });
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
