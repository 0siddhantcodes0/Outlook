import { GoogleGenAI, Type } from '@google/genai';
import { HttpError } from './errors.js';

const REQUEST_TIMEOUT_MS = 60_000;

/** Structured-output schema (the SDK's OpenAPI-style `Schema`). */
export const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_food: { type: Type.BOOLEAN, description: 'False if no food or drink is visible.' },
    meal_name: { type: Type.STRING, description: 'Short name for the whole meal, e.g. "Chicken burrito bowl".' },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          portion: { type: Type.STRING, description: 'Estimated amount, e.g. "1 cup (160 g)".' },
          calories: { type: Type.NUMBER, description: 'Whole kcal.' },
          protein_g: { type: Type.NUMBER },
          carbs_g: { type: Type.NUMBER },
          fat_g: { type: Type.NUMBER },
        },
        required: ['name', 'portion', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
        propertyOrdering: ['name', 'portion', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
      },
    },
    total_calories: { type: Type.NUMBER, description: 'Sum of item calories.' },
    confidence: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
    notes: { type: Type.STRING, description: 'Assumptions made, or why the photo is not food.' },
  },
  required: ['is_food', 'meal_name', 'items', 'total_calories', 'confidence', 'notes'],
  propertyOrdering: ['is_food', 'meal_name', 'items', 'total_calories', 'confidence', 'notes'],
};

export function buildPrompt(hint) {
  const lines = [
    'You are a nutrition analyst. Estimate the calories and macronutrients in this photo.',
    '',
    '- Identify every distinct food and drink that is visible, as separate items.',
    '- Estimate realistic portion sizes from visual cues such as plate and bowl size, utensils, hands and packaging. State each portion in the "portion" field (household units plus grams or ml).',
    '- If a nutrition label or package information is legible, read it and prefer it over visual estimates.',
    '- Use standard nutrition references (such as USDA FoodData Central) for per-portion values.',
    '- Count cooking oils, butter, dressings and sauces, as separate items when they are significant.',
    '- Give calories as whole numbers (kcal) and macros in grams. total_calories must equal the sum of the item calories.',
    '- Set confidence to "low", "medium" or "high" depending on how clearly the food and its portions can be identified.',
    '- Use notes for a short summary of key assumptions (hidden ingredients, portion guesses).',
    '- If there is no food or drink in the photo, set is_food to false, items to an empty array, total_calories to 0, and explain in notes what you see instead.',
  ];
  const cleanHint = hint?.trim();
  if (cleanHint) {
    lines.push(
      '',
      'The user added this note about the meal. Treat it as reliable extra context; it overrides your visual guess where they conflict (portion counts, ingredients, preparation):',
      `"""${cleanHint}"""`,
    );
  }
  return lines.join('\n');
}

/**
 * Real analyzer backed by the Gemini API. `analyze` resolves to the model's raw
 * JSON text; run it through normalizeAnalysis before use.
 *
 * Models in `config.geminiModels` are tried in order, moving to the next one
 * only when a model does not exist (404 / NOT_FOUND). `options.client` lets
 * tests inject a stub with the same `models.generateContent` shape.
 */
export function createGeminiAnalyzer(config, { client, logger = console } = {}) {
  const ai =
    client ??
    new GoogleGenAI({
      apiKey: config.geminiApiKey,
      httpOptions: {
        timeout: REQUEST_TIMEOUT_MS,
        ...(config.geminiBaseUrl && { baseUrl: config.geminiBaseUrl }),
      },
    });
  const models = config.geminiModels;
  // Index of the first model worth trying; skips models already found missing.
  let firstModel = 0;

  return {
    async analyze(buffer, mimeType, hint) {
      const contents = [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType, data: buffer.toString('base64') } }, { text: buildPrompt(hint) }],
        },
      ];

      for (let i = firstModel; i < models.length; i++) {
        const model = models[i];
        let response;
        try {
          response = await ai.models.generateContent({
            model,
            contents,
            config: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
            },
          });
        } catch (err) {
          const isLast = i === models.length - 1;
          if (!isModelNotFound(err) || isLast) {
            if (isLast && isModelNotFound(err)) firstModel = 0; // start over next time
            throw toHttpError(err, model, logger);
          }
          logger.warn(`Gemini model "${model}" not found; falling back to "${models[i + 1]}".`);
          firstModel = i + 1;
          continue;
        }
        return responseText(response);
      }
      throw new HttpError(502, 'analysis_failed', 'No Gemini model is configured.');
    },
  };
}

