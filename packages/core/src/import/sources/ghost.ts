import { htmlToPortableText } from "../../../../gutenberg-to-portable-text/src/index.js";
import type { EmDashHandlers, EmDashManifest } from "../../astro/types.js";
import { BylineRepository } from "../../database/repositories/byline.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { slugify } from "../../utils/slugify.js";
import { importSiteSettings, type SettingsImportResult } from "../settings.js";
import type { ImportFieldDef } from "../types.js";
import { resolveImportByline } from "../utils.js";
import { checkSchemaCompatibility, FEATURED_IMAGE_FIELD, BASE_REQUIRED_FIELDS } from "../utils.js";

type GhostStatus = "draft" | "published" | "scheduled";

export interface GhostExport {
	meta: {
		exportedOn?: number;
		version?: string;
	};
	data: GhostExportData;
}

export interface GhostExportData {
	posts: GhostPost[];
	postsMeta: GhostPostMeta[];
	tags: GhostTag[];
	postsTags: GhostPostTag[];
	users: GhostUser[];
	postsAuthors: GhostPostAuthor[];
	settings: GhostSetting[];
}

export interface GhostPost {
	id: string;
	title: string;
	slug: string;
	html?: string;
	plaintext?: string;
	customExcerpt?: string;
	featureImage?: string;
	type: "post" | "page";
	status: GhostStatus;
	createdAt?: string;
	updatedAt?: string;
	publishedAt?: string;
}

export interface GhostPostMeta {
	postId: string;
	featureImageAlt?: string;
	featureImageCaption?: string;
}

export interface GhostTag {
	id: string;
	name: string;
	slug: string;
}

export interface GhostPostTag {
	postId: string;
	tagId: string;
}

export interface GhostUser {
	id: string;
	name: string;
	slug: string;
	email?: string;
	profileImage?: string;
}

export interface GhostPostAuthor {
	postId: string;
	authorId: string;
	sortOrder?: number;
}

export interface GhostSetting {
	key: string;
	value: unknown;
}

export interface GhostAttachmentInfo {
	url: string;
	filename?: string;
	mimeType?: string;
}

export interface GhostAuthorInfo {
	id: string;
	slug: string;
	name: string;
	email?: string;
	postCount: number;
}

export interface GhostAnalysis {
	site: {
		title: string;
		url: string;
		tagline?: string;
	};
	postTypes: Array<{
		name: "post" | "page";
		count: number;
		suggestedCollection: string;
		requiredFields: ImportFieldDef[];
		schemaStatus: ReturnType<typeof checkSchemaCompatibility>;
	}>;
	attachments: {
		count: number;
		items: GhostAttachmentInfo[];
	};
	tags: number;
	authors: GhostAuthorInfo[];
}

export interface GhostImportConfig {
	postTypeMappings: Record<string, { collection: string; enabled: boolean }>;
	skipExisting: boolean;
	authorMappings?: Record<string, string | null>;
	importSiteTitle?: boolean;
}

export interface GhostImportResult {
	success: boolean;
	imported: number;
	skipped: number;
	errors: Array<{ title: string; error: string }>;
	byCollection: Record<string, number>;
	settings?: SettingsImportResult;
}

const IMAGE_URL_PATTERN = /<img[^>]+src=["']([^"'<>]+)["']/gi;

export function parseGhostExportString(json: string): GhostExport {
	const parsed: unknown = JSON.parse(json);
	const root = unwrapGhostRoot(parsed);
	const dataObject = asRecord(root.data);

	return {
		meta: {
			exportedOn: asNumber(root.meta?.exported_on),
			version: asString(root.meta?.version),
		},
		data: {
			posts: mapGhostPosts(dataObject.posts),
			postsMeta: mapGhostPostsMeta(dataObject.posts_meta),
			tags: mapGhostTags(dataObject.tags),
			postsTags: mapGhostPostsTags(dataObject.posts_tags),
			users: mapGhostUsers(dataObject.users),
			postsAuthors: mapGhostPostsAuthors(dataObject.posts_authors),
			settings: mapGhostSettings(dataObject.settings),
		},
	};
}

