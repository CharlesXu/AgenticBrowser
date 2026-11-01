"""Seal a staged PoC bundle with ad-hoc signatures, from the inside out.

This provides bundle integrity, not Developer ID signing or notarization.
"""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys


def sign_bundle(app):
    assert sys.platform == "darwin"
    app = Path(app).resolve()
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
    # codesign treats a bundle's main executable as the bundle itself. Leave
    # those executables to their bundle operation, after all nested code.
    main_executables = set()
    for bundle in bundles:
        candidates = [(bundle / "Contents/Info.plist", bundle / "Contents/MacOS"),
                      (bundle / "Resources/Info.plist", bundle),
                      (bundle / "Info.plist", bundle)]
        for info, directory in candidates:
            if not info.is_file():
                continue
            assert info.resolve().is_relative_to(bundle), "Bundle metadata outside stage"
            with info.open("rb") as stream:
                name = plistlib.load(stream)["CFBundleExecutable"]
            executable = (directory / name).resolve()
            assert executable.is_relative_to(bundle) and executable in binaries, "Invalid bundle executable"
            main_executables.add(executable)
            break
        else:
            raise AssertionError(f"Missing bundle Info.plist: {bundle}")
    targets = [file for file in binaries if file not in main_executables] + bundles
    for path in sorted(targets, key=lambda p: len(p.parts), reverse=True):
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
