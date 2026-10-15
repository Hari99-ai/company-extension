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

---

## Verifying & Testing Live Videos

### Option A: Local Live Test Stream (No internet stream required)
1. In Google Chrome, open the local match stream harness:
   ```text
   file:///D:/all/company/playernation-ai-extension/test-page/test-match.html
   ```
2. You will see an active 30 FPS pitch simulation stream with moving ball and players.
3. Click the **PlayerNation AI Vision** extension icon in your Chrome toolbar.
4. Click **Start Detection**.
5. Observe:
   - Video capture attaches to the match video with a `🔴 LIVE` indicator.
   - FPS counter displays live processing rate (8 FPS).
   - In-page video overlay renders real-time HUD badge, ball tracking, and player IDs.
   - Click **Pause**, **Resume**, and **Stop** to verify state machine transitions.

### Option B: On Live Web Streams (YouTube, Twitch, Sports Broadcasts)
1. Open any football/sports live stream on [YouTube](https://www.youtube.com/) or [Twitch](https://www.twitch.tv/).
2. Click the extension icon in your Chrome toolbar. Notice the domain badge updates automatically (e.g. `🌐 youtube.com`).
3. Click **Start Detection**.
4. The extension hooks the live `<video>` element, activates the in-page overlay canvas and draggable HUD, and tracks player and ball movements in real time.

---

## PlayerNation Match Logging Testing (`https://www.playernation.app/log/...`)

### Step-by-Step Testing on PlayerNation Log Pages:
1. In Google Chrome, navigate to your target match logging URL:
   ```text
   https://www.playernation.app/log/20956523-fdcc-4ab3-9f28-4848a3c5c08d/c1a8e8d0-59f9-484a-a79c-6f691422037b
   ```
2. Start or play the match video on the PlayerNation page.
3. Open the **PlayerNation AI Vision** extension from the Chrome toolbar (or inspect the in-page HUD).
4. Click **Start Detection**.
5. The extension attaches to the active match video, overlaying:
   - **Football Tracking Ring & Velocity Vector** (Amber/Yellow marker)
   - **Player Bounding Boxes & IDs** (Cyan boxes)
   - **Match Clock & Assisted Event Prompts** (Goal, Pass, Shot, Clearance)
   - **Layer Toggles**: In the popup or HUD, you can toggle individual layers on/off (Ball, Players, Trajectory, Possession, Event Prompts).

### Football Detection Enhancements:
- **Unletterbox Coordinate Inversion**: Eliminates vertical box squashing on widescreen (16:9) video feeds by mapping 640x640 letterbox coordinates accurately back to video space.
- **Dynamic CORS Media Rules**: Dynamically injects `Access-Control-Allow-Origin: *` headers for CDN video streams, preventing canvas security tainting and allowing high-res direct video frame sampling.
- **High-Sensitivity Football Threshold (8%)**: Broadcast match footage features small balls (6–15px). The detector accepts proposals at 8% confidence and filters false positives via spherical aspect ratio (`0.35 <= w/h <= 2.8`) and maximum scale filters (`w <= 0.09, h <= 0.09`).
- **Localized ROI Saliency Fallback**: If YOLO misses the ball during fast flight or occlusion, a 96x96 ROI circular blob detector directly tracks contrast changes on the `<video>` element to prevent losing tracking.
- **🎯 One-Click Manual Football Pinpoint**: Press keyboard shortcut `B` or click **🎯 Pinpoint Football** in the HUD/Popup, then click directly on the football anywhere on the video. The tracker locks onto that object, persists tracking frame-to-frame, and guides the detector using hint coordinates.

---

## Running Automated Unit Tests

Run the built-in Node.js test runner:

```bash
cd D:\all\company\playernation-ai-extension
npm test
```

### Test Results (31 Passing Tests)
- `BallTracker`: Set manual lock, player possession check, candidate snapping, and persistent manual lock.
- `Postprocessing`: Sports ball (class 32) extraction, spherical aspect ratio validation, oversized noise filtering, and hint location scoring.
- `VideoCaptureManager`: Unletterbox coordinate inverse mapping, aspect ratio letterbox scaling, and padding math.
- `PlayerNationAdapter`: Button finding and event logging verification.
- `Timestamps`: Time parsing, formatting, deduplication, and seek jump detection.

# company-extension
