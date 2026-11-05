'use strict';

// A tela do agente usa ?agent=003; os módulos do Wazuh usam ?agentId=003. Os dois ficam no hash.
const AGENT_PARAM = /[?&]agent(?:Id)?=(\d{1,10})(?=&|#|$)/;

function agentIdFromUrl(url) {
  const match = AGENT_PARAM.exec(String(url ?? ''));
  return match ? match[1] : null;
}

const replayPath = (agentId) => `?agent=${encodeURIComponent(agentId)}`;

module.exports = { agentIdFromUrl, replayPath };
