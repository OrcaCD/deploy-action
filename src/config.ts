import * as core from "@actions/core";

type Config = {
	hubUrl: string;
	endpoint: string;
	syncRepo: boolean;
	pullImages: boolean;
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

	return { hubUrl, endpoint: `${hubUrl}/api/v1/github-actions`, syncRepo, pullImages };
}
