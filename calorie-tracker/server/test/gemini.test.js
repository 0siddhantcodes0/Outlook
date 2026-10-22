import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { ApiError } from '@google/genai';
import { HttpError } from '../src/errors.js';
import { RESPONSE_SCHEMA, buildPrompt, createGeminiAnalyzer, createMockAnalyzer } from '../src/gemini.js';
import { normalizeAnalysis } from '../src/nutrition.js';
import { PNG_1X1, SAMPLE_ANALYSIS, silentLogger } from './helpers.js';

const RESULT_TEXT = JSON.stringify(SAMPLE_ANALYSIS);

/** An SDK ApiError shaped like the real ones: the message is the JSON error body. */
function apiError(code, status, message = 'error') {
  return new ApiError({ status: code, message: JSON.stringify({ error: { code, message, status } }) });
}

/** A stand-in for `new GoogleGenAI()`: `respond(model)` returns a response or throws. */
function stubClient(respond) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(params) {
        calls.push(params);
        return respond(params.model);
      },
    },
  };
}

const configFor = (models) => ({ geminiApiKey: 'test-key', geminiModels: models });

function analyzerWith(models, respond) {
  const client = stubClient(respond);
  const analyzer = createGeminiAnalyzer(configFor(models), { client, logger: silentLogger });
  return { analyzer, client, models: () => client.calls.map((call) => call.model) };
}

const rejectsWith = (promise, status, code) =>
  assert.rejects(promise, (err) => err instanceof HttpError && err.status === status && err.code === code);

describe('createGeminiAnalyzer', () => {
  it('sends the image inline with a JSON schema and low temperature', async () => {
    const { analyzer, client } = analyzerWith(['m1'], () => ({ text: RESULT_TEXT }));
    const text = await analyzer.analyze(PNG_1X1, 'image/png', 'two slices');
    assert.equal(text, RESULT_TEXT);

    const [{ model, contents, config }] = client.calls;
    assert.equal(model, 'm1');
    const [imagePart, textPart] = contents[0].parts;
    assert.deepEqual(imagePart, { inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } });
    assert.match(textPart.text, /two slices/);
    assert.equal(config.responseMimeType, 'application/json');
    assert.equal(config.responseSchema, RESPONSE_SCHEMA);
    assert.ok(config.temperature <= 0.3);
  });

  it('falls through to the next model only on not-found', async () => {
    const { analyzer, models } = analyzerWith(['gone-1', 'gone-2', 'ok'], (model) => {
      if (model.startsWith('gone')) throw apiError(404, 'NOT_FOUND', `models/${model} is not found`);
      return { text: RESULT_TEXT };
    });
    assert.equal(await analyzer.analyze(PNG_1X1, 'image/png', ''), RESULT_TEXT);
    assert.deepEqual(models(), ['gone-1', 'gone-2', 'ok']);

    // The working model is remembered for later scans.
    await analyzer.analyze(PNG_1X1, 'image/png', '');
    assert.deepEqual(models(), ['gone-1', 'gone-2', 'ok', 'ok']);
  });

  it('treats a NOT_FOUND status in the error body as not-found', async () => {
    const { analyzer, models } = analyzerWith(['a', 'b'], (model) => {
      if (model === 'a') throw new Error(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }));
      return { text: RESULT_TEXT };
    });
    await analyzer.analyze(PNG_1X1, 'image/png', '');
    assert.deepEqual(models(), ['a', 'b']);
  });

  it('does not fall through on a rate limit, and maps it to 429', async () => {
    const { analyzer, models } = analyzerWith(['a', 'b'], () => {
      throw apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded');
    });
    await rejectsWith(analyzer.analyze(PNG_1X1, 'image/png', ''), 429, 'rate_limited');
    assert.deepEqual(models(), ['a']);
  });

  it('maps RESOURCE_EXHAUSTED without a 429 status to rate_limited', async () => {
    const { analyzer } = analyzerWith(['a'], () => {
      throw new Error(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }));
    });
    await rejectsWith(analyzer.analyze(PNG_1X1, 'image/png', ''), 429, 'rate_limited');
  });

  it('does not fall through on other errors, and maps them to analysis_failed', async () => {
    for (const error of [
      apiError(400, 'INVALID_ARGUMENT', 'API key not valid'),
      apiError(500, 'INTERNAL'),
      apiError(503, 'UNAVAILABLE', 'The model is overloaded'),
      new TypeError('fetch failed'),
    ]) {
      const { analyzer, models } = analyzerWith(['a', 'b'], () => {
        throw error;
      });
      await assert.rejects(analyzer.analyze(PNG_1X1, 'image/png', ''), (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.code, 'analysis_failed');
        assert.doesNotMatch(err.message, /API key not valid|INTERNAL|fetch failed/); // raw SDK text stays server-side
        return true;
      });
      assert.deepEqual(models(), ['a']);
    }
  });

  it('fails with analysis_failed when every model is missing, then retries all of them', async () => {
    const { analyzer, models } = analyzerWith(['a', 'b'], () => {
      throw apiError(404, 'NOT_FOUND');
    });
    await rejectsWith(analyzer.analyze(PNG_1X1, 'image/png', ''), 502, 'analysis_failed');
    await rejectsWith(analyzer.analyze(PNG_1X1, 'image/png', ''), 502, 'analysis_failed');
    assert.deepEqual(models(), ['a', 'b', 'a', 'b']);
  });

  it('fails with analysis_failed on an empty or blocked response', async () => {
    for (const response of [{ text: undefined }, { text: '  ' }, { text: undefined, promptFeedback: { blockReason: 'SAFETY' } }]) {
      const { analyzer } = analyzerWith(['a'], () => response);
      await rejectsWith(analyzer.analyze(PNG_1X1, 'image/png', ''), 502, 'analysis_failed');
    }
  });
});

