"""
PlayerNation AI Local Inference Server (Flask + Ultralytics YOLOv8)
High-performance local football player and ball detection service.
Connects directly to the PlayerNation Chrome Extension to bypass browser CORS limits,
eliminate WebAssembly/CPU lag, and provide real-time YOLOv8 detections.
"""

import os
import sys
import time
import base64
import hashlib
import random
import shutil
import threading
from pathlib import Path
from threading import RLock
from typing import List, Dict, Any, Tuple

import cv2
import numpy as np
import torch
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
from markupsafe import escape
from ultralytics import YOLO

try:
    configured_minimum_samples = int(os.environ.get("PLAYER_NATION_MIN_TRAINING_SAMPLES", "10"))
    if not 10 <= configured_minimum_samples <= 10000:
        configured_minimum_samples = 10
except ValueError:
    configured_minimum_samples = 10

# Initialize Flask App
app = Flask(__name__)
# Enable CORS for all routes and origins (including chrome-extension:// and playernation.app)
CORS(app, resources={r"/*": {"origins": "*"}})
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

# State Tracking
SERVER_STATE = {
    "start_time": time.time(),
    "model_name": "yolov8n.pt",
    "device": "cuda" if torch.cuda.is_available() else "cpu",
    "frames_processed": 0,
    "total_latency_ms": 0.0,
    "last_detection_summary": "Ready",
    "training_samples": 0,
    "minimum_training_samples": configured_minimum_samples,
    "training_status": "collecting",
    "training_error": None,
    "football_model": False
}

# Resolve model path
BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE_DIR / "models" / "yolov8n.pt"
FOOTBALL_MODEL_PATH = BASE_DIR / "models" / "football_finetuned.pt"
FOOTBALL_DETECTOR_PATH = BASE_DIR / "models" / "football_detector.pt"
TRAINING_DATA_DIR = BASE_DIR / "training_data" / "football"
TRAINING_IMAGES_DIR = TRAINING_DATA_DIR / "images"
TRAINING_LABELS_DIR = TRAINING_DATA_DIR / "labels"
TRAINING_RUNS_DIR = TRAINING_DATA_DIR / "runs"
TRAINING_STATE_PATH = TRAINING_DATA_DIR / "last_trained_sample_count.txt"
if not MODEL_PATH.exists():
    MODEL_PATH = Path("models/yolov8n.pt")
    if not MODEL_PATH.exists():
        MODEL_PATH = Path("yolov8n.pt")

print(f"[PlayerNation AI Server] Loading model from: {MODEL_PATH}")
model = YOLO(str(MODEL_PATH))
football_model = YOLO(str(FOOTBALL_MODEL_PATH)) if FOOTBALL_MODEL_PATH.exists() else None
football_detector = YOLO(str(FOOTBALL_DETECTOR_PATH)) if FOOTBALL_DETECTOR_PATH.exists() else None
MODEL_LOCK = RLock()
TRAINING_LOCK = threading.Lock()
TRAINING_DATA_LOCK = RLock()
SERVER_STATE["football_model"] = football_model is not None or football_detector is not None
SERVER_STATE["model_name"] = "football_detector.pt" if football_detector else (
    "yolov8n.pt + football_finetuned.pt" if football_model else "yolov8n.pt"
)
TRAINING_LABELS_DIR.mkdir(parents=True, exist_ok=True)
TRAINING_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
SERVER_STATE["training_samples"] = len(list(TRAINING_LABELS_DIR.glob("*.txt")))
try:
    LAST_TRAINED_SAMPLE_COUNT = int(TRAINING_STATE_PATH.read_text(encoding="utf-8"))
except (FileNotFoundError, ValueError):
    LAST_TRAINED_SAMPLE_COUNT = 0
LAST_TRAINING_ATTEMPT_COUNT = LAST_TRAINED_SAMPLE_COUNT
print(f"[PlayerNation AI Server] Model loaded successfully on device: {SERVER_STATE['device']}")

# Warmup run
try:
    dummy = np.zeros((640, 640, 3), dtype=np.uint8)
    model.predict(dummy, verbose=False, device=SERVER_STATE['device'])
    print("[PlayerNation AI Server] Model warmup complete.")
except Exception as e:
    print(f"[PlayerNation AI Server] Warmup notice: {e}")


def decode_image_base64(b64_str: str) -> np.ndarray:
    """Decodes a base64 string or Data URL into an OpenCV BGR numpy array."""
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    
    img_bytes = base64.b64decode(b64_str)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Decoded image is empty or corrupted.")
    return img


