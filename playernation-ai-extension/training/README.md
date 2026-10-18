# Train the first PlayerNation football detector

This trains a football-specific detector initialized from the bundled YOLOv8n checkpoint. The trained weights are yours to evaluate and improve; the initial architecture and checkpoint come from Ultralytics. Version 1 learns three classes in this fixed order:

| ID | Class |
| --- | --- |
| 0 | ball |
| 1 | player |
| 2 | referee |

Goalkeepers are included with players in version 1. A later dataset can give them a separate class.

## 1. Prepare labeled footage

The starter dataset is [`training_data/Football-Image-Dataset`](../training_data/Football-Image-Dataset), a public collection of 612 annotated football frames with ball, player (including goalkeepers), and referee boxes. It is [licensed CC BY 4.0](https://github.com/skaczylo/Football-Image-Dataset). Attribution: **skaczylo, “Football Image Dataset,” 2026**. Keep this credit and license when sharing results or adapted labels. Additional match footage should be labeled with boxes for every visible ball, player, and referee. Include frames where the ball is difficult to see and empty frames with an empty label file. Keep frames from the same match/sequence in the same split to avoid near-identical frames appearing in both training and validation data.

For more ball examples, `training_data/Football-Ball-Detection` is a separate public dataset of 1,237 ball-labeled broadcast frames, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and attributed to [martinjolif / football-ball-detection](https://huggingface.co/datasets/martinjolif/football-ball-detection). This dataset labels only the ball, so use the ball-only trainer below; do not mix its frames into the three-class player/referee dataset as if the unannotated people were absent.

The dataset is kept out of Git because it is about 276 MB. Download it with the Hugging Face CLI:

```powershell
hf download martinjolif/football-ball-detection --repo-type dataset --local-dir training_data/Football-Ball-Detection
```

Create this YOLO dataset layout:

```text
football-dataset/
  dataset.yaml
  images/
    train/
    val/
  labels/
    train/
    val/
```

Each image needs a same-named `.txt` file under the matching `labels` split. Each line uses standard normalized YOLO boxes: `class_id center_x center_y width height`.

Example `dataset.yaml`:

```yaml
path: D:/datasets/football
train: images/train
val: images/val
names:
  0: ball
  1: player
  2: referee
```

Use at least 20 training and 5 validation frames to start; substantially more varied, correctly labeled frames are needed for useful results. The trainer checks labels and requires each class in the training split. This is a pipeline minimum, not a claim that 25 frames are enough for production quality.

## 2. Install training dependencies

From `playernation-ai-extension`, use a Python environment with PyTorch installed for your CPU or CUDA setup, then install:

```powershell
python -m pip install ultralytics pyyaml
```

The bundled `models/yolov8n.pt` checkpoint is used to initialize training.

## 3. Train and export

```powershell
python training/train_football.py --data training_data/Football-Image-Dataset/data.yaml --epochs 30 --imgsz 960 --batch 4 --device cpu --export-onnx
```

The script saves `models/football_detector.pt`, an ONNX export alongside it, and run metrics under `models/training_runs/football_detector/`. Use `--device cpu` if CUDA is unavailable, or `--device 0` for the first CUDA GPU. To continue training from the first candidate, pass `--base models/football_detector_candidate.pt --run-name football_detector_v2`. Review validation metrics and prediction samples before relying on a checkpoint.

To fine-tune a separate ball-focused candidate from the 1,450-frame supplemental dataset, run:

```powershell
python training/train_football_ball.py --epochs 30 --imgsz 960 --batch 4 --device cpu
```

This saves `models/football_ball_candidate.pt` and leaves the current detector untouched. Keep the dataset's test split held out when comparing the candidate with YOLO; deploy only after checking ball precision/recall and player false positives on your own match footage too.

## 4. Use the model in the local detector

After a sufficiently trained checkpoint is produced, keep it as `models/football_detector.pt` and restart the local backend. When present, the backend uses the three football classes for people and ball detections; otherwise it falls back to the existing general YOLO detector. The workspace currently has an early candidate at `models/football_detector_candidate.pt`; it reached 0.365 mAP@0.5 after five completed epochs at 416-pixel input. It remains separate from the active model because that result is not yet strong enough to claim parity with YOLO.

The extension's current click-to-label flow records verified football-ball boxes only. It does not yet annotate players or referees, so add-on footage for those classes needs labels from an annotation tool.

## Licensing

The bundled YOLO checkpoint and Ultralytics training code are distributed under Ultralytics' license terms. Review the applicable license before distributing the resulting model or integrating it into a product.
