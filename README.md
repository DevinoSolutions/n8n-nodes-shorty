# n8n-nodes-shorty

This is an n8n community node for [Shorty](https://aishorty.com), the AI summarizer by Devino Solutions. It lets you summarize YouTube videos, web pages and articles, and pasted text from your n8n workflows, transcribe audio and video links (podcast episodes included), search and read your summary library, and start workflows when a Shorty job finishes.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Trigger](#trigger)
- [Usage examples](#usage-examples)
- [Use as an AI Agent tool](#use-as-an-ai-agent-tool)
- [Compatibility](#compatibility)
- [Development](#development)
- [Publishing (owner step)](#publishing-owner-step)
- [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

1. In n8n, go to **Settings > Community Nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-shorty` as the npm package name.
4. Accept the risks of using community nodes and select **Install**.

After installation, search for **Shorty** in the nodes panel. The package adds two nodes:

- **Shorty**: summaries, transcriptions, jobs and your account's usage.
- **Shorty Trigger**: starts a workflow when a summary or transcription job succeeds or fails.

## Credentials

The nodes authenticate with a Shorty API key. Every call runs as the account the key belongs to.

1. Sign in to [Shorty](https://aishorty.com).
2. Open **Settings > API Keys** ([open](https://aishorty.com/settings?tab=api-keys)) and create a key (it starts with `shk_live_`). A **Full access** key covers every operation.
3. In n8n, create a new **Shorty API** credential and paste the key into **API Key**.

n8n checks the credential with `GET https://aishorty.com/v1/usage`, which costs no quota. The key is sent as the `Authorization: Bearer <key>` header.

The scopes each part of the package needs, for a custom key:

| Used by | Scopes |
| --- | --- |
| Credential test, Account > Get Usage | `usage:read` |
| Summary > Summarize | `articles:write`, plus `jobs:read` and `articles:read` with **Wait for Completion** |
| Summary > Get, Get Many, Search, the Summary dropdown | `articles:read` |
| Transcription > Transcribe | `transcriptions:write`, plus `jobs:read` and `transcriptions:read` with **Wait for Completion** |
| Transcription > Get, Get Many | `transcriptions:read` |
| Job > Get | `jobs:read` |
| Shorty Trigger | `webhooks:read`, `webhooks:write` (plus `articles:read` and `transcriptions:read` for **Include Result**) |

**Costs and limits.** Every summary and transcription the node starts counts toward the account's plan allowance, exactly as one started in the Shorty app. A transcript in a language other than English is a translation and needs Shorty Premium. The API allows 60 requests a minute on the free plan and 300 on paid plans; **Wait for Completion** polls the job once every 5 seconds. Each active **Shorty Trigger** uses one of the account's 5 webhook endpoints.

## Operations

### Summary

| Operation | What it does | Shorty API |
| --- | --- | --- |
| Summarize | Summarize a **YouTube video** or a **web page** (by URL), or pasted **text**, in the chosen language. With **Wait for Completion** (on by default, up to 5 minutes) the item is the finished summary: `summary_text` (Markdown, one heading per section), `summary_parts`, `title`, `description`, `body_text` (the source text or transcript) and `article_url`. Off, the item is the started job (`job_id`, `status`, `tracking_url`). If the same source was already summarized in that language, Shorty answers at once with the existing summary (`status: already_complete`) and starts nothing. | `POST /v1/summaries`, then `GET /v1/jobs/{id}` and `GET /v1/articles/{id}` |
| Get | Retrieve one summary, in the same shape. **Summary** is a searchable dropdown of your library, or an ID. | `GET /v1/articles/{id}` |
| Get Many | List your summaries, newest first, with Return All or a limit. | `GET /v1/articles` |
| Search | Search your summaries by keywords, optionally by source type (YouTube video, web page, PDF, Word document, text, audio), up to 20 best matches. | `GET /v1/articles/search` |

### Transcription

| Operation | What it does | Shorty API |
| --- | --- | --- |
| Transcribe | Transcribe an audio or video link (a podcast episode, an MP3, a video file). Options: the spoken **Language**, and an **Output Language** to translate the transcript into. With **Wait for Completion** (on by default, up to 10 minutes) the item is the finished transcription with `transcript_text` (the translation when one was asked for, otherwise the transcript). | `POST /v1/transcriptions`, then `GET /v1/jobs/{id}` and `GET /v1/transcriptions/{id}` |
| Get | Retrieve one transcription with its text and `transcript_text`. | `GET /v1/transcriptions/{id}` |
| Get Many | List your transcriptions, newest first, with Return All or a limit. | `GET /v1/transcriptions` |

**Keep Wait for Completion on for transcriptions.** Shorty moves a transcription started over the API forward each time it is read (`GET /v1/jobs/{id}` or `GET /v1/transcriptions`); there is no browser session doing it. Started with Wait for Completion off and never read again, it does not finish, and after about 30 minutes Shorty marks it failed. If you turn it off, read the job with **Job > Get** (Wait for Completion on) later in the workflow.

### Job

| Operation | What it does | Shorty API |
| --- | --- | --- |
| Get | Get a job's `status` (`queued`, `processing`, `success`, `error`, `cancelled`), `progress`, `error` and `output` (`jobType`, `title`, `outputId`, the summary or transcription ID). With **Wait for Completion** the node polls until the job finishes or the timeout passes. | `GET /v1/jobs/{id}` |

### Account

| Operation | What it does | Shorty API |
| --- | --- | --- |
| Get Usage | The account's plan, its limits and its usage. | `GET /v1/usage` |

### Waiting, timeouts and failures

- A job that does not finish within **Timeout** is returned as it stands, with `finished: false`, its `job_id` and `tracking_url`. It keeps running in Shorty; read it later with **Job > Get**.
- A job that fails or is cancelled stops the item with Shorty's own reason and the job ID. With **Continue On Fail** the item carries the error instead.

### Starting a job once

Every Summarize and Transcribe carries an `Idempotency-Key` header, and Shorty answers a repeated key with the first answer for 24 hours instead of starting a second job:

- **Without a Deduplication Key** the key is derived from where the item sits in n8n: the instance, workflow, execution, node, run of the node and input item.
  - The node's own retry (once, with the same key and the same body, after a 5xx, a 409 `idempotency_in_progress` or a request that got no answer) never starts two jobs.
  - n8n's **Retry On Fail** re-runs the whole node, every item included, inside the same execution, so items already started get their first answer back instead of a second job.
  - A loop, or an AI Agent calling the node again, is a new run of the node and starts again, as intended.
  - A manual **Retry** of a failed execution, or running the workflow again, is a new execution with a new ID, and starts again. Only a Deduplication Key prevents that.
- **With a Deduplication Key** (a row or record ID, say) the key is the same in every execution, so Shorty will not start that job again for 24 hours, whatever re-runs the item. The same key with a different body is refused with an error and nothing is started.

## Trigger

**Shorty Trigger** registers a webhook endpoint for your Shorty account when the workflow is activated, and deletes it when the workflow is deactivated. You pick one or both events:

| Event | Fires when |
| --- | --- |
| Job Succeeded | A summary or transcription job finished successfully |
| Job Failed | A job ended with an error |

- **The URL must be public.** Shorty only delivers to a public HTTPS URL on port 443, and refuses private and loopback addresses. n8n Cloud works as it is; a self-hosted n8n needs a public `WEBHOOK_URL` (a reverse proxy or a tunnel). When Shorty refuses the URL, the activation fails with Shorty's reason and the URL it was given.
- **The endpoint is verified first.** While registering, Shorty sends a `ping` to the URL and delivers events only to an endpoint that answered it. The node answers that ping (it never starts the workflow), and if Shorty could not reach the URL the node deletes the endpoint again and fails the activation, so a trigger never sits "active" without receiving anything.
- **Signatures are verified.** Shorty signs every delivery with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256). The node answers `401` to any request whose signature does not match, without starting the workflow. Both signatures sent during a secret rotation are accepted.
- **Replays are refused.** Shorty signs each attempt, retries included, with the time of that attempt, so the node also answers `401` to a delivery whose signed timestamp is more than 5 minutes from the n8n server's clock. Keep that clock synchronised (NTP).
- **Each event starts the workflow once.** Shorty retries a delivery until it gets a `2xx` (9 attempts over about 45 hours), with the same `webhook-id`. The node remembers the last 200 delivery IDs and answers a repeat with `200` without starting the workflow.
- **Where the secret lives.** Shorty returns the signing secret once, when the endpoint is created. The node keeps it, with the endpoint ID and the recent delivery IDs, in the workflow's static data, which n8n stores with the workflow in its database, as it does for its own trigger nodes. **Listen for test event** registers a separate endpoint for the test URL, with its own secret that n8n holds only for the test session.
- **Each item** has `event`, `event_id` (the delivery's `webhook-id`, stable across Shorty's retries), `occurred_at`, `test`, `job_id`, `status`, `job_type` (`YOUTUBE_SUMMARY`, `CONTENT_SUMMARY`, `TRANSCRIPTION`, ...), `title`, `output_id`, `error`, and the raw `job` (the same shape as **Job > Get**).
- **Include Result** (on by default) reads the finished summary (`summary`, the same shape as **Summary > Get**) or transcription (`transcription`) back from Shorty for a succeeded job. The node answers Shorty's request before that read, so the read never delays the answer. If the read fails, the item is still emitted with the result set to `null`. Turn it off to save that API request.
- A **Send test event** from Shorty's **Settings > Webhooks** is passed through with `test: true` and no result.
- On activation the node replaces an endpoint it registered earlier if its URL (n8n's base URL changed), its events or its state (unverified, or disabled by Shorty after 20 failed deliveries) no longer match, deleting the old one in Shorty first.

A transcription started over the API finishes only while something reads it (see [Transcription](#transcription)), so its **Job Succeeded** event arrives when the workflow that started it waits for it or polls it.

## Usage examples

**Summarize new videos.** Start with an **RSS Feed Trigger** on a YouTube channel feed, then add a **Shorty** node: Resource **Summary**, Operation **Summarize**, Source **YouTube Video**, **URL** `{{ $json.link }}`, and under **Options** set **Deduplication Key** to `{{ $json.id }}`. Send `{{ $json.summary_text }}` to Slack, Notion or email.

**Transcribe podcast episodes.** Start with an **RSS Feed Trigger** on the podcast feed, then **Transcription > Transcribe** with **Media URL** `{{ $json.enclosure.url }}` and **Timeout** raised to fit the episode length. Store `{{ $json.transcript_text }}` in a database or a doc.

**React to finished jobs.** Start with **Shorty Trigger** on **Job Succeeded** to post every new summary to a channel, or on **Job Failed** to alert you with `{{ $json.error }}`.

## Use as an AI Agent tool

The **Shorty** node can be used as a tool by n8n's AI Agent node, for example to summarize a link a user sends or to search the summary library. Connect it to the agent's **Tool** input and describe in the tool description what the agent may do. Each summary or transcription the agent starts counts toward the account's plan allowance.

## Compatibility

- Built with the `@n8n/node-cli` scaffold, n8n Nodes API version 1, strict mode.
- Tested with n8n 2.x. AI Agent tool use needs an n8n version that supports `usableAsTool`.
- No runtime dependencies (only `n8n-workflow` as a peer dependency and Node's built-in `crypto`).

## Development

```bash
npm install
npm run lint     # n8n community-node lint (strict)
npm test         # type-checks the tests, then runs them with mocked HTTP
npm run build
npm run dev      # starts a local n8n with the node loaded
```

The tests never reach the network: every request is answered from a queue of canned responses shaped like Shorty's `/v1` OpenAPI document and recorded for assertions.

## Publishing (owner step)

Publishing is an owner step and has not been done. The package is published from GitHub Actions with npm provenance (`.github/workflows/publish.yml`, see its header for the one-time npm setup), which n8n's Creator Portal requires for verified community nodes. Bump the version with `npm run release`, which updates `CHANGELOG.md`, tags and pushes; the tag triggers the publish workflow.

## Resources

- [Shorty developer API](https://aishorty.com/docs/api)
- [Shorty webhooks](https://aishorty.com/docs/api/webhooks)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