def collect_ball_predictions(
    prediction_results,
    image_width: int,
    image_height: int,
    minimum_confidence: float,
    offset_x: int = 0,
    offset_y: int = 0,
    class_ids: Tuple[int, ...] = (32,)
) -> List[Dict[str, Any]]:
    balls: List[Dict[str, Any]] = []
    if not prediction_results or prediction_results[0].boxes is None:
        return balls

    for box in prediction_results[0].boxes:
        if int(box.cls[0].item()) not in class_ids:
            continue
        confidence = float(box.conf[0].item())
        if confidence < minimum_confidence:
            continue
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        x1 += offset_x
        x2 += offset_x
        y1 += offset_y
        y2 += offset_y
        norm_x = max(0.0, x1 / image_width)
        norm_y = max(0.0, y1 / image_height)
        norm_w = min(1.0 - norm_x, (x2 - x1) / image_width)
        norm_h = min(1.0 - norm_y, (y2 - y1) / image_height)
        aspect = norm_w / max(1e-5, norm_h)
        if norm_w <= 0.06 and norm_h <= 0.06 and 0.65 <= aspect <= 1.55:
            balls.append({
                "x": norm_x,
                "y": norm_y,
                "width": norm_w,
                "height": norm_h,
                "confidence": round(confidence, 3),
                "classId": 32,
                "className": "ball"
            })
    return balls


def is_extension_request() -> bool:
    origin = request.headers.get("Origin", "")
    return origin.startswith("chrome-extension://") and len(origin) > len("chrome-extension://")


def get_training_status() -> Dict[str, Any]:
    return {
        "status": SERVER_STATE["training_status"],
        "samples": SERVER_STATE["training_samples"],
        "minimum_samples": SERVER_STATE["minimum_training_samples"],
        "football_model": SERVER_STATE["football_model"],
        "error": SERVER_STATE["training_error"]
    }


def update_training_sample_count() -> int:
    with TRAINING_DATA_LOCK:
        SERVER_STATE["training_samples"] = len(list(TRAINING_LABELS_DIR.glob("*.txt")))
        return SERVER_STATE["training_samples"]


def maybe_start_training() -> None:
    global LAST_TRAINING_ATTEMPT_COUNT

    sample_count = update_training_sample_count()
    with TRAINING_LOCK:
        minimum_samples = SERVER_STATE["minimum_training_samples"]
        required_samples = max(minimum_samples, LAST_TRAINED_SAMPLE_COUNT + minimum_samples)
        if sample_count < required_samples:
            if SERVER_STATE["training_status"] != "training":
                SERVER_STATE["training_status"] = "collecting"
            return
        if SERVER_STATE["training_status"] in ("queued", "training"):
            return
        if (
            SERVER_STATE["training_status"] == "error"
            and sample_count <= LAST_TRAINING_ATTEMPT_COUNT
        ):
            return

        LAST_TRAINING_ATTEMPT_COUNT = sample_count
        SERVER_STATE["training_status"] = "queued"
        SERVER_STATE["training_error"] = None
        threading.Thread(
            target=train_football_model,
            args=(sample_count,),
            daemon=True
        ).start()


