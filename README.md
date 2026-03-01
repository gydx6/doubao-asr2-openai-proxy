# Doubao ASR 2.0 OpenAI Proxy

Local OpenAI-compatible transcription proxy for Spokenly.

This project is fixed to:
- model: `bigmodel`
- resource id: `volc.seedasr.sauc.duration`
- websocket: `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`

## 1) Setup

```bash
cd /Users/gg/code/doubao-asr2-openai-proxy
cp .env.example .env
# edit .env and fill VOLC_APP_KEY / VOLC_ACCESS_KEY
npm install
npm run preflight
npm run start
```

## 2) Spokenly settings

Use OpenAI-compatible provider:
- Base URL: `http://127.0.0.1:8787`
- Route: `/v1/audio/transcriptions`
- API Key: any string (or exactly `PROXY_API_KEY` if you set it)

Alternative base URL also works:
- `http://127.0.0.1:8787/doubao`

## 3) Local quick test

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/audio/transcriptions" \
  -H "Authorization: Bearer test" \
  -F "model=whisper-1" \
  -F "file=@/absolute/path/to/test.wav"
```

If `PROXY_API_KEY` is empty, Authorization is optional.

## 4) PM2

```bash
cd /Users/gg/code/doubao-asr2-openai-proxy
pm2 start ecosystem.config.cjs
pm2 logs doubao-asr2-openai-proxy
pm2 save
```

`ecosystem.config.cjs` now uses `node_args: '--env-file=.env'` so PM2 loads your local env values.

## 5) Troubleshooting

- Connection failed before transcription:
  - check `VOLC_APP_KEY` / `VOLC_ACCESS_KEY`
  - verify `VOLC_RESOURCE_ID=volc.seedasr.sauc.duration`
  - verify `VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
  - ensure the account has access to ASR 2.0 seedasr duration package
- ffmpeg error:
  - install ffmpeg and make sure `ffmpeg` is in PATH
- Slow result after recording ends:
  - long audio stability profile (recommended): `SEGMENT_DURATION_MS=200`, `SEND_INTERVAL_MS=120`, `SHOW_UTTERANCES=false`
  - faster forwarding profile: `SEGMENT_DURATION_MS=1000`, `SEND_INTERVAL_MS=0` (may be less stable for long recordings)
- Body upload timeout:
  - tune `BODY_READ_TIMEOUT_MS` (default `30000`) if very large uploads are expected
- For support tickets, keep logs with:
  - `connectId`
  - `logid` (X-Tt-Logid)
