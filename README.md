# Volcengine Doubao ASR 2.0 OpenAI Proxy

[中文文档 (README.zh-CN)](./README.zh-CN.md)

> 豆包/火山引擎流式语音识别 ASR 2.0 (Seed-ASR) 转 OpenAI 兼容协议的本地代理服务。  
> Converts Volcengine Doubao ASR 2.0 (Seed-ASR) WebSocket binary protocol to OpenAI-compatible `/v1/audio/transcriptions` REST API.

Local OpenAI-compatible transcription proxy for Spokenly and any OpenAI-compatible client.

## Why This Project Exists

In a recent update, Spokenly added support for Doubao 1.0, and it works reliably in that mode.
However, when switching to Doubao 2.0, Spokenly's built-in path returns direct errors in practice, and Doubao 2.0 should be treated as unsupported in this path at this stage.
To bridge this gap, Spokenly provides an OpenAI-compatible integration path where users can supply their own API keys/endpoints and connect different models. This project was created around that path:

Community discussion reference (many users reporting similar behavior):
- [spokenly 弄半天接不进豆包 2.0，有遇到同样问题的佬友吗](https://linux.do/t/topic/1561971)

- accept OpenAI-compatible `/v1/audio/transcriptions`
- translate requests to Doubao ASR 2.0 WebSocket binary protocol
- return text in the format expected by OpenAI-compatible apps

## OpenAI Compatibility Scope

This project implements a practical subset for Spokenly-style transcription workflows, not the full OpenAI audio API surface.

- supported routes:
  - `POST /v1/audio/transcriptions`
  - `POST /doubao/v1/audio/transcriptions`
- supported output formats:
  - `json` (default, returns `{ "text": "..." }`)
  - `text` (plain text)
- not implemented:
  - `response_format=verbose_json`
  - `response_format=srt`
  - `response_format=vtt`

## Official Realtime API vs This Proxy

Official reference:
- [Volcengine Realtime API for Doubao ASR](https://www.volcengine.com/docs/6893/1527759?lang=en)

What the official layer provides:
- A stateful, event-driven WebSocket Realtime API.
- Compatibility with OpenAI Realtime-style events for ASR sessions.

How it differs from this project:
- Official Realtime API is a WebSocket event protocol.
- This project is an HTTP bridge for OpenAI-compatible `POST /v1/audio/transcriptions` clients.
- Official integration expects clients to implement Realtime event handling; this proxy keeps existing REST transcription clients unchanged.

Why this project is still useful:
- Spokenly and many existing tools are built around transcription REST flows rather than Realtime events.
- This proxy avoids client-side protocol rewrites and keeps deployment simple for local workflows.
- It also provides local control over transcoding, logging, and error mapping.

When this proxy may be optional:
- If your client natively supports the official Realtime API and your workflow is fully event-driven, direct integration can be a better fit.

## Agent Notes

This repository is intended to be discoverable and reusable by coding agents.
If an agent needs similar speech-to-text behavior, it can search this repository and reuse the existing patterns instead of re-implementing from scratch.

Suggested references for agents:

- `src/server.js`: OpenAI route compatibility, multipart parsing, ffmpeg transcoding, Doubao frame encode/decode, timeout handling, graceful shutdown
- `src/preflight.js`: upstream credential/connectivity validation and protocol-level smoke test
- `README.md` + `.env.example`: operational modes (`bigmodel_async` vs `bigmodel_nostream`) and recommended runtime parameters

Implementation guideline for agents:

- keep changes minimal and focused
- preserve OpenAI-compatible behavior for clients like Spokenly
- prioritize clean protocol boundaries and readable logging
- prefer configurable behavior via env vars over hardcoding

This project is fixed to:
- model: `bigmodel`
- resource id: `volc.seedasr.sauc.duration`
- websocket endpoint: configurable via `VOLC_WS_URL`
  - recommended default for Spokenly: `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`
  - optional realtime-optimized mode: `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`

Official Doubao ASR documentation:
- [Volcengine ASR 2.0 Official Docs](https://www.volcengine.com/docs/6561/1354869?lang=en)
- [Local official ASR markdown copy](./doubao_asr.md)
If the web docs page requires JavaScript in your environment, use `doubao_asr.md` as the local reference.

## 1) Setup

```bash
cd /path/to/repo
cp .env.example .env
# edit .env and fill VOLC_APP_KEY / VOLC_ACCESS_KEY
npm install
npm run preflight
npm run start
```

## 2) Recommended Runtime Defaults (Spokenly)

Use `bigmodel_nostream` as the default mode for Spokenly push-to-talk:

```bash
VOLC_RESOURCE_ID=volc.seedasr.sauc.duration
VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
VOLC_MODEL_NAME=bigmodel

SEGMENT_DURATION_MS=200
SEND_INTERVAL_MS=0
SHOW_UTTERANCES=false
RESULT_TYPE=full

BODY_READ_TIMEOUT_MS=30000
REQUEST_TIMEOUT_MS=90000
SHUTDOWN_TIMEOUT_MS=8000
```

Run command:

```bash
cd /path/to/repo
npm run start
```

If you still see occasional upstream packet timeout (`45000081`) on very long audio, try:
- `SEND_INTERVAL_MS=100` or `SEND_INTERVAL_MS=120` for a more conservative pacing.

## 3) Spokenly settings

Use OpenAI-compatible provider:
- Base URL: `http://127.0.0.1:8787`
- Route: `/v1/audio/transcriptions`
- API Key: any string (or exactly `PROXY_API_KEY` if you set it)

Alternative base URL also works:
- `http://127.0.0.1:8787/doubao`

## 4) Local quick test

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/audio/transcriptions" \
  -H "Authorization: Bearer test" \
  -F "model=whisper-1" \
  -F "file=@/absolute/path/to/test.wav"
```

If `PROXY_API_KEY` is empty, Authorization is optional.

## 5) PM2

```bash
cd /path/to/repo
pm2 delete doubao-asr2-openai-proxy || true
pm2 start ecosystem.config.cjs
pm2 logs volcengine-doubao-asr2-openai-proxy
pm2 save
```

`ecosystem.config.cjs` now uses `node_args: '--env-file=.env'` so PM2 loads your local env values.
If you used the old process name before rename, keep the `pm2 delete doubao-asr2-openai-proxy` step to avoid duplicate processes or port conflicts.

## 6) Decision Record: Why `bigmodel_nostream`

Background:
- We initially tested bidirectional streaming endpoints (`bigmodel` / `bigmodel_async`) to try realtime interaction.

Problem found in Spokenly (OpenAI-compatible workflow):
- Spokenly push-to-talk uploads audio after key release, instead of continuously streaming microphone packets to this proxy.
- In this workflow, bidirectional streaming does not provide practical realtime benefit, and often increases post-stop latency.

Experiment steps and observations:
1. Start with bidirectional endpoint (`VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`) and run normal Spokenly dictation tests.
2. Observe that text is usually returned after recording ends, not truly character-by-character in target input fields.
3. In long-audio tests, we observed high tail latency and occasional packet-timeout risks during tuning.
4. Switch to `bigmodel_nostream` endpoint (`VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`) and re-test with the same usage pattern.
5. With timing logs enabled, one ~30s sample showed local stages were small (`readBodyMs=5`, `parseMs=1`, `transcodeMs=98`) while upstream ASR dominated (`asrMs=18199`, `totalMs=18303`), confirming the main latency is in ASR processing rather than local parsing/transcoding.

Final decision:
- For Spokenly push-to-talk usage, this project should run in `bigmodel_nostream` mode by default.
- This gives better stability and clearer latency behavior for "record-then-return-final-text" workflows.

## 7) Troubleshooting

- Connection failed before transcription:
  - check `VOLC_APP_KEY` / `VOLC_ACCESS_KEY`
  - verify `VOLC_RESOURCE_ID=volc.seedasr.sauc.duration`
  - verify `VOLC_WS_URL` matches your mode (`bigmodel_async` or `bigmodel_nostream`)
  - ensure the account has access to ASR 2.0 seedasr duration package
- Language parameter:
  - `language` is only forwarded when `VOLC_WS_URL` uses `bigmodel_nostream` (per official doc)
- ffmpeg error:
  - install ffmpeg and make sure `ffmpeg` is in PATH
- Slow result after recording ends:
  - recommended for Spokenly push-to-talk: `VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`, `SEGMENT_DURATION_MS=200`, `SEND_INTERVAL_MS=0`, `SHOW_UTTERANCES=false`
  - if very long audio causes upstream timeout, increase pacing to `SEND_INTERVAL_MS=100~120`
- Body upload timeout:
  - tune `BODY_READ_TIMEOUT_MS` (default `30000`) if very large uploads are expected
- For support tickets, keep logs with:
  - `connectId`
  - `logid` (X-Tt-Logid)
