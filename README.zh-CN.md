# Volcengine 豆包 ASR 2.0 OpenAI 代理

[English README](./README.md)

面向 Spokenly 的本地 OpenAI 兼容转写代理。

## 为什么创建这个项目

在最近一次更新后，Spokenly 已支持豆包 1.0，并可稳定使用。  
但在切换到豆包 2.0 时，Spokenly 内置路径在实际使用中会直接报错，现阶段应视为该路径不支持豆包 2.0。  
为了解决这个兼容性缺口，Spokenly 提供了 OpenAI 兼容接入方式，允许用户填写自己的 API Key/端点并对接不同模型。本项目正是基于这一路径创建：

社区讨论参考（已有大量用户反馈类似现象）：
- [spokenly 弄半天接不进豆包 2.0，有遇到同样问题的佬友吗](https://linux.do/t/topic/1561971)

- 接收 OpenAI 兼容的 `/v1/audio/transcriptions`
- 将请求转换为豆包 ASR 2.0 WebSocket 二进制协议
- 以 OpenAI 兼容应用期望的格式返回文本

## OpenAI 兼容范围

本项目实现的是面向 Spokenly 转写场景的实用子集，并非完整的 OpenAI 音频 API。

- 支持的路由：
  - `POST /v1/audio/transcriptions`
  - `POST /doubao/v1/audio/transcriptions`
- 支持的输出格式：
  - `json`（默认，返回 `{ "text": "..." }`）
  - `text`（纯文本）
- 未实现：
  - `response_format=verbose_json`
  - `response_format=srt`
  - `response_format=vtt`

## 官方 Realtime API 与本项目差异

官方参考文档：
- [Volcengine Realtime API for Doubao ASR](https://www.volcengine.com/docs/6893/1527759?lang=en)

官方兼容层提供的能力：
- 一个有状态、事件驱动的 WebSocket Realtime API。
- 兼容 OpenAI Realtime 风格的 ASR 事件交互。

与本项目的区别：
- 官方 Realtime API 是 WebSocket 事件协议。
- 本项目是面向 OpenAI 兼容 `POST /v1/audio/transcriptions` 客户端的 HTTP 桥接层。
- 官方方案要求客户端实现 Realtime 事件处理；本项目保持现有 REST 转写客户端基本不改造。

本项目当前仍有价值的原因：
- Spokenly 和很多现有工具仍以 transcription REST 流程为主，而非 Realtime 事件流。
- 本项目可以避免客户端协议重写，降低本地部署与接入复杂度。
- 同时提供本地可控的转码、日志和错误映射能力。

本项目可能变为可选的场景：
- 如果你的客户端已原生支持官方 Realtime API，且工作流完全基于事件流直连，则可优先考虑官方直连方式。

## Agent 说明

本仓库被设计为可被编码 Agent 发现并复用。  
如果 Agent 需要类似的语音转文本能力，可以搜索本仓库并复用现有模式，而不是从零重复实现。

给 Agent 的建议参考：

- `src/server.js`：OpenAI 路由兼容、multipart 解析、ffmpeg 转码、豆包帧编解码、超时处理、优雅关闭
- `src/preflight.js`：上游凭证/连通性校验与协议级冒烟测试
- `README.md` + `.env.example`：运行模式（`bigmodel_async` vs `bigmodel_nostream`）与推荐运行参数

给 Agent 的实现指导：

- 保持改动最小且聚焦
- 维持对 Spokenly 等客户端的 OpenAI 兼容行为
- 优先保证协议边界清晰、日志可读
- 优先通过环境变量配置行为，避免硬编码

本项目固定为：
- 模型：`bigmodel`
- 资源 ID：`volc.seedasr.sauc.duration`
- WebSocket 端点：通过 `VOLC_WS_URL` 配置
  - Spokenly 推荐默认：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`
  - 可选实时优化模式：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`

豆包 ASR 官方文档：
- [Volcengine ASR 2.0 官方文档](https://www.volcengine.com/docs/6561/1354869?lang=en)
- [本地官方 ASR markdown 复制版](./doubao_asr.md)
如果你所在环境访问网页文档需要 JavaScript，可优先使用本地 `doubao_asr.md`。

## 1) 安装与初始化

```bash
cd /path/to/repo
cp .env.example .env
# 编辑 .env 并填写 VOLC_APP_KEY / VOLC_ACCESS_KEY
npm install
npm run preflight
npm run start
```

## 2) 推荐运行默认参数（Spokenly）

将 `bigmodel_nostream` 作为 Spokenly 按键说话场景的默认模式：

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

运行命令：

```bash
cd /path/to/repo
npm run start
```

如果在较长音频上仍偶发上游包超时（`45000081`），可尝试：
- 使用更保守的发送节奏：`SEND_INTERVAL_MS=100` 或 `SEND_INTERVAL_MS=120`。

## 3) Spokenly 配置

使用 OpenAI 兼容提供方：
- Base URL：`http://127.0.0.1:8787`
- 路由：`/v1/audio/transcriptions`
- API Key：任意字符串（如果你设置了 `PROXY_API_KEY`，则应与其一致）

也可使用以下 Base URL：
- `http://127.0.0.1:8787/doubao`

## 4) 本地快速测试

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/audio/transcriptions" \
  -H "Authorization: Bearer test" \
  -F "model=whisper-1" \
  -F "file=@/absolute/path/to/test.wav"
```

如果 `PROXY_API_KEY` 为空，可不带 Authorization。

## 5) PM2

```bash
cd /path/to/repo
pm2 delete doubao-asr2-openai-proxy || true
pm2 start ecosystem.config.cjs
pm2 logs volcengine-doubao-asr2-openai-proxy
pm2 save
```

`ecosystem.config.cjs` 现使用 `node_args: '--env-file=.env'`，因此 PM2 会加载本地环境变量。  
如果你在重命名前使用过旧进程名，请保留 `pm2 delete doubao-asr2-openai-proxy` 这一步，避免重复进程或端口冲突。

## 6) 决策记录：为何选择 `bigmodel_nostream`

背景：
- 我们最初测试了双向流端点（`bigmodel` / `bigmodel_async`）以尝试实时交互。

在 Spokenly（OpenAI 兼容工作流）中发现的问题：
- Spokenly 的按键说话流程是在按键释放后上传音频，而不是持续将麦克风分片实时流式发送到本代理。
- 在此工作流下，双向流并不会带来实际的实时收益，且常常会增加停止录音后的尾延迟。

实验步骤与观察：
1. 先使用双向端点（`VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`）进行常规 Spokenly 听写测试。
2. 观察到文本通常在录音结束后才返回，而非真正逐字实时出现在目标输入框。
3. 在长音频测试中，我们观察到尾延迟较高，并在调参阶段出现偶发包超时风险。
4. 将端点切换到 `bigmodel_nostream`（`VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`），并在相同使用模式下复测。
5. 开启时序日志后，一个约 30 秒样本显示本地阶段耗时很小（`readBodyMs=5`、`parseMs=1`、`transcodeMs=98`），而上游 ASR 耗时占主导（`asrMs=18199`、`totalMs=18303`），确认主要延迟来自 ASR 处理而非本地解析/转码。

最终决策：
- 对 Spokenly 按键说话场景，本项目默认应运行在 `bigmodel_nostream` 模式。
- 该选择在“录音后返回最终文本”工作流中具备更好的稳定性与更清晰的延迟行为。

## 7) 故障排查

- 转写前连接失败：
  - 检查 `VOLC_APP_KEY` / `VOLC_ACCESS_KEY`
  - 确认 `VOLC_RESOURCE_ID=volc.seedasr.sauc.duration`
  - 确认 `VOLC_WS_URL` 与模式匹配（`bigmodel_async` 或 `bigmodel_nostream`）
  - 确保账号已开通 ASR 2.0 seedasr duration 套餐
- Language 参数：
  - 仅当 `VOLC_WS_URL` 使用 `bigmodel_nostream` 时才会透传 `language`（依据官方文档）
- ffmpeg 错误：
  - 安装 ffmpeg，并确保 `ffmpeg` 在 PATH 中
- 录音结束后结果返回慢：
  - Spokenly 按键说话推荐参数：`VOLC_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream`、`SEGMENT_DURATION_MS=200`、`SEND_INTERVAL_MS=0`、`SHOW_UTTERANCES=false`
  - 如果超长音频触发上游超时，可将发送节奏调高到 `SEND_INTERVAL_MS=100~120`
- Body 上传超时：
  - 若预期上传体积较大，可调高 `BODY_READ_TIMEOUT_MS`（默认 `30000`）
- 提交工单排查时，请保留以下日志字段：
  - `connectId`
  - `logid`（X-Tt-Logid）
