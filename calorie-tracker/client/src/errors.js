// Friendly copy for API error codes (see CONTRACT.md). `retry` says whether
// trying the same request again could plausibly help; `setup` means the
// server needs fixing first, so the phone should offer manual entry instead.

const COPY = {
  no_food_detected: {
    title: 'No food spotted',
    body: "Gemini couldn't find food or drink in this photo. Try a closer, well-lit shot, or add a hint below.",
    retry: true,
  },
  rate_limited: {
    title: 'Gemini is busy',
    body: 'The free tier only allows a few scans per minute. Wait a moment, then try again.',
    retry: true,
  },
  gemini_not_configured: {
    title: "Scanning isn't set up",
    body: 'Add your GEMINI_API_KEY to server/.env and restart the server. You can still add meals by hand.',
    retry: false,
    setup: true,
  },
  image_too_large: {
    title: 'Photo is too large',
    body: 'Photos must be under 15 MB. Try a different photo or a screenshot of it.',
    retry: false,
  },
  bad_image_type: {
    title: "That file isn't supported",
    body: 'Use a JPEG, PNG, WebP or HEIC photo.',
    retry: false,
  },
  no_image: {
    title: 'No photo attached',
    body: 'Pick a photo and try again.',
    retry: false,
  },
  analysis_failed: {
    title: "Couldn't analyze the photo",
    body: 'Gemini sent back something unexpected. Trying again usually works.',
    retry: true,
  },
  network_error: {
    title: "Can't reach the server",
    body: 'Make sure the Snap Calories server is running and your phone is on the same Wi-Fi as the computer.',
    retry: true,
  },
  timeout: {
    title: 'That took too long',
    body: 'The analysis timed out. Check your connection and try again.',
    retry: true,
  },
  unauthorized: {
    title: 'Passcode needed',
    body: 'Enter the passcode for this server, then try again.',
    retry: true,
  },
};

// Shown when a typed passcode could never be sent (see isValidToken in api.js).
export const INVALID_PASSCODE = "Passcodes can't contain emoji or symbols like €. Check APP_TOKEN in server/.env.";

// Server messages that point at its own config, which no retry can fix.
const SERVER_SETUP = /GEMINI_API_KEY|GEMINI_MODEL/;

export function describeError(err) {
  const known = COPY[err?.code];
  if (!known) {
    return {
      title: 'Something went wrong',
      body: err?.message || 'Please try again.',
      retry: true,
    };
  }
  // ApiError falls back to the code as its message when the server sent none.
  const message = err.message?.trim();
  if (!message || message === err.code) return known;

  // The server includes the model's own explanation for no_food_detected.
  if (err.code === 'no_food_detected') {
    const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
    return { ...known, body: `${sentence} Try another photo, or add a hint below.` };
  }
  // analysis_failed covers everything from a wrong API key to a garbled reply,
  // and only the server's message says which.
  if (err.code === 'analysis_failed') {
    if (SERVER_SETUP.test(message)) {
      return { title: "Scanning isn't working", body: message, retry: false, setup: true };
    }
    return { ...known, body: message };
  }
  return known;
}