def train_football_model(sample_count: int) -> None:
    global football_model, LAST_TRAINED_SAMPLE_COUNT

    with TRAINING_LOCK:
        SERVER_STATE["training_status"] = "training"

    run_id = f"football-{sample_count}-{int(time.time())}"
    dataset_dir = TRAINING_DATA_DIR / "datasets" / run_id
    try:
        with TRAINING_DATA_LOCK:
            sample_files = sorted(TRAINING_IMAGES_DIR.glob("*.jpg"))
            sample_files = [
                path for path in sample_files
                if (TRAINING_LABELS_DIR / f"{path.stem}.txt").is_file()
            ]
            random.Random(42).shuffle(sample_files)
            sample_count = len(sample_files)
            if sample_count < SERVER_STATE["minimum_training_samples"]:
                raise RuntimeError("Not enough verified football samples to train.")

            val_count = max(1, round(sample_count * 0.2))
            split_files = {
                "train": sample_files[val_count:],
                "val": sample_files[:val_count]
            }
            for split, files in split_files.items():
                image_dir = dataset_dir / "images" / split
                label_dir = dataset_dir / "labels" / split
                image_dir.mkdir(parents=True, exist_ok=True)
                label_dir.mkdir(parents=True, exist_ok=True)
                for image_path in files:
                    shutil.copy2(image_path, image_dir / image_path.name)
                    shutil.copy2(
                        TRAINING_LABELS_DIR / f"{image_path.stem}.txt",
                        label_dir / f"{image_path.stem}.txt"
                    )

        yaml_path = dataset_dir / "dataset.yaml"
        yaml_path.write_text(
            f"path: {dataset_dir.as_posix()}\n"
            "train: images/train\n"
            "val: images/val\n"
            "names:\n"
            "  0: football\n",
            encoding="utf-8"
        )

        trainer = YOLO(str(FOOTBALL_MODEL_PATH if FOOTBALL_MODEL_PATH.exists() else MODEL_PATH))
        trainer.train(
            data=str(yaml_path),
            epochs=int(os.environ.get("PLAYER_NATION_TRAINING_EPOCHS", "20")),
            imgsz=640,
            batch=8,
            device=0 if torch.cuda.is_available() else "cpu",
            workers=0,
            project=str(TRAINING_RUNS_DIR),
            name=run_id,
            exist_ok=True,
            verbose=False
        )

        best_weights = Path(trainer.trainer.best)
        if not best_weights.is_file():
            raise RuntimeError("YOLO training finished without producing best.pt.")

        candidate_model = YOLO(str(best_weights))
        temporary_weights = FOOTBALL_MODEL_PATH.with_suffix(".tmp.pt")
        shutil.copy2(best_weights, temporary_weights)
        os.replace(temporary_weights, FOOTBALL_MODEL_PATH)

        with MODEL_LOCK:
            football_model = candidate_model
            SERVER_STATE["football_model"] = True
            SERVER_STATE["model_name"] = "yolov8n.pt + football_finetuned.pt"

        LAST_TRAINED_SAMPLE_COUNT = sample_count
        TRAINING_STATE_PATH.write_text(str(sample_count), encoding="utf-8")
        SERVER_STATE["training_status"] = "ready"
        SERVER_STATE["training_error"] = None
        print(f"[PlayerNation AI Server] Football model updated using {sample_count} labeled frames.")
    except Exception as error:
        SERVER_STATE["training_status"] = "error"
        SERVER_STATE["training_error"] = str(error)
        print(f"[PlayerNation AI Server] Automatic football training failed: {error}")
    finally:
        with TRAINING_LOCK:
            if SERVER_STATE["training_status"] == "training":
                SERVER_STATE["training_status"] = "ready"

    if SERVER_STATE["training_status"] == "ready":
        maybe_start_training()


@app.route("/health", methods=["GET"])
@app.route("/status", methods=["GET"])
def health():
    avg_latency = (
        round(SERVER_STATE["total_latency_ms"] / max(1, SERVER_STATE["frames_processed"]), 1)
        if SERVER_STATE["frames_processed"] > 0 else 0.0
    )
    return jsonify({
        "status": "online",
        "service": "PlayerNation AI Vision Local Server",
        "model": SERVER_STATE["model_name"],
        "device": SERVER_STATE["device"],
        "cuda": torch.cuda.is_available(),
        "frames_processed": SERVER_STATE["frames_processed"],
        "avg_latency_ms": avg_latency,
        "uptime_sec": round(time.time() - SERVER_STATE["start_time"], 1),
        "training": get_training_status()
    })


@app.route("/training-config", methods=["POST", "OPTIONS"])
def update_training_config():
    if not is_extension_request():
        return jsonify({"success": False, "error": "Training settings are accepted only from the extension."}), 403
    if request.method == "OPTIONS":
        return "", 200

    data = request.get_json(force=True, silent=True) or {}
    minimum_samples = data.get("minimum_samples")
    if (
        not isinstance(minimum_samples, int)
        or isinstance(minimum_samples, bool)
        or minimum_samples < 10
        or minimum_samples > 10000
    ):
        return jsonify({
            "success": False,
            "error": "minimum_samples must be an integer between 10 and 10000."
        }), 400

    SERVER_STATE["minimum_training_samples"] = minimum_samples
    maybe_start_training()
    return jsonify({"success": True, "training": get_training_status()})


