"""Train and export a football-specific YOLO detector.

Dataset labels use this fixed order: ball, player, referee.
The source dataset must already be split into train and val directories.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml
from ultralytics import YOLO


CLASS_NAMES = ["ball", "player", "referee"]
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def validate_dataset(dataset_yaml: Path) -> tuple[Path, Path, int]:
    config = yaml.safe_load(dataset_yaml.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("Dataset YAML must contain a mapping.")

    root = Path(config.get("path", dataset_yaml.parent))
    if not root.is_absolute():
        root = (dataset_yaml.parent / root).resolve()
    names = config.get("names")
    if isinstance(names, dict):
        names = [names.get(i, names.get(str(i))) for i in range(len(names))]
    if names != CLASS_NAMES:
        raise ValueError(f"Class names/order must be exactly: {CLASS_NAMES}")

    counts: dict[str, int] = {}
    for split in ("train", "val"):
        split_value = config.get(split)
        if not isinstance(split_value, str) or not split_value.strip():
            raise ValueError(f"Dataset YAML is missing '{split}'.")
        split_path = Path(split_value)
        image_dir = split_path if split_path.is_absolute() else root / split_path
        if not image_dir.is_dir():
            raise ValueError(f"Image directory does not exist: {image_dir}")
        images = [p for p in image_dir.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES]
        if not images:
            raise ValueError(f"No images found in {image_dir}")
        try:
            image_root_relative = image_dir.relative_to(root)
            label_dir = root / "labels" / image_root_relative.relative_to("images")
        except ValueError:
            label_dir = image_dir.parent.parent / "labels" / image_dir.name
        missing = [
            p.relative_to(image_dir).as_posix()
            for p in images
            if not (label_dir / p.relative_to(image_dir).with_suffix(".txt")).exists()
        ]
        if missing:
            raise ValueError(f"Missing YOLO label for {len(missing)} image(s), e.g. {missing[0]}")
        seen_classes: set[int] = set()
        for image_path in images:
            label_path = label_dir / image_path.relative_to(image_dir).with_suffix(".txt")
            for line_number, line in enumerate(label_path.read_text(encoding="utf-8").splitlines(), 1):
                values = line.split()
                if len(values) != 5:
                    raise ValueError(f"Invalid YOLO label at {label_path}:{line_number}")
                class_id = int(values[0])
                coords = [float(value) for value in values[1:]]
                if class_id not in range(len(CLASS_NAMES)) or not all(0 <= value <= 1 for value in coords):
                    raise ValueError(f"Invalid class or normalized box at {label_path}:{line_number}")
                if coords[2] == 0 or coords[3] == 0:
                    raise ValueError(f"Zero-size box at {label_path}:{line_number}")
                if split == "train":
                    seen_classes.add(class_id)
        if split == "train":
            missing_classes = [CLASS_NAMES[i] for i in range(len(CLASS_NAMES)) if i not in seen_classes]
            if missing_classes:
                raise ValueError(f"Training split has no labels for: {', '.join(missing_classes)}")
        counts[split] = len(images)

    if counts["train"] < 20 or counts["val"] < 5:
        raise ValueError("Use at least 20 training images and 5 validation images to start.")
    return dataset_yaml.resolve(), root.resolve(), counts["train"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path, help="YOLO dataset.yaml")
    parser.add_argument("--base", type=Path, default=Path("models/yolov8n.pt"), help="Initial YOLO weights")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", default="auto", help="auto, cpu, 0, or another Ultralytics device")
    parser.add_argument("--run-name", default="football_detector", help="Name for the Ultralytics training run")
    parser.add_argument("--output", type=Path, default=Path("models/football_detector.pt"))
    parser.add_argument("--export-onnx", action="store_true", help="Also export ONNX beside the PyTorch weights")
    args = parser.parse_args()

    try:
        source_yaml, dataset_root, train_count = validate_dataset(args.data)
        if not args.base.is_file():
            raise ValueError(f"Initial weights not found: {args.base}. Pass --base with a YOLO checkpoint.")
        if args.epochs < 1 or args.imgsz < 320 or args.batch < 1:
            raise ValueError("epochs and batch must be positive; imgsz must be at least 320.")

        device = args.device
        if device == "auto":
            import torch
            device = "0" if torch.cuda.is_available() else "cpu"

        print(f"Training on {train_count} labeled frames; device={device}")
        config = yaml.safe_load(source_yaml.read_text(encoding="utf-8"))
        config["path"] = dataset_root.as_posix()
        resolved_data_yaml = args.output.parent / "training_runs" / "football_dataset.yaml"
        resolved_data_yaml.parent.mkdir(parents=True, exist_ok=True)
        resolved_data_yaml.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
        detector = YOLO(str(args.base))
        result = detector.train(
            data=str(resolved_data_yaml),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            device=device,
            project=str((args.output.parent / "training_runs").resolve()),
            name=args.run_name,
            exist_ok=True,
            patience=20,
            workers=0,
        )
        best = Path(result.save_dir) / "weights" / "best.pt"
        if not best.is_file():
            raise RuntimeError(f"Training completed but best checkpoint was not found: {best}")

        args.output.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copy2(best, args.output)
        print(f"Football detector saved to {args.output.resolve()}")

        if args.export_onnx:
            exported = YOLO(str(args.output)).export(format="onnx", imgsz=args.imgsz, dynamic=False)
            print(f"ONNX export saved to {exported}")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Training failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
