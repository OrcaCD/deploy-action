import * as core from "@actions/core";

type TriggerStatus = "running" | "succeeded" | "failed";

type DeploymentEvent = {
	type: string;
	status: string;
	source?: string;
	commit?: string;
	error?: string;
};

export type ApplicationStatus = {
	id: string;
	name: string;
	status: TriggerStatus | "skipped";
	events: DeploymentEvent[];
};

export function parseStatus(body: Record<string, unknown> | undefined): {
	status: TriggerStatus;
	applications: ApplicationStatus[];
} {
	if (
		!isTriggerStatus(body?.status) ||
		!Array.isArray(body?.applications) ||
		!body.applications.every(isApplicationStatus)
	) {
		throw new Error("Hub returned an invalid deployment status response.");
	}
	return { status: body.status, applications: body.applications };
}

function isTriggerStatus(value: unknown): value is TriggerStatus {
	return value === "running" || value === "succeeded" || value === "failed";
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const { id, name, status, events } = value as Record<string, unknown>;
	return (
		typeof id === "string" &&
		typeof name === "string" &&
		(isTriggerStatus(status) || status === "skipped") &&
		Array.isArray(events) &&
		events.every(isDeploymentEvent)
	);
}

function isDeploymentEvent(value: unknown): value is DeploymentEvent {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const { type, status, source, commit, error } = value as Record<string, unknown>;
	return (
		typeof type === "string" &&
		typeof status === "string" &&
		[source, commit, error].every((field) => field === undefined || typeof field === "string")
	);
}

export function logProgress(applications: ApplicationStatus[], previous: Map<string, string>) {
	for (const app of applications) {
		const snapshot = JSON.stringify(app);
		if (snapshot === previous.get(app.id)) {
			continue;
		}
		previous.set(app.id, snapshot);
		core.startGroup(`Deployment: ${singleLine(app.name)} (${app.status})`);
		try {
			for (const event of app.events) {
				const details = [event.status, event.commit, event.source, event.error].filter(Boolean);
				core.info(singleLine(`${event.type}: ${details.join(" · ")}`));
			}
		} finally {
			core.endGroup();
		}
	}
}

export function rollbackDetails(applications: ApplicationStatus[]): string[] {
	return applications.flatMap((app) => {
		const rollback = app.events.findLast((event) => event.type === "rollback");
		if (!rollback) {
			return [];
		}
		const name = singleLine(app.name);
		const commit = rollback.commit ? singleLine(rollback.commit) : undefined;
		if (rollback.status === "succeeded") {
			return [
				commit
					? `${name} rolled back and is now running commit ${commit}.`
					: `${name} rolled back.`,
			];
		}
		return [
			`${name} rollback${commit ? ` to commit ${commit}` : ""} (${singleLine(rollback.status)}).`,
		];
	});
}

export async function writeSummary(status: string, applications: ApplicationStatus[]) {
	const headings = ["Application", "Operation", "Commit", "Result", "Error", "Rollback"];
	const rows = applications.flatMap((app) => {
		const name = escapeCell(app.name);
		if (!app.events.length) {
			return [[name, "—", "—", app.status, "—", "—"]];
		}
		return app.events.map((event) => [
			name,
			escapeCell(event.type),
			escapeCell(event.commit ?? "—"),
			escapeCell(event.status),
			escapeCell(event.error ?? "—"),
			event.type === "rollback" ? escapeCell(event.source ?? "Yes") : "—",
		]);
	});
	await core.summary
		.addHeading("OrcaCD deployment", 2)
		.addRaw(`Status: ${status}`, true)
		.addTable([headings.map((data) => ({ data, header: true })), ...rows])
		.write();
}

function singleLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

function escapeCell(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replace(/\r\n|\r|\n/g, "<br>");
}