@app.route("/training-samples", methods=["POST", "OPTIONS"])
def add_training_sample():
    if not is_extension_request():
        return jsonify({"success": False, "error": "Training labels are accepted only from the extension."}), 403
    if request.method == "OPTIONS":
        return "", 200

    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({"success": False, "error": "Expected a JSON training sample."}), 400

    sample_id = data.get("id")
    annotation = data.get("annotation")
    bbox = annotation.get("bbox") if isinstance(annotation, dict) else None
    if not isinstance(sample_id, str) or not sample_id or not isinstance(bbox, dict):
        return jsonify({"success": False, "error": "Training sample requires an id and football bounding box."}), 400
    if annotation.get("category") != "football":
        return jsonify({"success": False, "error": "Only manually verified football labels are accepted."}), 400

    try:
        center_x = float(bbox["x"])
        center_y = float(bbox["y"])
        width = float(bbox["width"])
        height = float(bbox["height"])
        values = (center_x, center_y, width, height)
        if not all(np.isfinite(value) for value in values):
            raise ValueError("Bounding-box values must be finite.")
        if not (0 <= center_x <= 1 and 0 <= center_y <= 1 and 0 < width <= 1 and 0 < height <= 1):
            raise ValueError("Bounding-box values must be normalized between 0 and 1.")
        if center_x - width / 2 < 0 or center_x + width / 2 > 1:
            raise ValueError("Football bounding box extends outside the image horizontally.")
        if center_y - height / 2 < 0 or center_y + height / 2 > 1:
            raise ValueError("Football bounding box extends outside the image vertically.")
        image = decode_image_base64(data.get("image", ""))
    except (KeyError, TypeError, ValueError) as error:
        return jsonify({"success": False, "error": f"Invalid football training sample: {error}"}), 400

    if image.shape[0] > 2048 or image.shape[1] > 2048:
        return jsonify({"success": False, "error": "Training frames must not exceed 2048 by 2048 pixels."}), 400

    supplied_minimum = data.get("minimum_samples")
    if supplied_minimum is not None:
        if (
            not isinstance(supplied_minimum, int)
            or isinstance(supplied_minimum, bool)
            or supplied_minimum < 10
            or supplied_minimum > 10000
        ):
            return jsonify({"success": False, "error": "minimum_samples must be between 10 and 10000."}), 400
        SERVER_STATE["minimum_training_samples"] = supplied_minimum

    sample_hash = hashlib.sha256(sample_id.encode("utf-8")).hexdigest()
    image_path = TRAINING_IMAGES_DIR / f"{sample_hash}.jpg"
    label_path = TRAINING_LABELS_DIR / f"{sample_hash}.txt"
    with TRAINING_DATA_LOCK:
        if not image_path.exists() or not label_path.exists():
            if not cv2.imwrite(str(image_path), image):
                return jsonify({"success": False, "error": "Could not save training frame to disk."}), 500
            label_path.write_text(
                f"0 {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f}\n",
                encoding="utf-8"
            )
        SERVER_STATE["training_samples"] = len(list(TRAINING_LABELS_DIR.glob("*.txt")))

    maybe_start_training()
    return jsonify({
        "success": True,
        "training": get_training_status()
    })


