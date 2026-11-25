import { after, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

// ── @actions/core mock ──────────────────────────────────────────────────────
const startGroupMock = mock.fn<(name: string) => void>();
const endGroupMock = mock.fn<() => void>();
const infoMock = mock.fn<(msg: string) => void>();
const warningMock = mock.fn<(msg: string) => void>();
const setFailedMock = mock.fn<(msg: string | Error) => void>();
const setSecretMock = mock.fn<(secret: string) => void>();
const getIDTokenMock = mock.fn<(aud?: string) => Promise<string>>(async () => "mock-oidc-token");
const setOutputMock = mock.fn<(name: string, value: string) => void>();
type SummaryTable = Parameters<typeof import("@actions/core").summary.addTable>[0];
const addTableMock = mock.fn<(table: SummaryTable) => void>();
const writeSummaryMock = mock.fn<() => Promise<void>>(() => Promise.resolve());
const summary = {
	addHeading() {
		return this;
	},
	addRaw() {
		return this;
	},
	addTable(table: SummaryTable) {
		addTableMock(table);
		return this;
	},
	write: writeSummaryMock,
};

mock.module("@actions/core", {
	exports: {
		startGroup: startGroupMock,
		endGroup: endGroupMock,
		info: infoMock,
		warning: warningMock,
		setFailed: setFailedMock,
		setSecret: setSecretMock,
		getIDToken: getIDTokenMock,
		setOutput: setOutputMock,
		summary,
	},
});

// ── config.ts mock ──────────────────────────────────────────────────────────
const defaultConfig = {
	hubUrl: "https://orca.example.com",
	endpoint: "https://orca.example.com/api/v1/github-actions",
	syncRepo: true,
	pullImages: false,
	wait: true,
	timeoutMs: 600_000,
};

const getConfigMock = mock.fn(() => ({ ...defaultConfig }));

mock.module("./config.ts", {
	exports: { getConfig: getConfigMock },
});

const sleepMock = mock.fn<(delay: number) => Promise<void>>(() => Promise.resolve());
mock.module("node:timers/promises", { exports: { setTimeout: sleepMock } });

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
	warningMock.mock.resetCalls();
	setFailedMock.mock.resetCalls();
	setSecretMock.mock.resetCalls();
	getIDTokenMock.mock.resetCalls();
	getConfigMock.mock.resetCalls();
	fetchMock.mock.resetCalls();
	setOutputMock.mock.resetCalls();
	addTableMock.mock.resetCalls();
	writeSummaryMock.mock.resetCalls();
	sleepMock.mock.resetCalls();
}

beforeEach(() => {
	resetAllMocks();
	getIDTokenMock.mock.mockImplementation(async () => "mock-oidc-token");
	getConfigMock.mock.mockImplementation(() => ({ ...defaultConfig }));
	fetchMock.mock.mockImplementation(async () =>
		makeResponse(true, 200, { message: "Deployment triggered." }),
	);
});

const triggerResponse = {
	triggerId: "trigger-123",
	message: "Deployment triggered.",
	applications: [{ id: "app-1", name: "web" }],
};

function acceptTrigger() {
	fetchMock.mock.mockImplementationOnce(async () => makeResponse(true, 202, triggerResponse));
}

