'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAGE_SIZE,
  parseListParams,
  parseRec,
  buildListBody,
  buildChunkBody,
  parseListResponse,
  fetchAllChunks,
} = require('../src/lib/queries');

test('valida os parâmetros da lista', () => {
  assert.equal(parseListParams({}).size, 100);
  assert.equal(parseListParams({ host: '' }).host, undefined);
  assert.equal(parseListParams({ from: '2026-11-04T10:00:00Z' }).from, '2026-11-04T10:00:00.000Z');
  assert.throws(() => parseListParams({ size: '100000' }));
  assert.throws(() => parseListParams({ size: 'abc' }));
  assert.throws(() => parseListParams({ from: 'ontem' }));
  assert.throws(() => parseListParams({ host: ['a', 'b'] }));
});

test('valida o identificador da gravação', () => {
  assert.equal(parseRec('dcf1298e-72-1f9e'), 'dcf1298e-72-1f9e');
  assert.throws(() => parseRec('../_cluster/settings'));
  assert.throws(() => parseRec('a b'));
  assert.throws(() => parseRec(undefined));
});

test('monta filtros apenas para o que foi informado', () => {
  const empty = buildListBody(parseListParams({}));
  assert.deepEqual(empty.query.bool, { filter: [], must: [] });

  const body = buildListBody(parseListParams({ host: 'web1', user: 'ana', q: 'rm -rf', from: '2026-01-01' }));
  assert.deepEqual(body.query.bool.filter[0], { term: { host: 'web1' } });
  assert.deepEqual(body.query.bool.filter[1], { term: { user: 'ana' } });
  assert.deepEqual(body.query.bool.must, [{ match_phrase: { out_txt: 'rm -rf' } }]);
});

test('filtra o período pela hora do tlog e só usa @timestamp quando ela não existe', () => {
  const body = buildListBody(parseListParams({ from: '2026-01-01T00:00:00Z' }));
  const [byTime, fallback] = body.query.bool.filter[0].bool.should;
  assert.equal(byTime.range.time.gte, Date.parse('2026-01-01T00:00:00Z') / 1000);
  assert.deepEqual(fallback.bool.must_not, [{ exists: { field: 'time' } }]);
  assert.equal(fallback.bool.filter[0].range['@timestamp'].gte, '2026-01-01T00:00:00.000Z');
});

test('nunca pede a entrada do usuário ao índice', () => {
  const fields = buildChunkBody('abc')._source;
  assert.ok(!fields.includes('in_txt'));
  assert.ok(!fields.includes('in_bin'));
  assert.ok(fields.includes('out_txt'));
});

test('interpreta a resposta da agregação', () => {
  const sessions = parseListResponse({
    aggregations: {
      sessions: {
        buckets: [
          {
            key: 'r1',
            doc_count: 3,
            first_seen: { value_as_string: '2026-01-01T09:00:00.000Z' },
            first_time: { value: Date.parse('2026-01-01T00:00:00Z') / 1000 },
            max_pos: { value: 2500 },
            max_id: { value: 5 },
            details: { hits: { hits: [{ _source: { host: 'web1', user: 'ana', term: 'xterm' } }] } },
          },
        ],
      },
    },
  });
  assert.deepEqual(sessions[0], {
    rec: 'r1',
    host: 'web1',
    user: 'ana',
    term: 'xterm',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationSeconds: 2.5,
    messages: 3,
    maxId: 5,
  });
  assert.deepEqual(parseListResponse({}), []);
});

test('usa a hora de chegada para gravações sem o campo time', () => {
  const [session] = parseListResponse({
    aggregations: {
      sessions: {
        buckets: [{ key: 'r', doc_count: 1, first_seen: { value_as_string: 'X' }, first_time: { value: null } }],
      },
    },
  });
  assert.equal(session.startedAt, 'X');
  assert.equal(session.durationSeconds, null);
});

const fakeSearch = (total, calls = []) => async (body) => {
  calls.push(body);
  const start = body.search_after ? body.search_after[0] : 0;
  const hits = [];
  for (let id = start + 1; id <= Math.min(total, start + body.size); id += 1) {
    hits.push({ _source: { id }, sort: [id] });
  }
  return { hits: { hits } };
};

test('pagina até ler todos os pedaços', async () => {
  const calls = [];
  const { messages, truncated } = await fetchAllChunks(fakeSearch(PAGE_SIZE * 2 + 7, calls), 'r');
  assert.equal(messages.length, PAGE_SIZE * 2 + 7);
  assert.equal(truncated, false);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].search_after, [PAGE_SIZE]);
});

test('não entra em loop quando o total é múltiplo exato da página', async () => {
  const calls = [];
  const { messages } = await fetchAllChunks(fakeSearch(PAGE_SIZE, calls), 'r');
  assert.equal(messages.length, PAGE_SIZE);
  assert.equal(calls.length, 2);
});

test('sinaliza quando a gravação passa do limite', async () => {
  const { messages, truncated } = await fetchAllChunks(fakeSearch(PAGE_SIZE * 3), 'r', PAGE_SIZE);
  assert.equal(messages.length, PAGE_SIZE);
  assert.equal(truncated, true);
});
