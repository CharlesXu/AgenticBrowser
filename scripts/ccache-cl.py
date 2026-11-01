"""Keep known clang-cl options intact while ccache hashes them."""
import subprocess
import sys
import json
import os
from pathlib import Path


# ccache 4.14.2 rejects all /clang: forwarding. These single-token options do
# not name inputs, outputs, include paths or dependency files. --ccache-skip
# preserves the option in the compiler command AND the direct-mode cache key.
# Never skip arbitrary /clang: arguments or expand opaque response files here.
FORWARDED_OPTIONS = {
    "-fno-strict-overflow", "-fno-math-errno", "-ffp-contract=off",
    "-fdiagnostics-show-inlining-chain", "-fdiagnostics-format=clang",
    "-O2", "-O3", "-fno-implicit-module-maps",
}

# The last option is observed in both Windows jobs' real module commands.
# It disables implicit map discovery; explicit -fmodule-map-file and
# -fmodule-file dependencies remain visible to ccache. The native probe checks
# module creation/consumption and map/header/PCM invalidation before building.


def cache_args(args):
    result = []
    for arg in args:
        if arg.startswith(("/clang:", "-clang:")) and arg[7:] in FORWARDED_OPTIONS:
            result.append("--ccache-skip")
        result.append(arg)
    return result


if __name__ == "__main__":
    compiler, *args = sys.argv[1:]
    env = dict(os.environ)
    report = None
    directory = env.get("AGENTIC_CCACHE_DIAGNOSTICS")
    if directory:
        # At most four actual compile commands per job. Exclusive creation also
        # prevents concurrent compiler processes from overwriting evidence.
        unknown = [a for a in args if a.startswith(("/clang:", "-clang:"))
                   and a[7:] not in FORWARDED_OPTIONS]
        group = "forwarding" if unknown else "modules" if "-fmodules" in args else "cxx" if "/TP" in args else "c"
        path = Path(directory) / ("cache-command-" + group + ".json")
        try:
            report = path.open("x")
            env["CCACHE_LOGFILE"] = str(path.with_suffix(".log"))
        except FileExistsError:
            pass
    code = subprocess.call(["ccache", compiler, *cache_args(args)], env=env)
    if report:
        log = Path(env["CCACHE_LOGFILE"])
        diagnostic = log.read_text(errors="replace") if log.exists() else ""
        json.dump({"compiler": compiler, "arguments": args, "exitCode": code,
                   "ccacheLog": diagnostic[-16000:]}, report, indent=2)
        report.write("\n")
        report.close()
        log.unlink(missing_ok=True)
    sys.exit(code)
