"""Fine-tune a one-class football-ball detector on an Ultralytics dataset."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import yaml
from ultralytics import YOLO


def resolve_dataset(data_yaml: Path, output: Path) -> Path:
    config = yaml.safe_load(data_yaml.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("Dataset YAML must contain a mapping.")
    names = config.get("names")
    if isinstance(names, dict):
        names = [names.get(i, names.get(str(i))) for i in range(len(names))]
    if not isinstance(names, list) or len(names) != 1:
        raise ValueError("This trainer expects a ball-only dataset with exactly one class.")

    root_value = config.get("path")
    if root_value:
        root = Path(root_value)
        if not root.is_absolute():
            root = (data_yaml.parent / root).resolve()
    else:
        root = data_yaml.parent.resolve()
    config["path"] = root.as_posix()
    if "val" not in config and "valid" in config:
        config["val"] = config.pop("valid")
    if not isinstance(config.get("train"), str) or not isinstance(config.get("val"), str):
        raise ValueError("Dataset YAML must define train and val (or valid) image paths.")

    for split in ("train", "val"):
        split_path = Path(config[split])
        if not split_path.is_absolute() and not (root / split_path).is_dir():
            # Some dataset exports keep data.yaml in a nested folder but retain
            # paths relative to the archive root (for example ../train/images).
            archive_relative = Path(*split_path.parts[-2:])
            if (data_yaml.parent / archive_relative).is_dir():
                config[split] = archive_relative.as_posix()
            else:
                raise ValueError(f"Dataset {split} image directory not found: {split_path}")

    resolved = output.parent / "training_runs" / "football_ball_dataset.yaml"
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("training_data/Football-Ball-Detection/data/data.yaml"))
    parser.add_argument("--base", type=Path, default=Path("models/yolov8n.pt"))
    parser.add_argument("--output", type=Path, default=Path("models/football_ball_candidate.pt"))
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--run-name", default="football_ball_bootstrap")
    args = parser.parse_args()

    try:
        if not args.data.is_file():
            raise ValueError(f"Dataset YAML not found: {args.data}")
        if not args.base.is_file():
            raise ValueError(f"Initial weights not found: {args.base}")
        if args.epochs < 1 or args.imgsz < 320 or args.batch < 1:
            raise ValueError("epochs and batch must be positive; imgsz must be at least 320.")

        dataset = resolve_dataset(args.data, args.output)
        device = args.device
        if device == "auto":
            import torch
            device = "0" if torch.cuda.is_available() else "cpu"

        detector = YOLO(str(args.base))
        result = detector.train(
            data=str(dataset), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch,
            device=device, project=str((args.output.parent / "training_runs").resolve()),
            name=args.run_name, exist_ok=True, patience=12, workers=0,
        )
        best = Path(result.save_dir) / "weights" / "best.pt"
        if not best.is_file():
            raise RuntimeError(f"Training finished without best.pt: {best}")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best, args.output)
        print(f"Ball detector candidate saved to {args.output.resolve()}")
        print("Review validation metrics and held-out test predictions before deployment.")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Training failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
