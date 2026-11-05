import { createHmac } from 'crypto';
import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { REMEMBERED_DELIVERIES, ShortyTrigger } from '../nodes/ShortyTrigger/ShortyTrigger.node';
import { signatureMatches, timestampIsFresh } from '../nodes/ShortyTrigger/signature';
import {
	hookContext,
	MockHttp,
	rejection,
	sampleArticle,
	sampleTranscription,
	WEBHOOK_URL,
	webhookContext,
	type WebhookResponseRecorder,
} from './helpers';

const trigger = new ShortyTrigger();
const API = 'https://aishorty.com';
const ENDPOINT_ID = 'ep_1';
// A Standard Webhooks secret: `whsec_` + base64 of the key bytes.
const SECRET = `whsec_${Buffer.from('a-32-byte-signing-key-for-tests!').toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.from('another-key-that-does-not-match').toString('base64')}`;

/** Signs the way Shorty's src/lib/webhooks/signing.ts does, written out independently. */
function sign(secret: string, id: string, timestamp: string, body: string): string {
	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const digest = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
	return `v1,${digest}`;
}

function nowSeconds(): string {
	return String(Math.floor(Date.now() / 1000));
}

function signedHeaders(
	body: string,
	secret = SECRET,
	id = 'whevt_1',
	timestamp = nowSeconds(),
): IDataObject {
	return {
		'content-type': 'application/json',
		'webhook-id': id,
		'webhook-timestamp': timestamp,
		'webhook-signature': sign(secret, id, timestamp, body),
	};
}

function envelope(type: string, data: IDataObject = {}): string {
	return JSON.stringify({ type, timestamp: '2026-11-04T12:00:00.000Z', data });
}

const SUMMARY_JOB = {
	jobId: 'job_1',
	status: 'success',
	output: { jobType: 'CONTENT_SUMMARY', title: 'Example Domain', outputId: 'art_1' },
};
const TRANSCRIPTION_JOB = {
	jobId: 'tr_1',
	status: 'success',
	output: { jobType: 'TRANSCRIPTION', title: 'Episode 1', outputId: 'tr_1' },
};
const FAILED_JOB = {
	jobId: 'job_2',
	status: 'error',
	progress: 40,
	error: 'Transcription failed: unreadable audio',
	output: {},
};
/** What Shorty actually sends for a failed transcription: the job, with no reason in it. */
const FAILED_TRANSCRIPTION_JOB = {
	jobId: 'tr_2',
	status: 'error',
	output: { jobType: 'TRANSCRIPTION', title: 'Episode 2', outputId: 'tr_2' },
};