describe('createGeminiAnalyzer with the real SDK against a local fake API', () => {
  let server;
  let baseUrl;
  const requests = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
        const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        if (req.url.includes('/models/missing-model:')) {
          return reply(404, { error: { code: 404, message: 'models/missing-model is not found', status: 'NOT_FOUND' } });
        }
        if (req.url.includes('/models/busy-model:')) {
          return reply(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
        }
        reply(200, {
          candidates: [{ content: { role: 'model', parts: [{ text: RESULT_TEXT }] }, finishReason: 'STOP' }],
        });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('serializes the request the way the Gemini REST API expects and falls back on 404', async () => {
    requests.length = 0;
    const analyzer = createGeminiAnalyzer(
      { geminiApiKey: 'fake-key', geminiModels: ['missing-model', 'good-model'], geminiBaseUrl: baseUrl },
      { logger: silentLogger },
    );
    const text = await analyzer.analyze(PNG_1X1, 'image/png', 'no sugar');
    assert.deepEqual(normalizeAnalysis(text), normalizeAnalysis(SAMPLE_ANALYSIS));

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/models\/missing-model:generateContent$/);
    assert.match(requests[1].url, /\/models\/good-model:generateContent$/);

    const { headers, body } = requests[1];
    assert.equal(headers['x-goog-api-key'], 'fake-key');
    assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } });
    assert.match(body.contents[0].parts[1].text, /no sugar/);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
    assert.deepEqual(body.generationConfig.responseSchema.properties.confidence.enum, ['low', 'medium', 'high']);
    assert.equal(body.generationConfig.temperature, 0.2);
  });

  it('maps a real 429 to rate_limited without trying the next model', async () => {
    requests.length = 0;
    const analyzer = createGeminiAnalyzer(
      { geminiApiKey: 'fake-key', geminiModels: ['busy-model', 'good-model'], geminiBaseUrl: baseUrl },
      { logger: silentLogger },
    );
    await rejectsWith(analyzer.analyze(PNG_1X1, 'image/png', ''), 429, 'rate_limited');
    assert.equal(requests.length, 1);
  });
});

describe('buildPrompt', () => {
  it('covers the estimation rules and includes the hint only when given', () => {
    const prompt = buildPrompt('');
    for (const phrase of [/every distinct food and drink/, /portion/, /nutrition label/, /oils/, /whole numbers/, /is_food to false/]) {
      assert.match(prompt, phrase);
    }
    assert.doesNotMatch(prompt, /user added this note/);
    assert.match(buildPrompt('  2 slices '), /"""2 slices"""/);
  });
});

describe('createMockAnalyzer', () => {
  it('returns a realistic meal that survives normalization', async () => {
    const raw = await createMockAnalyzer({ delayMs: 0 }).analyze(PNG_1X1, 'image/png', 'extra rice');
    const meal = normalizeAnalysis(raw);
    assert.equal(meal.is_food, true);
    assert.ok(meal.items.length >= 2);
    assert.equal(meal.total_calories, raw.total_calories); // its total matches its items
    assert.match(meal.notes, /extra rice/);
  });
});
