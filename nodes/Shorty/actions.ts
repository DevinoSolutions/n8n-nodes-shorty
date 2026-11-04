import { NodeOperationError, type IDataObject, type IExecuteFunctions } from 'n8n-workflow';
import type { CursorPage } from './listSearch';
import { createIdempotencyKey, sendWithOneRetry, type StartPosition } from './shared/idempotency';
import {
	articleUrl,
	getJob,
	isFinished,
	jobOutputId,
	jobState,
	jobWaitSettings,
	readSummary,
	readTranscription,
	toSummary,
	toTranscription,
	translationInFlight,
	waitForJob,
	type Job,
} from './shared/jobs';
import {
	API_BASE_URL,
	shortyApiRequest,
	shortyRequest,
	throwApiError,
	type ShortyRequest,
	type ShortyResponse,
} from './shared/transport';

type Handler = (this: IExecuteFunctions, itemIndex: number) => Promise<IDataObject | IDataObject[]>;

function requiredString(
	this: IExecuteFunctions,
	name: string,
	displayName: string,
	itemIndex: number,
): string {
	const value = String(this.getNodeParameter(name, itemIndex, '') ?? '').trim();
	if (value === '') {
		throw new NodeOperationError(this.getNode(), `The '${displayName}' parameter is empty`, {
			itemIndex,
		});
	}
	return value;
}

/** Reads an optional piece of n8n context; a runtime that lacks it yields `undefined`. */
function optional<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

function startPosition(this: IExecuteFunctions, itemIndex: number): StartPosition {
	return {
		instanceId: optional(() => this.getInstanceId()),
		workflowId: optional(() => this.getWorkflow().id),
		executionId: optional(() => this.getExecutionId()),
		nodeName: this.getNode().name,
		runIndex: optional(() => this.getWorkflowDataProxy(itemIndex).$thisRunIndex) ?? 0,
		itemIndex,
	};
}

/** Upper bound on pages for Return All, so a huge library cannot run one item forever. */
const MAX_PAGES = 200;

/** GET a cursor-paginated `/v1` list until `limit` items or the last page. */
async function readPages(
	this: IExecuteFunctions,
	path: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
	const results: IDataObject[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES && results.length < limit; page++) {
		const qs: IDataObject = { limit: Math.min(100, limit - results.length) };
		if (cursor) qs.cursor = cursor;
		const response = (await shortyApiRequest.call(
			this,
			{ method: 'GET', path, qs },
			itemIndex,
		)) as unknown as CursorPage<IDataObject>;
		results.push(...(response.data ?? []));
		if (!response.has_more || !response.next_cursor) break;
		cursor = response.next_cursor;
	}
	return results.slice(0, limit);
}

/**
 * POST a job start with an `Idempotency-Key`, retried once with the same key and body on a 5xx,
 * a 409 `idempotency_in_progress` or a request that got no answer, so a job is started once.
 */
async function startJob(
	this: IExecuteFunctions,
	itemIndex: number,
	operation: 'summary' | 'transcription',
	path: string,
	body: IDataObject,
	context: string,
): Promise<{ statusCode: number; body: IDataObject }> {
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const key = createIdempotencyKey(
		operation,
		options.idempotencyKey,
		startPosition.call(this, itemIndex),
	);
	const request: ShortyRequest = {
		method: 'POST',
		path,
		headers: { 'Idempotency-Key': key },
		body,
	};
	const response = await sendWithOneRetry(
		async () => (await shortyRequest.call(this, request)) as ShortyResponse<IDataObject>,
	);
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, context, itemIndex);
	}
	return { statusCode: response.statusCode, body: response.body };
}

function readWait(this: IExecuteFunctions, itemIndex: number): number | null {
	if (!(this.getNodeParameter('waitForCompletion', itemIndex, false) as boolean)) return null;
	return this.getNodeParameter('timeout', itemIndex, 300) as number;
}

/** A job that has not finished within the timeout: returned as it stands, not as an error. */
function unfinished(job: Job): IDataObject {
	return {
		job_id: job.jobId,
		status: job.status,
		finished: false,
		progress: job.progress ?? null,
		step: job.step ?? null,
		tracking_url: `${API_BASE_URL}/v1/jobs/${encodeURIComponent(job.jobId)}`,
	};
}

