'use strict';
let config, request;
const el = (id) => document.getElementById(id);
function render() {
  el('agents').replaceChildren();
  request.agents.forEach((agent, index) => {
    const row = document.createElement('div');
    row.className = 'agent';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = agent.role.replaceAll('_', ' ');
    row.append(name);
    const models = document.createElement('select');
    models.setAttribute('aria-label', `${agent.id} model`);
    config.catalogue.forEach((p) =>
      p.models.forEach((m) => {
        const option = document.createElement('option');
        option.value = JSON.stringify([p.id, m.id]);
        option.textContent = m.label;
        option.selected = p.id === agent.providerId && m.id === agent.model;
        models.append(option);
      }),
    );
    models.onchange = () => {
      [agent.providerId, agent.model] = JSON.parse(models.value);
      delete agent.effort;
      render();
    };
    row.append(models);
    const effort = document.createElement('select');
    effort.setAttribute('aria-label', `${agent.id} effort`);
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default';
    effort.append(defaultOption);
    const model = config.catalogue
      .find((p) => p.id === agent.providerId)
      ?.models.find((m) => m.id === agent.model);
    (model?.efforts ?? []).forEach((e) => {
      const option = document.createElement('option');
      option.value = e;
      option.textContent = e;
      option.selected = agent.effort === e;
      effort.append(option);
    });
    effort.onchange = () => {
      if (effort.value) agent.effort = effort.value;
      else delete agent.effort;
    };
    row.append(effort);
    const count = document.createElement('input');
    count.type = 'number';
    count.min = '1';
    count.max = ['chair', 'skeptic', 'verifier'].includes(agent.role) ? '1' : '10';
    count.value = String(agent.instances);
    count.setAttribute('aria-label', `${agent.id} instances`);
    count.onchange = () => {
      agent.instances = Number(count.value);
      updateCount();
    };
    row.append(count);
    el('agents').append(row);
  });
  updateCount();
}
function updateCount() {
  el('count').textContent = request.agents.reduce((n, a) => n + a.instances, 0) + ' agents';
}
async function submit(path) {
  request.task = el('task').value;
  request.mode = el('mode').value;
  request.apiBudgetUsd = Number(el('budget').value);
  request.runId = 'ui-' + crypto.randomUUID();
  el('status').textContent = 'Validating the bounded request…';
  el('state').textContent = 'RUNNING';
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Council-CSRF': config.csrf },
      body: JSON.stringify(request),
    });
    const data = await response.json();
    el('output').textContent = JSON.stringify(data, null, 2);
    el('state').textContent = String(
      data.decision ?? data.status ?? data.error ?? data.state ?? 'DONE',
    ).toUpperCase();
    el('status').textContent = data.simulation
      ? 'OFFLINE FIXTURE — no model calls and no API spend.'
      : response.ok
        ? 'Plan checked. This does not validate live model access.'
        : 'Request rejected; nothing was dispatched.';
    el('summary').replaceChildren();
    if (data.synthesis) {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.textContent = data.synthesis.recommendation;
      el('summary').append(card);
    }
  } catch {
    el('status').textContent = 'Local runtime unavailable. No fallback was attempted.';
    el('state').textContent = 'ERROR';
  }
}
async function init() {
  config = await (await fetch('/api/config')).json();
  request = config.request;
  el('task').value = request.task;
  render();
  el('plan').onclick = () => submit('/api/plan');
  el('demo').onclick = () => submit('/api/demo');
  el('add').onclick = () => {
    if (request.agents.length >= 16) return;
    const first = config.catalogue[0];
    request.agents.push({
      id: 'researcher-' + request.agents.length,
      role: 'researcher',
      providerId: first.id,
      model: first.models[0].id,
      instances: 1,
    });
    render();
  };
}
init().catch(() => {
  el('status').textContent = 'Could not load the local configuration.';
});
