# Changelog

## 0.1.0

First release.

- **Shorty API** credential: an API key (`shk_live_...`), sent as `Authorization: Bearer`, tested with `GET /v1/usage`.
- **Shorty** node (programmatic, usable as an AI Agent tool):
  - Summary: Summarize (YouTube video, web page or pasted text; answers an already-summarized source at once), Get, Get Many, Search, and a searchable Summary dropdown.
  - Transcription: Transcribe (audio or video URL, spoken language, optional output language), Get, Get Many.
  - Job: Get. Account: Get Usage.
  - Wait for Completion on Summarize, Transcribe and Job > Get: polls `GET /v1/jobs/{id}` every 5 seconds up to a timeout, then reads the finished summary or transcription back (and, for a translated transcript, reads it until the translation is done). A job that fails stops the item with Shorty's reason; one still running at the timeout is returned with `finished: false`.
  - Every Summarize and Transcribe carries an `Idempotency-Key` derived from the execution, node, run and item (so Retry On Fail does not start jobs twice), an optional deduplication key, and one same-key retry on a 5xx, a 409 `idempotency_in_progress` or a request that got no answer.
- **Shorty Trigger** node: registers a Shorty webhook endpoint for `job.succeeded` and/or `job.failed`, answers Shorty's verification ping, removes an endpoint Shorty could not verify, verifies the Standard Webhooks signature of every delivery, refuses deliveries signed more than 5 minutes from now, starts the workflow once per `webhook-id`, and can read the finished summary or transcription back after answering Shorty.