/** A job that failed or was cancelled stops the item with Shorty's own reason. */
function failJob(this: IExecuteFunctions, job: Job, what: string, itemIndex: number): never {
	const state = jobState(job.status);
	const reason =
		state === 'cancelled' ? 'the job was cancelled' : (job.error ?? 'the job failed in Shorty');
	throw new NodeOperationError(this.getNode(), `Shorty could not finish the ${what}: ${reason}`, {
		itemIndex,
		description: `Job ID: ${job.jobId}.`,
	});
}

/* -------------------------------------------------------------------------- */
/*                                   Summary                                  */
/* -------------------------------------------------------------------------- */

/** The CreateSummaryBody for the chosen source: a union on `source`. */
export function buildSummaryBody(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const source = this.getNodeParameter('source', itemIndex, 'url') as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const language =
		typeof options.language === 'string' && options.language.trim() !== ''
			? options.language.trim()
			: 'english';
	if (source === 'text') {
		return {
			source: 'text',
			content: requiredString.call(this, 'text', 'Text', itemIndex),
			language,
		};
	}
	if (source !== 'url' && source !== 'youtube') {
		throw new NodeOperationError(this.getNode(), `Unknown source '${source}'`, { itemIndex });
	}
	return { source, url: requiredString.call(this, 'url', 'URL', itemIndex), language };
}

/**
 * The summary Shorty answered `already_complete` with. Shorty keeps one summary per source,
 * language and source type for all accounts, but `GET /v1/articles/{id}` reads only the caller's
 * own: a source another account summarized first answers 404. That is not a missing summary, so
 * the item stops with the reason and the summary's public page instead of a bare "not found".
 */
async function readExistingSummary(
	this: IExecuteFunctions,
	articleId: string,
	itemIndex: number,
): Promise<IDataObject> {
	const response = await shortyRequest.call(this, {
		method: 'GET',
		path: `/v1/articles/${encodeURIComponent(articleId)}`,
	});
	if (response.statusCode === 404) {
		throw new NodeOperationError(
			this.getNode(),
			'Shorty already has a summary of this source, but this API key cannot read it',
			{
				itemIndex,
				description: `Shorty keeps one summary per source and language, and this one was made by another Shorty account. Open it at ${articleUrl(articleId)}, or summarize the source in another language. Summary ID: ${articleId}.`,
			},
		);
	}
	if (response.statusCode >= 400) {
		throwApiError.call(this, response, 'Shorty did not return the summary:', itemIndex);
	}
	return {
		status: 'already_complete',
		finished: true,
		...toSummary(response.body as IDataObject, null),
	};
}

/**
 * POST /v1/summaries. A 200 means this exact source was already summarized in this language:
 * the summary is read back at once. A 202 starts a job; with Wait for Completion the node polls
 * it and returns the finished summary.
 */
const summarize: Handler = async function (itemIndex) {
	const body = buildSummaryBody.call(this, itemIndex);
	const started = await startJob.call(
		this,
		itemIndex,
		'summary',
		'/v1/summaries',
		body,
		'Shorty did not start the summary:',
	);
	if (started.statusCode === 200 && started.body.status === 'already_complete') {
		return await readExistingSummary.call(this, String(started.body.article_id), itemIndex);
	}

	const jobId = typeof started.body.job_id === 'string' ? started.body.job_id : null;
	const accepted: IDataObject = {
		job_id: jobId,
		status: started.body.status,
		finished: false,
		tracking_url:
			typeof started.body.tracking_url === 'string'
				? `${API_BASE_URL}${started.body.tracking_url}`
				: null,
		article_id: started.body.article_id ?? null,
	};
	const timeout = readWait.call(this, itemIndex);
	if (timeout === null || jobId === null) return accepted;

	const { job, finished } = await waitForJob.call(this, jobId, timeout, itemIndex);
	if (!finished) return unfinished(job);
	if (jobState(job.status) !== 'success') failJob.call(this, job, 'summary', itemIndex);
	const articleId = jobOutputId(job) ?? (started.body.article_id as string | undefined);
	if (!articleId) return { job_id: jobId, status: job.status, finished: true, job };
	const summary = await readSummary.call(this, articleId, jobId, itemIndex);
	return { status: job.status, finished: true, ...summary };
};

const getSummary: Handler = async function (itemIndex) {
	const id = String(
		this.getNodeParameter('articleId', itemIndex, '', { extractValue: true }) ?? '',
	).trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), 'No summary was chosen', { itemIndex });
	}
	return await readSummary.call(this, id, null, itemIndex);
};

const getManySummaries: Handler = async function (itemIndex) {
	return await readPages.call(this, '/v1/articles', itemIndex);
};

