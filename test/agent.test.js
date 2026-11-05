'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { agentIdFromUrl, replayPath } = require('../src/lib/agent_url');
const { parseListParams, buildAgentLookupBody, parseAgentLookup } = require('../src/lib/queries');

test('encontra o agente nas URLs usadas pelo Wazuh', () => {
  assert.equal(agentIdFromUrl('#/agents?tab=welcome&agent=003'), '003');
  assert.equal(agentIdFromUrl('#/overview/?tab=sca&agentId=012&x=1'), '012');
  assert.equal(agentIdFromUrl('?agent=001'), '001');
});

test('ignora agente ausente ou inválido', () => {
  assert.equal(agentIdFromUrl('#/agents?tab=welcome'), null);
  assert.equal(agentIdFromUrl('?agent=abc'), null);
  assert.equal(agentIdFromUrl('?agent=1x'), null);
  assert.equal(agentIdFromUrl('?agentes=1'), null);
  assert.equal(agentIdFromUrl(undefined), null);
});

test('monta o caminho do app para o agente', () => {
  assert.equal(replayPath('003'), '?agent=003');
});

test('só aceita id numérico de agente na API', () => {
  assert.equal(parseListParams({ agent: '003' }).agent, '003');
  assert.throws(() => parseListParams({ agent: '1 OR 1=1' }));
  assert.throws(() => parseListParams({ agent: '12345678901' }));
});

test('busca o hostname do agente mantendo o zero à esquerda', () => {
  assert.deepEqual(buildAgentLookupBody('003').query.bool.filter, [{ term: { 'agent.id': '003' } }]);
  assert.deepEqual(
    parseAgentLookup({
      hits: { hits: [{ _source: { agent: { id: '003', name: 'nome-do-agente' }, host: { hostname: 'host-real' } } }] },
    }),
    { id: '003', name: 'nome-do-agente', hostname: 'host-real' }
  );
});

test('agente sem inventário não vira filtro vazio', () => {
  assert.equal(parseAgentLookup({ hits: { hits: [] } }), null);
  assert.equal(parseAgentLookup({ hits: { hits: [{ _source: { agent: { id: '1' } } }] } }), null);
});
