import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoDir = path.resolve(import.meta.dirname, "..");
const model = process.env.PI_SUBAGENT_REAL_MODEL || "openai-codex/gpt-5.6-luna";
const secondaryModel = process.env.PI_SUBAGENT_REAL_SECONDARY_MODEL || "openai-codex/gpt-5.6-sol";
const thinking = process.env.PI_SUBAGENT_REAL_THINKING || "minimal";
const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piIndexUrl = pathToFileURL(path.join(npmRoot, "@earendil-works/pi-coding-agent/dist/index.js")).href;

function messageText(message) {
	return Array.isArray(message?.content)
		? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
		: "";
}

test("openai-codex models execute foreground and detached subagents with explicit model and thinking", { timeout: 240_000 }, () => {
	const harness = `
import fs from 'node:fs';
import path from 'node:path';
import { DefaultResourceLoader, getAgentDir, SessionManager } from ${JSON.stringify(piIndexUrl)};
const repoDir=${JSON.stringify(repoDir)};
const model=${JSON.stringify(model)};
const secondaryModel=${JSON.stringify(secondaryModel)};
const thinking=${JSON.stringify(thinking)};
const loader=new DefaultResourceLoader({cwd:repoDir,agentDir:getAgentDir(),additionalExtensionPaths:[path.join(repoDir,'index.ts')]});
await loader.reload();
const extension=loader.getExtensions().extensions.find((item)=>item.path.includes(repoDir));
const tool=extension?.tools.get('subagent')?.definition;
if(!tool) throw new Error('subagent tool not loaded');
const ctx={cwd:repoDir,hasUI:false,sessionManager:{getSessionFile:()=>'/tmp/pi-subagent-real-parent.jsonl'}};
const signal=new AbortController().signal;
const foreground=await tool.execute('real-foreground',{agent:'scout',task:'Do not use tools. Include the exact token REAL_FOREGROUND_OK in your brief final answer.',model,thinking},signal,undefined,ctx);
if(foreground.isError||!foreground.content[0].text.includes('REAL_FOREGROUND_OK')) throw new Error('foreground: '+foreground.content[0].text);
if(foreground.details.results[0].model!==model) throw new Error('foreground model override was not preserved');
if(!foreground.details.results[0].sessionId) throw new Error('foreground child session was not persisted');
const secondary=await tool.execute('real-secondary',{agent:'scout',task:'Do not use tools. Include the exact token REAL_SECONDARY_MODEL_OK in your brief final answer.',model:secondaryModel,thinking},signal,undefined,ctx);
if(secondary.isError||!secondary.content[0].text.includes('REAL_SECONDARY_MODEL_OK')) throw new Error('secondary foreground: '+secondary.content[0].text);
if(secondary.details.results[0].model!==secondaryModel) throw new Error('secondary model override was not preserved');
if(!secondary.details.results[0].sessionId) throw new Error('secondary child session was not persisted');
const started=await tool.execute('real-async',{agent:'scout',task:'Do not use tools. Include the exact token REAL_ASYNC_OK in your brief final answer.',model,thinking,async:true,ping:false},signal,undefined,ctx);
const id=started.content[0].text.match(/job \x60([^\x60]+)\x60/)?.[1];
if(!id) throw new Error(started.content[0].text);
let result;
for(let i=0;i<240;i++) {
  result=await tool.execute('real-result',{action:'result',id},signal,undefined,ctx);
  if(result.content[0].text.includes('REAL_ASYNC_OK')) break;
  await new Promise((resolve)=>setTimeout(resolve,500));
}
if(!result?.content[0].text.includes('REAL_ASYNC_OK')) throw new Error('async: '+(result?.content?.[0]?.text||'timeout'));
const jobDir=path.join(getAgentDir(),'subagent-jobs',id);
const status=JSON.parse(fs.readFileSync(path.join(jobDir,'status.json'),'utf8'));
const persistedResult=JSON.parse(fs.readFileSync(path.join(jobDir,'result.json'),'utf8'));
if(status.status!=='completed'||!status.resultPath) throw new Error('invalid persisted status: '+JSON.stringify(status));
if(!status.childSessions?.[0]?.sessionId||!persistedResult.results?.[0]?.sessionId) throw new Error('async child session was not persisted');
const childSessionIds=new Set([
  foreground.details.results[0].sessionId,
  secondary.details.results[0].sessionId,
  persistedResult.results[0].sessionId,
]);
const sessions=await SessionManager.list(repoDir);
for(const session of sessions) if(childSessionIds.has(session.id)) fs.rmSync(session.path,{force:true});
fs.rmSync(jobDir,{recursive:true,force:true});
console.log(JSON.stringify({foreground:true,secondary:true,async:true,persisted:true,model,secondaryModel,thinking}));
`;

	const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", harness], {
		cwd: repoDir,
		encoding: "utf8",
		timeout: 230_000,
	});
	const result = JSON.parse(stdout.trim());
	assert.deepEqual(result, {
		foreground: true,
		secondary: true,
		async: true,
		persisted: true,
		model,
		secondaryModel,
		thinking,
	});
});

