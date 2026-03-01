import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';

const config = {
  volcAppKey: process.env.VOLC_APP_KEY || '',
  volcAccessKey: process.env.VOLC_ACCESS_KEY || '',
  volcResourceId: process.env.VOLC_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  volcWsUrl: process.env.VOLC_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
  modelName: process.env.VOLC_MODEL_NAME || 'bigmodel',
  timeoutMs: Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '90000', 10)
};

const MSG_TYPE = {
  CLIENT_FULL_REQUEST: 0b0001,
  CLIENT_AUDIO_ONLY_REQUEST: 0b0010,
  SERVER_FULL_RESPONSE: 0b1001,
  SERVER_ERROR_RESPONSE: 0b1111
};

const FLAGS = {
  POS_SEQUENCE: 0b0001,
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

function decodePayload(serialization, compression, payload) {
  let decoded = payload;
  if (compression === COMPRESSION.GZIP && payload.length > 0) {
    decoded = gunzipSync(payload);
  }
  if (serialization === SERIALIZATION.JSON && decoded.length > 0) {
    return JSON.parse(decoded.toString('utf8'));
  }
  return decoded;
}

function fail(message, extra = null) {
  console.error(`FAIL: ${message}`);
  if (extra) {
    console.error(JSON.stringify(extra, null, 2));
  }
  process.exit(1);
}

function buildHeader(messageType, flags, serialization, compression) {
  const header = Buffer.alloc(4);
  header[0] = (0b0001 << 4) | 0b0001;
  header[1] = (messageType << 4) | flags;
  header[2] = (serialization << 4) | compression;
  header[3] = 0x00;
  return header;
}

function buildFullClientRequest(seq, payloadObj) {
  const payload = gzipSync(Buffer.from(JSON.stringify(payloadObj), 'utf8'));
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length, 0);
  return Buffer.concat([
    buildHeader(MSG_TYPE.CLIENT_FULL_REQUEST, FLAGS.POS_SEQUENCE, SERIALIZATION.JSON, COMPRESSION.GZIP),
    seqBuf,
    sizeBuf,
    payload
  ]);
}

function buildAudioOnlyRequest(seq, audioBuf, isLast) {
  const payload = gzipSync(audioBuf);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(isLast ? -seq : seq, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length, 0);
  return Buffer.concat([
    buildHeader(
      MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST,
      isLast ? FLAGS.NEG_WITH_SEQUENCE : FLAGS.POS_SEQUENCE,
      SERIALIZATION.NONE,
      COMPRESSION.GZIP
    ),
    seqBuf,
    sizeBuf,
    payload
  ]);
}

function parseServerFrame(frame) {
  const msg = Buffer.from(frame);
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
    let json = null;
    try {
      json = decodePayload(serialization, compression, payload);
    } catch {
      json = null;
    }
    return { messageType, sequence, isLast, json };
  }

  if (messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
    const errorCode = msg.readInt32BE(offset);
    offset += 4;
    const payloadSize = msg.readUInt32BE(offset);
    offset += 4;
    const payload = msg.slice(offset, offset + payloadSize);
    let error;
    try {
      const decoded = decodePayload(serialization, compression, payload);
      error = typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
    } catch {
      error = payload.toString('utf8');
    }
    return { messageType, sequence, isLast, errorCode, error };
  }

  return { messageType, sequence, isLast };
}

async function run() {
  if (!config.volcAppKey) fail('Missing VOLC_APP_KEY');
  if (!config.volcAccessKey) fail('Missing VOLC_ACCESS_KEY');
  if (config.modelName !== 'bigmodel') fail('VOLC_MODEL_NAME must be bigmodel');

  const connectId = randomUUID();
  const requestId = randomUUID();

  const ws = new WebSocket(config.volcWsUrl, {
    headers: {
      'X-Api-App-Key': config.volcAppKey,
      'X-Api-Access-Key': config.volcAccessKey,
      'X-Api-Resource-Id': config.volcResourceId,
      'X-Api-Connect-Id': connectId,
      'X-Api-Request-Id': requestId
    },
    handshakeTimeout: 15000
  });

  let gotLast = false;
  let seenLogid = '';

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${config.timeoutMs}ms`));
      try {
        ws.close();
      } catch {
        // ignore
      }
    }, config.timeoutMs);

    ws.on('upgrade', (res) => {
      seenLogid = String(res.headers['x-tt-logid'] || '');
      console.log('UPGRADE_OK', JSON.stringify({
        statusCode: res.statusCode,
        connectId: res.headers['x-api-connect-id'] || connectId,
        logid: seenLogid || null
      }));
    });

    ws.on('open', () => {
      const fullPayload = {
        user: { uid: 'preflight' },
        audio: {
          format: 'pcm',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1
        },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
          show_utterances: true,
          result_type: 'full'
        }
      };

      ws.send(buildFullClientRequest(1, fullPayload));
      // 400ms silent audio in two 200ms packets
      ws.send(buildAudioOnlyRequest(2, Buffer.alloc(6400, 0), false));
      ws.send(buildAudioOnlyRequest(3, Buffer.alloc(6400, 0), true));
    });

    ws.on('message', (frame) => {
      try {
        const parsed = parseServerFrame(frame);
        if (parsed.messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
          const err = new Error('Received server error frame');
          err.detail = parsed;
          reject(err);
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }

        if (parsed.isLast) {
          gotLast = true;
          clearTimeout(timer);
          resolve(parsed);
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      } catch (err) {
        reject(err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', (code, reasonBuf) => {
      if (!gotLast) {
        const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
        clearTimeout(timer);
        reject(new Error(`Closed before final frame. code=${code} reason=${reason}`));
      }
    });
  });

  const text = result?.json?.result?.text || '';
  console.log('PASS', JSON.stringify({
    wsUrl: config.volcWsUrl,
    resourceId: config.volcResourceId,
    model: config.modelName,
    logid: seenLogid || null,
    finalTextLength: text.length
  }));
}

run().catch((err) => {
  fail(err.message || 'Unknown preflight failure', err.detail || null);
});