const searchSummaries: Handler = async function (itemIndex) {
	const query = requiredString.call(this, 'query', 'Query', itemIndex);
	const limit = this.getNodeParameter('maxResults', itemIndex, 8) as number;
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const qs: IDataObject = { q: query, limit: Math.min(20, Math.max(1, limit)) };
	if (typeof filters.articleType === 'string' && filters.articleType !== '') {
		qs.article_type = filters.articleType;
	}
	const response = await shortyApiRequest.call(
		this,
		{ method: 'GET', path: '/v1/articles/search', qs },
		itemIndex,
	);
	return (response.data as IDataObject[] | undefined) ?? [];
};

/* -------------------------------------------------------------------------- */
/*                                Transcription                               */
/* -------------------------------------------------------------------------- */

/**
 * A finished transcription, read back, and when a translation was asked for, read again until
 * the translation is done or the deadline passes: Shorty translates a few batches on each read.
 */
async function finishedTranscription(
	this: IExecuteFunctions,
	transcriptionId: string,
	jobId: string,
	deadline: number,
	itemIndex: number,
): Promise<IDataObject> {
	let transcription = await readTranscription.call(this, transcriptionId, itemIndex);
	while (translationInFlight(transcription) && Date.now() < deadline) {
		await jobWaitSettings.pause(jobWaitSettings.intervalMs);
		transcription = await readTranscription.call(this, transcriptionId, itemIndex);
	}
	return toTranscription(transcription, jobId);
}

/**
 * POST /v1/transcriptions. With Wait for Completion the node polls the job, which is also what
 * moves an API-started transcription forward in Shorty, and returns the transcript.
 */
const transcribe: Handler = async function (itemIndex) {
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const body: IDataObject = { url: requiredString.call(this, 'url', 'Media URL', itemIndex) };
	if (typeof options.language === 'string' && options.language.trim() !== '') {
		body.language = options.language.trim();
	}
	if (typeof options.outputLanguage === 'string' && options.outputLanguage !== '') {
		body.output_language = options.outputLanguage;
	}
	const started = await startJob.call(
		this,
		itemIndex,
		'transcription',
		'/v1/transcriptions',
		body,
		'Shorty did not start the transcription:',
	);
	const jobId = String(started.body.job_id);
	const accepted: IDataObject = {
		job_id: jobId,
		status: started.body.status,
		finished: false,
		tracking_url:
			typeof started.body.tracking_url === 'string'
				? `${API_BASE_URL}${started.body.tracking_url}`
				: null,
	};
	const timeout = readWait.call(this, itemIndex);
	if (timeout === null) return accepted;

	const deadline = Date.now() + timeout * 1000;
	const { job, finished } = await waitForJob.call(this, jobId, timeout, itemIndex);
	if (!finished) return unfinished(job);
	if (jobState(job.status) !== 'success') failJob.call(this, job, 'transcription', itemIndex);
	const transcription = await finishedTranscription.call(
		this,
		jobOutputId(job) ?? jobId,
		jobId,
		deadline,
		itemIndex,
	);
	return { finished: true, ...transcription };
};

const getTranscription: Handler = async function (itemIndex) {
	const id = requiredString.call(this, 'transcriptionId', 'Transcription ID', itemIndex);
	return toTranscription(await readTranscription.call(this, id, itemIndex), null);
};

const getManyTranscriptions: Handler = async function (itemIndex) {
	return await readPages.call(this, '/v1/transcriptions', itemIndex);
};

/* -------------------------------------------------------------------------- */
/*                                  Job, Account                              */
/* -------------------------------------------------------------------------- */

const getJobHandler: Handler = async function (itemIndex) {
	const id = requiredString.call(this, 'jobId', 'Job ID', itemIndex);
	const timeout = readWait.call(this, itemIndex);
	const first = await getJob.call(this, id, itemIndex);
	if (timeout === null || isFinished(first)) return first;
	const { job } = await waitForJob.call(this, id, timeout, itemIndex);
	return job;
};

const getUsage: Handler = async function (itemIndex) {
	return await shortyApiRequest.call(this, { method: 'GET', path: '/v1/usage' }, itemIndex);
};

export const handlers: Record<string, Record<string, Handler>> = {
	summary: {
		create: summarize,
		get: getSummary,
		getAll: getManySummaries,
		search: searchSummaries,
	},
	transcription: { create: transcribe, get: getTranscription, getAll: getManyTranscriptions },
	job: { get: getJobHandler },
	account: { getUsage },
};
