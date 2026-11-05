'use strict';

class LimiterBusyError extends Error {
  constructor() {
    super('Muitas gravações sendo analisadas ao mesmo tempo.');
    this.statusCode = 429;
  }
}

/**
 * Limita quantas tarefas pesadas rodam juntas. Cada análise pode manter dezenas de megabytes em
 * memória: sem limite, várias telas abertas juntas poderiam esgotar a memória do dashboard.
 */
function createLimiter({ concurrency, queue }) {
  let running = 0;
  const waiting = [];

  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };

  return async function run(task) {
    if (running >= concurrency) {
      if (waiting.length >= queue) throw new LimiterBusyError();
      await new Promise((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

module.exports = { LimiterBusyError, createLimiter };
