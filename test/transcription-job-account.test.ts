import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Shorty } from '../nodes/Shorty/Shorty.node';
import {
	executeContext,
	MockHttp,
	rejection,
	sampleJob,
	sampleTranscription,
	type MockResponse,
} from './helpers';

const node = new Shorty();
const API = 'https://aishorty.com';

function transcribeParams(overrides: IDataObject = {}): IDataObject {
	return {
		resource: 'transcription',
		operation: 'create',
		url: 'https://example.com/episode.mp3',
		waitForCompletion: false,
		timeout: 600,
		options: {},
		...overrides,
	};
}

async function run(params: IDataObject[], http: MockHttp, continueOnFail = false) {
	return await node.execute.call(executeContext(params, http, { continueOnFail }));
}

const DOWNLOAD_FAILED =
	'Failed to download the audio file from storage. Please check the file URL and try again.';

const ACCEPTED: MockResponse = {
	statusCode: 202,
	body: { job_id: 'tr_1', status: 'queued', tracking_url: '/v1/jobs/tr_1' },
};

const transcriptionJob = (overrides: IDataObject = {}) =>
	sampleJob({
		jobId: 'tr_1',
		output: { jobType: 'TRANSCRIPTION', title: 'Episode 1', outputId: 'tr_1' },
		...overrides,
	});

describe('Transcription > Transcribe', () => {
	it('POSTs the media URL to /v1/transcriptions with an Idempotency-Key and returns the job', async () => {
		const http = new MockHttp([ACCEPTED]);
		const [[item]] = await run([transcribeParams()], http);
		assert.deepEqual(item.json, {
			job_id: 'tr_1',
			status: 'queued',
			finished: false,
			tracking_url: `${API}/v1/jobs/tr_1`,
		});
		const [call] = http.calls;
		assert.strictEqual(call.url, `${API}/v1/transcriptions`);
		assert.deepEqual(call.body, { url: 'https://example.com/episode.mp3' });
		assert.match(String(call.headers['Idempotency-Key']), /^n8n-run:[0-9a-f]{64}$/);
	});

	it('sends the spoken language and the output language when set', async () => {
		const http = new MockHttp([ACCEPTED]);
		await run(
			[
				transcribeParams({
					options: { language: 'english', outputLanguage: 'es', idempotencyKey: 'ep-1' },
				}),
			],
			http,
		);
		assert.deepEqual(http.calls[0].body, {
			url: 'https://example.com/episode.mp3',
			language: 'english',
			output_language: 'es',
		});
		assert.strictEqual(http.calls[0].headers['Idempotency-Key'], 'n8n-transcription:ep-1');
	});

	it('waits by polling the job (which advances it in Shorty), then returns the transcript', async () => {
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: transcriptionJob({ status: 'processing' }) },
			{ statusCode: 200, body: transcriptionJob() },
			{ statusCode: 200, body: sampleTranscription() },
		]);
		const [[item]] = await run([transcribeParams({ waitForCompletion: true })], http);
		assert.strictEqual(http.calls[3].url, `${API}/v1/transcriptions/tr_1`);
		assert.strictEqual(item.json.finished, true);
		assert.strictEqual(item.json.job_id, 'tr_1');
		assert.strictEqual(item.json.output_text, 'Welcome to the show.');
		assert.strictEqual(item.json.transcript_text, 'Welcome to the show.');
	});

	it('keeps reading a transcription while its translation runs, then returns the translation', async () => {
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: transcriptionJob() },
			{
				statusCode: 200,
				body: sampleTranscription({ output_language: 'es', translation_status: 'RUNNING' }),
			},
			{
				statusCode: 200,
				body: sampleTranscription({
					output_language: 'es',
					translation_status: 'SUCCEEDED',
					translated_output_text: 'Bienvenidos al programa.',
				}),
			},
		]);
		const [[item]] = await run(
			[transcribeParams({ waitForCompletion: true, options: { outputLanguage: 'es' } })],
			http,
		);
		assert.strictEqual(item.json.transcript_text, 'Bienvenidos al programa.');
		assert.strictEqual(item.json.output_text, 'Welcome to the show.');
	});

	it('stops the item when the transcription is cancelled', async () => {
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: transcriptionJob({ status: 'cancelled' }) },
		]);
		const error = await rejection(run([transcribeParams({ waitForCompletion: true })], http));
		assert.match(error.message, /could not finish the transcription: the job was cancelled/);
	});

	it('stops a failed transcription with the reason the transcription recorded', async () => {
		// Shorty's job carries no reason; seen live on PROD 2026-11-04 with a host that refused
		// Shorty's download.
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: transcriptionJob({ status: 'error' }) },
			{ statusCode: 200, body: sampleTranscription({ status: 'ERROR', error: DOWNLOAD_FAILED }) },
		]);
		const error = await rejection(run([transcribeParams({ waitForCompletion: true })], http));
		assert.strictEqual(http.calls[2].url, `${API}/v1/transcriptions/tr_1`);
		assert.strictEqual(
			error.message,
			`Shorty could not finish the transcription: ${DOWNLOAD_FAILED}`,
		);
		assert.strictEqual(String(error.description), 'Job ID: tr_1.');
	});

	it('still stops a failed transcription when its reason cannot be read', async () => {
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: transcriptionJob({ status: 'error' }) },
			{ statusCode: 500, body: { code: 'internal_error' } },
		]);
		const error = await rejection(run([transcribeParams({ waitForCompletion: true })], http));
		assert.match(error.message, /could not finish the transcription: the job failed in Shorty/);
	});
});

