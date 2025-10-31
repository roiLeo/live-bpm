
# Live BPM Detector

A Nuxt 4 web app for real-time BPM (beats per minute) detection from live audio input. Visualizes waveform and tempo, designed for musicians, DJs, and anyone needing instant tempo feedback.

## Features
- Real-time BPM calculation from microphone input
- Live waveform visualization
- Confidence meter for BPM accuracy
- Responsive UI with Nuxt UI components
- Works best with clear, rhythmic music or metronome

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- pnpm (recommended)

### Install dependencies
```bash
pnpm install
```

### Run in development mode
```bash
pnpm dev
```

App will start on `http://localhost:3000` (default Nuxt port).

### Build for production
```bash
pnpm build
```

### Start production server
```bash
pnpm start
```

## Usage
1. Open the app in your browser.
2. Click **Start Listening** and allow microphone access.
3. Play music, use a metronome, or clap near the mic.
4. The BPM and confidence will update in real time.

## Troubleshooting
- If BPM is not detected, try louder or clearer beats.
- Make sure microphone permissions are granted.
- Use a metronome or drum loop for best results.
- Check browser console for debug logs if needed.

## Project Structure
- `app/pages/index.vue` — main BPM detection and UI logic
- `app/components/` — UI components
- `app/assets/css/` — styles
- `nuxt.config.ts` — Nuxt configuration

## License
WTFPL

---

Made with Nuxt 4 and ❤️ for live music analysis.
