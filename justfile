set shell := ["bash", "-e", "-u", "-o", "pipefail", "-c"]

default:
    @just --list

install:
    pnpm install

install-ci:
    pnpm install --frozen-lockfile

dev: native
    pnpm dev

preview: build
    pnpm start

typecheck:
    pnpm run typecheck

test:
    pnpm test

version kind:
    pnpm version {{kind}}

native:
    bash scripts/build-native-quick-question.sh

# Build the app and, on Linux, compile its native GTK Quick Question popup.
build:
    pnpm run build
    if [[ "$(uname -s)" == "Linux" ]]; then just native; fi

# Build all Linux packages with the GTK launcher included.
package-linux: build
    pnpm exec electron-builder --linux

package-mac arch="arm64":
    pnpm run build
    pnpm exec electron-builder --mac --{{arch}}

clean:
    rm -rf out release
    rm -f build/native/deep-pink-quick
