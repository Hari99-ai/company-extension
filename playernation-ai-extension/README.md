# PlayerNation AI Football Event Logger Chrome Extension

An AI-powered Chrome Extension built with **Manifest V3** designed to automate and simplify football match event logging on [PlayerNation](https://playernation.app/).

---

## Architecture Overview

```
playernation-ai-extension/
├── manifest.json              # Chrome Extension Manifest V3
├── package.json               # Test scripts & project metadata
├── background/
│   └── service-worker.js      # Manifest V3 service worker (state & tab management)
├── content/
│   ├── content.js             # Content script: video capture, in-page HUD, DOM bridge
│   └── content.css            # Styles for in-page canvas overlay & draggable HUD
├── popup/
│   ├── popup.html             # Extension dashboard (Controls, Status, Suggestions, Log Table)
│   ├── popup.css              # Glassmorphism dark-theme stylesheet
│   └── popup.js               # Popup controller & telemetry polling
├── utils/
│   ├── video-capture.js       # VideoCaptureManager (DOM video, letterbox, throttled FPS)
│   └── timestamps.js          # Time formatting, parser, seek detection, deduplication
├── models/
│   └── README.md              # ONNX model input/output specs & export instructions
├── test-page/
│   ├── test-match.html        # Local match simulation harness with PlayerNation action buttons
│   └── test-match.js          # Continuous 30fps pitch simulation stream
├── tests/
│   ├── timestamps.test.js     # Timestamp conversion & deduplication unit tests
│   └── video-capture.test.js  # Letterbox math, FPS throttle, & capture state tests
└── README.md
```

---

## Installation & Setup Instructions (Windows 11 & Google Chrome)

### Step 1: Open Chrome Extensions Manager
1. Launch **Google Chrome** on Windows 11.
2. In the URL address bar, navigate to:
   ```text
   chrome://extensions/
   ```
3. In the top-right corner, toggle the **"Developer mode"** switch to **ON**.

### Step 2: Load Unpacked Extension
1. Click the **"Load unpacked"** button in the top-left toolbar.
2. Browse to the folder:
   ```text
   D:\all\company\playernation-ai-extension
   ```
3. Click **Select Folder**.
4. The extension **"PlayerNation AI Football Event Logger"** will appear in your installed extensions with version `1.0.0` and no manifest errors.

### Step 3: Pin the Extension
1. Click the puzzle icon (Extensions) in the Chrome toolbar.
2. Click the pin icon next to **PlayerNation AI Football Event Logger** to keep it accessible.

---

## Universal Live Video Support (YouTube, Twitch, Sports Streams & PlayerNation)

This extension is built to hook into and work with **any live video present in the browser**:
- **Universal Scope**: Runs across all websites (`<all_urls>`), including YouTube Live, Twitch, web sports streams, and local files.
- **Smart Video Discovery**: Automatically scans the active tab, ranks videos by playback activity and screen size, and attaches to the primary player.
- **Live Stream Tracking**: Recognizes live broadcast streams (`duration: Infinity`, `MediaStream`, or continuous HLS/DASH feeds), applies continuous live clocks, and shows a `🔴 LIVE` badge.
- **On-the-Fly Dynamic Injection**: Open any existing tab with a live video and click **Start Detection**; the extension injects the vision pipeline immediately without requiring a full page reload.
- **In-Page Canvas Overlay & Draggable HUD**: Renders real-time player detection boxes, ball trajectory trails, match clock, and assisted event prompts directly over the video player (with full-screen support).
- **Overlay Layers & Detection Levels**:
  - 👤 **Human / Players**: Toggle player bounding boxes ON/OFF.
  - ⚽ **Football**: Toggle ball detection bounding box ON/OFF.
  - 🏷️ **Player Labels**: Toggle player ID tags and team jersey indicators ON/OFF.
  - 〰️ **Ball Trajectory**: Toggle flight trajectory trail ON/OFF.
  - ⏱️ **Telemetry HUD**: Toggle video clock and FPS overlay badge ON/OFF.
  - 🎚️ **Detection Confidence Sliders**: Real-time sensitivity threshold adjustment for humans (10%–80%) and football (5%–60%).
  - 📱 **Interactive In-Page HUD Bar**: Clickable quick-toggle pills (`[👤 Human]` `[⚽ Ball]` `[🏷️ Labels]` `[〰️ Trail]`) right inside the floating HUD on the video stream.

---

## Verifying & Testing Live Videos

### Option A: Local Match Compare Test Bench (Dual Video Simulation & File Loader)
1. In Google Chrome, open the dedicated match compare harness matching the PlayerNation compare URL:
   ```text
   file:///D:/all/company/playernation-ai-extension/test-page/test-match-compare.html
   ```
2. You will see dual side-by-side pitch simulations:
   - **Match 1 (454ba202...)**: White vs Red pitch action.
   - **Match 2 (a710594e...)**: Blue vs Yellow pitch action.
   - Or click **Load Local Video File** on either player to test your own football match `.mp4`/`.webm` recording!
3. Click the **PlayerNation AI Vision** extension icon in your Chrome toolbar.
4. Click **Start Detection**:
   - The HUD attaches to the active match video.
   - Click either video on the page to seamlessly switch AI tracking to that match!
   - You can also click the `📹 Switch Video (1/2)` button in the in-page floating HUD.
   - Trigger any action button (or shortcut `p`, `x`, `g`, `e`, `r`, `s`) to verify simulated click logging in the audit stream.

### Option B: On the Live PlayerNation App (Match Compare URL)
1. In Google Chrome, navigate to the target compare URL:
   ```text
   https://www.playernation.app/match-compare/454ba202-b516-45ca-9d69-543be6c16101/a710594e-3048-4cb6-9f3b-9724b986f8e0
   ```
2. Ensure at least one match video is playing on the page.
3. Click the extension icon in your toolbar. The domain pill will display `🌐 playernation.app`.
4. Click **Start Detection**:
   - The extension automatically attaches to the playing match video.
   - The in-page draggable HUD and bounding box overlays will appear over the video player.
   - If two videos are playing side-by-side, click on either video to target AI vision to that match.
   - When football events are detected, they appear in the Assisted Mode queue and can be logged directly into PlayerNation's match buttons.

### Option C: On Universal Live Streams (YouTube, Twitch, Broadcast Feeds)
1. Open any football/sports live stream on [YouTube](https://www.youtube.com/) or [Twitch](https://www.twitch.tv/).
2. Click the extension icon in your Chrome toolbar. Notice the domain badge updates automatically (e.g. `🌐 youtube.com`).
3. Click **Start Detection**.
4. The extension hooks the live `<video>` element, activates the in-page overlay canvas and draggable HUD, and tracks player and ball movements in real time.

---

## Local Python AI Backend (YOLOv8 PyTorch)

To detect players and footballs on **PlayerNation live videos** where external CDNs have Cross-Origin (CORS) restrictions, connect the extension to the included **Local AI Backend**:

### Why Use the Local Backend?
1. **Defeats Stream CORS**: PlayerNation serves match recordings from external CDNs without `Access-Control-Allow-Origin: *`. The extension uses Chrome's Tab Capture API to stream pixels directly into the local server without browser security blocks.
2. **Lightning-Fast Inference**: Uses native PyTorch + Ultralytics YOLOv8n running directly on your GPU (CUDA) or CPU.
3. **Zero Browser Tab Freezing**: Offloads heavy tensor calculations from Chrome to the Python process.
4. **Automatic Fallback**: If the local server is stopped, the extension seamlessly falls back to the in-browser ONNX model.

### Starting the Local Backend (1-Click)
Choose any of the following:

- **Option 1**: Double-click [`start-backend.bat`](file:///d:/all/company/playernation-ai-extension/start-backend.bat).
- **Option 2**: Run in terminal:
  ```bash
  npm run backend
  ```
- **Option 3**: Run directly with Python:
  ```bash
  python server/server.py
  ```

Once started:
- Server dashboard is live at `http://127.0.0.1:8000`.
- The extension popup will display: `🟢 Local PyTorch (CPU/CUDA)`.
- Real-time bounding boxes, jersey tracking, and football trajectories appear on the live video!
- Small-ball recovery uses the included YOLOv8n COCO model at higher resolution on uncertain frames, or a magnified crop around the last tracked location when a position hint is available. On the supplied PlayerNation screenshot, YOLOv8n identified the visible football at about 0.67 confidence at 960-pixel inference size; the same frame at 640 pixels only scored about 0.08.

---

## Football Tracking Training Samples

While detection is running, the extension enters football pinpoint mode once per match minute. Click the football in the video to correct the tracker and save that captured frame with a football bounding-box label. You can also use the existing **Pinpoint on Video** control at any time; each manual pinpoint is saved as a labeled example.

Use **Export Labeled Frames** in the popup to download the locally stored examples as JSON. Frames remain in extension storage and are only synced to the local Python backend at `127.0.0.1` when it is running; they are not sent to a remote service. The exported bundle uses the `playernation-football-training-v1` format, with JPEG frame data and normalized football box coordinates.

When the local Python backend is running, verified examples sync to `http://127.0.0.1:8000` and automatically fine-tune a football-only YOLO model after the configured number of new labels (default: 20). Change **Auto-train after verified labels** in the popup to adjust the threshold (10–10000). The original COCO model continues to detect players; the trained football model is used alongside it for ball detection. The in-browser ONNX fallback remains unchanged.

Training uses local CPU or CUDA resources and may take time. The trained weights are saved to `models/football_finetuned.pt`; uploaded frames and labels are stored under `training_data/football/`. The backend dashboard reports training status and errors. If the backend is offline when a label is created, it remains in extension storage and syncs when the backend reconnects.

---

## Running Automated Unit Tests

Run the built-in Node.js test runner:

```bash
cd D:\all\company\playernation-ai-extension
npm test
```

### Test Results (37/37 Passing)
- `LocalBackendClient`: Health check, error recovery, missing payload validation (Passed).
- `formatMatchTime`: Converts seconds to `MM:SS` and `HH:MM:SS` (Passed).
- `parseMatchTime`: Converts time strings to float seconds (Passed).
- `isSeekDetected`: Distinguishes normal playback from backward rewinds and forward seeks (Passed).
- `isDuplicateEvent`: Enforces event window deduplication (Passed).
- `VideoCaptureManager`: Validates aspect ratio letterbox scaling and padding math (Passed).
- `VideoCaptureManager`: Enforces FPS bounds and state machine transitions (Passed).
- `PlayerNationAdapter`: Dynamic button mapping and submission (Passed).
- Football training reminders and normalized training-frame labels (Passed).
- Local backend training configuration and verified-sample uploads (Passed).
