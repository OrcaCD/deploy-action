import * as core from "@actions/core";
import { getConfig } from "./config.ts";

const timeoutMs = 30_000; // 30 seconds

export async function run(): Promise<void> {
	try {
		const { hubUrl, endpoint, syncRepo, pullImages } = getConfig();

		const token = await core.getIDToken(hubUrl);
		core.setSecret(token); // Prevent token from being logged

		core.startGroup("Triggering Deployment");
		try {
			core.info(`Hub: ${hubUrl}`);
			core.info(`syncRepo: ${syncRepo}, pullImages: ${pullImages}`);

			const abortController = new AbortController();
			const timeout = setTimeout(() => {
				abortController.abort();
			}, timeoutMs);

			let response: Response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						Accept: "application/json",
						"User-Agent": "OrcaCD Deploy GitHub Action",
					},
					body: JSON.stringify({ syncRepo, pullImages }),
					signal: abortController.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			const json: unknown = await response.json().catch(() => null);
			const message = extractMessage(json);

			if (!response.ok) {
				throw new Error(
					`Can not start deployment. Hub returned HTTP ${response.status}: ${message ?? "(empty body)"}`,
				);
			}

			core.info(message ?? "Deployment triggered successfully.");
		} finally {
			core.endGroup();
		}
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

function extractMessage(json: unknown): string | undefined {
	if (
		json !== null &&
		typeof json === "object" &&
		"message" in json &&
		typeof (json as Record<string, unknown>).message === "string"
	) {
		return (json as Record<string, string>).message;
	}
}
