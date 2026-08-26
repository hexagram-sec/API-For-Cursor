# API for Cursor

Local OpenAI-compatible `chat.completions` and `responses` endpoints backed by Cursor models (Composer 2.5, Grok 4.6, and more).

This repository is the **Windows** app: a local Worker + Vite console + Cursor SDK bridge, packaged as an exe. Data stays on the machine (`%APPDATA%\api-for-cursor\`).

## Supported endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`

## Models

- `composer-2.5`
- `composer-2.5-fast`
- `grok-4.6`
- `grok-4.6-fast`
- `grok-4.5`
- `grok-4.5-fast`

## Usage

Start the app (or `npm run dev`). The default base URL is:

```txt
http://127.0.0.1:8787/v1
```

Point any OpenAI-compatible client at the local base URL. Authenticate with a relay key (`sk-...`) from the console, or with a Cursor API key as Bearer. Paste Cursor keys in the app (Dashboard → Integrations → API Keys); do not commit them.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local",
  baseURL: "http://127.0.0.1:8787/v1"
});

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Write a TypeScript debounce." }]
});
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

## Windows package

```bat
npm install
npm run dist:win
```

Outputs land in `dist-win/`. See [WINDOWS.md](WINDOWS.md).

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev
```

Open http://127.0.0.1:5173

Business config (encryption key, SDK listen address, upstream versions) lives in D1. The encryption key is generated on first request if the database does not already have one. You do **not** need a `.dev.vars` file for local `npm run dev`.

If you still have an old `.dev.vars`, the first start will import `ENCRYPTION_KEY` and other values into D1, then ignore the file. After that you can delete `.dev.vars`. Do not rotate `ENCRYPTION_KEY` once Cursor tokens exist in the database.

Optional first-run console password can still be set as `CONSOLE_PASSWORD` in the environment; after the first login the hash is stored in D1 and can be changed from 设置.

Listen host/port for the SDK bridge and the Vite relay can be changed on the settings page. Access logs for `/v1` and `/api/admin` are under 访问日志.

`npm run dev` starts the SDK local-agent bridge automatically (default http://127.0.0.1:8792/sdk). To run it yourself:

```bash
npm run sdk:opencode-bridge
```

The bridge process also accepts `CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS`; the default is `180000`.

## Compatibility notes

This project supports text and image input, non-streaming and streaming output, JSON-output prompt constraints, and the common SDK response shapes. Image inputs can be sent as Chat Completions `image_url` parts or Responses `input_image` parts; each resolved image must be 1MB or smaller.

These OpenAI features are intentionally rejected because Cursor does not expose equivalent OpenAI controls through this path:

- `n` greater than `1`
- `logprobs` and `top_logprobs`
- audio output
- OpenAI function/tool calls on the Responses API
- background Responses API jobs

Token usage is estimated from character counts because Cursor's stream does not return OpenAI token accounting on this path. For Composer 2.5 and the listed Grok models, `usage.cost` is estimated from Cursor's published per-million-token pricing.

## OpenCode

![Composer 2.5 in OpenCode](public/opencode-composer-2-5.webp)

Use **Agent Setup** to install the local OpenCode provider. The configured provider points at the local base URL.

## Research sources

- Cursor SDK package: `@cursor/sdk@1.0.13`
- Cursor SDK TypeScript docs: https://cursor.com/docs/api/sdk/typescript
- Cursor Composer 2.5 changelog: https://cursor.com/changelog/composer-2-5
- Cursor Grok 4.6 docs: https://cursor.com/docs/models/grok-4-6
- Cursor Grok 4.5 docs: https://cursor.com/docs/models/grok-4-5
- OpenAI Chat Completions reference: https://developers.openai.com/api/docs/api-reference/chat
- OpenAI Responses reference: https://developers.openai.com/api/docs/api-reference/responses
- OpenAI migration guide: https://developers.openai.com/api/docs/guides/migrate-to-responses