async function receive(options: {
	body: string;
	headers: IDataObject;
	events?: string[];
	staticData?: IDataObject;
	http?: MockHttp;
	includeResult?: boolean;
}) {
	const recorder: WebhookResponseRecorder = {};
	const http = options.http ?? new MockHttp();
	const staticData = options.staticData ?? { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
	const result = await trigger.webhook.call(
		webhookContext({
			parameters: {
				events: options.events ?? ['job.succeeded', 'job.failed'],
				options:
					options.includeResult === undefined ? {} : { includeResult: options.includeResult },
			},
			staticData,
			headers: options.headers,
			rawBody: options.body,
			http,
			recorder,
		}),
	);
	return { result, recorder, http, staticData };
}

function endpoint(overrides: IDataObject = {}): IDataObject {
	return {
		id: ENDPOINT_ID,
		url: WEBHOOK_URL,
		description: 'n8n: Daily digest',
		event_types: ['job.succeeded'],
		enabled: true,
		verified_at: '2026-11-04T12:00:00.000Z',
		disabled_at: null,
		disabled_reason: null,
		created_at: '2026-11-04T12:00:00.000Z',
		...overrides,
	};
}

const hooks = trigger.webhookMethods.default;

describe('Shorty Trigger > activation', () => {
	it('registers the n8n webhook URL for the chosen events and keeps the id and secret', async () => {
		const http = new MockHttp([
			{ statusCode: 201, body: { endpoint: endpoint(), secret: SECRET } },
		]);
		const staticData: IDataObject = {};
		await hooks.create.call(hookContext({ events: ['job.succeeded'] }, staticData, http));

		const [call] = http.calls;
		assert.strictEqual(call.credentialName, 'shortyApi');
		assert.strictEqual(call.method, 'POST');
		assert.strictEqual(call.url, `${API}/v1/webhook-endpoints`);
		assert.deepEqual(call.body, {
			url: WEBHOOK_URL,
			event_types: ['job.succeeded'],
			description: 'n8n: Daily digest',
		});
		assert.deepEqual(staticData, { webhookId: ENDPOINT_ID, webhookSecret: SECRET });
	});

	it('removes an endpoint Shorty could not verify and fails the activation', async () => {
		const http = new MockHttp([
			{ statusCode: 201, body: { endpoint: endpoint({ verified_at: null }), secret: SECRET } },
			{ statusCode: 200, body: { id: ENDPOINT_ID, deleted: true } },
		]);
		const staticData: IDataObject = {};
		const error = await rejection(
			hooks.create.call(hookContext({ events: ['job.succeeded'] }, staticData, http)),
		);
		assert.match(error.message, /could not reach n8n's webhook URL/);
		assert.strictEqual(http.calls[1].method, 'DELETE');
		assert.strictEqual(http.calls[1].url, `${API}/v1/webhook-endpoints/${ENDPOINT_ID}`);
		assert.deepEqual(staticData, {});
	});

	it('removes an endpoint created without a secret and fails the activation', async () => {
		const http = new MockHttp([
			{ statusCode: 201, body: { endpoint: endpoint() } },
			{ statusCode: 200, body: { id: ENDPOINT_ID, deleted: true } },
		]);
		const error = await rejection(
			hooks.create.call(hookContext({ events: ['job.succeeded'] }, {}, http)),
		);
		assert.match(error.message, /without returning its signing secret/);
		assert.strictEqual(http.calls[1].method, 'DELETE');
	});

	it("names n8n's URL when Shorty refuses it (a localhost or non-HTTPS n8n)", async () => {
		const http = new MockHttp([
			{
				statusCode: 400,
				body: { code: 'validation_failed', detail: 'Invalid webhook URL: must be https' },
			},
		]);
		const error = await rejection(
			hooks.create.call(
				hookContext({ events: ['job.succeeded'] }, {}, http, 'http://localhost:5678/webhook/x'),
			),
		);
		assert.match(
			error.message,
			/refused n8n's webhook URL \(http:\/\/localhost:5678\/webhook\/x\)/,
		);
	});

	it('explains the 5-endpoint cap', async () => {
		const http = new MockHttp([
			{
				statusCode: 429,
				body: { code: 'quota_exhausted', detail: 'You can have at most 5 webhook endpoints.' },
			},
		]);
		const error = await rejection(
			hooks.create.call(hookContext({ events: ['job.succeeded'] }, {}, http)),
		);
		assert.match(error.message, /at most 5 webhook endpoints/);
	});

	it('reports nothing registered when no id or secret is stored, without a request', async () => {
		const http = new MockHttp();
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['job.succeeded'] }, {}, http)),
			false,
		);
		assert.strictEqual(http.calls.length, 0);
	});

	it('keeps a registered endpoint whose URL, events and state still match', async () => {
		const http = new MockHttp([{ statusCode: 200, body: { data: [endpoint()] } }]);
		const staticData = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['job.succeeded'] }, staticData, http)),
			true,
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/webhook-endpoints`);
	});

	for (const [label, changed] of [
		['another URL', { url: 'https://old.example.com/webhook/abc' }],
		['other events', { event_types: ['job.failed'] }],
		['an auto-disabled endpoint', { enabled: false, disabled_reason: 'auto_failure_ladder' }],
		['an unverified endpoint', { verified_at: null }],
	] as Array<[string, IDataObject]>) {
		it(`replaces ${label}: deletes it and asks create to register again`, async () => {
			const http = new MockHttp([
				{ statusCode: 200, body: { data: [endpoint(changed)] } },
				{ statusCode: 200, body: { id: ENDPOINT_ID, deleted: true } },
			]);
			const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
			assert.strictEqual(
				await hooks.checkExists.call(hookContext({ events: ['job.succeeded'] }, staticData, http)),
				false,
			);
			assert.strictEqual(http.calls[1].method, 'DELETE');
			assert.deepEqual(staticData, {});
		});
	}

	it('forgets an endpoint that was deleted in Shorty', async () => {
		const http = new MockHttp([{ statusCode: 200, body: { data: [] } }]);
		const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		assert.strictEqual(
			await hooks.checkExists.call(hookContext({ events: ['job.succeeded'] }, staticData, http)),
			false,
		);
		assert.deepEqual(staticData, {});
	});

	it('deletes the endpoint on deactivation, and treats 404 as already gone', async () => {
		for (const statusCode of [200, 404]) {
			const http = new MockHttp([{ statusCode, body: {} }]);
			const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
			assert.strictEqual(await hooks.delete.call(hookContext({}, staticData, http)), true);
			assert.strictEqual(http.calls[0].method, 'DELETE');
			assert.strictEqual(http.calls[0].url, `${API}/v1/webhook-endpoints/${ENDPOINT_ID}`);
			assert.deepEqual(staticData, {});
		}
	});

	it('keeps the id when the delete fails, so a later deactivation can retry', async () => {
		const http = new MockHttp([{ statusCode: 500, body: {} }]);
		const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		assert.strictEqual(await hooks.delete.call(hookContext({}, staticData, http)), false);
		assert.strictEqual(staticData.webhookId, ENDPOINT_ID);
	});
});

describe('Shorty Trigger > deliveries', () => {
	it("answers Shorty's verification ping 200 before any secret is stored, starting nothing", async () => {
		const body = envelope('ping', { message: 'Shorty webhook verification' });
		const { result, http } = await receive({
			body,
			// Signed with a secret the node does not hold yet.
			headers: signedHeaders(body, OTHER_SECRET),
			staticData: {},
		});
		assert.deepEqual(result, { webhookResponse: { received: true } });
		assert.strictEqual(http.calls.length, 0);
	});

	it('starts the workflow for a signed job.failed with the job fields', async () => {
		const body = envelope('job.failed', FAILED_JOB);
		const { result, staticData } = await receive({ body, headers: signedHeaders(body) });
		const [[item]] = result.workflowData ?? [];
		assert.deepEqual(item.json, {
			event: 'job.failed',
			event_id: 'whevt_1',
			occurred_at: '2026-11-04T12:00:00.000Z',
			test: false,
			job_id: 'job_2',
			status: 'error',
			job_type: null,
			title: null,
			output_id: null,
			error: 'Transcription failed: unreadable audio',
			job: FAILED_JOB,
		});
		assert.deepEqual(staticData.deliveryIds, ['whevt_1']);
	});

	it('fills in the reason a transcription failed, which the job.failed event does not carry', async () => {
		const body = envelope('job.failed', FAILED_TRANSCRIPTION_JOB);
		const http = new MockHttp([
			{
				statusCode: 200,
				body: sampleTranscription({ id: 'tr_2', status: 'ERROR', error: 'Download refused' }),
			},
		]);
		const { result, recorder } = await receive({ body, headers: signedHeaders(body), http });
		assert.strictEqual(recorder.statusCode, 200);
		assert.strictEqual(result.noWebhookResponse, true);
		assert.strictEqual(http.calls[0].url, `${API}/v1/transcriptions/tr_2`);
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.error, 'Download refused');
		assert.strictEqual(item.json.job_type, 'TRANSCRIPTION');
		assert.strictEqual(item.json.transcription, undefined);
	});

	it('leaves the failure reason empty with Include Result off, or when it cannot be read', async () => {
		const body = envelope('job.failed', FAILED_TRANSCRIPTION_JOB);
		const off = await receive({ body, headers: signedHeaders(body), includeResult: false });
		assert.strictEqual(off.http.calls.length, 0);
		assert.strictEqual(off.result.workflowData?.[0][0].json.error, null);

		const unreadable = await receive({
			body,
			headers: signedHeaders(body, SECRET, 'whevt_2'),
			http: new MockHttp([{ statusCode: 404, body: { code: 'resource_not_found' } }]),
		});
		assert.strictEqual(unreadable.result.workflowData?.[0][0].json.error, null);
	});

	it('reads the finished summary back after answering Shorty first', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const http = new MockHttp([{ statusCode: 200, body: sampleArticle() }]);
		const { result, recorder } = await receive({ body, headers: signedHeaders(body), http });
		assert.strictEqual(recorder.statusCode, 200);
		assert.strictEqual(result.noWebhookResponse, true);
		assert.strictEqual(http.calls[0].url, `${API}/v1/articles/art_1`);
		const [[item]] = result.workflowData ?? [];
		const summary = item.json.summary as IDataObject;
		assert.strictEqual(summary.article_id, 'art_1');
		assert.strictEqual(summary.job_id, 'job_1');
		assert.match(String(summary.summary_text), /## Key points/);
	});

	it('reads the finished transcription back for a transcription job', async () => {
		const body = envelope('job.succeeded', TRANSCRIPTION_JOB);
		const http = new MockHttp([{ statusCode: 200, body: sampleTranscription() }]);
		const { result } = await receive({ body, headers: signedHeaders(body), http });
		assert.strictEqual(http.calls[0].url, `${API}/v1/transcriptions/tr_1`);
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(
			(item.json.transcription as IDataObject).transcript_text,
			'Welcome to the show.',
		);
	});

	it('still emits the item, with the result null, when the read-back fails', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const http = new MockHttp([{ statusCode: 500, body: {} }]);
		const { result } = await receive({ body, headers: signedHeaders(body), http });
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.summary, null);
		assert.strictEqual(item.json.job_id, 'job_1');
	});

	it('skips the read-back with Include Result off', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const { result, http } = await receive({
			body,
			headers: signedHeaders(body),
			includeResult: false,
		});
		assert.strictEqual(http.calls.length, 0);
		assert.strictEqual(result.workflowData?.[0][0].json.output_id, 'art_1');
	});

	it('refuses a delivery whose signature does not match, with 401 and no workflow run', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const { result, recorder } = await receive({
			body,
			headers: signedHeaders(body, OTHER_SECRET),
		});
		assert.strictEqual(recorder.statusCode, 401);
		assert.strictEqual(result.workflowData, undefined);
	});

	it('refuses a body changed after signing', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const tampered = body.replace('art_1', 'art_9');
		const { recorder } = await receive({ body: tampered, headers: signedHeaders(body) });
		assert.strictEqual(recorder.statusCode, 401);
	});

	it('refuses a delivery with no stored secret or missing headers', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const noSecret = await receive({ body, headers: signedHeaders(body), staticData: {} });
		assert.strictEqual(noSecret.recorder.statusCode, 401);
		const noHeaders = await receive({ body, headers: { 'content-type': 'application/json' } });
		assert.strictEqual(noHeaders.recorder.statusCode, 401);
	});

	it('refuses a delivery signed more than 5 minutes ago (a replay)', async () => {
		const body = envelope('job.succeeded', SUMMARY_JOB);
		const old = String(Math.floor(Date.now() / 1000) - 6 * 60);
		const { recorder, result } = await receive({
			body,
			headers: signedHeaders(body, SECRET, 'whevt_1', old),
		});
		assert.strictEqual(recorder.statusCode, 401);
		assert.strictEqual(result.workflowData, undefined);
	});

	it('accepts either signature during a secret rotation', async () => {
		const body = envelope('job.failed', FAILED_JOB);
		const headers = signedHeaders(body);
		const ts = String(headers['webhook-timestamp']);
		headers['webhook-signature'] =
			`${sign(OTHER_SECRET, 'whevt_1', ts, body)} ${String(headers['webhook-signature'])}`;
		const { result } = await receive({ body, headers });
		assert.strictEqual(result.workflowData?.[0].length, 1);
	});

	it('answers 200 without running for an event the trigger did not choose', async () => {
		const body = envelope('job.failed', FAILED_JOB);
		const { result } = await receive({
			body,
			headers: signedHeaders(body),
			events: ['job.succeeded'],
		});
		assert.deepEqual(result, { webhookResponse: { received: true } });
	});

	it("runs once per webhook-id: Shorty's retry of the same event starts nothing", async () => {
		const body = envelope('job.failed', FAILED_JOB);
		const staticData: IDataObject = { webhookId: ENDPOINT_ID, webhookSecret: SECRET };
		await receive({ body, headers: signedHeaders(body), staticData });
		const again = await receive({ body, headers: signedHeaders(body), staticData });
		assert.deepEqual(again.result, { webhookResponse: { received: true, duplicate: true } });
	});

	it(`remembers only the last ${REMEMBERED_DELIVERIES} delivery ids`, async () => {
		const body = envelope('job.failed', FAILED_JOB);
		const seen = Array.from({ length: REMEMBERED_DELIVERIES }, (_, index) => `old_${index}`);
		const staticData: IDataObject = {
			webhookId: ENDPOINT_ID,
			webhookSecret: SECRET,
			deliveryIds: seen,
		};
		await receive({ body, headers: signedHeaders(body, SECRET, 'whevt_new'), staticData });
		const ids = staticData.deliveryIds as string[];
		assert.strictEqual(ids.length, REMEMBERED_DELIVERIES);
		assert.strictEqual(ids[ids.length - 1], 'whevt_new');
		assert.strictEqual(ids[0], 'old_1');
	});

	it("passes Shorty's signed Send test event through as test: true, without a read-back", async () => {
		const body = envelope('test.ping', {
			jobId: 'job_test_1',
			status: 'success',
			output: { jobType: 'YOUTUBE_SUMMARY', title: 'Sample', outputId: 'art_test_sample' },
		});
		const { result, http } = await receive({ body, headers: signedHeaders(body) });
		const [[item]] = result.workflowData ?? [];
		assert.strictEqual(item.json.test, true);
		assert.strictEqual(item.json.event, 'test.ping');
		assert.strictEqual(http.calls.length, 0);
	});
});

describe('Shorty Trigger > signature helpers', () => {
	it('matches only v1 signatures over id.timestamp.body with the decoded key', () => {
		const body = '{"type":"job.succeeded"}';
		const valid = sign(SECRET, 'id1', '1700000000', body);
		const check = (signatureHeader: string) =>
			signatureMatches({
				secret: SECRET,
				id: 'id1',
				timestamp: '1700000000',
				body,
				signatureHeader,
			});
		assert.strictEqual(check(valid), true);
		assert.strictEqual(check(valid.replace('v1,', 'v2,')), false);
		assert.strictEqual(check('v1,'), false);
		assert.strictEqual(check('garbage'), false);
		assert.strictEqual(
			signatureMatches({
				secret: SECRET,
				id: 'id2',
				timestamp: '1700000000',
				body,
				signatureHeader: valid,
			}),
			false,
		);
	});

	it('accepts a timestamp within 5 minutes either way, and nothing malformed', () => {
		const now = 1_700_000_000_000;
		assert.strictEqual(timestampIsFresh('1700000000', now), true);
		assert.strictEqual(timestampIsFresh('1700000299', now), true);
		assert.strictEqual(timestampIsFresh('1699999600', now), false);
		assert.strictEqual(timestampIsFresh('17e8', now), false);
		assert.strictEqual(timestampIsFresh('', now), false);
	});
});
