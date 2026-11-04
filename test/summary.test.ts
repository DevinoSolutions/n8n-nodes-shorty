import { assert, describe, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { Shorty } from '../nodes/Shorty/Shorty.node';
import {
	executeContext,
	locator,
	MockHttp,
	rejection,
	sampleArticle,
	sampleJob,
	type ExecutionPosition,
	type MockResponse,
} from './helpers';

const node = new Shorty();
const API = 'https://aishorty.com';

function summarizeParams(overrides: IDataObject = {}): IDataObject {
	return {
		resource: 'summary',
		operation: 'create',
		source: 'url',
		url: 'https://example.com',
		waitForCompletion: false,
		timeout: 300,
		options: {},
		...overrides,
	};
}

async function run(
	params: IDataObject[],
	http: MockHttp,
	options: { continueOnFail?: boolean; position?: ExecutionPosition } = {},
) {
	return await node.execute.call(executeContext(params, http, options));
}

const ACCEPTED: MockResponse = {
	statusCode: 202,
	body: { job_id: 'job_1', status: 'queued', tracking_url: '/v1/jobs/job_1' },
};

const SUMMARY_TEXT =
	'## Key points\n\nThe domain is reserved for examples.\n\nNo permission is needed to use it.';

describe('Summary > Summarize', () => {
	it('POSTs a web page to /v1/summaries with an Idempotency-Key and returns the started job', async () => {
		const http = new MockHttp([ACCEPTED]);
		const [[item]] = await run([summarizeParams()], http);

		assert.deepEqual(item.json, {
			job_id: 'job_1',
			status: 'queued',
			finished: false,
			tracking_url: `${API}/v1/jobs/job_1`,
			article_id: null,
		});
		const [call] = http.calls;
		assert.strictEqual(call.credentialName, 'shortyApi');
		assert.strictEqual(call.method, 'POST');
		assert.strictEqual(call.url, `${API}/v1/summaries`);
		assert.deepEqual(call.body, {
			source: 'url',
			url: 'https://example.com',
			language: 'english',
		});
		assert.match(String(call.headers['Idempotency-Key']), /^n8n-run:[0-9a-f]{64}$/);
	});

	it('sends a YouTube source and the chosen language', async () => {
		const http = new MockHttp([ACCEPTED]);
		await run(
			[
				summarizeParams({
					source: 'youtube',
					url: '  https://www.youtube.com/watch?v=abc  ',
					options: { language: ' fr ' },
				}),
			],
			http,
		);
		assert.deepEqual(http.calls[0].body, {
			source: 'youtube',
			url: 'https://www.youtube.com/watch?v=abc',
			language: 'fr',
		});
	});

	it('sends pasted text as content', async () => {
		const http = new MockHttp([ACCEPTED]);
		await run([summarizeParams({ source: 'text', text: 'Long notes.' })], http);
		assert.deepEqual(http.calls[0].body, {
			source: 'text',
			content: 'Long notes.',
			language: 'english',
		});
	});

	it('refuses an empty URL before any request', async () => {
		const http = new MockHttp();
		const error = await rejection(run([summarizeParams({ url: '  ' })], http));
		assert.match(error.message, /'URL' parameter is empty/);
		assert.strictEqual(http.calls.length, 0);
	});

	it('reads an already-summarized source back at once (200 already_complete)', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { status: 'already_complete', article_id: 'art_1' } },
			{ statusCode: 200, body: sampleArticle() },
		]);
		const [[item]] = await run([summarizeParams({ waitForCompletion: true })], http);

		assert.strictEqual(http.calls[1].url, `${API}/v1/articles/art_1`);
		assert.strictEqual(item.json.status, 'already_complete');
		assert.strictEqual(item.json.finished, true);
		assert.strictEqual(item.json.job_id, null);
		assert.strictEqual(item.json.article_id, 'art_1');
		assert.strictEqual(item.json.summary_text, SUMMARY_TEXT);
		assert.strictEqual(item.json.article_url, `${API}/articles/art_1`);
	});

	it('waits for the job, then returns the finished summary', async () => {
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: sampleJob({ status: 'queued', output: {} }) },
			{ statusCode: 200, body: sampleJob({ status: 'processing', progress: 40, output: {} }) },
			{ statusCode: 200, body: sampleJob() },
			{ statusCode: 200, body: sampleArticle() },
		]);
		const [[item]] = await run([summarizeParams({ waitForCompletion: true })], http);

		assert.deepEqual(
			http.calls.map((call) => `${call.method} ${call.url}`),
			[
				`POST ${API}/v1/summaries`,
				`GET ${API}/v1/jobs/job_1`,
				`GET ${API}/v1/jobs/job_1`,
				`GET ${API}/v1/jobs/job_1`,
				`GET ${API}/v1/articles/art_1`,
			],
		);
		assert.strictEqual(item.json.job_id, 'job_1');
		assert.strictEqual(item.json.status, 'success');
		assert.strictEqual(item.json.finished, true);
		assert.strictEqual(item.json.title, 'Example Domain');
		assert.strictEqual(item.json.summary_text, SUMMARY_TEXT);
		assert.deepEqual(item.json.summary_parts, [
			{ title: 'Key points', content: 'The domain is reserved for examples.' },
			{ title: null, content: 'No permission is needed to use it.' },
		]);
	});

	it('stops the item with Shorty’s reason when the job fails', async () => {
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: sampleJob({ status: 'error', error: 'Page could not be read' }) },
		]);
		const error = await rejection(run([summarizeParams({ waitForCompletion: true })], http));
		assert.match(error.message, /Shorty could not finish the summary: Page could not be read/);
		assert.match(String(error.description), /Job ID: job_1/);
	});

	it('returns the job as it stands, unfinished, when the timeout passes', async () => {
		// 10 seconds at one poll every 5 seconds is two polls.
		const http = new MockHttp([
			ACCEPTED,
			{ statusCode: 200, body: sampleJob({ status: 'processing', progress: 20 }) },
			{ statusCode: 200, body: sampleJob({ status: 'processing', progress: 60 }) },
		]);
		const [[item]] = await run([summarizeParams({ waitForCompletion: true, timeout: 10 })], http);
		assert.deepEqual(item.json, {
			job_id: 'job_1',
			status: 'processing',
			finished: false,
			progress: 60,
			step: null,
			tracking_url: `${API}/v1/jobs/job_1`,
		});
		assert.strictEqual(http.remaining, 0);
	});

	it('retries once with the same key and body after a 5xx, so the job starts once', async () => {
		const http = new MockHttp([
			{ statusCode: 503, body: { code: 'service_unavailable' } },
			ACCEPTED,
		]);
		const [[item]] = await run([summarizeParams()], http);
		assert.strictEqual(item.json.job_id, 'job_1');
		assert.strictEqual(http.calls.length, 2);
		assert.strictEqual(
			http.calls[0].headers['Idempotency-Key'],
			http.calls[1].headers['Idempotency-Key'],
		);
		assert.deepEqual(http.calls[0].body, http.calls[1].body);
	});

	it('retries once after 409 idempotency_in_progress and after a request that got no answer', async () => {
		const inProgress = new MockHttp([
			{ statusCode: 409, body: { code: 'idempotency_in_progress' } },
			ACCEPTED,
		]);
		await run([summarizeParams()], inProgress);
		assert.strictEqual(inProgress.calls.length, 2);

		const reset = new MockHttp([{ statusCode: 0, networkError: 'ECONNRESET' }, ACCEPTED]);
		await run([summarizeParams()], reset);
		assert.strictEqual(reset.calls.length, 2);
	});

	it('does not retry a 409 idempotency_key_reused, and says so', async () => {
		const http = new MockHttp([
			{
				statusCode: 409,
				body: { code: 'idempotency_key_reused', detail: 'Key reused with another body.' },
			},
		]);
		const error = await rejection(run([summarizeParams()], http));
		assert.strictEqual(http.calls.length, 1);
		assert.match(error.message, /Shorty did not start the summary: Key reused with another body/);
	});

	it('uses a mapped Deduplication Key as-is, namespaced by operation', async () => {
		const http = new MockHttp([ACCEPTED]);
		await run([summarizeParams({ options: { idempotencyKey: ' row-42 ' } })], http);
		assert.strictEqual(http.calls[0].headers['Idempotency-Key'], 'n8n-summary:row-42');
	});

	it('gives each item its own key and the same key on Retry On Fail', async () => {
		const first = new MockHttp([ACCEPTED, ACCEPTED]);
		await run([summarizeParams(), summarizeParams()], first);
		const again = new MockHttp([ACCEPTED, ACCEPTED]);
		await run([summarizeParams(), summarizeParams()], again);
		const keys = (http: MockHttp) => http.calls.map((call) => call.headers['Idempotency-Key']);
		assert.notStrictEqual(keys(first)[0], keys(first)[1]);
		assert.deepEqual(keys(first), keys(again));

		const otherExecution = new MockHttp([ACCEPTED]);
		await run([summarizeParams()], otherExecution, { position: { executionId: '2002' } });
		assert.notStrictEqual(keys(otherExecution)[0], keys(first)[0]);
	});

	it('explains a quota_exhausted refusal', async () => {
		const http = new MockHttp([
			{
				statusCode: 429,
				body: { code: 'quota_exhausted', detail: 'Daily summary limit reached.' },
			},
		]);
		const error = await rejection(run([summarizeParams()], http));
		assert.match(error.message, /Daily summary limit reached/);
		assert.match(String(error.description), /allowance/);
	});

	it('emits an error item instead of failing with Continue On Fail', async () => {
		const http = new MockHttp([
			{ statusCode: 401, body: { code: 'invalid_api_key', detail: 'Invalid API key.' } },
		]);
		const [[item]] = await run([summarizeParams()], http, { continueOnFail: true });
		assert.match(String(item.json.error), /Invalid API key/);
		assert.deepEqual(item.pairedItem, { item: 0 });
	});
});

