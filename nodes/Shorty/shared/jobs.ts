import { sleep, type IDataObject } from 'n8n-workflow';
import { API_BASE_URL, shortyApiRequest, type ShortyContext } from './transport';

/**
 * A job as `GET /v1/jobs/{id}` answers it, which is also the `data` of every `job.succeeded` and
 * `job.failed` webhook. `status` is Shorty's un-normalized lower-case string, and `output` carries
 * `jobType` (YOUTUBE_SUMMARY, CONTENT_SUMMARY, TRANSCRIPTION, ...), `title` and `outputId` (the
 * summary's article ID or the transcription's ID).
 */
export interface Job extends IDataObject {
	jobId: string;
	status: string;
	progress?: number;
	step?: string | null;
	error?: string | null;
	output?: IDataObject;
}

export type JobState = 'queued' | 'processing' | 'success' | 'error' | 'cancelled';

/** Shorty's own status normalization (src/lib/jobs/jobStatus.ts `statusFromStream`). */
export function jobState(status: unknown): JobState {
	const raw = String(status ?? 'queued').toLowerCase();
	if (raw === 'success' || raw === 'completed' || raw === 'done') return 'success';
	if (raw === 'cancelled') return 'cancelled';
	if (raw === 'error' || raw === 'failed' || raw === 'missing') return 'error';
	if (raw === 'processing' || raw === 'running') return 'processing';
	return 'queued';
}

export function isFinished(job: Job): boolean {
	const state = jobState(job.status);
	return state === 'success' || state === 'error' || state === 'cancelled';
}

/** The ID of what a finished job produced: an article for a summary, a transcription otherwise. */
export function jobOutputId(job: Job): string | undefined {
	const id = job.output?.outputId;
	return typeof id === 'string' && id !== '' ? id : undefined;
}

export function isTranscriptionJob(job: Job): boolean {
	return job.output?.jobType === 'TRANSCRIPTION';
}

/**
 * How often Wait for Completion asks Shorty for the job, and how it pauses. The pause is a
 * setting so tests can skip it; the interval still bounds how many polls a timeout allows.
 */
export const jobWaitSettings = {
	intervalMs: 5_000,
	pause: async (ms: number): Promise<void> => await sleep(ms),
};

export function getJob(this: ShortyContext, jobId: string, itemIndex?: number): Promise<Job> {
	return shortyApiRequest.call(
		this,
		{ method: 'GET', path: `/v1/jobs/${encodeURIComponent(jobId)}` },
		itemIndex,
	) as Promise<Job>;
}

/**
 * Polls `GET /v1/jobs/{id}` until the job succeeds, fails or is cancelled, or until `timeoutSeconds`
 * have passed. Polling is also what moves an API-started transcription forward: Shorty advances
 * it on each read of the job.
 */
export async function waitForJob(
	this: ShortyContext,
	jobId: string,
	timeoutSeconds: number,
	itemIndex?: number,
): Promise<{ job: Job; finished: boolean }> {
	const polls = Math.max(1, Math.floor((timeoutSeconds * 1000) / jobWaitSettings.intervalMs));
	let job: Job | undefined;
	for (let poll = 0; poll < polls; poll++) {
		await jobWaitSettings.pause(jobWaitSettings.intervalMs);
		job = await getJob.call(this, jobId, itemIndex);
		if (isFinished(job)) return { job, finished: true };
	}
	return { job: job as Job, finished: false };
}

/* -------------------------------------------------------------------------- */
/*                                  Summaries                                 */
/* -------------------------------------------------------------------------- */

interface SummaryPart {
	title: string | null;
	content: string | null;
}

/** The summary as readable Markdown: each part's title as a heading, then its text. */
export function summaryText(parts: SummaryPart[]): string {
	return parts
		.map((part) =>
			[part.title?.trim() ? `## ${part.title.trim()}` : '', part.content?.trim() ?? '']
				.filter(Boolean)
				.join('\n\n'),
		)
		.filter(Boolean)
		.join('\n\n');
}

export function articleUrl(articleId: string): string {
	return `${API_BASE_URL}/articles/${encodeURIComponent(articleId)}`;
}

/**
 * One summary item, the same shape Shorty's Zapier app emits: the article from
 * `GET /v1/articles/{id}`, plus the summary as Markdown and a link to it in Shorty.
 */
export function toSummary(article: IDataObject, jobId: string | null): IDataObject {
	const summary = article.summary as { parts?: SummaryPart[] } | null | undefined;
	const parts = summary?.parts ?? [];
	return {
		job_id: jobId,
		article_id: article.id,
		title: article.title ?? null,
		description: article.description ?? null,
		article_type: article.article_type,
		source_url: article.source_url ?? null,
		created_at: article.created_at,
		summary_text: summaryText(parts),
		summary_parts: parts.map((part) => ({ title: part.title, content: part.content })),
		body_text: article.body_text ?? null,
		article_url: articleUrl(String(article.id)),
	};
}

export async function readSummary(
	this: ShortyContext,
	articleId: string,
	jobId: string | null,
	itemIndex?: number,
): Promise<IDataObject> {
	const article = await shortyApiRequest.call(
		this,
		{ method: 'GET', path: `/v1/articles/${encodeURIComponent(articleId)}` },
		itemIndex,
	);
	return toSummary(article, jobId);
}

/* -------------------------------------------------------------------------- */
/*                               Transcriptions                               */
/* -------------------------------------------------------------------------- */

/** A translation into `output_language` that is still being made. */
export function translationInFlight(transcription: IDataObject): boolean {
	return (
		transcription.translation_status === 'PENDING' || transcription.translation_status === 'RUNNING'
	);
}

/**
 * The transcription with `job_id` and `transcript_text`: the translation when one was asked for
 * and finished, otherwise the transcript itself.
 */
export function toTranscription(transcription: IDataObject, jobId: string | null): IDataObject {
	const translated =
		transcription.translation_status === 'SUCCEEDED' &&
		typeof transcription.translated_output_text === 'string'
			? transcription.translated_output_text
			: null;
	return {
		job_id: jobId,
		...transcription,
		transcript_text: translated ?? transcription.output_text ?? null,
	};
}

export async function readTranscription(
	this: ShortyContext,
	transcriptionId: string,
	itemIndex?: number,
): Promise<IDataObject> {
	return await shortyApiRequest.call(
		this,
		{ method: 'GET', path: `/v1/transcriptions/${encodeURIComponent(transcriptionId)}` },
		itemIndex,
	);
}

/**
 * Why a transcription failed. Shorty's job, and the `job.failed` webhook built from it, carries no
 * reason; the transcription records it, for example that the host refused the download. Null when
 * it records none or cannot be read, since the job's failure is reported either way.
 */
export async function transcriptionFailure(
	this: ShortyContext,
	transcriptionId: string,
): Promise<string | null> {
	try {
		const { error } = await readTranscription.call(this, transcriptionId);
		return typeof error === 'string' && error.trim() !== '' ? error : null;
	} catch {
		return null;
	}
}
