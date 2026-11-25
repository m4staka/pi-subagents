#!/usr/bin/env node

/**
 * Detached runner for the official Pi subagent example.
 * It intentionally uses only Node built-ins so it can survive the parent Pi process.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const jobDir = path.resolve(process.argv[2] ?? "");
if (!jobDir || !fs.existsSync(jobDir)) process.exit(2);

const requestPath = path.join(jobDir, "request.json");
const statusPath = path.join(jobDir, "status.json");
const resultPath = path.join(jobDir, "result.json");
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
let activeChild = null;
let canceled = false;

function atomicWrite(filePath, value) {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, filePath);
}

function readStatus() {
	try {
		return JSON.parse(fs.readFileSync(statusPath, "utf8"));
	} catch {
		return {};
	}
}

function updateStatus(patch) {
	atomicWrite(statusPath, { ...readStatus(), ...patch, updatedAt: new Date().toISOString() });
}

function finalOutput(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) if (part?.type === "text") return part.text;
	}
	return "";
}

function failed(result) {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function resultOutput(result) {
	return result.errorMessage || result.stderr || finalOutput(result.messages) || "(no output)";
}

function makeSessionName(agentName, task) {
	const prefix = `subagent: ${agentName}`;
	const summary = task.replace(/\s+/g, " ").trim();
	if (!summary) return prefix;
	const maxLength = 120;
	const available = maxLength - prefix.length - 3;
	return `${prefix} — ${summary.length > available ? `${summary.slice(0, Math.max(1, available - 1))}…` : summary}`;
}

function recordChildSession(result, event) {
	result.sessionId = event.id;
	result.sessionCwd = event.cwd;
	const current = readStatus();
	const childSessions = Array.isArray(current.childSessions) ? current.childSessions : [];
	const session = { agent: result.agent, step: result.step, sessionId: event.id, cwd: event.cwd };
	updateStatus({
		childSessions: [...childSessions.filter((item) => item.sessionId !== event.id), session],
	});
}

async function runAgent(agentName, task, cwd, step) {
	const agent = request.agents.find((item) => item.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			step,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: ${agentName}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const model = request.model || agent.model;
	const thinking = request.thinking || agent.thinking;
	const args = [...request.piArgs, "--mode", "json", "-p", "--name", makeSessionName(agent.name, task)];
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (request.noExtensions) args.push("--no-extensions");
	if (Array.isArray(agent.tools) && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (agent.systemPrompt?.trim()) {
		const promptPath = path.join(jobDir, `system-${agentName.replace(/[^\w.-]+/g, "_")}-${step ?? "single"}.md`);
		fs.writeFileSync(promptPath, agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}
	args.push(`Task: ${task}`);

	const result = {
		agent: agentName,
		agentSource: agent.source,
		task,
		step,
		exitCode: 0,
		messages: [],
		stderr: "",
		model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};

	result.exitCode = await new Promise((resolve) => {
		const child = spawn(request.piCommand, args, {
			cwd: cwd || agent.cwd || request.defaultCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		activeChild = child;
		let buffer = "";

		const processLine = (line) => {
			if (!line.trim()) return;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "session" && typeof event.id === "string" && typeof event.cwd === "string") {
				recordChildSession(result, event);
			}
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				result.messages.push(event.message);
				if (event.type === "message_end" && event.message.role === "assistant") {
					result.usage.turns++;
					const usage = event.message.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && event.message.model) result.model = event.message.model;
					if (event.message.stopReason) result.stopReason = event.message.stopReason;
					if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
				}
			}
		};

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk) => {
			result.stderr += chunk.toString();
		});
		child.on("error", (error) => {
			result.errorMessage = error.message;
			resolve(1);
		});
		child.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			activeChild = null;
			resolve(code ?? 1);
		});
	});

	if (canceled) result.stopReason = "aborted";
	return result;
}

async function mapLimit(items, limit, fn) {
	const output = new Array(items.length);
	let next = 0;
	await Promise.all(
		new Array(Math.min(limit, items.length)).fill(null).map(async () => {
			while (!canceled) {
				const index = next++;
				if (index >= items.length) return;
				output[index] = await fn(items[index], index);
			}
		}),
	);
	return output.filter(Boolean);
}

function handleTermination() {
	canceled = true;
	if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
}
process.on("SIGTERM", handleTermination);
process.on("SIGINT", handleTermination);

async function main() {
	updateStatus({ status: "running", runnerPid: process.pid, startedAt: new Date().toISOString() });
	let results = [];
	let output = "";

	if (request.mode === "single") {
		results = [await runAgent(request.single.agent, request.single.task, request.single.cwd, undefined)];
		output = resultOutput(results[0]);
	} else if (request.mode === "parallel") {
		let completed = 0;
		results = await mapLimit(request.tasks, request.concurrency || 4, async (item, index) => {
			const result = await runAgent(item.agent, item.task, item.cwd, index + 1);
			completed++;
			updateStatus({ progress: { completed, total: request.tasks.length } });
			return result;
		});
		output = results.map((item) => `### [${item.agent}] ${failed(item) ? "failed" : "completed"}\n\n${resultOutput(item)}`).join("\n\n---\n\n");
	} else if (request.mode === "chain") {
		let previous = "";
		for (let i = 0; i < request.chain.length && !canceled; i++) {
			const item = request.chain[i];
			const result = await runAgent(item.agent, item.task.replace(/\{previous\}/g, previous), item.cwd, i + 1);
			results.push(result);
			updateStatus({ progress: { completed: i + 1, total: request.chain.length } });
			if (failed(result)) break;
			previous = finalOutput(result.messages);
		}
		output = results.length ? resultOutput(results[results.length - 1]) : "(no output)";
	}

	const status = canceled ? "canceled" : results.some(failed) ? "failed" : "completed";
	const finishedAt = new Date().toISOString();
	atomicWrite(resultPath, {
		jobId: request.jobId,
		status,
		mode: request.mode,
		startedAt: readStatus().startedAt,
		finishedAt,
		output,
		results,
	});
	updateStatus({ status, finishedAt, resultPath });
}

main().catch((error) => {
	const finishedAt = new Date().toISOString();
	atomicWrite(resultPath, {
		jobId: request.jobId,
		status: canceled ? "canceled" : "failed",
		mode: request.mode,
		finishedAt,
		output: error instanceof Error ? error.stack || error.message : String(error),
		results: [],
	});
	updateStatus({ status: canceled ? "canceled" : "failed", finishedAt, resultPath });
	process.exitCode = 1;
});
