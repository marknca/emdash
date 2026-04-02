import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import {
	executeGhostImport,
	parseGhostExportString,
	type GhostImportConfig,
} from "#import/sources/ghost.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, emdashManifest, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleContentCreate) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;
		const configEntry = formData.get("config");
		const configJson = typeof configEntry === "string" ? configEntry : null;

		if (!file) {
			return apiError("VALIDATION_ERROR", "No file provided", 400);
		}

		if (!configJson) {
			return apiError("VALIDATION_ERROR", "No config provided", 400);
		}

		const config = parseGhostImportConfig(configJson);
		const ghost = parseGhostExportString(await file.text());
		return apiSuccess(await executeGhostImport(ghost, config, emdash, emdashManifest));
	} catch (error) {
		return handleError(error, "Failed to import Ghost content", "GHOST_IMPORT_ERROR");
	}
};

function parseGhostImportConfig(configJson: string): GhostImportConfig {
	const parsed: unknown = JSON.parse(configJson);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid Ghost import config");
	}

	const config = Object.fromEntries(Object.entries(parsed));
	const postTypeMappings = parsePostTypeMappings(config.postTypeMappings);
	const authorMappings = parseAuthorMappings(config.authorMappings);

	return {
		postTypeMappings,
		skipExisting: config.skipExisting !== false,
		authorMappings,
		importSiteTitle: config.importSiteTitle === true,
	};
}

function parsePostTypeMappings(value: unknown): GhostImportConfig["postTypeMappings"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}

	const result: GhostImportConfig["postTypeMappings"] = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			continue;
		}
		const record = Object.fromEntries(Object.entries(entry));
		if (typeof record.collection !== "string" || typeof record.enabled !== "boolean") {
			continue;
		}
		result[key] = {
			collection: record.collection,
			enabled: record.enabled,
		};
	}
	return result;
}

function parseAuthorMappings(value: unknown): Record<string, string | null> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const result: Record<string, string | null> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" || entry === null) {
			result[key] = entry;
		}
	}

	return Object.keys(result).length > 0 ? result : undefined;
}
