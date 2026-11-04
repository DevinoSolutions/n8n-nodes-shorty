import type { INodeProperties } from 'n8n-workflow';
import {
	DEDUPLICATION_KEY,
	ID_PLACEHOLDER,
	LANGUAGE,
	paginationFields,
	waitFields,
} from './common';

const showForCreate = { resource: ['summary'], operation: ['create'] };
const showForGet = { resource: ['summary'], operation: ['get'] };
const showForGetAll = { resource: ['summary'], operation: ['getAll'] };
const showForSearch = { resource: ['summary'], operation: ['search'] };

/** The `article_type` values Shorty stores, for the Search filter. */
export const ARTICLE_TYPES = [
	{ name: 'Audio', value: 'AUDIO_ARTICLE' },
	{ name: 'PDF', value: 'PDF_ARTICLE' },
	{ name: 'Text', value: 'TEXT_ARTICLE' },
	{ name: 'Web Page', value: 'WEBPAGE_ARTICLE' },
	{ name: 'Word Document', value: 'WORD_ARTICLE' },
	{ name: 'YouTube Video', value: 'YOUTUBE_ARTICLE' },
];

export const summaryOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['summary'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get a summary',
			description: 'Get a summary with its sections and the source text or transcript behind it',
		},
		{
			name: 'Get Many',
			value: 'getAll',
			action: 'Get many summaries',
			description: 'List the summaries in your library, newest first',
		},
		{
			name: 'Search',
			value: 'search',
			action: 'Search summaries',
			description: 'Search your summary library by keywords',
		},
		{
			name: 'Summarize',
			value: 'create',
			action: 'Summarize a URL or text',
			description: 'Summarize a YouTube video, a web page or article, or pasted text',
		},
	],
	default: 'create',
};

export const summaryFields: INodeProperties[] = [
	{
		displayName: 'Source',
		name: 'source',
		type: 'options',
		required: true,
		default: 'url',
		options: [
			{ name: 'Text', value: 'text', description: 'Pasted text' },
			{ name: 'Web Page', value: 'url', description: 'A web page or article URL' },
			{ name: 'YouTube Video', value: 'youtube', description: 'A YouTube video URL' },
		],
		description: 'What to summarize',
		displayOptions: { show: showForCreate },
	},
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		description: 'The YouTube video or web page to summarize',
		displayOptions: { show: { ...showForCreate, source: ['url', 'youtube'] } },
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 6 },
		description: 'The text to summarize',
		displayOptions: { show: { ...showForCreate, source: ['text'] } },
	},
	...waitFields(showForCreate, {
		waitDefault: true,
		timeoutDefault: 300,
		what: 'the finished summary',
	}),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showForCreate },
		options: [
			DEDUPLICATION_KEY,
			{
				...LANGUAGE,
				description: `The language to write the summary in. ${LANGUAGE.description}.`,
			},
		],
	},
	{
		displayName: 'Summary',
		name: 'articleId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The summary to get',
		displayOptions: { show: showForGet },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a summary...',
				typeOptions: { searchListMethod: 'searchSummaries', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: ID_PLACEHOLDER,
			},
		],
	},
	...paginationFields(showForGetAll),
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. transformers attention',
		description: 'Keywords to look for in your summaries',
		displayOptions: { show: showForSearch },
	},
	{
		displayName: 'Max Results',
		name: 'maxResults',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 20 },
		default: 8,
		description: 'How many of the best matches to return (at most 20)',
		displayOptions: { show: showForSearch },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showForSearch },
		options: [
			{
				displayName: 'Source Type',
				name: 'articleType',
				type: 'options',
				default: 'YOUTUBE_ARTICLE',
				options: ARTICLE_TYPES,
				description: 'Only summaries of this kind of source',
			},
		],
	},
];
