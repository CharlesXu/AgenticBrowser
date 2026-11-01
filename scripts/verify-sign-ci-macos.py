"""Exercise real codesign on isolated unsigned x64 and ARM64 nested bundles."""
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile


assert sys.platform == "darwin", "Run this check on macOS with Xcode tools"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("sign_ci", Path(__file__).with_name("sign-ci-macos.py"))
sign_ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign_ci)


def run(*args, check=True):
    return subprocess.run(list(map(str, args)), capture_output=True, check=check)


def plist(path, executable, kind):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps({"CFBundleExecutable": executable,
        "CFBundleIdentifier": "test.agentic." + executable, "CFBundlePackageType": kind,
        "CFBundleVersion": "1"}))


results = []
with tempfile.TemporaryDirectory(prefix="agentic-signing-") as temporary:
    root = Path(temporary).resolve()
    (root / "main.c").write_text("int main(void) { return 0; }\n")
    (root / "library.c").write_text("int example(void) { return 1; }\n")
    entitlements = {"com.apple.security.get-task-allow": True}
    (root / "entitlements.plist").write_bytes(plistlib.dumps(entitlements))
    for arch in ["x86_64", "arm64"]:
        app = root / arch / "Example.app"
        main = app / "Contents/MacOS/Main"
        main.parent.mkdir(parents=True)
        plist(app / "Contents/Info.plist", "Main", "APPL")
        framework = app / "Contents/Frameworks/Example.framework"
        version = framework / "Versions/A"
        plist(version / "Resources/Info.plist", "Example", "FMWK")
        (framework / "Versions/Current").symlink_to("A")
        (framework / "Example").symlink_to("Versions/Current/Example")
        (framework / "Resources").symlink_to("Versions/Current/Resources")
        helper = version / "Helpers/Helper.app"
        helper_main = helper / "Contents/MacOS/Helper"
        helper_main.parent.mkdir(parents=True)
        plist(helper / "Contents/Info.plist", "Helper", "APPL")
        service = app / "Contents/XPCServices/Service.xpc"
        service_main = service / "Contents/MacOS/Service"
        service_main.parent.mkdir(parents=True)
        plist(service / "Contents/Info.plist", "Service", "XPC!")
        run("xcrun", "clang", "-arch", arch, root / "main.c", "-o", main)
        run("xcrun", "clang", "-arch", arch, "-dynamiclib", root / "library.c", "-o", version / "Example")
        shutil.copy2(main, helper_main)
        shutil.copy2(main, service_main)
        shutil.copy2(version / "Example", app / "Contents/Frameworks/libextra.dylib")
        for binary in [main, helper_main, service_main, version / "Example", app / "Contents/Frameworks/libextra.dylib"]:
            run("codesign", "--remove-signature", binary, check=False)
        resource = version / "Resources/data.txt"
        resource.write_text("original\n")

        # This is the original failure: the main executable also seals its app.
        early = run("codesign", "--force", "--sign", "-", "--timestamp=none", main, check=False)
        assert early.returncode != 0 and b"code object is not signed at all" in early.stderr
        assert b"In subcomponent:" in early.stderr
        signed = sign_ci.sign_bundle(app)
        assert signed["status"] == "passed" and signed["binaries"] == 5 and signed["bundles"] == 4

        # Resigning must retain existing main/helper entitlements and flags.
        for bundle in [helper, framework, app]:
            extra = [] if bundle == framework else ["--options", "runtime", "--entitlements", root / "entitlements.plist"]
            run("codesign", "--force", "--sign", "-", "--timestamp=none", *extra, bundle)
        sign_ci.sign_bundle(app)
        for bundle in [helper, app]:
            extracted = run("codesign", "-d", "--entitlements", ":-", bundle).stdout
            assert plistlib.loads(extracted) == entitlements
            assert b"runtime" in run("codesign", "-d", "--verbose=4", bundle).stderr
        assert (framework / "Versions/Current").is_symlink()
        resource.write_text("changed\n")
        damaged = run("codesign", "--verify", "--deep", "--strict", app, check=False)
        assert damaged.returncode != 0, "Modified nested resource must fail verification"
        results.append({"arch": arch, "unsignedNestedFailureReproduced": True,
            "nestedSigning": "passed", "metadataPreserved": True, "tamperRejected": True})
print(json.dumps({"status": "passed", "fixtures": results}))
