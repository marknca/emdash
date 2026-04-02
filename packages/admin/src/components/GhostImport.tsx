import { Badge, Button, Loader } from "@cloudflare/kumo";
import { Check, FileText, GlobeSimple, Upload } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import {
	analyzeGhost,
	prepareGhostImport,
	executeGhostImport,
	importWxrMedia,
	rewriteContentUrls,
	fetchUsers,
	type GhostAnalysis,
	type PrepareResult,
	type AttachmentInfo,
	type GhostImportResult,
	type MediaImportResult,
	type MediaImportProgress,
	type RewriteUrlsResult,
	type UserListItem,
} from "../lib/api";
import { DialogError, getMutationError } from "./DialogError.js";

type GhostStep =
	| "upload"
	| "review"
	| "authors"
	| "preparing"
	| "importing"
	| "media"
	| "importing-media"
	| "rewriting"
	| "complete";

interface PostTypeSelection {
	enabled: boolean;
	collection: string;
}

interface GhostAuthorMapping {
	ghostAuthorId: string;
	name: string;
	email?: string;
	postCount: number;
	emdashUserId: string | null;
}

export function GhostImport() {
	const [step, setStep] = React.useState<GhostStep>("upload");
	const [file, setFile] = React.useState<File | null>(null);
	const [analysis, setAnalysis] = React.useState<GhostAnalysis | null>(null);
	const [selections, setSelections] = React.useState<Record<string, PostTypeSelection>>({});
	const [authorMappings, setAuthorMappings] = React.useState<GhostAuthorMapping[]>([]);
	const [emdashUsers, setEmdashUsers] = React.useState<UserListItem[]>([]);
	const [_prepareResult, setPrepareResult] = React.useState<PrepareResult | null>(null);
	const [result, setResult] = React.useState<GhostImportResult | null>(null);
	const [mediaResult, setMediaResult] = React.useState<MediaImportResult | null>(null);
	const [rewriteResult, setRewriteResult] = React.useState<RewriteUrlsResult | null>(null);
	const [mediaProgress, setMediaProgress] = React.useState<MediaImportProgress | null>(null);
	const [skipMedia, setSkipMedia] = React.useState(false);
	const [importSiteTitle, setImportSiteTitle] = React.useState(true);

	const analyzeMutation = useMutation({
		mutationFn: analyzeGhost,
		onSuccess: async (data) => {
			setAnalysis(data);
			setSelections(
				Object.fromEntries(
					data.postTypes.map((postType) => [
						postType.name,
						{
							enabled: postType.schemaStatus.canImport,
							collection: postType.suggestedCollection,
						},
					]),
				),
			);

			try {
				const usersResult = await fetchUsers({ limit: 100 });
				setEmdashUsers(usersResult.items);
				setAuthorMappings(
					data.authors.map((author) => ({
						ghostAuthorId: author.id,
						name: author.name,
						email: author.email,
						postCount: author.postCount,
						emdashUserId:
							usersResult.items.find(
								(user) => user.email.toLowerCase() === author.email?.toLowerCase(),
							)?.id ?? null,
					})),
				);
			} catch {
				setAuthorMappings(
					data.authors.map((author) => ({
						ghostAuthorId: author.id,
						name: author.name,
						email: author.email,
						postCount: author.postCount,
						emdashUserId: null,
					})),
				);
			}

			setStep("review");
		},
	});

	const prepareMutation = useMutation({
		mutationFn: prepareGhostImport,
		onSuccess: (data) => {
			setPrepareResult(data);
			if (data.success) {
				startExecute();
			} else {
				setStep("review");
			}
		},
	});

	const importMutation = useMutation({
		mutationFn: ({
			importFile,
			config,
		}: {
			importFile: File;
			config: Parameters<typeof executeGhostImport>[1];
		}) => executeGhostImport(importFile, config),
		onSuccess: (data) => {
			setResult(data);
			if (analysis && analysis.attachments.count > 0) {
				setStep("media");
			} else {
				setStep("complete");
			}
		},
	});

	const mediaMutation = useMutation({
		mutationFn: (attachments: AttachmentInfo[]) =>
			importWxrMedia(attachments, (progress) => {
				setMediaProgress(progress);
			}),
		onSuccess: (data) => {
			setMediaResult(data);
			if (Object.keys(data.urlMap).length > 0) {
				setStep("rewriting");
				rewriteMutation.mutate(data.urlMap);
			} else {
				setStep("complete");
			}
		},
	});

	const rewriteMutation = useMutation({
		mutationFn: (urlMap: Record<string, string>) => rewriteContentUrls(urlMap),
		onSuccess: (data) => {
			setRewriteResult(data);
			setStep("complete");
		},
	});

	const handleFileSelect = (selectedFile: File | null) => {
		if (!selectedFile) return;
		setFile(selectedFile);
		analyzeMutation.mutate(selectedFile);
	};

	const startImport = () => {
		if (!analysis) return;
		if (analysis.authors.length > 0) {
			setStep("authors");
			return;
		}
		continueImport();
	};

	const continueImport = () => {
		if (!analysis) return;

		const needsSchemaChanges = analysis.postTypes.filter((postType) => {
			const selection = selections[postType.name];
			if (!selection?.enabled) return false;
			return (
				!postType.schemaStatus.exists ||
				Object.values(postType.schemaStatus.fieldStatus).some((field) => field.status === "missing")
			);
		});

		if (needsSchemaChanges.length > 0) {
			setStep("preparing");
			prepareMutation.mutate({
				postTypes: needsSchemaChanges.map((postType) => ({
					name: postType.name,
					collection: selections[postType.name]?.collection ?? postType.suggestedCollection,
					fields: postType.requiredFields,
				})),
			});
			return;
		}

		startExecute();
	};

	const startExecute = () => {
		if (!file) return;
		setStep("importing");
		importMutation.mutate({
			importFile: file,
			config: {
				postTypeMappings: selections,
				skipExisting: true,
				importSiteTitle,
				authorMappings: Object.fromEntries(
					authorMappings.map((mapping) => [mapping.ghostAuthorId, mapping.emdashUserId]),
				),
			},
		});
	};

	const reset = () => {
		setStep("upload");
		setFile(null);
		setAnalysis(null);
		setSelections({});
		setAuthorMappings([]);
		setEmdashUsers([]);
		setPrepareResult(null);
		setResult(null);
		setMediaResult(null);
		setRewriteResult(null);
		setMediaProgress(null);
		setSkipMedia(false);
		setImportSiteTitle(true);
		analyzeMutation.reset();
		prepareMutation.reset();
		importMutation.reset();
		mediaMutation.reset();
		rewriteMutation.reset();
	};

	const selectedCount = Object.values(selections).filter((selection) => selection.enabled).length;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-bold">Import from Ghost</h1>
				<p className="mt-1 text-kumo-subtle">
					Upload a Ghost export JSON file to migrate posts, pages, authors, and media references.
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StepIndicator
					number={1}
					label="Upload"
					active={step === "upload"}
					complete={step !== "upload"}
				/>
				<div className="h-px w-8 bg-kumo-line" />
				<StepIndicator
					number={2}
					label="Review"
					active={step === "review" || step === "authors"}
					complete={[
						"preparing",
						"importing",
						"media",
						"importing-media",
						"rewriting",
						"complete",
					].includes(step)}
				/>
				<div className="h-px w-8 bg-kumo-line" />
				<StepIndicator
					number={3}
					label="Import"
					active={step === "preparing" || step === "importing"}
					complete={["media", "importing-media", "rewriting", "complete"].includes(step)}
				/>
				{analysis && analysis.attachments.count > 0 && (
					<>
						<div className="h-px w-8 bg-kumo-line" />
						<StepIndicator
							number={4}
							label="Media"
							active={step === "media" || step === "importing-media" || step === "rewriting"}
							complete={step === "complete"}
						/>
					</>
				)}
			</div>

			{step === "upload" && (
				<div className="rounded-lg border bg-kumo-base p-8">
					<div className="flex items-start gap-3">
						<div className="rounded-lg bg-kumo-brand/10 p-3 text-kumo-brand">
							<Upload className="size-6" />
						</div>
						<div className="space-y-2">
							<h2 className="font-medium text-lg">Ghost Export File</h2>
							<p className="text-sm text-kumo-subtle">
								Upload the `.json` export downloaded from Ghost Admin.
							</p>
						</div>
					</div>
					<div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
						<label className="inline-flex cursor-pointer items-center gap-3 rounded-md border border-kumo-line px-4 py-2 text-sm">
							<FileText className="size-4" />
							<span>{file?.name || "Choose export file"}</span>
							<input
								type="file"
								accept=".json,application/json"
								className="hidden"
								onChange={(event) => handleFileSelect(event.target.files?.[0] ?? null)}
							/>
						</label>
						{analyzeMutation.isPending && (
							<div className="flex items-center gap-2 text-sm text-kumo-subtle">
								<Loader />
								<span>Analyzing export...</span>
							</div>
						)}
					</div>
					<DialogError message={getMutationError(analyzeMutation.error)} className="mt-4" />
				</div>
			)}

			{step === "review" && analysis && (
				<div className="space-y-4 rounded-lg border bg-kumo-base p-6">
					<div className="flex items-start justify-between gap-4">
						<div>
							<div className="flex items-center gap-2">
								<h2 className="font-medium text-lg">{analysis.site.title}</h2>
								<Badge variant="primary">{analysis.site.url ? "Ghost" : "Export"}</Badge>
							</div>
							<p className="mt-1 text-sm text-kumo-subtle">
								{analysis.site.tagline || analysis.site.url || "Ghost content export"}
							</p>
						</div>
						<div className="rounded-lg bg-kumo-surface px-4 py-3 text-right">
							<div className="text-sm text-kumo-subtle">Media assets</div>
							<div className="font-medium text-lg">{analysis.attachments.count}</div>
						</div>
					</div>

					<DialogError
						message={
							getMutationError(prepareMutation.error) || getMutationError(importMutation.error)
						}
					/>

					<div className="space-y-3">
						<h3 className="font-medium">Content to import</h3>
						{analysis.postTypes.map((postType) => {
							const selection = selections[postType.name];
							const incompatible = !postType.schemaStatus.canImport;
							return (
								<label
									key={postType.name}
									className="flex items-start justify-between gap-4 rounded-lg border border-kumo-line p-4"
								>
									<div className="space-y-1">
										<div className="font-medium capitalize">
											{postType.name}s <span className="text-kumo-subtle">({postType.count})</span>
										</div>
										<div className="text-sm text-kumo-subtle">
											Collection: {selection?.collection ?? postType.suggestedCollection}
										</div>
										{incompatible && postType.schemaStatus.reason && (
											<div className="text-sm text-kumo-danger">{postType.schemaStatus.reason}</div>
										)}
									</div>
									<input
										type="checkbox"
										checked={selection?.enabled ?? false}
										disabled={incompatible}
										onChange={(event) =>
											setSelections((prev) => ({
												...prev,
												[postType.name]: {
													enabled: event.target.checked,
													collection:
														prev[postType.name]?.collection ?? postType.suggestedCollection,
												},
											}))
										}
									/>
								</label>
							);
						})}
					</div>

					<div className="rounded-lg border border-kumo-line p-4">
						<label className="flex items-start justify-between gap-4">
							<div>
								<div className="font-medium">Import site title and tagline</div>
								<p className="text-sm text-kumo-subtle">
									Apply Ghost’s site title and description to EmDash settings.
								</p>
							</div>
							<input
								type="checkbox"
								checked={importSiteTitle}
								onChange={(event) => setImportSiteTitle(event.target.checked)}
							/>
						</label>
					</div>

					<div className="flex items-center justify-between gap-3">
						<div className="text-sm text-kumo-subtle">
							{selectedCount} content type{selectedCount === 1 ? "" : "s"} selected
						</div>
						<div className="flex gap-3">
							<Button variant="ghost" onClick={reset}>
								Start Over
							</Button>
							<Button onClick={startImport} disabled={selectedCount === 0}>
								Start Import
							</Button>
						</div>
					</div>
				</div>
			)}

			{step === "authors" && (
				<div className="space-y-4 rounded-lg border bg-kumo-base p-6">
					<div>
						<h2 className="font-medium text-lg">Map Authors</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							Match Ghost authors to EmDash users. Unmapped authors will be imported as guest
							bylines.
						</p>
					</div>
					<div className="space-y-3">
						{authorMappings.map((mapping) => (
							<div
								key={mapping.ghostAuthorId}
								className="grid gap-3 rounded-lg border border-kumo-line p-4 md:grid-cols-[1fr_220px]"
							>
								<div>
									<div className="font-medium">{mapping.name}</div>
									<div className="text-sm text-kumo-subtle">
										{mapping.email || "No email"} · {mapping.postCount} item
										{mapping.postCount === 1 ? "" : "s"}
									</div>
								</div>
								<select
									className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
									value={mapping.emdashUserId ?? ""}
									onChange={(event) => {
										const nextValue = event.target.value || null;
										setAuthorMappings((prev) =>
											prev.map((entry) =>
												entry.ghostAuthorId === mapping.ghostAuthorId
													? { ...entry, emdashUserId: nextValue }
													: entry,
											),
										);
									}}
								>
									<option value="">Create guest byline</option>
									{emdashUsers.map((user) => (
										<option key={user.id} value={user.id}>
											{user.name || user.email}
										</option>
									))}
								</select>
							</div>
						))}
					</div>
					<div className="flex justify-between gap-3">
						<Button variant="ghost" onClick={() => setStep("review")}>
							Back
						</Button>
						<Button onClick={continueImport}>Continue Import</Button>
					</div>
				</div>
			)}

			{["preparing", "importing", "rewriting"].includes(step) && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">
						{step === "preparing"
							? "Creating collections and fields..."
							: step === "importing"
								? "Importing Ghost content..."
								: "Updating imported content URLs..."}
					</p>
				</div>
			)}

			{step === "media" && analysis && (
				<div className="space-y-4 rounded-lg border bg-kumo-base p-6">
					<div className="flex items-start gap-3">
						<div className="rounded-lg bg-kumo-brand/10 p-3 text-kumo-brand">
							<GlobeSimple className="size-6" />
						</div>
						<div>
							<h2 className="font-medium text-lg">Import Media Files</h2>
							<p className="mt-1 text-sm text-kumo-subtle">
								Copy {analysis.attachments.count} referenced Ghost media files into EmDash.
							</p>
						</div>
					</div>
					<DialogError
						message={
							getMutationError(mediaMutation.error) || getMutationError(rewriteMutation.error)
						}
					/>
					<div className="flex justify-between gap-3">
						<Button
							variant="ghost"
							onClick={() => {
								setSkipMedia(true);
								setStep("complete");
							}}
						>
							Skip Media
						</Button>
						<Button
							onClick={() => {
								setStep("importing-media");
								mediaMutation.mutate(analysis.attachments.items);
							}}
						>
							Import Media
						</Button>
					</div>
				</div>
			)}

			{step === "importing-media" && (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Loader />
					<p className="mt-4 text-kumo-subtle">
						{mediaProgress
							? `${mediaProgress.current}/${mediaProgress.total} ${mediaProgress.filename || "media item"}`
							: "Importing media..."}
					</p>
				</div>
			)}

			{step === "complete" && result && (
				<div className="space-y-4 rounded-lg border bg-kumo-base p-6">
					<div className="flex items-center gap-3">
						<div className="rounded-full bg-kumo-success/10 p-2 text-kumo-success">
							<Check className="size-5" />
						</div>
						<div>
							<h2 className="font-medium text-lg">
								{result.success ? "Ghost Import Complete" : "Ghost Import Completed with Errors"}
							</h2>
							<p className="text-sm text-kumo-subtle">
								Imported {result.imported} item{result.imported === 1 ? "" : "s"}.
							</p>
						</div>
					</div>

					<div className="grid gap-3 sm:grid-cols-3">
						<SummaryCard label="Imported" value={String(result.imported)} />
						<SummaryCard label="Skipped" value={String(result.skipped)} />
						<SummaryCard
							label="Media"
							value={
								skipMedia
									? "Skipped"
									: String(
											(mediaResult?.imported.length ?? 0) +
												((rewriteResult?.urlsRewritten ?? 0 > 0) ? 0 : 0),
										)
							}
						/>
					</div>

					{result.settings && (
						<div className="rounded-lg border border-kumo-line p-4 text-sm">
							<div className="font-medium">Site settings</div>
							<div className="mt-1 text-kumo-subtle">
								Applied {result.settings.applied.length}, skipped {result.settings.skipped.length}
							</div>
						</div>
					)}

					{result.errors.length > 0 && (
						<div className="rounded-lg border border-kumo-danger/20 bg-kumo-danger/5 p-4">
							<div className="font-medium text-kumo-danger">Errors</div>
							<ul className="mt-2 space-y-2 text-sm text-kumo-subtle">
								{result.errors.map((error, index) => (
									<li key={`${error.title}-${index}`}>
										<strong>{error.title}:</strong> {error.error}
									</li>
								))}
							</ul>
						</div>
					)}

					<Button onClick={reset}>Import Another File</Button>
				</div>
			)}
		</div>
	);
}

function StepIndicator({
	number,
	label,
	active,
	complete,
}: {
	number: number;
	label: string;
	active: boolean;
	complete: boolean;
}) {
	return (
		<div className="flex items-center gap-2">
			<div
				className={[
					"flex size-7 items-center justify-center rounded-full border text-xs font-medium",
					complete
						? "border-kumo-brand bg-kumo-brand text-white"
						: active
							? "border-kumo-brand text-kumo-brand"
							: "border-kumo-line text-kumo-subtle",
				].join(" ")}
			>
				{number}
			</div>
			<span className={active || complete ? "text-kumo-foreground" : "text-kumo-subtle"}>
				{label}
			</span>
		</div>
	);
}

function SummaryCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-kumo-line p-4">
			<div className="text-sm text-kumo-subtle">{label}</div>
			<div className="mt-1 font-medium text-lg">{value}</div>
		</div>
	);
}
