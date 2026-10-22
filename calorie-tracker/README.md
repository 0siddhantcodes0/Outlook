# Snap Calories

Take a photo of a meal on your phone. Gemini estimates the calories and macros,
and the server adds the meal to your daily total.

- `server/`: Node + Express API with a local SQLite database (`server/data/calories.db`)
- `client/`: React app built with Vite and designed for phones

The server runs on your computer, and your phone opens it in the browser over
your home Wi-Fi. Photos are analyzed in memory and never stored.

## Requirements

- Node.js 22.12 or newer
- A free Gemini API key from <https://aistudio.google.com/apikey>. You can skip
  the key and try the app with a fake analyzer first (see step 2).

## 1. Install

From this folder (`calorie-tracker/`):

```sh
npm run setup
```

This installs the root, server and client dependencies.

## 2. Configure

Copy the example config and fill it in:

```sh
cp server/.env.example server/.env        # Windows: copy server\.env.example server\.env
```

Then edit `server/.env`:

- `GEMINI_API_KEY=...` is your key from AI Studio.
- Or set `GEMINI_MOCK=1` to try the app without a key. Every scan then returns
  the same sample meal.

The other settings are optional and documented in the file: `PORT` (3001),
`HOST`, `DB_PATH`, `GEMINI_MODEL` (models to try in order) and `APP_TOKEN` (see
below).

## 3. Build and start

```sh
npm run build
npm start
```

The server prints its addresses:

```
Snap Calories server is running:
  Local:   http://localhost:3001
  Network: http://192.168.1.23:3001   <- open this on your phone
```

## 4. Open it on your phone

1. Connect the phone to the **same Wi-Fi** as the computer.
2. Open the `Network:` URL in the phone's browser.
3. If the page doesn't load, the computer's firewall is probably blocking it.
   Allow Node.js through the firewall:
   - **Windows:** accept the "Windows Defender Firewall" prompt for private
     networks, or allow `node.exe` under *Allow an app through firewall*.
   - **macOS:** click *Allow* on the "accept incoming network connections"
     prompt, or check System Settings → Network → Firewall.
   - **Linux (ufw):** `sudo ufw allow 3001/tcp`.

   Guest networks and some routers block devices from reaching each other
   ("AP/client isolation"). Use the main network if you hit that.

Use **Scan food** to open the camera, or **Gallery** to pick an
existing picture. Both work over plain HTTP on your home network.

### Add it to your home screen

- **iPhone (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** ⋮ menu → *Add to Home screen*.

The app is served over plain HTTP on your LAN, so Android Chrome adds a
home-screen shortcut, not a fully installed app (Chrome only installs web apps
over HTTPS). The shortcut still opens Snap Calories in one tap.

The computer has to be on, with `npm start` running, while you use the app.
Your phone can only reach it on the same network.

## Optional: passcode

Anyone on your Wi-Fi can open the app. To require a passcode, set
`APP_TOKEN=some-secret` in `server/.env` and restart the server. The app asks
for the passcode once and remembers it on that device. You can change or forget
it in Settings.

## Optional: use it away from home

To log meals over mobile data, put the server behind an HTTPS tunnel. With
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
installed, run:

```sh
cloudflared tunnel --url http://localhost:3001
```

Then open the `https://….trycloudflare.com` address it prints on your phone.
**Set `APP_TOKEN` first.** Anyone with the link could otherwise read your log
and use up your Gemini quota. Over HTTPS, Android Chrome can also install the
app properly. The computer still has to stay on.

## Development

```sh
npm run dev
```

This runs the API on :3001 (restarting on changes) and the Vite dev server on
:5173 with hot reload. Vite forwards `/api` to the API. It is also reachable
from your phone at `http://<your computer's IP>:5173`.

Run the server tests (Gemini is always faked, no key needed):

```sh
npm test
```

After you change the client, run `npm run build` again and reload the page.
`npm start` picks up the new build without a restart.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Scanning isn't set up" | Add `GEMINI_API_KEY` (or `GEMINI_MOCK=1`) to `server/.env` and restart the server. |
| "Gemini is busy" | The free tier allows only a few scans per minute. Wait a minute and try again. |
| "Scanning isn't working" | The server's Gemini settings are wrong. Fix `GEMINI_API_KEY`, or set `GEMINI_MODEL` to a model your key can use (e.g. `gemini-2.5-flash`), then restart. |
| "Couldn't analyze the photo" on every scan | Check the server terminal for `Gemini request ... failed` and the reason Google gave. |
| "Gemini is busy" even on the first scan of the day | Your key's free tier may have no quota for the first model in `GEMINI_MODEL`. Put a different flash model first (e.g. `GEMINI_MODEL=gemini-2.5-flash`) and restart. |
| "Can't reach the server" | Make sure `npm start` is running and the phone is on the same Wi-Fi, then check the firewall (step 4). |
| "Snap Calories API is running. Build the client…" | Run `npm run build`, then reload the page. |
| "Port 3001 is already in use" (terminal) | Stop the other process, or set another `PORT` in `server/.env`. |

## Your data

Meals are stored in `server/data/calories.db` (SQLite). To back up your log,
stop the server and copy that file. Photos are only sent to Gemini for analysis
and are not kept. On the free tier, Google may use what you send to improve its
products. See the Gemini API terms.