@app.route("/detect", methods=["POST", "OPTIONS"])
def detect():
    if request.method == "OPTIONS":
        return "", 200

    t0 = time.perf_counter()
    data = request.get_json(force=True, silent=True)

    if not data or "image" not in data:
        return jsonify({"success": False, "error": "Missing 'image' base64 payload."}), 400

    player_conf = float(data.get("player_conf", 0.25))
    ball_conf = float(data.get("ball_conf", 0.08))
    iou_thresh = float(data.get("iou_threshold", 0.45))

    try:
        img = decode_image_base64(data["image"])
    except Exception as e:
        return jsonify({"success": False, "error": f"Image decode failure: {str(e)}"}), 400

    h_img, w_img = img.shape[:2]
    hint_x = data.get("hint_x")
    hint_y = data.get("hint_y")
    try:
        hint_x = float(hint_x) if hint_x is not None else None
        hint_y = float(hint_y) if hint_y is not None else None
        if (
            hint_x is None or hint_y is None
            or not np.isfinite(hint_x) or not np.isfinite(hint_y)
            or not 0 <= hint_x <= 1 or not 0 <= hint_y <= 1
        ):
            hint_x = hint_y = None
    except (TypeError, ValueError):
        hint_x = hint_y = None

    min_conf = min(player_conf, ball_conf)

    # Run YOLOv8 PyTorch inference
    with MODEL_LOCK:
        active_football_model = football_model
        active_football_detector = football_detector
        if active_football_detector:
            results = active_football_detector.predict(
                img, conf=min_conf, iou=iou_thresh, verbose=False,
                device=SERVER_STATE['device'], classes=[0, 1, 2], imgsz=960
            )
            football_results = []
            balls = collect_ball_predictions(results, w_img, h_img, ball_conf, class_ids=(0,))
        else:
            results = model.predict(
                img,
                conf=min_conf,
                iou=iou_thresh,
                verbose=False,
                device=SERVER_STATE['device'],
                classes=[0, 32]
            )
            balls = collect_ball_predictions(results, w_img, h_img, min(0.03, ball_conf))

        best_full_frame_confidence = max((ball["confidence"] for ball in balls), default=0)
        if not active_football_detector and best_full_frame_confidence < 0.30:
            zoom_results = []
            offset_x = 0
            offset_y = 0
            if hint_x is not None and hint_y is not None:
                crop_size = max(1, round(min(w_img, h_img) * 0.24))
                offset_x = max(0, min(w_img - crop_size, round(hint_x * w_img - crop_size / 2)))
                offset_y = max(0, min(h_img - crop_size, round(hint_y * h_img - crop_size / 2)))
                zoom_frame = img[offset_y:offset_y + crop_size, offset_x:offset_x + crop_size]
                if zoom_frame.size:
                    zoom_results = model.predict(
                        zoom_frame,
                        conf=min(0.03, ball_conf),
                        iou=iou_thresh,
                        imgsz=640,
                        verbose=False,
                        device=SERVER_STATE['device'],
                        classes=[32]
                    )
            else:
                zoom_results = model.predict(
                    img,
                    conf=min(0.03, ball_conf),
                    iou=iou_thresh,
                    imgsz=960,
                    verbose=False,
                    device=SERVER_STATE['device'],
                    classes=[32]
                )
            balls.extend(
                collect_ball_predictions(
                    zoom_results,
                    w_img,
                    h_img,
                    ball_conf,
                    offset_x,
                    offset_y
                )
            )

        if not active_football_detector:
            football_results = active_football_model.predict(
            img,
            conf=ball_conf,
            iou=iou_thresh,
            verbose=False,
            device=SERVER_STATE['device'],
            classes=[0],
            imgsz=640
            ) if active_football_model else []

    t1 = time.perf_counter()
    latency_ms = round((t1 - t0) * 1000, 2)

    SERVER_STATE["frames_processed"] += 1
    SERVER_STATE["total_latency_ms"] += latency_ms

    players: List[Dict[str, Any]] = []
    all_detections: List[Dict[str, Any]] = []

    # The custom detector uses class order: ball, player, referee.
    if active_football_detector and len(results) > 0 and results[0].boxes is not None:
        role_names = {1: "player", 2: "referee"}
        for box in results[0].boxes:
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            if cls_id not in role_names or conf < player_conf:
                continue
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            det_obj = {
                "x": max(0.0, x1 / w_img), "y": max(0.0, y1 / h_img),
                "width": min(1.0, (x2 - x1) / w_img),
                "height": min(1.0, (y2 - y1) / h_img),
                "confidence": round(conf, 3), "classId": 0,
                "className": role_names[cls_id], "role": role_names[cls_id]
            }
            players.append(det_obj)
            all_detections.append(det_obj)

    # COCO Class mapping: 0 = person (player), 32 = sports ball (football)
    if not active_football_detector and len(results) > 0 and results[0].boxes is not None:
        boxes = results[0].boxes
        for box in boxes:
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            xyxy = box.xyxy[0].tolist()

            x1, y1, x2, y2 = xyxy
            norm_x = max(0.0, x1 / w_img)
            norm_y = max(0.0, y1 / h_img)
            norm_w = min(1.0, (x2 - x1) / w_img)
            norm_h = min(1.0, (y2 - y1) / h_img)

            det_obj = {
                "x": norm_x,
                "y": norm_y,
                "width": norm_w,
                "height": norm_h,
                "confidence": round(conf, 3),
                "classId": cls_id
            }

            if cls_id == 0 and conf >= player_conf:
                det_obj["className"] = "player"
                players.append(det_obj)
                all_detections.append(det_obj)
    all_detections.extend(balls)

    # The football-specific model uses class 0, while the base COCO model remains
    # responsible for player detections.
    if football_results and len(football_results) > 0 and football_results[0].boxes is not None:
        fine_tuned_balls = collect_ball_predictions(
            football_results,
            w_img,
            h_img,
            ball_conf,
            class_ids=(0,)
        )
        balls.extend(fine_tuned_balls)
        all_detections.extend(fine_tuned_balls)

    if hint_x is not None and hint_y is not None and balls:
        def ball_score(b):
            bcx = b["x"] + b["width"] / 2
            bcy = b["y"] + b["height"] / 2
            dist = ((bcx - hint_x)**2 + (bcy - hint_y)**2)**0.5
            return b["confidence"] - (dist * 1.5)
        best_ball = max(balls, key=ball_score)
    else:
        best_ball = max(balls, key=lambda b: b["confidence"]) if balls else None

    return jsonify({
        "success": True,
        "backend": f"Local PyTorch YOLOv8 ({SERVER_STATE['device'].upper()})",
        "latencyMs": latency_ms,
        "imageWidth": w_img,
        "imageHeight": h_img,
        "players": players,
        "ball": best_ball,
        "allBalls": balls,
        "allDetections": all_detections,
        "totalDetections": len(all_detections)
    })


