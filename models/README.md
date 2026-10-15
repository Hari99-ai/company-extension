# PlayerNation AI - Computer Vision Models Directory

This directory hosts the ONNX models used for in-browser computer vision inference with ONNX Runtime Web (`ort.min.js`).

## Compatible Model Specifications

### Architecture: YOLOv8 / YOLOv9 / YOLOv11 ONNX
- **Input Tensor Name**: `images`
- **Input Dimensions**: `[1, 3, 640, 640]`
- **Data Type**: `Float32`
- **Color Format**: `RGB` normalized between `0.0` and `1.0` (NCHW layout)
- **Output Tensor Name**: `output0`
- **Output Dimensions**: `[1, 84, 8400]` (for standard COCO 80 classes) or `[1, 4 + N_classes, 8400]`
  - Rows 0-3: `[x_center, y_center, width, height]` (pixel coordinates relative to 640x640)
  - Rows 4-83: Class probability scores

### Relevant COCO Classes
- **Class 0**: `person` (Players, Goalkeepers, Referees)
- **Class 32**: `sports ball` (Football)

## How to Export a Real YOLO Model to ONNX

Run the following command using the installed Python environment:

```bash
# Export standard YOLOv8 nano model directly to ONNX
yolo export model=yolov8n.pt format=onnx imgsz=640 dynamic=False
```

Once exported, place `yolov8n.onnx` directly into this folder (`models/yolov8n.onnx`).

### Football-Specific Finetuned Models
For small ball detection in wide-angle football footage, a model finetuned on the SoccerNet or Football Tracking dataset with classes `[ball, player, goalkeeper, referee]` can be placed here as `football_yolo.onnx`.