function responseText(response) {
  const text = response?.text;
  if (typeof text === 'string' && text.trim()) return text;
  const reason = response?.promptFeedback?.blockReason ?? response?.candidates?.[0]?.finishReason;
  throw new HttpError(
    502,
    'analysis_failed',
    reason ? `Gemini returned no analysis (${reason}). Try another photo.` : 'Gemini returned an empty response.',
  );
}

/** HTTP status and Google RPC status (e.g. "NOT_FOUND") of an SDK error, when present. */
export function errorDetails(err) {
  let status = typeof err?.status === 'number' ? err.status : undefined;
  let reason;
  // The SDK's ApiError message is the JSON error body: {"error":{"code":404,"status":"NOT_FOUND",...}}
  try {
    const body = JSON.parse(err?.message);
    status ??= body?.error?.code;
    reason = body?.error?.status;
  } catch {
    // Not a JSON message.
  }
  return { status, reason };
}

function isModelNotFound(err) {
  const { status, reason } = errorDetails(err);
  return status === 404 || reason === 'NOT_FOUND';
}

function isRateLimited(err) {
  const { status, reason } = errorDetails(err);
  return status === 429 || reason === 'RESOURCE_EXHAUSTED';
}

/** Maps an SDK or network error to a client-safe HttpError (never echoing the raw message). */
export function toHttpError(err, model, logger = console) {
  if (err instanceof HttpError) return err;
  if (isRateLimited(err)) {
    return new HttpError(429, 'rate_limited', 'Gemini rate limit reached. Wait a minute and try again.');
  }

  logger.error(`Gemini request to "${model}" failed:`, err?.message ?? err);
  const { status } = errorDetails(err);
  let message = 'Gemini could not analyze this photo. Please try again.';
  if (status === 400 || status === 401 || status === 403) {
    message = 'Gemini rejected the request. Check GEMINI_API_KEY and GEMINI_MODEL on the server.';
  } else if (status === 404) {
    message = 'None of the configured Gemini models were found. Check GEMINI_MODEL on the server.';
  } else if (status === 500 || status === 503) {
    message = 'Gemini is temporarily unavailable. Please try again in a moment.';
  } else if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    message = 'Gemini took too long to respond. Please try again.';
  } else if (status === undefined) {
    message = 'Could not reach Gemini. Check the server’s internet connection.';
  }
  return new HttpError(502, 'analysis_failed', message);
}

const MOCK_MEAL = {
  is_food: true,
  meal_name: 'Grilled chicken rice bowl',
  items: [
    { name: 'Grilled chicken breast', portion: '150 g', calories: 248, protein_g: 46.5, carbs_g: 0, fat_g: 5.4 },
    { name: 'White rice', portion: '1 cup cooked (160 g)', calories: 205, protein_g: 4.3, carbs_g: 44.5, fat_g: 0.4 },
    { name: 'Steamed broccoli', portion: '1 cup (90 g)', calories: 31, protein_g: 2.5, carbs_g: 6, fat_g: 0.3 },
    { name: 'Olive oil', portion: '1 tbsp (14 g)', calories: 119, protein_g: 0, carbs_g: 0, fat_g: 13.5 },
  ],
  total_calories: 603,
  confidence: 'medium',
  notes: 'Mock analysis (GEMINI_MOCK=1): the same sample meal is returned for every photo.',
};

/** Fake analyzer for demos and offline testing (GEMINI_MOCK=1). */
export function createMockAnalyzer({ delayMs = 600 } = {}) {
  return {
    async analyze(_buffer, _mimeType, hint) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const meal = structuredClone(MOCK_MEAL);
      if (hint?.trim()) meal.notes += ` Your hint was: "${hint.trim()}".`;
      return meal;
    },
  };
}
