import { after, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

const getInputMock = mock.fn<(name: string, options?: { required?: boolean }) => string>();
const getBooleanInputMock = mock.fn<(name: string) => boolean>();

mock.module("@actions/core", {
	exports: {
		getInput: getInputMock,
		getBooleanInput: getBooleanInputMock,
	},
});

const { getConfig } = await import("./config.ts");

function setHub(value: string) {
	getInputMock.mock.mockImplementation((name) => (name === "hub" ? value : ""));
}

function setFlags(syncRepo: boolean, pullImages: boolean) {
	getBooleanInputMock.mock.mockImplementation((name: string) => {
		if (name === "syncRepo") {
			return syncRepo;
		}
		if (name === "pullImages") {
			return pullImages;
		}
		return false;
	});
}

beforeEach(() => {
	getInputMock.mock.resetCalls();
	getBooleanInputMock.mock.resetCalls();
	setHub("https://orca.example.com");
	setFlags(true, false);
});

after(() => {
	mock.restoreAll();
});

describe("getConfig()", () => {
	describe("URL normalization: trailing slashes", () => {
		test("strips a single trailing slash", () => {
			setHub("https://orca.example.com/");
			const result = getConfig();
			assert.equal(result.hubUrl, "https://orca.example.com");
		});

		test("strips multiple trailing slashes", () => {
			setHub("https://orca.example.com///");
			const result = getConfig();
			assert.equal(result.hubUrl, "https://orca.example.com");
		});

		test("leaves URL without trailing slash unchanged", () => {
			setHub("https://orca.example.com");
			const result = getConfig();
			assert.equal(result.hubUrl, "https://orca.example.com");
		});
	});

	describe("URL normalization: protocol", () => {
		test("prepends https:// when no protocol is given", () => {
			setHub("orca.example.com");
			const result = getConfig();
			assert.equal(result.hubUrl, "https://orca.example.com");
		});

		test("prepends https:// and strips trailing slash together", () => {
			setHub("orca.example.com/");
			const result = getConfig();
			assert.equal(result.hubUrl, "https://orca.example.com");
		});

		test("preserves explicit https:// protocol", () => {
			setHub("https://orca.example.com");
			const result = getConfig();
			assert.equal(result.hubUrl, "https://orca.example.com");
		});

		test("preserves explicit http:// protocol", () => {
			setHub("http://orca.example.com");
			const result = getConfig();
			assert.equal(result.hubUrl, "http://orca.example.com");
		});
	});

	describe("URL validation: path component", () => {
		test("throws when URL contains a path component", () => {
			setHub("https://orca.example.com/some/path");
			assert.throws(
				() => getConfig(),
				(err: Error) => {
					assert(err instanceof Error);
					assert(err.message.includes("contains a path"));
					return true;
				},
			);
		});

		test("throws when bare hostname has a path component", () => {
			setHub("orca.example.com/path");
			assert.throws(
				() => getConfig(),
				(err: Error) => {
					assert(err instanceof Error);
					assert(err.message.includes("contains a path"));
					return true;
				},
			);
		});
	});

	describe("URL validation: invalid URL", () => {
		test("throws TypeError for a syntactically invalid URL", () => {
			setHub("not a valid url with spaces");
			assert.throws(() => getConfig(), TypeError);
		});
	});

	describe("flag validation", () => {
		test("throws when both syncRepo and pullImages are false", () => {
			setFlags(false, false);
			assert.throws(
				() => getConfig(),
				(err: Error) => {
					assert(err instanceof Error);
					assert.equal(err.message, "At least one of syncRepo or pullImages must be set to true.");
					return true;
				},
			);
		});

		test("succeeds when only syncRepo is true", () => {
			setFlags(true, false);
			const result = getConfig();
			assert.equal(result.syncRepo, true);
			assert.equal(result.pullImages, false);
		});

		test("succeeds when only pullImages is true", () => {
			setFlags(false, true);
			const result = getConfig();
			assert.equal(result.syncRepo, false);
			assert.equal(result.pullImages, true);
		});

		test("succeeds when both are true", () => {
			setFlags(true, true);
			const result = getConfig();
			assert.equal(result.syncRepo, true);
			assert.equal(result.pullImages, true);
		});
	});

	describe("return value shape", () => {
		test("constructs endpoint from hubUrl", () => {
			setHub("https://orca.example.com");
			const result = getConfig();
			assert.equal(result.endpoint, "https://orca.example.com/api/v1/github-actions");
		});

		test("endpoint uses the normalized hubUrl (no trailing slash)", () => {
			setHub("orca.example.com/");
			const result = getConfig();
			assert.equal(result.endpoint, "https://orca.example.com/api/v1/github-actions");
		});

		test("requires the hub input", () => {
			getConfig();
			assert.deepEqual(getInputMock.mock.calls[0]?.arguments, ["hub", { required: true }]);
		});

		test("calls getBooleanInput for 'syncRepo' and 'pullImages'", () => {
			getConfig();
			const names = getBooleanInputMock.mock.calls.map((c) => c.arguments[0]);
			assert(names.includes("syncRepo"));
			assert(names.includes("pullImages"));
		});
	});

	test("waits by default with a 600-second timeout", () => {
		const config = getConfig();
		assert.equal(config.wait, true);
		assert.equal(config.timeoutMs, 600_000);
	});

	test("accepts explicit wait and timeout settings", () => {
		const inputs: Record<string, string> = {
			hub: "https://orca.example.com",
			wait: "false",
			timeout: "900",
		};
		getInputMock.mock.mockImplementation((name) => inputs[name] ?? "");
		const config = getConfig();
		assert.equal(config.wait, false);
		assert.equal(config.timeoutMs, 900_000);
		assert(getBooleanInputMock.mock.calls.some((call) => call.arguments[0] === "wait"));
	});

	test("accepts a timeout of exactly 24 hours", () => {
		getInputMock.mock.mockImplementation((name) =>
			name === "timeout" ? "86400" : name === "hub" ? "https://orca.example.com" : "",
		);
		assert.equal(getConfig().timeoutMs, 86_400_000);
	});

	for (const timeout of ["0", "-1", "Infinity", "1.5", "later", "86401"]) {
		test(`rejects invalid timeout input ${timeout}`, () => {
			getInputMock.mock.mockImplementation((name) =>
				name === "timeout" ? timeout : name === "hub" ? "https://orca.example.com" : "",
			);
			assert.throws(getConfig, /timeout must be a whole number of seconds/);
		});
	}
});
