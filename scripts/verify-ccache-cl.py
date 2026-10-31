"""Verify the actual pinned compiler/cache before a Windows Chromium build."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from importlib.util import module_from_spec, spec_from_file_location

sys.dont_write_bytecode = True
spec = spec_from_file_location("ccache_cl", Path(__file__).with_name("ccache-cl.py"))
wrapper = module_from_spec(spec)
spec.loader.exec_module(wrapper)


def verify(compiler, arch):
    ccache = shutil.which("ccache")
    assert ccache, "ccache must be on PATH"
    with tempfile.TemporaryDirectory(prefix="agentic-ccache-") as folder:
        root = Path(folder)
        env = {**os.environ, "CCACHE_DIR": str(root / "cache"),
               "CCACHE_BASEDIR": folder, "CCACHE_COMPILERCHECK": "content"}
        source, header, obj = (root / name for name in ["sample.cc", "value.h", "sample.obj"])
        source.write_text('#include "value.h"\nint value() {return VALUE;}\n')
        header.write_text("#define VALUE 7\n")
        old = time.time() - 10
        for path in [source, header]:
            os.utime(path, (old, old))
        target = {"x64": "x86_64", "arm64": "aarch64"}[arch]
        common = [f"--target={target}-pc-windows-msvc", "/c", "sample.cc",
                  "/Fosample.obj", "/nologo", "/showIncludes", "/Brepro"]
        # Match Chromium's /Brepro: COFF timestamps must not hide byte equality.
        forwarded = ["/clang:" + flag for flag in sorted(wrapper.FORWARDED_OPTIONS - {"-O3"})]
        flags = common + forwarded

        def run(args):
            return subprocess.run(args, cwd=root, env=env, check=True,
                                  capture_output=True, text=True, timeout=30)

        def stats():
            return json.loads(run([ccache, "--print-stats", "--format", "json"]).stdout)

        def compile_cached(options):
            obj.unlink(missing_ok=True)
            run([sys.executable, str(Path(__file__).with_name("ccache-cl.py")), compiler, *options])
            cached = obj.read_bytes()
            obj.unlink()
            run([compiler, *options])
            assert obj.read_bytes() == cached, "Cached and direct compiler output differ"

        run([ccache, "--zero-stats"])
        run([ccache, compiler, *flags])
        assert stats()["unsupported_compiler_option"] == 1, "Expected pinned ccache forwarding limitation"
        compile_cached(flags)
        first = stats()
        assert first["cache_miss"] == 1 and first["files_in_cache"] > 0
        compile_cached(flags)
        second = stats()
        assert second["direct_cache_hit"] == first["direct_cache_hit"] + 1
        header.write_text("#define VALUE 123\n")
        os.utime(header, (old - 1, old - 1))
        compile_cached(flags)
        changed_header = stats()
        assert changed_header["cache_miss"] == second["cache_miss"] + 1, "Header change reused stale output"
        compile_cached(["/clang:-O3" if flag == "/clang:-O2" else flag for flag in flags])
        changed_flag = stats()
        assert changed_flag["cache_miss"] == changed_header["cache_miss"] + 1, "Code-generation flag was not hashed"
        compile_cached(flags + ["/clang:-fwrapv"])
        final = stats()
        assert final["unsupported_compiler_option"] == changed_flag["unsupported_compiler_option"] + 1
        assert wrapper.cache_args(["@opaque.rsp", "/clang:-Iprivate"]) == ["@opaque.rsp", "/clang:-Iprivate"]
        return {"status": "passed", "host": sys.platform, "targetArch": arch,
                "checks": ["originalRejection", "identicalObject", "cacheHit", "headerInvalidation",
                           "flagInvalidation", "unknownForwardingUncached"], "stats": final}


if __name__ == "__main__":
    compiler, arch, report = sys.argv[1:]
    try:
        result = verify(compiler, arch)
    except Exception as error:
        result = {"status": "failed", "error": str(error)}
        if isinstance(error, subprocess.CalledProcessError):
            result["stderr"] = error.stderr[-4000:]
        Path(report).parent.mkdir(parents=True, exist_ok=True)
        Path(report).write_text(json.dumps(result, indent=2) + "\n")
        raise
    Path(report).parent.mkdir(parents=True, exist_ok=True)
    Path(report).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
