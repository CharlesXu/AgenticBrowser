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


def verify_modules(compiler, ccache, root, env, target):
    root.mkdir()
    env = {**env, "CCACHE_DIR": str(root / "cache"), "CCACHE_BASEDIR": str(root),
           "CCACHE_DEPEND": "1", "CCACHE_SLOPPINESS": "modules,time_macros"}
    header, module_map, pcm, obj = (root / n for n in
                                   ["value.h", "module.modulemap", "module.pcm", "sample.obj"])
    old = time.time() - 20

    def write(path, text):
        path.write_text(text)
        os.utime(path, (old, old))

    write(header, "inline int value(){return 7;}\n")
    write(module_map, 'module Value { header "value.h" export * }\n')
    write(root / "sample.cc", '#include "value.h"\nint result(){return value();}\n')
    # Match the observed producer/consumer flags; keep dependency paths visible.
    common = [f"--target={target}-pc-windows-msvc", "/c", "/nologo", "/showIncludes",
              "/Brepro", "-fcolor-diagnostics", "-fmodules", "/clang:-fno-implicit-module-maps",
              "-fno-implicit-modules", "-fmodule-map-file=module.modulemap"]
    producer = common + ["-x", "c++", "-Xclang", "-emit-module", "-fmodule-name=Value",
                         "module.modulemap", "/Fomodule.pcm"]
    consumer = common + ["-fmodule-file=Value=module.pcm", "sample.cc", "/Fosample.obj"]
    assert wrapper.cache_args(common)[-1] == common[-1]
    assert "--ccache-skip" not in wrapper.cache_args(consumer)[-3:]

    def run(args):
        return subprocess.run(args, cwd=root, env=env, check=True,
                              capture_output=True, text=True, timeout=30)

    def stats():
        return json.loads(run([ccache, "--print-stats", "--format", "json"]).stdout)

    def cached(args, output, expected):
        before = stats()
        output.unlink(missing_ok=True)
        run([sys.executable, str(Path(__file__).with_name("ccache-cl.py")), compiler, *args])
        data = output.read_bytes()
        after = stats()
        assert after[expected] == before[expected] + 1, (expected, before, after)
        output.unlink()
        run([compiler, *args])
        assert output.read_bytes() == data, "Cached and direct module output differ"
        return data

    run([ccache, "--zero-stats"])
    run([ccache, compiler, *producer])
    assert stats()["unsupported_compiler_option"] == 1
    cached(producer, pcm, "cache_miss")
    cached(producer, pcm, "direct_cache_hit")
    original = cached(consumer, obj, "cache_miss")
    cached(consumer, obj, "direct_cache_hit")
    # Change PCM bytes alone, with the same source, header, map and consumer argv.
    previous = pcm.read_bytes()
    run([compiler, *producer, "-Xclang", "-fmodules-embed-all-files"])
    assert pcm.read_bytes() != previous
    cached(consumer, obj, "cache_miss")
    write(header, "inline int value(){return 123;}\n")
    cached(producer, pcm, "cache_miss")
    changed = cached(consumer, obj, "cache_miss")
    assert changed != original, "Module header change reused stale object"
    cached(consumer, obj, "direct_cache_hit")
    write(module_map, 'module Value { header "value.h" export * }\n// changed map\n')
    cached(producer, pcm, "cache_miss")
    cached(consumer, obj, "cache_miss")
    cached(consumer + ["/clang:-O2"], obj, "cache_miss")
    cached(consumer + ["/clang:-O3"], obj, "cache_miss")
    final = stats()
    assert final["unsupported_compiler_option"] == 1
    return {"status": "passed", "checks": ["originalModuleRejection", "producerHit",
            "consumerHit", "moduleObjectEquality", "pcmInvalidation", "moduleHeaderInvalidation",
            "moduleMapInvalidation", "moduleFlagInvalidation"], "stats": final}


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
        modules = verify_modules(compiler, ccache, root / "modules", env, target)
        return {"status": "passed", "host": sys.platform, "targetArch": arch,
                "checks": ["originalRejection", "identicalObject", "cacheHit", "headerInvalidation",
                           "flagInvalidation", "unknownForwardingUncached"], "stats": final,
                "modules": modules}


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
