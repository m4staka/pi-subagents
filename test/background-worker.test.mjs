import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repoDir, "background-worker.mjs");

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function createJob(overrides = {}) {
	const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-worker-test-"));
	const fakePi = path.join(jobDir, "fake-pi.mjs");
	const agentCwd = path.join(jobDir, "agent-cwd");
	fs.mkdirSync(agentCwd);
	fs.writeFileSync(
		fakePi,
		`const args = process.argv.slice(2);\nconst task = args.find((arg) => arg.startsWith("Task: ")) || "";\nif (task.includes("FAIL")) { console.error("intentional failure"); process.exit(7); }\nconst sessionId = "fake-" + task.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();\nconsole.log(JSON.stringify({type:"session",version:3,id:sessionId,timestamp:new Date().toISOString(),cwd:process.cwd()}));\nconst text = task.includes("FIRST") ? "HANDOFF_TOKEN" : task.includes("SLEEP") ? "late" : JSON.stringify(args);\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}],model:"fake-model",stopReason:"end",usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{total:0}}}}));\n`,
		{ mode: 0o700 },
	);
	const request = {
		jobId: "test-job",
		mode: "single",
		defaultCwd: jobDir,
		model: "test-provider/test-model",
		noExtensions: true,
		agents: [
			{
				name: "scout",
				description: "test agent",
				source: "user",
				systemPrompt: "Be concise.",
				tools: ["read", "grep"],
				thinking: "high",
				cwd: agentCwd,
			},
		],
		single: { agent: "scout", task: "SINGLE" },
		piCommand: process.execPath,
		piArgs: [fakePi],
		...overrides,
	};
	writeJson(path.join(jobDir, "request.json"), request);
	writeJson(path.join(jobDir, "status.json"), {
		jobId: request.jobId,
		status: "starting",
		mode: request.mode,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		ping: false,
	});
	return jobDir;
}

function runJob(jobDir) {
	execFileSync(process.execPath, [workerPath, jobDir], { encoding: "utf8", timeout: 10_000 });
	return {
		status: JSON.parse(fs.readFileSync(path.join(jobDir, "status.json"), "utf8")),
		result: JSON.parse(fs.readFileSync(path.join(jobDir, "result.json"), "utf8")),
	};
}

test("single jobs propagate model, thinking, tools, prompt, and task", (t) => {
	const jobDir = createJob();
	t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
	const { status, result } = runJob(jobDir);

	assert.equal(status.status, "completed");
	assert.equal(result.status, "completed");
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].sessionId, "fake-task-single");
	assert.equal(result.results[0].sessionCwd, path.join(jobDir, "agent-cwd"));
	assert.deepEqual(status.childSessions, [
		{ agent: "scout", sessionId: "fake-task-single", cwd: path.join(jobDir, "agent-cwd") },
	]);
	const args = JSON.parse(result.output);
	assert.deepEqual(args.slice(0, 3), ["--mode", "json", "-p"]);
	assert.equal(args.includes("--no-session"), false);
	assert.equal(args[args.indexOf("--name") + 1], "subagent: scout — SINGLE");
	assert.ok(args.includes("--model"));
	assert.ok(args.includes("test-provider/test-model"));
	assert.ok(args.includes("--thinking"));
	assert.ok(args.includes("high"));
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--tools"));
	assert.ok(args.includes("read,grep"));
	assert.ok(args.includes("--append-system-prompt"));
	assert.ok(args.includes("Task: SINGLE"));
});

test("chain jobs substitute the previous result and persist each step", (t) => {
	const jobDir = createJob({
		mode: "chain",
		single: undefined,
		chain: [
			{ agent: "scout", task: "FIRST" },
			{ agent: "scout", task: "SECOND receives {previous}" },
		],
	});
	t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
	const { status, result } = runJob(jobDir);

	assert.equal(status.status, "completed");
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].messages[0].content[0].text, "HANDOFF_TOKEN");
	assert.match(result.results[1].task, /SECOND receives HANDOFF_TOKEN/);
	assert.match(result.output, /Task: SECOND receives HANDOFF_TOKEN/);
});

test("parallel jobs persist all child results", (t) => {
	const jobDir = createJob({
		mode: "parallel",
		single: undefined,
		concurrency: 2,
		tasks: [
			{ agent: "scout", task: "PARALLEL_A" },
			{ agent: "scout", task: "PARALLEL_B" },
		],
	});
	t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
	const { status, result } = runJob(jobDir);

	assert.equal(status.status, "completed");
	assert.deepEqual(status.progress, { completed: 2, total: 2 });
	assert.equal(result.results.length, 2);
	assert.match(result.output, /PARALLEL_A/);
	assert.match(result.output, /PARALLEL_B/);
});

test("child failures produce a failed persistent job", (t) => {
	const jobDir = createJob({ single: { agent: "scout", task: "FAIL" } });
	t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
	const { status, result } = runJob(jobDir);

	assert.equal(status.status, "failed");
	assert.equal(result.status, "failed");
	assert.equal(result.results[0].exitCode, 7);
	assert.match(result.output, /intentional failure/);
});
