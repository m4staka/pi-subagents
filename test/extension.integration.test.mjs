import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoDir = path.resolve(import.meta.dirname, "..");
const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piIndexUrl = pathToFileURL(path.join(npmRoot, "@earendil-works/pi-coding-agent/dist/index.js")).href;

function makeFakePi(binDir) {
	const fakePi = path.join(binDir, "pi");
	fs.writeFileSync(
		fakePi,
		`#!/usr/bin/env node\nconst args=process.argv.slice(2);\nconst task=args.find((arg)=>arg.startsWith("Task: "))||"";\nconst sessionId="fake-"+task.replace(/[^A-Za-z0-9]+/g,"-").toLowerCase();\nconsole.log(JSON.stringify({type:"session",version:3,id:sessionId,timestamp:new Date().toISOString(),cwd:process.cwd()}));\nconst emit=()=>console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(args)}],model:"fake",stopReason:"end",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}}}));\nif(task.includes("SLEEP")) setTimeout(emit,30000); else emit();\n`,
		{ mode: 0o700 },
	);
}

test("the loaded extension lists agents and manages foreground, async, status, result, and cancel flows", { timeout: 30_000 }, () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-extension-test-"));
	makeFakePi(tempDir);
	const projectAgentsDir = path.join(tempDir, ".pi", "agents");
	fs.mkdirSync(projectAgentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(projectAgentsDir, "project-test.md"),
		"---\nname: project-test\ndescription: project discovery test\nthinking: minimal\n---\n\nBe concise.\n",
	);

	const harness = `
import fs from 'node:fs';
import path from 'node:path';
import { DefaultResourceLoader, getAgentDir } from ${JSON.stringify(piIndexUrl)};
const repoDir=${JSON.stringify(repoDir)};
const loader=new DefaultResourceLoader({cwd:repoDir,agentDir:getAgentDir(),additionalExtensionPaths:[path.join(repoDir,'index.ts')]});
await loader.reload();
const extension=loader.getExtensions().extensions.find((item)=>item.path.includes(repoDir));
if(!extension) throw new Error('extension not loaded');
const tool=extension.tools.get('subagent')?.definition;
if(!tool) throw new Error('subagent tool not registered');
const ctx={cwd:${JSON.stringify(tempDir)},hasUI:false,sessionManager:{getSessionFile:()=>'/tmp/fake-parent-session.jsonl'}};
const signal=new AbortController().signal;
const list=await tool.execute('list',{action:'list'},signal,undefined,ctx);
if(!list.content[0].text.includes('scout')||!list.content[0].text.includes('history-search')||!list.content[0].text.includes('project-test (project)')) throw new Error(list.content[0].text);
const foreground=await tool.execute('foreground',{agent:'scout',task:'FOREGROUND',model:'fake-provider/fake-model',thinking:'high',noExtensions:true},signal,undefined,ctx);
if(!foreground.content[0].text.includes('fake-provider/fake-model')||!foreground.content[0].text.includes('--thinking')||!foreground.content[0].text.includes('--no-extensions')) throw new Error(foreground.content[0].text);
if(foreground.content[0].text.includes('--no-session')) throw new Error('foreground remained ephemeral');
if(foreground.details.results[0].sessionId!=='fake-task-foreground') throw new Error('missing foreground session');
const started=await tool.execute('async',{agent:'scout',task:'ASYNC',model:'fake-provider/fake-model',thinking:'low',noExtensions:true,async:true,ping:false},signal,undefined,ctx);
const id=started.content[0].text.match(/job \x60([^\x60]+)\x60/)?.[1];
if(!id) throw new Error(started.content[0].text);
const statusResult=await tool.execute('status',{action:'status',id},signal,undefined,ctx);
if(!statusResult.content[0].text.includes(id)) throw new Error(statusResult.content[0].text);
let asyncResult;
for(let i=0;i<100;i++) {
  asyncResult=await tool.execute('result',{action:'result',id},signal,undefined,ctx);
  if(asyncResult.content[0].text.includes('fake-provider/fake-model')) break;
  await new Promise((resolve)=>setTimeout(resolve,50));
}
if(!asyncResult?.content[0].text.includes('--thinking')||!asyncResult.content[0].text.includes('low')||!asyncResult.content[0].text.includes('--no-extensions')) throw new Error(asyncResult?.content?.[0]?.text||'missing async result');
const jobDir=path.join(getAgentDir(),'subagent-jobs',id);
const persistedStatus=JSON.parse(fs.readFileSync(path.join(jobDir,'status.json'),'utf8'));
const persistedResult=JSON.parse(fs.readFileSync(path.join(jobDir,'result.json'),'utf8'));
if(persistedStatus.childSessions?.[0]?.sessionId!=='fake-task-async') throw new Error('missing async status session');
if(persistedResult.results?.[0]?.sessionId!=='fake-task-async') throw new Error('missing async result session');
const sleeping=await tool.execute('sleep',{agent:'scout',task:'SLEEP',async:true,ping:false},signal,undefined,ctx);
const cancelId=sleeping.content[0].text.match(/job \x60([^\x60]+)\x60/)?.[1];
await new Promise((resolve)=>setTimeout(resolve,150));
const canceled=await tool.execute('cancel',{action:'cancel',id:cancelId},signal,undefined,ctx);
if(!canceled.content[0].text.includes('Canceled')) throw new Error(canceled.content[0].text);
const canceledResult=await tool.execute('canceled-result',{action:'result',id:cancelId},signal,undefined,ctx);
if(!canceledResult.content[0].text.includes('canceled')) throw new Error(canceledResult.content[0].text);
for(const jobId of [id,cancelId]) fs.rmSync(path.join(getAgentDir(),'subagent-jobs',jobId),{recursive:true,force:true});
console.log(JSON.stringify({list:true,foreground:true,async:true,status:true,result:true,cancel:true}));
`;

	try {
		const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", harness], {
			cwd: repoDir,
			encoding: "utf8",
			timeout: 25_000,
			env: { ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH}` },
		});
		assert.deepEqual(JSON.parse(stdout.trim()), {
			list: true,
			foreground: true,
			async: true,
			status: true,
			result: true,
			cancel: true,
		});
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
