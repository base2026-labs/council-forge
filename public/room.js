'use strict';
const roomElement = (id) => document.getElementById(id);
let roomConfig,
  roomAgents = [],
  activeRun,
  nextRpcId = 1,
  runBusy = false,
  uncertainRun = false;
const pendingRpc = new Map();
const previewPresets = [
  { name: 'research', roles: ['researcher', 'evidence_hunter', 'skeptic', 'verifier', 'chair'] },
  {
    name: 'seo_geo_aeo',
    roles: [
      'technical_seo',
      'indexation',
      'serp',
      'geo_aeo',
      'schema',
      'content',
      'evidence_hunter',
      'implementation',
      'skeptic',
      'verifier',
      'chair',
    ],
  },
  { name: 'code_review', roles: ['architect', 'implementation', 'skeptic', 'verifier', 'chair'] },
];
function roomRequest(method, params, timeoutMs = 30000) {
  if (window.parent === window) return Promise.reject(new Error('Native MCP host required.'));
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      reject(new Error('Host result unknown. Do not repeat this run.'));
    }, timeoutMs);
    pendingRpc.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}
function unpack(result) {
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'Host rejected the request.');
  return result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text ?? '{}');
}
async function roomCall(name, args, timeoutMs) {
  return unpack(await roomRequest('tools/call', { name, arguments: args }, timeoutMs));
}
function roomShow(value) {
  roomElement('receipt').textContent = JSON.stringify(value, null, 2);
  roomElement('state').textContent =
    value.decision ?? value.status ?? value.state ?? 'Plan received';
  roomElement('recommendation').textContent = value.synthesis?.recommendation ?? '';
  if (value.outputLanguage) roomElement('recommendation').lang = value.outputLanguage;
}
function roomOptions(select, values, chosen) {
  select.replaceChildren();
  for (const [value, label] of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === chosen;
    select.append(option);
  }
}
function roomRenderAgents(reset = false) {
  if (reset) {
    const preset = (roomConfig?.presets ?? previewPresets).find(
      (p) => p.name === roomElement('preset').value,
    );
    const prior = roomAgents;
    roomAgents = preset.roles.map(
      (role) => prior.find((a) => a.role === role) ?? { id: role, role, instances: 1 },
    );
  }
  roomElement('agents').replaceChildren();
  const choices = [
    ['', 'Choose a model…'],
    ...(roomConfig?.catalogue ?? []).flatMap((p) =>
      p.models.map((m) => [JSON.stringify([p.id, m.id]), `${p.kind} · ${m.label}`]),
    ),
  ];
  for (const agent of roomAgents) {
    const row = document.createElement('div');
    row.className = 'agent';
    const title = document.createElement('strong');
    title.textContent = agent.role.replaceAll('_', ' ');
    row.append(title);
    const add = (title, control) => {
      const label = document.createElement('label');
      label.textContent = title;
      label.append(control);
      row.append(label);
    };
    const model = document.createElement('select');
    roomOptions(model, choices, agent.model ? JSON.stringify([agent.providerId, agent.model]) : '');
    model.onchange = () => {
      if (!model.value) {
        delete agent.providerId;
        delete agent.model;
      } else [agent.providerId, agent.model] = JSON.parse(model.value);
      // Keep the effort pin visible even when a new model does not support it.
      // Validation rejects the mismatch; changing models does not downgrade effort.
      roomRenderAgents();
    };
    add(`${agent.role} model`, model);
    const effort = document.createElement('select');
    const supported =
      roomConfig?.catalogue
        .find((p) => p.id === agent.providerId)
        ?.models.find((m) => m.id === agent.model)?.efforts ?? [];
    const efforts = [...new Set([...supported, ...(agent.effort ? [agent.effort] : [])])];
    roomOptions(
      effort,
      [
        ['', 'Choose effort…'],
        ...efforts.map((e) => [e, supported.includes(e) ? e : `${e} (unsupported pin)`]),
      ],
      agent.effort ?? '',
    );
    effort.onchange = () => {
      if (effort.value) agent.effort = effort.value;
      else delete agent.effort;
    };
    add(`${agent.role} effort`, effort);
    const count = document.createElement('input');
    count.type = 'number';
    count.min = '1';
    count.max = ['skeptic', 'verifier', 'chair'].includes(agent.role) ? '1' : '10';
    count.value = String(agent.instances);
    count.onchange = () => {
      agent.instances = Number(count.value);
    };
    add(`${agent.role} count`, count);
    roomElement('agents').append(row);
  }
}
function roomConfigure(config) {
  const initial = !roomConfig;
  roomConfig = config;
  roomElement('connection').textContent = config.liveEnabled
    ? 'Native host connected. Operator live gate enabled.'
    : 'Native host connected. Live execution is disabled by the operator.';
  if (initial) roomElement('language').value = config.outputLanguage ?? 'en';
  roomOptions(
    roomElement('mode'),
    config.allowedModes.map((m) => [m, m.replaceAll('_', ' ')]),
    initial ? 'subscription_only' : roomElement('mode').value,
  );
  roomElement('budget').max = String(config.maxApiBudgetUsd);
  roomRenderAgents(true);
  roomElement('plan').disabled = false;
  roomElement('run').disabled = !config.liveEnabled || runBusy || uncertainRun;
}
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !event.data || event.data.jsonrpc !== '2.0') return;
  const message = event.data;
  if (message.id !== undefined && pendingRpc.has(message.id)) {
    const request = pendingRpc.get(message.id);
    clearTimeout(request.timer);
    pendingRpc.delete(message.id);
    if (message.error) request.reject(new Error('Native host rejected the operation.'));
    else request.resolve(message.result);
    return;
  }
  if (
    message.method === 'ui/notifications/tool-result' &&
    message.params?.structuredContent?.catalogue
  )
    roomConfigure(message.params.structuredContent);
});
roomElement('preset').onchange = () => roomRenderAgents(true);
roomElement('mode').onchange = () => {
  roomElement('budget').disabled = roomElement('mode').value === 'subscription_only';
};
function roomReadRequest() {
  if (roomAgents.some((a) => !a.model || !a.effort))
    throw new Error('Choose an explicit model and reasoning effort for every role.');
  return {
    runId: 'room-' + crypto.randomUUID(),
    task: roomElement('task').value,
    kind:
      roomElement('preset').value === 'seo_geo_aeo'
        ? 'seo_audit'
        : roomElement('preset').value === 'code_review'
          ? 'code_review'
          : 'research',
    mode: roomElement('mode').value,
    apiBudgetUsd: Number(roomElement('budget').value),
    agents: roomAgents,
    evidence: JSON.parse(roomElement('evidence').value),
    outputLanguage: roomElement('language').value,
    permissionScope: 'read_only',
    useJev: false,
    timeoutMs: 120000,
  };
}
roomElement('plan').onclick = async () => {
  try {
    roomShow(await roomCall('council_plan', { request: roomReadRequest() }));
  } catch (error) {
    roomElement('state').textContent = error.message;
  }
};
async function roomPoll() {
  if (!runBusy || !activeRun) return;
  try {
    const status = await roomCall('council_status', { runId: activeRun });
    roomElement('progress').textContent = (status.events ?? [])
      .map((e) => {
        const data = JSON.parse(e.data);
        return `${e.at} · ${e.type} · ${data.agent ?? data.code ?? ''}`;
      })
      .join('\n');
    if (status.run?.result) {
      roomShow(status.run.result);
      return;
    }
  } catch {
    roomElement('progress').textContent =
      'Progress unavailable. Run outcome remains unknown until a receipt is read.';
  }
  if (runBusy) setTimeout(roomPoll, 1500);
}
roomElement('run').onclick = async () => {
  if (runBusy || uncertainRun) return;
  try {
    const request = roomReadRequest();
    activeRun = request.runId;
    runBusy = true;
    roomElement('run').disabled = true;
    roomElement('plan').disabled = true;
    roomElement('cancel').disabled = false;
    roomElement('state').textContent = `Running ${activeRun}`;
    setTimeout(roomPoll, 1000);
    const result = await roomCall('council_run', { request }, request.timeoutMs + 30000);
    roomShow(result);
    uncertainRun = !['completed', 'needs_input'].includes(result.state);
    if (uncertainRun)
      roomElement('state').textContent =
        'HOLD. Inspect this receipt with the operator before another run.';
    // New run is enabled only after a definite returned result. UNKNOWN stays locked.
    roomElement('run').disabled = !roomConfig.liveEnabled || uncertainRun;
  } catch (error) {
    if (activeRun) uncertainRun = true;
    roomElement('state').textContent = error.message;
  } finally {
    runBusy = false;
    roomElement('plan').disabled = false;
    roomElement('cancel').disabled = true;
  }
};
roomElement('cancel').onclick = async () => {
  try {
    roomShow(await roomCall('council_cancel', { runId: activeRun }));
  } catch (error) {
    roomElement('state').textContent = error.message;
  }
};
roomRenderAgents(true);
if (window.parent === window) {
  roomElement('connection').textContent =
    'Component preview only. Open council_room in an MCP Apps host to connect. No live or fixture run is performed here.';
} else {
  roomRequest('ui/initialize', {
    appInfo: { name: 'Council Forge', version: '0.1.0-alpha.2' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  })
    .then(() => {
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
      return roomCall('council_configuration', {});
    })
    .then(roomConfigure)
    .catch(() => {
      roomElement('connection').textContent =
        'Native MCP bridge unavailable. No run was dispatched.';
    });
}
