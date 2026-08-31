{
  lib,
  stdenv,
  autoPatchelfHook,
  copyDesktopItems,
  electron,
  fetchPnpmDeps,
  makeDesktopItem,
  makeWrapper,
  nodejs,
  pnpmConfigHook,
  pnpm_11,
}:

/*
  Deep Pink, built from this tree.

  Two things make an Electron app awkward to package with Nix, and both are
  avoidable here rather than worked around:

  1. Electron itself. `pnpm install` normally downloads a hundred-megabyte
     binary from GitHub, which a sandboxed build cannot do and should not want
     to — so the download is skipped and the app is launched with the Electron
     from nixpkgs, whose libraries the rest of the system already knows how to
     update. That is `pkgs.electron`, the current major, rather than the one
     package.json asks for: nixpkgs carries only the versions upstream still
     supports, and pinning an older one is a build that stops working the month
     it is dropped. Nothing this app calls has changed since 38.

  2. The native SQLite binding. better-sqlite3 ships N-API prebuilds inside the
     npm package for every platform it supports, and N-API is stable across
     Node and Electron alike, so there is nothing to compile against Electron's
     ABI and no headers to fetch. What those prebuilds do expect is a system
     libstdc++, which is exactly what a Nix system does not have lying about —
     so the one for this platform is kept and patched, and the seven for other
     people's platforms are thrown away.
*/

let
  manifest = lib.importJSON ../package.json;
  # "linux-x64.node", "linux-arm64.node" — the name better-sqlite3 looks for.
  binding = "${stdenv.hostPlatform.node.platform}-${stdenv.hostPlatform.node.arch}.node";
in
stdenv.mkDerivation (finalAttrs: {
  pname = "deep-pink";
  inherit (manifest) version;

  # Only what the build actually reads. A plain `../.` would copy the 600 MB
  # of node_modules and the last build's output into the store, and change the
  # derivation every time either of them moved.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../.npmrc
      ../electron.vite.config.ts
      ../tsconfig.json
      ../tsconfig.node.json
      ../tsconfig.web.json
      ../src
      ../build/icon.png
      ../LICENSE
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    # Every dependency in pnpm-lock.yaml, fetched once and pinned. The fetch
    # asks for all of them rather than only this platform's, so one hash covers
    # both architectures. When the lockfile changes this has to change with it:
    # set it to "", build, and copy the hash the mismatch prints.
    hash = "sha256-zTG7V8f/2KkGn2r172T/PrKya29MYmX3HxBAs146Bz8=";
  };

  nativeBuildInputs = [
    autoPatchelfHook
    copyDesktopItems
    makeWrapper
    nodejs
    pnpmConfigHook
    pnpm_11
  ];

  # What the prebuilt SQLite binding links against. Without it the app starts,
  # fails to open its database and never draws a window.
  buildInputs = [ (lib.getLib stdenv.cc.cc) ];

  __structuredAttrs = true;
  strictDeps = true;

  env = {
    # The binary comes from nixpkgs; the npm package is here for its types and
    # for electron-vite to read a version out of.
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };

  buildPhase = ''
    runHook preBuild

    pnpm exec electron-vite build

    # What ships is the bundle plus the three runtime dependencies. Everything
    # else — Electron, TypeScript, the whole renderer toolchain — was scaffolding
    # and would otherwise be copied into the store as well.
    pnpm --ignore-scripts prune --prod
    find node_modules/.bin -xtype l -delete 2>/dev/null || true

    # One prebuilt binding is this machine's; the other seven are 12 MB of
    # architectures it will never run, and autoPatchelf would try to fix up
    # each of them and fail.
    find node_modules -path '*better-sqlite3/prebuilds/*' -type f \
      ! -name '${binding}' -delete

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/deep-pink
    cp -r out node_modules package.json $out/share/deep-pink/

    # `--inherit-argv0` so the process is called what the launcher called it,
    # and the Wayland flags only when the session is actually Wayland: XWayland
    # is the safer default, and the README says how to ask for native.
    makeWrapper ${electron}/bin/electron $out/bin/deep-pink \
      --inherit-argv0 \
      --add-flags $out/share/deep-pink \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations}}"

    # Named for the app id, which is also what Electron reports as its
    # WM_CLASS / Wayland app_id — that is what lets the desktop tell that this
    # window belongs to that launcher.
    install -Dm444 build/icon.png \
      $out/share/icons/hicolor/512x512/apps/dev.deeppink.app.png

    runHook postInstall
  '';

  # pnpm leaves dangling symlinks behind after pruning; they are removed above,
  # but the check runs over the whole tree and node_modules is a symlink farm.
  dontCheckForBrokenSymlinks = true;

  desktopItems = [
    (makeDesktopItem {
      name = "dev.deeppink.app";
      desktopName = "Deep Pink";
      comment = "Local-first desktop AI chat for OpenRouter";
      exec = "deep-pink";
      icon = "dev.deeppink.app";
      startupWMClass = "dev.deeppink.app";
      categories = [
        "Network"
        "InstantMessaging"
        "Utility"
      ];
      keywords = [
        "AI"
        "Chat"
        "LLM"
        "OpenRouter"
      ];
    })
  ];

  meta = {
    description = "Local-first desktop AI chat client for OpenRouter";
    longDescription = ''
      Threads, usage statistics and settings live in a SQLite file on your own
      machine. The app contacts OpenRouter, the MCP servers you configure and
      the web pages you ask for, and nothing else: no telemetry, no crash
      reporting, no update check.
    '';
    homepage = "https://github.com/gokhanmergen/deep-pink";
    license = lib.licenses.mit;
    mainProgram = "deep-pink";
    platforms = lib.platforms.linux;
  };
})
