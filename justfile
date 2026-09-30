set shell := ["bash", "-e", "-u", "-o", "pipefail", "-c"]

default:
    @just --list

install:
    pnpm install

install-ci:
    pnpm install --frozen-lockfile

dev:
    pnpm dev

preview: build
    pnpm start

typecheck:
    pnpm run typecheck

test:
    pnpm test

version kind:
    pnpm version {{kind}}

# Build the app.
build:
    pnpm run build

# Build all Linux packages.
package-linux: build
    pnpm exec electron-builder --linux

package-mac arch="arm64":
    pnpm run build
    pnpm exec electron-builder --mac --{{arch}}

clean:
    rm -rf out release
