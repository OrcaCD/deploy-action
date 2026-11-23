import * as core from "@actions/core";

type Config = {
	hubUrl: string;
	endpoint: string;
	syncRepo: boolean;
	pullImages: boolean;
	wait: boolean;
	timeoutMs: number;
};

export function getConfig(): Config {
	let hubUrl = core.getInput("hub", { required: true }).trim().replace(/\/+$/, "");
	if (!hubUrl.startsWith("http://") && !hubUrl.startsWith("https://")) {
		hubUrl = `https://${hubUrl}`;
	}

	const parsed = new URL(hubUrl);
	if (parsed.pathname !== "/") {
		throw new Error(
			`Invalid hub URL: "${hubUrl}" contains a path ("${parsed.pathname}"). Provide only the origin, e.g. https://orca.example.com`,
		);
	}

	const syncRepo = core.getBooleanInput("syncRepo");
	const pullImages = core.getBooleanInput("pullImages");

	if (!syncRepo && !pullImages) {
		throw new Error("At least one of syncRepo or pullImages must be set to true.");
	}

	const wait = core.getInput("wait") === "" ? true : core.getBooleanInput("wait");
	const timeout = Number(core.getInput("timeout") || "600");
	const timeoutMs = timeout * 1000;
	if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeoutMs > 2_147_483_647) {
		throw new Error("timeout must be a whole number of seconds between 1 and 2147483.");
	}

	return {
		hubUrl,
		endpoint: `${hubUrl}/api/v1/github-actions`,
		syncRepo,
		pullImages,
		wait,
		timeoutMs,
	};
}
