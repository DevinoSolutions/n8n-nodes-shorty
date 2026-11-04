import type { INodeProperties } from 'n8n-workflow';
import { ID_PLACEHOLDER, waitFields } from './common';

const showForGet = { resource: ['job'], operation: ['get'] };

export const jobOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['job'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get a job',
			description: "Get a summary or transcription job's status, progress and result ID",
		},
	],
	default: 'get',
};

export const jobFields: INodeProperties[] = [
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		required: true,
		default: '',
		placeholder: ID_PLACEHOLDER,
		description: 'The job_id returned by Summarize or Transcribe',
		displayOptions: { show: showForGet },
	},
	...waitFields(showForGet, {
		waitDefault: false,
		timeoutDefault: 300,
		what: 'the finished job',
	}),
];

export const accountOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['account'] } },
	options: [
		{
			name: 'Get Usage',
			value: 'getUsage',
			action: 'Get plan and usage',
			description: "Get the account's plan, limits and usage",
		},
	],
	default: 'getUsage',
};
