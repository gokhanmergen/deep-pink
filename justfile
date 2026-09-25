set shell := ["bash", "-e", "-u", "-o", "pipefail", "-c"]

default:
    @just --list

install:
    pnpm install

install-ci:
    pnpm install --frozen-lockfile

dev: launcher
    pnpm dev

preview: build
    pnpm start

typecheck:
    pnpm run typecheck

test:
    pnpm test

version kind:
    pnpm version {{kind}}

launcher:
    bash scripts/build-native-launcher.sh

# Build the app and, on Linux, compile its native GTK Quick Question popup.
build:
    pnpm run build
    if [[ "$(uname -s)" == "Linux" ]]; then just launcher; fi

# Build all Linux packages with the GTK launcher included.
package-linux: build
    pnpm exec electron-builder --linux

package-mac arch="arm64":
    pnpm run build
    pnpm exec electron-builder --mac --{{arch}}

clean:
    rm -rf out release
    rm -f build/native/deep-pink-launcher