export function analyzeGhostExport(
	ghost: GhostExport,
	existingCollections: Map<string, { slug: string; fields: Map<string, { type: string }> }>,
): GhostAnalysis {
	const settings = extractGhostSiteSettings(ghost.data.settings);
	const authorsByPost = buildAuthorsByPost(ghost.data.postsAuthors);
	const authorCounts = new Map<string, number>();
	let hasFeaturedImage = false;

	for (const post of ghost.data.posts) {
		const authorIds = authorsByPost.get(post.id) ?? [];
		for (const authorId of authorIds) {
			authorCounts.set(authorId, (authorCounts.get(authorId) ?? 0) + 1);
		}
		if (post.featureImage) {
			hasFeaturedImage = true;
		}
	}

	const requiredFields = hasFeaturedImage
		? [...BASE_REQUIRED_FIELDS, FEATURED_IMAGE_FIELD]
		: [...BASE_REQUIRED_FIELDS];

	const postTypes = (["post", "page"] as const)
		.map((type) => {
			const count = ghost.data.posts.filter((post) => post.type === type).length;
			if (count === 0) return null;

			const suggestedCollection = type === "post" ? "posts" : "pages";
			return {
				name: type,
				count,
				suggestedCollection,
				requiredFields,
				schemaStatus: checkSchemaCompatibility(
					requiredFields,
					existingCollections.get(suggestedCollection),
				),
			};
		})
		.filter((value): value is NonNullable<typeof value> => value !== null);

	const attachments = collectGhostAttachments(ghost);

	return {
		site: {
			title: settings.title || "Ghost Site",
			url: settings.url || "",
			tagline: settings.tagline,
		},
		postTypes,
		attachments: {
			count: attachments.length,
			items: attachments,
		},
		tags: ghost.data.tags.length,
		authors: ghost.data.users.map((user) => ({
			id: user.id,
			slug: user.slug,
			name: user.name,
			email: user.email,
			postCount: authorCounts.get(user.id) ?? 0,
		})),
	};
}

export async function executeGhostImport(
	ghost: GhostExport,
	config: GhostImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
): Promise<GhostImportResult> {
	const result: GhostImportResult = {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
	};

	const contentRepo = new ContentRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();
	const authorsByPost = buildAuthorsByPost(ghost.data.postsAuthors);
	const usersById = new Map(ghost.data.users.map((user) => [user.id, user] as const));

	const createContent = emdash.handleContentCreate as (
		collection: string,
		body: {
			data: Record<string, unknown>;
			slug?: string;
			status?: string;
			authorId?: string;
			locale?: string;
			translationOf?: string;
			bylines?: Array<{ bylineId: string }>;
		},
	) => ReturnType<EmDashHandlers["handleContentCreate"]>;

	for (const post of ghost.data.posts) {
		const mapping = config.postTypeMappings[post.type];
		if (!mapping || !mapping.enabled) {
			result.skipped++;
			continue;
		}

		const collection = mapping.collection;
		if (!manifest.collections[collection]) {
			result.errors.push({
				title: post.title || "Untitled",
				error: `Collection "${collection}" does not exist`,
			});
			continue;
		}

		try {
			const slug = post.slug || slugify(post.title || `ghost-${post.id}`);
			if (config.skipExisting) {
				const existing = await contentRepo.findBySlug(collection, slug);
				if (existing) {
					result.skipped++;
					continue;
				}
			}

			const content = ghostPostToPortableText(post);
			const data: Record<string, unknown> = {
				title: post.title || "Untitled",
				content,
				excerpt: post.customExcerpt || undefined,
			};

			const collectionSchema = manifest.collections[collection];
			const hasFeaturedImageField = collectionSchema?.fields
				? "featured_image" in collectionSchema.fields
				: false;
			if (hasFeaturedImageField && post.featureImage) {
				data.featured_image = post.featureImage;
			}

			const primaryAuthor = (authorsByPost.get(post.id) ?? [])
				.map((authorId) => usersById.get(authorId))
				.find((author) => author);

			let authorId: string | undefined;
			if (primaryAuthor && config.authorMappings) {
				const mappedUserId = config.authorMappings[primaryAuthor.id];
				if (mappedUserId !== undefined && mappedUserId !== null) {
					authorId = mappedUserId;
				}
			}

			const bylineId = primaryAuthor
				? await resolveImportByline(
						primaryAuthor.slug || primaryAuthor.email || primaryAuthor.id,
						primaryAuthor.name,
						authorId,
						bylineRepo,
						bylineCache,
					)
				: undefined;

			const createResult = await createContent(collection, {
				data,
				slug,
				status: mapGhostStatus(post.status),
				authorId,
				bylines: bylineId ? [{ bylineId }] : undefined,
			});

			if (createResult.success) {
				result.imported++;
				result.byCollection[collection] = (result.byCollection[collection] ?? 0) + 1;
			} else {
				result.errors.push({
					title: post.title || "Untitled",
					error:
						typeof createResult.error === "object" && createResult.error !== null
							? (createResult.error as { message?: string }).message || "Unknown error"
							: String(createResult.error),
				});
			}
		} catch (error) {
			result.errors.push({
				title: post.title || "Untitled",
				error: error instanceof Error ? error.message : "Failed to import item",
			});
		}
	}

	if (config.importSiteTitle) {
		result.settings = await importSiteSettings(
			{
				title: extractGhostSiteSettings(ghost.data.settings).title,
				tagline: extractGhostSiteSettings(ghost.data.settings).tagline,
			},
			emdash.db,
		);
		if (result.settings.errors.length > 0) {
			result.errors.push(
				...result.settings.errors.map((entry) => ({
					title: "Site settings",
					error: `${entry.setting}: ${entry.error}`,
				})),
			);
		}
	}

	result.success = result.errors.length === 0;
	return result;
}

