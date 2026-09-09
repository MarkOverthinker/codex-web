import os
from pathlib import Path
import pwd
import subprocess
import sys
import tomllib


def escape(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")


def main():
    if len(sys.argv) != 2 or os.getuid() == 0:
        raise SystemExit("Run as an unprivileged user: install-user-service.py CONFIG.toml")
    project = Path(__file__).resolve().parents[2]
    config_path = Path(sys.argv[1]).resolve()
    configuration = tomllib.loads(config_path.read_text())
    root = (config_path.parent / configuration["root"]).resolve()
    if not (root / "runtime" / "bin" / "python").exists():
        raise SystemExit("Prepare the local ASR runtime first.")
    template = (project / "deploy" / "codex-web-asr.service").read_text()
    unit = template.replace("__PROJECT_ROOT__", escape(project)).replace("__ASR_ROOT__", escape(root)).replace("__CONFIG_PATH__", escape(config_path))
    unit_path = root / "codex-web-asr.service"
    unit_path.write_text(unit)
    environment = os.environ.copy()
    environment.update({"HOME": pwd.getpwuid(os.getuid()).pw_dir, "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}", "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus"})
    subprocess.run(["systemctl", "--user", "link", str(unit_path)], env=environment, check=True)
    subprocess.run(["systemctl", "--user", "daemon-reload"], env=environment, check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "codex-web-asr.service"], env=environment, check=True)
    print("User service enabled. Configure TRANSCRIPTION_PROVIDER=local and LOCAL_ASR_SOCKET in the web server environment.")


if __name__ == "__main__":
    main()
