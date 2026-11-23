import * as core from "@actions/core";
import { setTimeout as sleep } from "node:timers/promises";
import { getConfig } from "./config.ts";
import {
	type ApplicationStatus,
	logProgress,
	parseStatus,
	rollbackDetails,
	writeSummary,
} from "./status.ts";

const requestTimeoutMs = 30_000;
const pollIntervalMs = 5_000;

type Config = ReturnType<typeof getConfig>;

export async function run(): Promise<void> {
	try {
		const config = getConfig();
		const trigger = await triggerDeployment(config);
		if (trigger.id === undefined || !config.wait) {
			if (config.wait) {
				core.info("The Hub did not return a trigger ID. Skipping deployment status polling.");
			}
			core.setOutput("status", "triggered");
			return;
		}

		await waitForDeployment(config, trigger.id, trigger.applications);
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

async function triggerDeployment(config: Config) {
	const { hubUrl, endpoint, syncRepo, pullImages, wait } = config;
	const token = await getToken(hubUrl);

	core.startGroup("Triggering Deployment");
	try {
		core.info(`Hub: ${hubUrl}`);
		core.info(`syncRepo: ${syncRepo}, pullImages: ${pullImages}`);

		const signal = AbortSignal.timeout(requestTimeoutMs);
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { ...hubHeaders(token), "Content-Type": "application/json" },
			body: JSON.stringify({ syncRepo, pullImages, waitForResult: wait ? true : undefined }),
			signal,
		});
		const body = await readBody(response, signal);
		const message = extractMessage(body);

		if (!response.ok) {
			throw new Error(
				`Can not start deployment. Hub returned HTTP ${response.status}: ${message ?? "(empty body)"}`,
			);
		}

		core.info(message ?? "Deployment triggered successfully.");
		const id = typeof body?.triggerId === "string" && body.triggerId ? body.triggerId : undefined;
		if (id !== undefined) {
			core.setOutput("triggerId", id);
		}
		const applications: ApplicationStatus[] = [];
		if (Array.isArray(body?.applications)) {
			for (const value of body.applications as unknown[]) {
				const app = asRecord(value);
				if (typeof app?.id === "string" && typeof app.name === "string") {
					applications.push({ id: app.id, name: app.name, status: "running", events: [] });
				}
			}
		}
		return { id, applications };
	} finally {
		core.endGroup();
	}
}

async function waitForDeployment(config: Config, id: string, applications: ApplicationStatus[]) {
	let latest = applications;
	const previous = new Map<string, string>();
	const deadline = new AbortController();
	const expired = Promise.withResolvers<"timeout">();
	const timeout = setTimeout(() => {
		expired.resolve("timeout");
		deadline.abort();
	}, config.timeoutMs);

	let status: "succeeded" | "failed" | "timeout";
	try {
		status = await Promise.race([
			expired.promise,
			poll(config, id, deadline.signal, (applications) => {
				latest = applications;
				logProgress(applications, previous);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}

	const rollbacks = rollbackDetails(latest);
	core.setOutput("status", status);
	await writeSummary(status, latest);
	const details = rollbacks.length ? ` ${rollbacks.join(" ")}` : "";
	if (status === "timeout") {
		throw new Error(
			`Timed out after ${config.timeoutMs / 1000}s waiting for OrcaCD. The deployment may still be running.${details}`,
		);
	}
	if (status === "failed") {
		throw new Error(`OrcaCD deployment failed.${details}`);
	}
}

async function poll(
	config: Config,
	id: string,
	deadline: AbortSignal,
	report: (applications: ApplicationStatus[]) => void,
): Promise<"succeeded" | "failed"> {
	const url = `${config.endpoint}/triggers/${encodeURIComponent(id)}`;
	let retryMs = pollIntervalMs;
	while (true) {
		const token = await getToken(config.hubUrl);
		deadline.throwIfAborted();
		const signal = AbortSignal.any([deadline, AbortSignal.timeout(requestTimeoutMs)]);
		const response = await fetch(url, { method: "GET", headers: hubHeaders(token), signal });
		deadline.throwIfAborted();

		if (response.status === 429 || response.status >= 500) {
			await response.body?.cancel();
			core.info(`Hub returned HTTP ${response.status}. Retrying in ${retryMs / 1000}s.`);
			await sleep(retryMs, undefined, { signal: deadline });
			retryMs = Math.min(retryMs * 2, requestTimeoutMs);
			continue;
		}

		const body = await readBody(response, signal);
		if (!response.ok) {
			throw new Error(
				`Could not check deployment status. Hub returned HTTP ${response.status}: ${extractMessage(body) ?? "(empty body)"}`,
			);
		}

		const result = parseStatus(body);
		report(result.applications);
		if (result.status !== "running") {
			return result.applications.some((app) =>
				app.events.some((event) => event.type === "rollback"),
			)
				? "failed"
				: result.status;
		}

		retryMs = pollIntervalMs;
		await sleep(pollIntervalMs, undefined, { signal: deadline });
	}
}

async function getToken(hubUrl: string) {
	const token = await core.getIDToken(hubUrl);
	core.setSecret(token);
	return token;
}

function hubHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "OrcaCD Deploy GitHub Action",
	};
}

async function readBody(response: Response, signal: AbortSignal) {
	const json: unknown = await response.json().catch(() => null);
	signal.throwIfAborted();
	return asRecord(json);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
}

function extractMessage(body: Record<string, unknown> | undefined): string | undefined {
	if (typeof body?.message === "string") {
		return body.message;
	}
	if (typeof body?.error === "string") {
		return body.error;
	}
}
