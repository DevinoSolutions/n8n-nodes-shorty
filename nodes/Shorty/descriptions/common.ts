import type { INodeProperties } from 'n8n-workflow';

export type DisplayShow = NonNullable<NonNullable<INodeProperties['displayOptions']>['show']>;

/** Return All and Limit for a Get Many operation. */
export function paginationFields(show: DisplayShow): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
			displayOptions: { show: { ...show, returnAll: [false] } },
		},
	];
}

/** Wait for Completion and its timeout, for an operation that starts or reads an async job. */
export function waitFields(
	show: DisplayShow,
	options: { waitDefault: boolean; timeoutDefault: number; what: string },
): INodeProperties[] {
	const wait: INodeProperties = {
		displayName: 'Wait for Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: true,
		description: `Whether to wait until Shorty has finished the job and return ${options.what}. Off returns the job right away; read it later with Job > Get or the Shorty Trigger.`,
		displayOptions: { show },
	};
	const timeout: INodeProperties = {
		displayName: 'Timeout (Seconds)',
		name: 'timeout',
		type: 'number',
		typeOptions: { minValue: 10, maxValue: 3600 },
		default: 300,
		description:
			'How long to wait before returning the job as it stands (with finished: false). The job keeps running in Shorty.',
		displayOptions: { show: { ...show, waitForCompletion: [true] } },
	};
	wait.default = options.waitDefault;
	timeout.default = options.timeoutDefault;
	return [wait, timeout];
}

export const DEDUPLICATION_KEY: INodeProperties = {
	displayName: 'Deduplication Key',
	name: 'idempotencyKey',
	type: 'string',
	default: '',
	placeholder: 'e.g. {{ $json.rowId }}',
	description:
		'Map something unique to this request, such as a row or record ID. Shorty will not start a second job with the same key within 24 hours, even if the execution is retried or the workflow re-runs. Left empty, Retry On Fail does not start items twice, but a manual retry of a failed execution does.',
};

export const LANGUAGE: INodeProperties = {
	displayName: 'Language',
	name: 'language',
	type: 'string',
	default: 'english',
	placeholder: 'e.g. english or en',
	description: 'A language name (english, french) or a two-letter code (en, fr)',
};

export const ID_PLACEHOLDER = 'e.g. a1b2c3d4-0000-4000-8000-000000000000';
