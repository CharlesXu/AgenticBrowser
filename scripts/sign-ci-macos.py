"""Seal a staged PoC bundle with ad-hoc signatures, from the inside out.

This provides bundle integrity, not Developer ID signing or notarization.
"""
import json
import os
from pathlib import Path
import subprocess
import sys


def sign_bundle(app):
    assert sys.platform == "darwin"
    app = Path(app).absolute()
    assert app.suffix == ".app" and app.is_dir()
    binaries, bundles = [], []
    # Never follow framework aliases or sign an executable outside the stage.
    for folder, dirs, files in os.walk(app, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(folder) / name).is_symlink()]
        path = Path(folder)
        if path.suffix in {".app", ".framework", ".xpc", ".appex"}:
            bundles.append(path)
        for name in files:
            file = path / name
            if file.is_symlink():
                continue
            with file.open("rb") as stream:
                magic = stream.read(4)
            if magic in {bytes.fromhex(h) for h in ["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"]}:
                binaries.append(file)
    assert binaries, "No Mach-O code in the staged app"
    # Sign code first, then seal helper apps, frameworks and the outer app.
    for path in binaries + sorted(bundles, key=lambda p: len(p.parts), reverse=True):
        subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none",
                        "--preserve-metadata=entitlements,flags", str(path)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    return {"status": "passed", "signature": "ad-hoc", "developerId": False,
            "notarized": False, "binaries": len(binaries), "bundles": len(bundles)}


if __name__ == "__main__":
    app, report = map(Path, sys.argv[1:])
    assert app.absolute().is_relative_to(Path.cwd() / ".runtime/package")
    try:
        result = sign_bundle(app)
    except Exception as error:
        report.write_text(json.dumps({"status": "failed", "error": str(error)}, indent=2) + "\n")
        raise
    report.write_text(json.dumps(result, indent=2) + "\n")