export function collectGhostAttachments(ghost: GhostExport): GhostAttachmentInfo[] {
	const urls = new Set<string>();

	for (const post of ghost.data.posts) {
		if (post.featureImage) urls.add(post.featureImage);
		if (post.html) {
			for (const url of extractImageUrls(post.html)) {
				urls.add(url);
			}
		}
	}

	for (const user of ghost.data.users) {
		if (user.profileImage) urls.add(user.profileImage);
	}

	for (const setting of ghost.data.settings) {
		if ((setting.key === "logo" || setting.key === "icon") && typeof setting.value === "string") {
			urls.add(setting.value);
		}
	}

	return Array.from(urls, (url) => ({
		url,
		filename: getFilenameFromUrl(url),
		mimeType: getMimeType(url),
	}));
}

export function ghostPostToPortableText(post: GhostPost) {
	if (post.html?.trim()) {
		return htmlToPortableText(post.html);
	}

	if (post.plaintext?.trim()) {
		return htmlToPortableText(`<p>${escapeHtml(post.plaintext)}</p>`);
	}

	return [];
}

function unwrapGhostRoot(input: unknown): {
	meta?: Record<string, unknown>;
	data: Record<string, unknown>;
} {
	if (Array.isArray(input)) {
		throw new Error("Ghost export root must be an object");
	}

	const root = asRecord(input);
	if (root.db && Array.isArray(root.db)) {
		const first = root.db[0];
		const wrapped = asRecord(first);
		return {
			meta: wrapped.meta ? asRecord(wrapped.meta) : undefined,
			data: asRecord(wrapped.data),
		};
	}

	return {
		meta: root.meta ? asRecord(root.meta) : undefined,
		data: asRecord(root.data),
	};
}

function mapGhostPosts(value: unknown): GhostPost[] {
	return asArray(value).flatMap((entry) => {
		const post = asRecord(entry);
		const type = asString(post.type);
		if (type !== "post" && type !== "page") return [];

		return [
			{
				id: asRequiredString(post.id, "Ghost post id"),
				title: asString(post.title) || "Untitled",
				slug: asString(post.slug) || "",
				html: asString(post.html),
				plaintext: asString(post.plaintext),
				customExcerpt: asString(post.custom_excerpt),
				featureImage: asString(post.feature_image),
				type,
				status: mapRawGhostStatus(asString(post.status)),
				createdAt: asString(post.created_at),
				updatedAt: asString(post.updated_at),
				publishedAt: asString(post.published_at),
			},
		];
	});
}

