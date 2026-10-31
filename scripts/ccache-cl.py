"""Keep known clang-cl code-generation options intact while ccache hashes them."""
import subprocess
import sys


# ccache 4.14.2 rejects all /clang: forwarding. These single-token options do
# not name inputs, outputs, include paths or dependency files. --ccache-skip
# preserves the option in the compiler command AND the direct-mode cache key.
# Never skip arbitrary /clang: arguments or expand opaque response files here.
FORWARDED_OPTIONS = {
    "-fno-strict-overflow", "-fno-math-errno", "-ffp-contract=off",
    "-fdiagnostics-show-inlining-chain", "-fdiagnostics-format=clang",
    "-O2", "-O3",
}


def cache_args(args):
    result = []
    for arg in args:
        if arg.startswith(("/clang:", "-clang:")) and arg[7:] in FORWARDED_OPTIONS:
            result.append("--ccache-skip")
        result.append(arg)
    return result


if __name__ == "__main__":
    compiler, *args = sys.argv[1:]
    sys.exit(subprocess.call(["ccache", compiler, *cache_args(args)]))
