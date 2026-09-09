import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tomllib


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare_model(root, specification, offline):
    destination = root / "models" / specification["file"]
    if not destination.is_file() or digest(destination) != specification["sha256"]:
        if offline:
            raise RuntimeError(f"Missing or corrupt offline model: {destination.name}")
        temporary = destination.with_suffix(destination.suffix + ".partial")
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "4", "--connect-timeout", "30", "--max-time", "1800", "--output", str(temporary), specification["url"]], check=True)
        if digest(temporary) != specification["sha256"]:
            raise RuntimeError(f"Model checksum mismatch: {destination.name}")
        temporary.replace(destination)
    if "name" in specification:
        marker = root / "models" / specification["name"] / ".ready"
        if not marker.is_file():
            with tarfile.open(destination) as archive:
                archive.extractall(root / "models", filter="data")
            marker.write_text(specification["sha256"] + "\n")
    print("Verified model:", specification["file"], flush=True)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: setup.py CONFIG.toml")
    source_root = Path(__file__).resolve().parent
    config_path = Path(sys.argv[1]).resolve()
    configuration = tomllib.loads(config_path.read_text())
    root = (config_path.parent / configuration["root"]).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    (root / "models").mkdir(exist_ok=True)
    wheelhouse = root / "wheels"
    wheelhouse.mkdir(exist_ok=True)
    specifications = json.loads((source_root / "models.json").read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(prepare_model, root, specification, configuration["offline"]) for specification in specifications]
        if not configuration["offline"]:
            subprocess.run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--dest", str(wheelhouse), "-r", str(source_root / "requirements.txt")], check=True)
        for future in futures:
            future.result()
    uv = os.environ.get("CWW_UV") or shutil.which("uv")
    if not uv:
        raise SystemExit("Install uv, or run in the codex-web task environment.")
    environment = root / "runtime"
    python = environment / "bin" / "python"
    if not python.exists():
        subprocess.run([uv, "venv", "--python", os.environ.get("CWW_SHARED_PYTHON", sys.executable), str(environment)], check=True)
    subprocess.run([uv, "pip", "install", "--python", str(python), "--no-index", "--find-links", str(wheelhouse), "-r", str(source_root / "requirements.txt")], check=True)
    manifest = [{"path": str(path.relative_to(root)), "bytes": path.stat().st_size, "sha256": digest(path)} for base in [root / "models", wheelhouse] for path in sorted(base.rglob("*")) if path.is_file()]
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Local ASR assets and dedicated runtime are ready.", flush=True)


if __name__ == "__main__":
    main()
