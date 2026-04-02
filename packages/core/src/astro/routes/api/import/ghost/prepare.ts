import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { wpPrepareBody } from "#api/schemas.js";
import type { FieldType } from "#schema/types.js";
import type { EmDashHandlers } from "#types";

export const prerender = false;

interface ImportFieldDef {
	slug: string;
	label: string;
	type: string;
	required: boolean;
	searchable?: boolean;
}

interface PrepareRequest {
	postTypes: Array<{
		name: string;
		collection: string;
		fields: ImportFieldDef[];
	}>;
}

interface PrepareResult {
	success: boolean;
	collectionsCreated: string[];
	fieldsCreated: Array<{ collection: string; field: string }>;
	errors: Array<{ collection: string; error: string }>;
}

function asFieldType(value: string): FieldType | undefined {
	switch (value) {
		case "boolean":
		case "datetime":
		case "image":
		case "integer":
		case "json":
		case "number":
		case "portableText":
		case "reference":
		case "slug":
		case "string":
		case "text":
			return value;
		default:
			return undefined;
	}
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	try {
		const body = await parseBody(request, wpPrepareBody);
		if (isParseError(body)) return body;

		const importRequest: PrepareRequest = {
			postTypes: body.postTypes.map((postType) => ({
				name: postType.name,
				collection: postType.collection,
				fields: postType.fields ?? [],
			})),
		};

		return apiSuccess(await prepareImport(emdash.db, importRequest));
	} catch (error) {
		return handleError(error, "Failed to prepare Ghost import", "GHOST_PREPARE_ERROR");
	}
};

async function prepareImport(
	db: NonNullable<EmDashHandlers["db"]>,
	importRequest: PrepareRequest,
): Promise<PrepareResult> {
	const { SchemaRegistry } = await import("#schema/registry.js");
	const registry = new SchemaRegistry(db);
	const result: PrepareResult = {
		success: true,
		collectionsCreated: [],
		fieldsCreated: [],
		errors: [],
	};

	for (const postType of importRequest.postTypes) {
		const collectionSlug = postType.collection;

		try {
			let collection = await registry.getCollection(collectionSlug);

			if (!collection) {
				const label =
					collectionSlug === "posts"
						? "Posts"
						: collectionSlug === "pages"
							? "Pages"
							: capitalize(collectionSlug);
				const labelSingular =
					collectionSlug === "posts"
						? "Post"
						: collectionSlug === "pages"
							? "Page"
							: capitalize(singularize(collectionSlug));

				const isSearchable = ["posts", "pages", "post", "page"].includes(collectionSlug);
				const supports: ("revisions" | "drafts" | "search")[] = ["revisions", "drafts"];
				if (isSearchable) supports.push("search");

				collection = await registry.createCollection({
					slug: collectionSlug,
					label,
					labelSingular,
					description: `Imported from Ghost ${postType.name}s`,
					supports,
					urlPattern:
						collectionSlug === "pages"
							? "/{slug}"
							: collectionSlug === "posts"
								? "/blog/{slug}"
								: undefined,
				});

				result.collectionsCreated.push(collectionSlug);
			}

			const existingFields = await registry.listFields(collection.id);
			const existingFieldSlugs = new Set(existingFields.map((field) => field.slug));

			for (const field of postType.fields) {
				if (existingFieldSlugs.has(field.slug)) continue;

				const fieldType = asFieldType(field.type);
				if (!fieldType) {
					result.errors.push({
						collection: collectionSlug,
						error: `Unknown field type "${field.type}" for field "${field.slug}"`,
					});
					continue;
				}

				await registry.createField(collectionSlug, {
					slug: field.slug,
					label: field.label,
					type: fieldType,
					required: field.required,
					unique: false,
					searchable: field.searchable ?? false,
					sortOrder: existingFields.length + result.fieldsCreated.length,
				});

				result.fieldsCreated.push({ collection: collectionSlug, field: field.slug });
			}
		} catch (error) {
			console.error(`Prepare error for collection "${collectionSlug}":`, error);
			result.success = false;
			result.errors.push({
				collection: collectionSlug,
				error: "Failed to prepare collection",
			});
		}
	}

	return result;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function singularize(value: string): string {
	return value.endsWith("s") ? value.slice(0, -1) : value;
}
