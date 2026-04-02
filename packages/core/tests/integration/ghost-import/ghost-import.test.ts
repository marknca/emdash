import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import {
	analyzeGhostExport,
	executeGhostImport,
	parseGhostExportString,
} from "../../../src/import/sources/ghost.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "sample-export.json");

describe("Ghost Import Integration", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;

	beforeEach(async () => {
		db = await setupTestDatabase();

		const registry = new SchemaRegistry(db);

		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("posts", {
			slug: "excerpt",
			label: "Excerpt",
			type: "text",
		});
		await registry.createField("posts", {
			slug: "featured_image",
			label: "Featured Image",
			type: "image",
		});

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("pages", {
			slug: "excerpt",
			label: "Excerpt",
			type: "text",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("analyzes Ghost exports with schema compatibility and attachments", async () => {
		const ghost = parseGhostExportString(await readFile(FIXTURE_PATH, "utf-8"));
		const analysis = analyzeGhostExport(
			ghost,
			new Map([
				[
					"posts",
					{
						slug: "posts",
						fields: new Map([
							["title", { type: "string" }],
							["content", { type: "portableText" }],
							["excerpt", { type: "text" }],
							["featured_image", { type: "image" }],
						]),
					},
				],
				[
					"pages",
					{
						slug: "pages",
						fields: new Map([
							["title", { type: "string" }],
							["content", { type: "portableText" }],
							["excerpt", { type: "text" }],
						]),
					},
				],
			]),
		);

		expect(analysis.site.title).toBe("Ghost Test Site");
		expect(analysis.site.url).toBe("https://ghost.example");
		expect(analysis.postTypes).toEqual([
			expect.objectContaining({
				name: "post",
				count: 1,
				suggestedCollection: "posts",
			}),
			expect.objectContaining({
				name: "page",
				count: 1,
				suggestedCollection: "pages",
			}),
		]);
		expect(analysis.attachments.items.map((item) => item.url)).toEqual(
			expect.arrayContaining([
				"https://ghost.example/content/images/2026/04/cover.jpg",
				"https://ghost.example/content/images/2026/04/inline.jpg",
				"https://ghost.example/content/images/2026/04/avatar.jpg",
			]),
		);
		expect(analysis.authors).toEqual([
			expect.objectContaining({
				id: "user-1",
				slug: "ghost-author",
				postCount: 2,
			}),
		]);
	});

	it("imports Ghost posts and pages into EmDash collections", async () => {
		const ghost = parseGhostExportString(await readFile(FIXTURE_PATH, "utf-8"));
		const emdash = {
			db,
			handleContentCreate: (collection, body) =>
				handleContentCreate(db, collection, body as Parameters<typeof handleContentCreate>[2]),
		} as unknown as EmDashHandlers;
		const manifest = {
			collections: {
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: ["drafts", "revisions"],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
						excerpt: { kind: "text" },
						featured_image: { kind: "image" },
					},
				},
				pages: {
					label: "Pages",
					labelSingular: "Page",
					supports: ["drafts", "revisions"],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
						excerpt: { kind: "text" },
					},
				},
			},
		} as EmDashManifest;

		const result = await executeGhostImport(
			ghost,
			{
				postTypeMappings: {
					post: { collection: "posts", enabled: true },
					page: { collection: "pages", enabled: true },
				},
				skipExisting: true,
				importSiteTitle: true,
			},
			emdash,
			manifest,
		);

		expect(result.success).toBe(true);
		expect(result.imported).toBe(2);
		expect(result.byCollection).toEqual({
			posts: 1,
			pages: 1,
		});
		expect(result.settings?.applied).toEqual(
			expect.arrayContaining(["site_title", "site_tagline"]),
		);

		const repo = new ContentRepository(db);
		const post = await repo.findBySlug("posts", "hello-from-ghost");
		const page = await repo.findBySlug("pages", "about-ghost");

		expect(post?.data.title).toBe("Hello From Ghost");
		expect(post?.data.excerpt).toBe("Ghost excerpt");
		expect(post?.data.featured_image).toBe(
			"https://ghost.example/content/images/2026/04/cover.jpg",
		);
		expect(post?.status).toBe("published");
		expect(page?.status).toBe("draft");
		expect(Array.isArray(post?.data.content)).toBe(true);
		expect(post?.primaryBylineId).toBeTruthy();

		const siteTitle = await db
			.selectFrom("options")
			.select("value")
			.where("name", "=", "site_title")
			.executeTakeFirst();
		expect(siteTitle?.value).toBe("Ghost Test Site");
	});
});
