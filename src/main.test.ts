import { after, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

// ── @actions/core mock ──────────────────────────────────────────────────────
const startGroupMock = mock.fn<(name: string) => void>();
const endGroupMock = mock.fn<() => void>();
const infoMock = mock.fn<(msg: string) => void>();
const setFailedMock = mock.fn<(msg: string | Error) => void>();
const setSecretMock = mock.fn<(secret: string) => void>();
const getIDTokenMock = mock.fn<(aud?: string) => Promise<string>>(async () => "mock-oidc-token");

mock.module("@actions/core", {
	exports: {
		startGroup: startGroupMock,
		endGroup: endGroupMock,
		info: infoMock,
		setFailed: setFailedMock,
		setSecret: setSecretMock,
		getIDToken: getIDTokenMock,
	},
});

// ── config.ts mock ──────────────────────────────────────────────────────────
const defaultConfig = {
	hubUrl: "https://orca.example.com",
	endpoint: "https://orca.example.com/api/v1/github-actions",
	syncRepo: true,
	pullImages: false,
};

const getConfigMock = mock.fn(() => ({ ...defaultConfig }));

mock.module("./config.ts", {
	exports: { getConfig: getConfigMock },
});

// ── main.ts import (after all mocks) ───────────────────────────────────────
const { run } = await import("./main.ts");

// ── fetch mock ──────────────────────────────────────────────────────────────
const fetchMock = mock.fn<typeof fetch>();
globalThis.fetch = fetchMock;

function makeResponse(ok: boolean, status: number, body: unknown, jsonThrows = false): Response {
	return {
		ok,
		status,
		statusText: String(status),
		json: jsonThrows ? () => Promise.reject(new Error("not json")) : () => Promise.resolve(body),
	} as unknown as Response;
}

function resetAllMocks() {
	startGroupMock.mock.resetCalls();
	endGroupMock.mock.resetCalls();
	infoMock.mock.resetCalls();
	setFailedMock.mock.resetCalls();
	setSecretMock.mock.resetCalls();
	getIDTokenMock.mock.resetCalls();
	getConfigMock.mock.resetCalls();
	fetchMock.mock.resetCalls();
}

beforeEach(() => {
	resetAllMocks();
	getIDTokenMock.mock.mockImplementation(async () => "mock-oidc-token");
	getConfigMock.mock.mockImplementation(() => ({ ...defaultConfig }));
	fetchMock.mock.mockImplementation(async () =>
		makeResponse(true, 200, { message: "Deployment triggered." }),
	);
});

after(() => {
	mock.restoreAll();
});

describe("run()", () => {
	describe("happy path", () => {
		test("calls getIDToken with the hubUrl as audience", async () => {
			await run();
			assert.equal(getIDTokenMock.mock.callCount(), 1);
			assert.equal(getIDTokenMock.mock.calls[0]?.arguments[0], "https://orca.example.com");
		});

		test("masks the OIDC token with setSecret", async () => {
			await run();
			assert.equal(setSecretMock.mock.callCount(), 1);
			assert.equal(setSecretMock.mock.calls[0]?.arguments[0], "mock-oidc-token");
		});

		test("POSTs to the correct endpoint", async () => {
			await run();
			assert.equal(fetchMock.mock.callCount(), 1);
			assert.equal(
				fetchMock.mock.calls[0]?.arguments[0],
				"https://orca.example.com/api/v1/github-actions",
			);
			const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit;
			assert.equal(init.method, "POST");
		});

		test("sends correct headers and body", async () => {
			await run();
			const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit;
			const headers = init.headers as Record<string, string>;
			assert.equal(headers["Authorization"], "Bearer mock-oidc-token");
			assert.equal(headers["Content-Type"], "application/json");
			assert.equal(headers["Accept"], "application/json");
			assert.equal(headers["User-Agent"], "OrcaCD Deploy GitHub Action");
			assert.equal(init.body, JSON.stringify({ syncRepo: true, pullImages: false }));
		});

		test("logs the message from the response body", async () => {
			await run();
			const infoCalls = infoMock.mock.calls.map((c) => c.arguments[0]);
			assert(infoCalls.includes("Deployment triggered."));
		});

		test("falls back to default success message when body has no message field", async () => {
			fetchMock.mock.mockImplementation(async () => makeResponse(true, 200, {}));
			await run();
			const infoCalls = infoMock.mock.calls.map((c) => c.arguments[0]);
			assert(infoCalls.includes("Deployment triggered successfully."));
		});

		test("calls startGroup and endGroup", async () => {
			await run();
			assert.equal(startGroupMock.mock.callCount(), 1);
			assert.equal(endGroupMock.mock.callCount(), 1);
		});

		test("does not call setFailed on success", async () => {
			await run();
			assert.equal(setFailedMock.mock.callCount(), 0);
		});
	});

	describe("HTTP error responses", () => {
		test("uses error message from response body", async () => {
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(false, 401, { message: "Invalid token" }),
			);
			await run();
			assert.equal(setFailedMock.mock.callCount(), 1);
			assert.equal(
				setFailedMock.mock.calls[0]?.arguments[0],
				"Can not start deployment. Hub returned HTTP 401: Invalid token",
			);
		});

		test("falls back to (empty body) when error response has no message", async () => {
			fetchMock.mock.mockImplementation(async () => makeResponse(false, 500, {}));
			await run();
			assert.equal(
				setFailedMock.mock.calls[0]?.arguments[0],
				"Can not start deployment. Hub returned HTTP 500: (empty body)",
			);
		});

		test("falls back to (empty body) when error response body is not JSON", async () => {
			fetchMock.mock.mockImplementation(async () => makeResponse(false, 503, null, true));
			await run();
			assert.equal(
				setFailedMock.mock.calls[0]?.arguments[0],
				"Can not start deployment. Hub returned HTTP 503: (empty body)",
			);
		});

		test("still calls endGroup even on error response", async () => {
			fetchMock.mock.mockImplementation(async () => makeResponse(false, 500, {}));
			await run();
			assert.equal(endGroupMock.mock.callCount(), 1);
		});
	});

	describe("30-second abort timeout", () => {
		test("passes an AbortSignal to fetch", async () => {
			await run();
			const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit;
			assert(init.signal instanceof AbortSignal);
		});

		test("calls setFailed when fetch is aborted", async () => {
			fetchMock.mock.mockImplementation(() =>
				Promise.reject(new DOMException("This operation was aborted", "AbortError")),
			);
			await run();
			assert.equal(setFailedMock.mock.callCount(), 1);
			assert.match(String(setFailedMock.mock.calls[0]?.arguments[0]), /aborted|abort/i);
		});
	});

	describe("error propagation", () => {
		test("calls setFailed when getConfig throws", async () => {
			getConfigMock.mock.mockImplementationOnce(() => {
				throw new Error("Invalid hub URL");
			});
			await run();
			assert.equal(setFailedMock.mock.calls[0]?.arguments[0], "Invalid hub URL");
		});

		test("calls setFailed when getIDToken throws", async () => {
			getIDTokenMock.mock.mockImplementationOnce(async () => {
				throw new Error("OIDC failed");
			});
			await run();
			assert.equal(setFailedMock.mock.calls[0]?.arguments[0], "OIDC failed");
		});

		test("handles non-Error thrown values", async () => {
			getConfigMock.mock.mockImplementationOnce(() => {
				// oxlint-disable-next-line no-throw-literal
				throw "a raw string error";
			});
			await run();
			assert.equal(setFailedMock.mock.calls[0]?.arguments[0], "a raw string error");
		});
	});
});
