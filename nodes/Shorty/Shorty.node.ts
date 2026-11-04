import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type JsonObject,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { handlers } from './actions';
import { accountOperations, jobFields, jobOperations } from './descriptions/job';
import { summaryFields, summaryOperations } from './descriptions/summary';
import { transcriptionFields, transcriptionOperations } from './descriptions/transcription';
import { searchSummaries } from './listSearch';

/*
 * Programmatic style, not declarative: Summarize and Transcribe send an Idempotency-Key and retry
 * once with the same key on a 5xx or a 409 idempotency_in_progress, branch on 200 (already
 * summarized) versus 202 (job started), and Wait for Completion polls the job and then reads the
 * summary or transcription back, which routing rules cannot express.
 */
export class Shorty implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Shorty',
		name: 'shorty',
		icon: { light: 'file:../../icons/shorty.svg', dark: 'file:../../icons/shorty.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Summarize YouTube videos, web pages and text, transcribe audio and video links, and read your Shorty library',
		defaults: {
			name: 'Shorty',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'shortyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Account',
						value: 'account',
						description: 'Your Shorty plan, limits and usage',
					},
					{
						name: 'Job',
						value: 'job',
						description: 'A summary or transcription job in progress or finished',
					},
					{
						name: 'Summary',
						value: 'summary',
						description: 'Summaries of YouTube videos, web pages and text',
					},
					{
						name: 'Transcription',
						value: 'transcription',
						description: 'Transcripts of audio and video links',
					},
				],
				default: 'summary',
			},
			summaryOperations,
			transcriptionOperations,
			jobOperations,
			accountOperations,
			...summaryFields,
			...transcriptionFields,
			...jobFields,
		],
	};

	methods = {
		listSearch: {
			searchSummaries,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const handler = handlers[resource]?.[operation];
				if (!handler) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation '${operation}' is not supported for '${resource}'`,
						{ itemIndex },
					);
				}

				const result = await handler.call(this, itemIndex);
				const results: IDataObject[] = Array.isArray(result) ? result : [result];
				returnData.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(results), {
						itemData: { item: itemIndex },
					}),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				// Errors from the request helpers are already NodeApiError or NodeOperationError, and
				// both constructors hand those back unchanged; anything else gets wrapped.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