describe('Summary > Get, Get Many, Search', () => {
	it('gets one summary by its locator value', async () => {
		const http = new MockHttp([{ statusCode: 200, body: sampleArticle() }]);
		const [[item]] = await run(
			[{ resource: 'summary', operation: 'get', articleId: locator('art_1', 'id') }],
			http,
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/articles/art_1`);
		assert.strictEqual(item.json.article_id, 'art_1');
		assert.strictEqual(item.json.job_id, null);
		assert.strictEqual(item.json.body_text, sampleArticle().body_text);
	});

	it('pages through /v1/articles with the cursor until the limit', async () => {
		const page = (ids: string[], next: string | null) => ({
			statusCode: 200,
			body: { data: ids.map((id) => ({ id })), has_more: next !== null, next_cursor: next },
		});
		const http = new MockHttp([page(['a', 'b'], 'c1'), page(['c', 'd'], null)]);
		const items = await run(
			[{ resource: 'summary', operation: 'getAll', returnAll: false, limit: 3 }],
			http,
		);
		assert.deepEqual(
			items[0].map((item) => item.json.id),
			['a', 'b', 'c'],
		);
		assert.deepEqual(http.calls[0].qs, { limit: 3 });
		assert.deepEqual(http.calls[1].qs, { limit: 1, cursor: 'c1' });
	});

	it('searches with the query, the result cap and the source-type filter', async () => {
		const http = new MockHttp([
			{ statusCode: 200, body: { data: [{ id: 'a' }, { id: 'b' }], count: 2 } },
		]);
		const items = await run(
			[
				{
					resource: 'summary',
					operation: 'search',
					query: 'attention',
					maxResults: 5,
					filters: { articleType: 'YOUTUBE_ARTICLE' },
				},
			],
			http,
		);
		assert.strictEqual(http.calls[0].url, `${API}/v1/articles/search`);
		assert.deepEqual(http.calls[0].qs, {
			q: 'attention',
			limit: 5,
			article_type: 'YOUTUBE_ARTICLE',
		});
		assert.strictEqual(items[0].length, 2);
	});
});