function outputs() {
	return Object.fromEntries(setOutputMock.mock.calls.map((call) => call.arguments));
}

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
			assert.equal(
				init.body,
				JSON.stringify({ syncRepo: true, pullImages: false, waitForResult: true }),
			);
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

		test("uses error field from response body when message is absent", async () => {
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(false, 403, {
					error: 'no repository with GitHub Actions OIDC enabled matches "owner/repo"',
				}),
			);
			await run();
			assert.equal(
				setFailedMock.mock.calls[0]?.arguments[0],
				'Can not start deployment. Hub returned HTTP 403: no repository with GitHub Actions OIDC enabled matches "owner/repo"',
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

	describe("deployment status", () => {
		test("keeps fire-and-forget behavior for older Hubs", async () => {
			await run();
			assert.equal(fetchMock.mock.callCount(), 1);
			assert.deepEqual(outputs(), { status: "triggered" });
			assert.equal(writeSummaryMock.mock.callCount(), 0);
		});

		test("skips polling when wait is false and still outputs the trigger ID", async () => {
			getConfigMock.mock.mockImplementationOnce(() => ({ ...defaultConfig, wait: false }));
			acceptTrigger();
			await run();
			assert.equal(fetchMock.mock.callCount(), 1);
			assert.equal(
				fetchMock.mock.calls[0]?.arguments[1]?.body,
				JSON.stringify({ syncRepo: true, pullImages: false }),
			);
			assert.deepEqual(outputs(), { triggerId: "trigger-123", status: "triggered" });
			assert.equal(writeSummaryMock.mock.callCount(), 0);
			assert.equal(setFailedMock.mock.callCount(), 0);
		});

		test("waits for every application and uses a fresh OIDC token for each poll", async () => {
			let tokenCount = 0;
			getIDTokenMock.mock.mockImplementation(async () => `oidc-token-${++tokenCount}`);
			acceptTrigger();
			const web = { id: "app-1", name: "web", status: "running", events: [] };
			const worker = {
				id: "app-2",
				name: "worker",
				status: "skipped",
				events: [{ type: "image_update", status: "skipped", error: "Auto-sync is paused" }],
			};
			fetchMock.mock.mockImplementationOnce(
				async () =>
					makeResponse(true, 200, {
						status: "running",
						applications: [web, worker],
					}),
				1,
			);
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(true, 200, {
					status: "succeeded",
					applications: [
						{
							...web,
							status: "succeeded",
							events: [{ type: "commit_sync", status: "no_change", commit: "abc123" }],
						},
						worker,
					],
				}),
			);
			await run();

			assert.equal(fetchMock.mock.callCount(), 3);
			assert.deepEqual(
				getIDTokenMock.mock.calls.map((call) => call.arguments),
				[[defaultConfig.hubUrl], [defaultConfig.hubUrl], [defaultConfig.hubUrl]],
			);
			for (const [index, call] of fetchMock.mock.calls.slice(1).entries()) {
				const [url, options] = call.arguments;
				assert.equal(url, `${defaultConfig.endpoint}/triggers/trigger-123`);
				assert.equal(options?.method, "GET");
				assert.equal(
					new Headers(options?.headers).get("Authorization"),
					`Bearer oidc-token-${index + 2}`,
				);
			}
			assert.deepEqual(
				sleepMock.mock.calls.map((call) => call.arguments[0]),
				[5_000],
			);
			assert.deepEqual(
				startGroupMock.mock.calls.map((call) => call.arguments[0]),
				[
					"Triggering Deployment",
					"Deployment: web (running)",
					"Deployment: worker (skipped)",
					"Deployment: web (succeeded)",
				],
			);
			assert.equal(endGroupMock.mock.callCount(), 4);
			assert.deepEqual(outputs(), { triggerId: "trigger-123", status: "succeeded" });
			assert.deepEqual(addTableMock.mock.calls[0]?.arguments[0].slice(1), [
				["web", "commit_sync", "abc123", "no_change", "—", "—"],
				["worker", "image_update", "—", "skipped", "Auto-sync is paused", "—"],
			]);
			assert.equal(writeSummaryMock.mock.callCount(), 1);
			assert.deepEqual(
				warningMock.mock.calls.map((call) => call.arguments[0]),
				["OrcaCD skipped deployment for worker."],
			);
			assert.equal(setFailedMock.mock.callCount(), 0);
		});

		test("warns and preserves a successful deployment when the job summary cannot be written", async () => {
			acceptTrigger();
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(true, 200, {
					status: "succeeded",
					applications: [{ id: "app-1", name: "web", status: "succeeded", events: [] }],
				}),
			);
			writeSummaryMock.mock.mockImplementationOnce(() =>
				Promise.reject(new Error("Summary unavailable")),
			);
			await run();

			assert.equal(outputs().status, "succeeded");
			assert.match(String(warningMock.mock.calls[0]?.arguments[0]), /Summary unavailable/);
			assert.equal(setFailedMock.mock.callCount(), 0);
		});

		test("fails if a deployment fails and includes its error in the summary", async () => {
			acceptTrigger();
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(true, 200, {
					status: "failed",
					applications: [
						{
							id: "app-1",
							name: "web",
							status: "failed",
							events: [
								{
									type: "image_update",
									status: "failed",
									error: "Health check <failed>\r\n\nAgent offline",
								},
							],
						},
					],
				}),
			);
			await run();

			assert.equal(outputs().status, "failed");
			assert.equal(setFailedMock.mock.calls[0]?.arguments[0], "OrcaCD deployment failed.");
			assert.deepEqual(addTableMock.mock.calls[0]?.arguments[0][1], [
				"web",
				"image_update",
				"—",
				"failed",
				"Health check &lt;failed&gt;<br><br>Agent offline",
				"—",
			]);
			assert.equal(writeSummaryMock.mock.callCount(), 1);
		});

		test("fails on a successful rollback and reports the restored commit even if the summary fails", async () => {
			acceptTrigger();
			writeSummaryMock.mock.mockImplementationOnce(() =>
				Promise.reject(new Error("Summary unavailable")),
			);
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(true, 200, {
					status: "succeeded",
					applications: [
						{
							id: "app-1",
							name: "web",
							status: "failed",
							events: [
								{ type: "commit_sync", status: "failed", commit: "abc123", error: "Unhealthy" },
								{
									type: "rollback",
									status: "succeeded",
									source: "deployment_failure",
									commit: "def456",
								},
							],
						},
					],
				}),
			);
			await run();

			assert.equal(outputs().status, "failed");
			assert.match(
				String(setFailedMock.mock.calls[0]?.arguments[0]),
				/web rolled back and is now running commit def456/,
			);
			assert.match(String(warningMock.mock.calls[0]?.arguments[0]), /Summary unavailable/);
			assert.deepEqual(addTableMock.mock.calls[0]?.arguments[0][2], [
				"web",
				"rollback",
				"def456",
				"succeeded",
				"—",
				"deployment_failure",
			]);
		});

		for (const { rollback, message, row } of [
			{
				rollback: { type: "rollback", status: "failed", commit: "def456", error: "Agent offline" },
				message: "OrcaCD deployment failed. web rollback to commit def456 (failed).",
				row: ["web", "rollback", "def456", "failed", "Agent offline", "Yes"],
			},
			{
				rollback: { type: "rollback", status: "failed", error: "No previous deployment" },
				message: "OrcaCD deployment failed. web rollback (failed).",
				row: ["web", "rollback", "—", "failed", "No previous deployment", "Yes"],
			},
			{
				rollback: { type: "rollback", status: "succeeded" },
				message: "OrcaCD deployment failed. web rolled back.",
				row: ["web", "rollback", "—", "succeeded", "—", "Yes"],
			},
		]) {
			const target = rollback.commit ? "with a target commit" : "without a target commit";
			test(`reports a ${rollback.status} rollback ${target}`, async () => {
				acceptTrigger();
				fetchMock.mock.mockImplementation(async () =>
					makeResponse(true, 200, {
						status: "failed",
						applications: [{ id: "app-1", name: "web", status: "failed", events: [rollback] }],
					}),
				);
				await run();

				assert.equal(outputs().status, "failed");
				assert.equal(setFailedMock.mock.calls[0]?.arguments[0], message);
				assert.deepEqual(addTableMock.mock.calls[0]?.arguments[0][1], row);
			});
		}

		for (const { invalid, applications } of [
			{ invalid: "application", applications: [null] },
			{
				invalid: "event",
				applications: [{ id: "app-1", name: "web", status: "succeeded", events: [null] }],
			},
		]) {
			test(`rejects a successful status response containing a null ${invalid}`, async () => {
				acceptTrigger();
				fetchMock.mock.mockImplementation(async () =>
					makeResponse(true, 200, { status: "succeeded", applications }),
				);
				await run();

				assert.equal(fetchMock.mock.callCount(), 2);
				assert.equal(
					setFailedMock.mock.calls[0]?.arguments[0],
					"Hub returned an invalid deployment status response.",
				);
				assert.deepEqual(outputs(), { triggerId: "trigger-123" });
				assert.equal(writeSummaryMock.mock.callCount(), 0);
			});
		}

		test("cancels the response body before retrying and resets backoff on recovery", async () => {
			acceptTrigger();
			const cancel = mock.fn();
			fetchMock.mock.mockImplementationOnce(
				async () => new Response(new ReadableStream({ cancel }), { status: 429 }),
				1,
			);
			fetchMock.mock.mockImplementationOnce(async () => {
				assert.equal(cancel.mock.callCount(), 1);
				return makeResponse(false, 502, {});
			}, 2);
			fetchMock.mock.mockImplementationOnce(
				async () =>
					makeResponse(true, 200, {
						status: "running",
						applications: [{ id: "app-1", name: "web", status: "running", events: [] }],
					}),
				3,
			);
			fetchMock.mock.mockImplementationOnce(async () => makeResponse(false, 503, {}), 4);
			fetchMock.mock.mockImplementation(async () =>
				makeResponse(true, 200, {
					status: "succeeded",
					applications: [{ id: "app-1", name: "web", status: "succeeded", events: [] }],
				}),
			);
			await run();

			assert.deepEqual(
				sleepMock.mock.calls.map((call) => call.arguments[0]),
				[5_000, 10_000, 5_000, 5_000],
			);
			assert.equal(getIDTokenMock.mock.callCount(), 6);
			assert.equal(outputs().status, "succeeded");
		});

		test("fails immediately when the trigger cannot be read by this run", async () => {
			acceptTrigger();
			fetchMock.mock.mockImplementation(async () => makeResponse(false, 404, {}));
			await run();
			assert.equal(fetchMock.mock.callCount(), 2);
			assert.match(String(setFailedMock.mock.calls[0]?.arguments[0]), /HTTP 404/);
		});

		test("fails on timeout, aborts an in-flight request and summarizes known applications", async (context) => {
			context.mock.timers.enable({ apis: ["setTimeout"] });
			acceptTrigger();
			const polling = Promise.withResolvers<AbortSignal>();
			fetchMock.mock.mockImplementation((_url, options) => {
				assert(options?.signal);
				const signal = options.signal;
				polling.resolve(signal);
				return new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			});
			const running = run();
			const signal = await polling.promise;
			context.mock.timers.tick(defaultConfig.timeoutMs);
			await running;

			assert.equal(signal.aborted, true);
			assert.equal(outputs().status, "timeout");
			assert.match(
				String(setFailedMock.mock.calls[0]?.arguments[0]),
				/600s.*deployment may still be running/,
			);
			assert.deepEqual(addTableMock.mock.calls[0]?.arguments[0][1], [
				"web",
				"—",
				"—",
				"running",
				"—",
				"—",
			]);
			assert.equal(writeSummaryMock.mock.callCount(), 1);
		});
	});
});
