import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexLocalProvider } from '../dist/adapters/codex-local.js';

// Executable protocol fixture, not Codex and not a real subscription/model call.
const fixture = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode=readFileSync(join(process.env.CODEX_HOME,'fixture-mode'),'utf8');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if(q.id===undefined)return;
 const ok=result=>send({id:q.id,result});
 if(process.env.COUNCIL_TEST_SENTINEL){send({id:q.id,error:{code:-32000}});return;}
 switch(q.method){
 case 'initialize':ok({});break;
 case 'account/read':ok({account:{type:mode==='api-auth'?'apiKey':'chatgpt'},requiresOpenaiAuth:true});break;
 case 'config/read':ok({config:{}});break;
 case 'model/list':ok({data:[{model:'fixture-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});break;
 case 'thread/start':ok({thread:{id:'fixture-thread',modelProvider:'openai'},model:mode==='wrong-model'?'other-model':'fixture-sol',modelProvider:'openai'});break;
 case 'app/installed':ok({apps:mode==='tools-enabled'?[{callable:true}]:[]});break;
 case 'mcpServerStatus/list':ok({data:[],nextCursor:null});break;
 case 'turn/start':
  if(q.params.model!=='fixture-sol'||q.params.effort!=='high'||q.params.sandboxPolicy.type!=='readOnly'||q.params.approvalPolicy!=='never'||!q.params.outputSchema){send({id:q.id,error:{code:-32001}});break;}
  ok({turn:{id:'fixture-turn'}});
  if(mode==='reroute'){send({method:'model/rerouted',params:{}});break;}
  if(mode==='incomplete'){send({method:'turn/completed',params:{turn:{status:'interrupted'}}});break;}
  send({method:'item/completed',params:{item:{type:'agentMessage',text:JSON.stringify({summary:'fixture',claims:[],objections:[]}),phase:'final_answer'}}});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});break;
 default:send({id:q.id,error:{code:-32601}});
 }
});
`;
async function invoke(mode) {
  const root = await mkdtemp(join(tmpdir(), 'council-codex-contract-'));
  try {
    const executable = join(root, 'fixture.mjs');
    await writeFile(executable, fixture, { mode: 0o700 });
    await writeFile(join(root, 'fixture-mode'), mode);
    const p = new CodexLocalProvider({
      id: 'fixture-local',
      kind: 'codex-local',
      codexHome: root,
      codexExecutable: executable,
      models: [],
    });
    return await p.complete({
      agent: {
        id: 'seo',
        role: 'technical_seo',
        providerId: 'fixture-local',
        model: 'fixture-sol',
        effort: 'high',
        instances: 1,
      },
      phase: 'propose',
      prompt: 'Fixture only',
      maxOutputTokens: 256,
      evidence: [],
      claims: [],
      signal: AbortSignal.timeout(5000),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const unix = { skip: process.platform === 'win32' };
test('Codex stdio fixture completes with pinned model and effort', unix, async () => {
  process.env.COUNCIL_TEST_SENTINEL = 'fixture-not-a-secret';
  try {
    const result = await invoke('success');
    assert.equal(result.actualModel, 'fixture-sol');
    assert.equal(result.usage.costUsd, null);
    assert.equal(result.requestId, 'fixture-thread');
  } finally {
    delete process.env.COUNCIL_TEST_SENTINEL;
  }
});
for (const [mode, code] of [
  ['api-auth', 'SUBSCRIPTION_AUTH_REQUIRED'],
  ['wrong-model', 'MODEL_NOT_ATTESTED'],
  ['tools-enabled', 'HOST_TOOLS_ENABLED'],
  ['reroute', 'MODEL_REROUTED'],
  ['incomplete', 'CODEX_INCOMPLETE'],
]) {
  test('Codex stdio fixture rejects ' + mode, unix, async () => {
    await assert.rejects(
      () => invoke(mode),
      (e) => e.code === code,
    );
  });
}