test("an openai-codex parent receives the async completion ping and starts a follow-up turn", { timeout: 300_000 }, async (t) => {
	const proc = spawn(
		"pi",
		["--mode", "rpc", "--no-session", "--model", model, "--thinking", thinking],
		{ cwd: repoDir, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	let jobId;
	let sawLaunch = false;
	let sawCustomPing = false;
	let settledCount = 0;
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const lines = readline.createInterface({ input: proc.stdout });
	const completion = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`RPC ping test timed out. stderr: ${stderr}`)), 285_000);
		lines.on("line", (line) => {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "agent_settled") settledCount++;
			if (event.type === "tool_execution_end" && event.toolName === "subagent") {
				const text = event.result?.content?.[0]?.text || "";
				jobId = text.match(/job `([^`]+)`/)?.[1];
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = messageText(event.message);
				if (text.includes("PARENT_LAUNCHED")) sawLaunch = true;
				if (text.includes("PING_RECEIVED REAL_PING_CHILD_OK")) {
					clearTimeout(timer);
					resolve();
				}
			}
			if (
				event.type === "message_end" &&
				event.message?.role === "custom" &&
				event.message?.customType === "subagent-result" &&
				String(event.message.content).includes("REAL_PING_CHILD_OK")
			) {
				sawCustomPing = true;
			}
		});
		proc.once("error", reject);
		proc.once("exit", (code) => {
			if (code !== null && code !== 0) reject(new Error(`RPC parent exited ${code}. stderr: ${stderr}`));
		});
	});

	t.after(() => {
		lines.close();
		if (!proc.killed) proc.kill("SIGTERM");
		if (jobId) fs.rmSync(path.join(process.env.HOME, ".pi/agent/subagent-jobs", jobId), { recursive: true, force: true });
	});

	const prompt = `Call the subagent tool exactly once with this execution: agent="scout", task="Do not use tools. Include the exact token REAL_PING_CHILD_OK in your brief final answer.", model="${model}", thinking="${thinking}", async=true, ping=true. Do not call status or result and do not wait. After the tool returns, reply with exactly PARENT_LAUNCHED. When the completion custom message arrives later, reply with PING_RECEIVED REAL_PING_CHILD_OK.`;
	proc.stdin.write(`${JSON.stringify({ id: "real-ping", type: "prompt", message: prompt })}\n`);
	await completion;

	assert.ok(jobId, "parent tool call should return a job ID");
	assert.equal(sawLaunch, true, "parent should settle after launching the detached job");
	assert.equal(sawCustomPing, true, "parent should receive a subagent-result custom message");
	assert.ok(settledCount >= 1, "RPC parent should settle before or after the completion turn");
});
