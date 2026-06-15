import * as core from "@actions/core";

export async function run(): Promise<void> {
	try {
		// Todo
		await new Promise((resolve) => setTimeout(resolve, 1000));
	} catch (error) {
		core.setFailed(error instanceof Error ? error : String(error));
	}
}
