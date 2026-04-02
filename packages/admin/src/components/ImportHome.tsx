import { Upload, GlobeSimple, ArrowRight } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";

import { cn } from "../lib/utils.js";

export function ImportHome() {
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-bold">Import Content</h1>
				<p className="mt-1 text-kumo-subtle">Choose a source to migrate content into EmDash.</p>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				<ImportCard
					title="WordPress"
					description="Import from a WordPress export file or a live site using the EmDash Exporter plugin."
					to="/import/wordpress"
					icon={Upload}
				/>
				<ImportCard
					title="Ghost"
					description="Import posts, pages, authors, and site title settings from a Ghost export JSON file."
					to="/import/ghost"
					icon={GlobeSimple}
				/>
			</div>
		</div>
	);
}

function ImportCard({
	title,
	description,
	to,
	icon: Icon,
}: {
	title: string;
	description: string;
	to: "/import/wordpress" | "/import/ghost";
	icon: typeof Upload;
}) {
	return (
		<Link
			to={to}
			className={cn(
				"group block rounded-xl border border-kumo-line bg-kumo-base p-6 no-underline transition-colors",
				"hover:border-kumo-brand/40 hover:bg-kumo-surface",
			)}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-3">
					<div className="flex size-11 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
						<Icon className="size-6" />
					</div>
					<div>
						<h2 className="font-medium text-lg text-kumo-foreground">{title}</h2>
						<p className="mt-1 text-sm text-kumo-subtle">{description}</p>
					</div>
				</div>
				<ArrowRight className="mt-1 size-5 text-kumo-subtle transition-transform group-hover:translate-x-0.5" />
			</div>
		</Link>
	);
}