function mapGhostPostsMeta(value: unknown): GhostPostMeta[] {
	return asArray(value).flatMap((entry) => {
		const meta = asRecord(entry);
		const postId = asString(meta.post_id);
		if (!postId) return [];
		return [
			{
				postId,
				featureImageAlt: asString(meta.feature_image_alt),
				featureImageCaption: asString(meta.feature_image_caption),
			},
		];
	});
}

function mapGhostTags(value: unknown): GhostTag[] {
	return asArray(value).flatMap((entry) => {
		const tag = asRecord(entry);
		const id = asString(tag.id);
		const name = asString(tag.name);
		const slug = asString(tag.slug);
		if (!id || !name || !slug) return [];
		return [{ id, name, slug }];
	});
}

function mapGhostPostsTags(value: unknown): GhostPostTag[] {
	return asArray(value).flatMap((entry) => {
		const relation = asRecord(entry);
		const postId = asString(relation.post_id);
		const tagId = asString(relation.tag_id);
		if (!postId || !tagId) return [];
		return [{ postId, tagId }];
	});
}

function mapGhostUsers(value: unknown): GhostUser[] {
	return asArray(value).flatMap((entry) => {
		const user = asRecord(entry);
		const id = asString(user.id);
		const name = asString(user.name);
		const slug = asString(user.slug);
		if (!id || !name || !slug) return [];
		return [
			{
				id,
				name,
				slug,
				email: asString(user.email),
				profileImage: asString(user.profile_image),
			},
		];
	});
}

function mapGhostPostsAuthors(value: unknown): GhostPostAuthor[] {
	return asArray(value).flatMap((entry) => {
		const relation = asRecord(entry);
		const postId = asString(relation.post_id);
		const authorId = asString(relation.author_id);
		if (!postId || !authorId) return [];
		return [
			{
				postId,
				authorId,
				sortOrder: asNumber(relation.sort_order),
			},
		];
	});
}

function mapGhostSettings(value: unknown): GhostSetting[] {
	return asArray(value).flatMap((entry) => {
		const setting = asRecord(entry);
		const key = asString(setting.key);
		if (!key) return [];
		return [{ key, value: setting.value }];
	});
}

function extractGhostSiteSettings(settings: GhostSetting[]) {
	const map = new Map(settings.map((setting) => [setting.key, setting.value] as const));
	return {
		title: asString(map.get("title")),
		tagline: asString(map.get("description")),
		url: asString(map.get("url")),
	};
}

function buildAuthorsByPost(relations: GhostPostAuthor[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	const sortedRelations = relations.toSorted((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	for (const relation of sortedRelations) {
		const existing = map.get(relation.postId);
		if (existing) {
			existing.push(relation.authorId);
		} else {
			map.set(relation.postId, [relation.authorId]);
		}
	}
	return map;
}

function extractImageUrls(html: string): string[] {
	const urls: string[] = [];
	for (const match of html.matchAll(IMAGE_URL_PATTERN)) {
		const url = match[1];
		if (url) {
			urls.push(url);
		}
	}
	return urls;
}

function mapGhostStatus(status: GhostStatus): "draft" | "published" {
	return status === "published" ? "published" : "draft";
}

function mapRawGhostStatus(status: string | undefined): GhostStatus {
	switch (status) {
		case "published":
			return "published";
		case "scheduled":
			return "scheduled";
		default:
			return "draft";
	}
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected object in Ghost export");
	}
	return Object.fromEntries(Object.entries(value));
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asRequiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function getFilenameFromUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split("/").filter(Boolean);
		return segments.pop();
	} catch {
		return undefined;
	}
}

function getMimeType(url: string): string | undefined {
	const filename = getFilenameFromUrl(url);
	if (!filename) return undefined;
	if (filename.endsWith(".png")) return "image/png";
	if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
	if (filename.endsWith(".gif")) return "image/gif";
	if (filename.endsWith(".webp")) return "image/webp";
	if (filename.endsWith(".svg")) return "image/svg+xml";
	return undefined;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
