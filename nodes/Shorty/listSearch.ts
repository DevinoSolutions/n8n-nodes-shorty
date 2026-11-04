import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { articleUrl } from './shared/jobs';
import { shortyApiRequest } from './shared/transport';

export interface Article extends IDataObject {
	id: string;
	title: string | null;
	description: string | null;
	article_type: string;
	source_url: string | null;
	created_at: string;
}

export interface CursorPage<T> {
	data: T[];
	has_more: boolean;
	next_cursor: string | null;
}

/** How a summary reads in a list: its title, else its source, else its ID. */
export function articleLabel(article: Article): string {
	const text = article.title?.trim() || article.source_url?.trim() || article.id;
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function toItem(article: Article): INodeListSearchItems {
	return { name: articleLabel(article), value: article.id, url: articleUrl(article.id) };
}

/**
 * The Summary dropdown. Without a filter it pages through the library newest first
 * (GET /v1/articles); with one it asks Shorty's search (GET /v1/articles/search), which answers
 * one page of the best matches.
 */
export async function searchSummaries(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const query = filter?.trim();
	if (query) {
		const response = (await shortyApiRequest.call(this, {
			method: 'GET',
			path: '/v1/articles/search',
			qs: { q: query, limit: 20 },
		})) as unknown as { data: Article[] };
		return { results: (response.data ?? []).map(toItem) };
	}

	const qs: IDataObject = { limit: 50 };
	if (paginationToken) qs.cursor = paginationToken;
	const page = (await shortyApiRequest.call(this, {
		method: 'GET',
		path: '/v1/articles',
		qs,
	})) as unknown as CursorPage<Article>;
	return {
		results: (page.data ?? []).map(toItem),
		paginationToken: page.has_more && page.next_cursor ? page.next_cursor : undefined,
	};
}