describe('Transcription > Get, Get Many', () => {
	it('gets one transcription with transcript_text', async () => {
		const http = new MockHttp([{ statusCode: 200, body: sampleTranscription() }]);
		const [[item]] = await run(
			[{ resource: 'transcription', operation: 'get', transcriptionId: ' tr_1 ' }],
			http,
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/transcriptions/tr_1`);
		assert.strictEqual(item.json.transcript_text, 'Welcome to the show.');
	});

	it('lists transcriptions with Return All across pages', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [{ id: 'a' }], has_more: true, next_cursor: 'n1' } },
			{ statusCode: 200, body: { data: [{ id: 'b' }], has_more: false, next_cursor: null } },
		]);
		const items = await run(
			[{ resource: 'transcription', operation: 'getAll', returnAll: true }],
			http,
		);
		assert.deepEqual(
			items[0].map((item) => item.json.id),
			['a', 'b'],
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/transcriptions`);
		assert.deepEqual(http.calls[1].qs, { limit: 100, cursor: 'n1' });
	});
});

describe('Job > Get', () => {
	it('returns the job as Shorty answers it', async () => {
		const http = new MockHttp([{ statusCode: 200, body: sampleJob({ status: 'processing' }) }]);
		const [[item]] = await run(
			[{ resource: 'job', operation: 'get', jobId: 'job_1', waitForCompletion: false }],
			http,
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/jobs/job_1`);
		assert.strictEqual(item.json.status, 'processing');
		assert.strictEqual(http.calls.length, 1);
	});

	it('with Wait for Completion polls until the job finishes', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: sampleJob({ status: 'queued' }) },
			{ statusCode: 200, body: sampleJob({ status: 'processing' }) },
			{ statusCode: 200, body: sampleJob() },
		]);
		const [[item]] = await run(
			[{ resource: 'job', operation: 'get', jobId: 'job_1', waitForCompletion: true, timeout: 60 }],
			http,
		);
		assert.strictEqual(item.json.status, 'success');
		assert.strictEqual(http.calls.length, 3);
	});

	it('does not poll a job that has already finished', async () => {
		const http = new MockHttp([{ statusCode: 200, body: sampleJob({ status: 'error' }) }]);
		const [[item]] = await run(
			[{ resource: 'job', operation: 'get', jobId: 'job_1', waitForCompletion: true, timeout: 60 }],
			http,
		);
		assert.strictEqual(item.json.status, 'error');
		assert.strictEqual(http.calls.length, 1);
	});

	it('reports a missing job with Shorty’s 404 message', async () => {
		const http = new MockHttp([
			{
				statusCode: 404,
				body: { code: 'resource_not_found', detail: 'No job with that id.', request_id: 'req_9' },
			},
		]);
		const error = await rejection(
			run([{ resource: 'job', operation: 'get', jobId: 'nope', waitForCompletion: false }], http),
		);
		assert.match(error.message, /No job with that id/);
		assert.match(String(error.description), /Request ID: req_9/);
	});
});

describe('Account > Get Usage', () => {
	it('returns plan, limits and usage from /v1/usage', async () => {
		const usage = { plan: { tier: 'free', planName: 'Free' }, limits: {}, usage: {} };
		const http = new MockHttp([{ statusCode: 200, body: usage }]);
		const [[item]] = await run([{ resource: 'account', operation: 'getUsage' }], http);
		assert.strictEqual(http.calls[0].url, `${API}/v1/usage`);
		assert.deepEqual(item.json, usage);
	});

	it('explains a 401, an insufficient_scope 403 and a rate limit with Retry-After', async () => {
		const unauthorized = await rejection(
			run(
				[{ resource: 'account', operation: 'getUsage' }],
				new MockHttp([{ statusCode: 401, body: { code: 'invalid_api_key' } }]),
			),
		);
		assert.match(String(unauthorized.description), /shk_live_/);

		const scope = await rejection(
			run(
				[{ resource: 'account', operation: 'getUsage' }],
				new MockHttp([{ statusCode: 403, body: { code: 'insufficient_scope' } }]),
			),
		);
		assert.match(String(scope.description), /missing a permission/);

		const limited = await rejection(
			run(
				[{ resource: 'account', operation: 'getUsage' }],
				new MockHttp([
					{ statusCode: 429, body: { code: 'rate_limited' }, headers: { 'retry-after': '12' } },
				]),
			),
		);
		assert.match(String(limited.description), /Retry after 12 seconds/);
	});

	it('refuses an unknown operation', async () => {
		const error = await rejection(
			run([{ resource: 'account', operation: 'nope' }], new MockHttp()),
		);
		assert.match(error.message, /not supported/);
	});
});