@app.route("/", methods=["GET"])
def index():
    uptime = round(time.time() - SERVER_STATE["start_time"], 1)
    avg_latency = (
        round(SERVER_STATE["total_latency_ms"] / max(1, SERVER_STATE["frames_processed"]), 1)
        if SERVER_STATE["frames_processed"] > 0 else 0.0
    )
    training_error = escape(SERVER_STATE["training_error"] or "")
    html = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>PlayerNation AI - Local Vision Server</title>
      <style>
        body {{
          background: #090d16;
          color: #f1f5f9;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          margin: 0;
          padding: 40px;
          display: flex;
          justify-content: center;
        }}
        .card {{
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 14px;
          max-width: 640px;
          width: 100%;
          padding: 32px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.5);
        }}
        .header {{
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 24px;
        }}
        .badge {{
          background: #10b981;
          color: #000;
          font-weight: bold;
          font-size: 11px;
          padding: 4px 10px;
          border-radius: 20px;
          text-transform: uppercase;
        }}
        h1 {{
          font-size: 22px;
          margin: 0;
          color: #f8fafc;
        }}
        .stats-grid {{
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-top: 20px;
          margin-bottom: 24px;
        }}
        .stat-box {{
          background: #1a2234;
          border: 1px solid #2d3748;
          border-radius: 10px;
          padding: 16px;
        }}
        .stat-title {{
          font-size: 11px;
          color: #94a3b8;
          text-transform: uppercase;
          margin-bottom: 6px;
        }}
        .stat-val {{
          font-size: 20px;
          font-weight: 700;
          color: #38bdf8;
        }}
        .endpoint-info {{
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 8px;
          padding: 14px;
          font-family: monospace;
          font-size: 12px;
          color: #a5f3fc;
          margin-top: 20px;
        }}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <span class="badge">ONLINE</span>
          <h1>PlayerNation AI Local Backend</h1>
        </div>
        <p style="color: #94a3b8; font-size: 14px; line-height: 1.5;">
          High-speed PyTorch YOLOv8 detection microservice active. Chrome extension frames sent to this server bypass browser CORS restrictions and run native AI inference.
        </p>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-title">Device & Model</div>
            <div class="stat-val">{SERVER_STATE['model_name']} ({SERVER_STATE['device'].upper()})</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Frames Processed</div>
            <div class="stat-val">{SERVER_STATE['frames_processed']} frames</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Average Latency</div>
            <div class="stat-val">{avg_latency} ms</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Uptime</div>
            <div class="stat-val">{uptime}s</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Football Training</div>
            <div class="stat-val">{SERVER_STATE['training_status']}</div>
          </div>
          <div class="stat-box">
            <div class="stat-title">Verified Labels</div>
            <div class="stat-val">{SERVER_STATE['training_samples']} / {SERVER_STATE['minimum_training_samples']}</div>
          </div>
        </div>
        <p style="color: #f87171; font-size: 12px;">{training_error}</p>
        <div class="endpoint-info">
          POST http://127.0.0.1:8000/detect<br>
          POST http://127.0.0.1:8000/training-samples<br>
          GET  http://127.0.0.1:8000/health
        </div>
      </div>
    </body>
    </html>
    """
    return html


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"\n===========================================================")
    print(f"  PlayerNation AI Vision Local Backend Starting on:")
    print(f"  http://127.0.0.1:{port}")
    print(f"===========================================================\n")
    # threaded=True for handling multiple frame requests concurrently
    app.run(host="127.0.0.1", port=port, threaded=True)
