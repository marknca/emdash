import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { analyzeGhostExport, parseGhostExportString } from "#import/sources/ghost.js";
import type { EmDashHandlers } from "#types";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	try {
		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;

		if (!file) {
			return apiError("VALIDATION_ERROR", "No file provided", 400);
		}

		const ghost = parseGhostExportString(await file.text());
		const existingCollections = await fetchExistingCollections(emdash?.db);
		return apiSuccess(analyzeGhostExport(ghost, existingCollections));
	} catch (error) {
		return handleError(error, "Failed to analyze Ghost export", "GHOST_ANALYZE_ERROR");
	}
};

interface ExistingCollection {
	slug: string;
	fields: Map<string, { type: string }>;
}

async function fetchExistingCollections(
	db: EmDashHandlers["db"] | undefined,
): Promise<Map<string, ExistingCollection>> {
	const result = new Map<string, ExistingCollection>();

	if (!db) return result;

	try {
		const { SchemaRegistry } = await import("#schema/registry.js");
		const registry = new SchemaRegistry(db);
		const collections = await registry.listCollections();

		for (const collection of collections) {
			const fields = await registry.listFields(collection.id);
			result.set(collection.slug, {
				slug: collection.slug,
				fields: new Map(fields.map((field) => [field.slug, { type: field.type }])),
			});
		}
	} catch (error) {
		console.warn("Could not fetch schema registry:", error);
	}

	return result;
}
