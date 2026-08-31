{
  description = "Deep Pink — a local-first desktop AI chat client for OpenRouter";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # The packaged app wraps the Electron from nixpkgs, which is a Linux
      # build; macOS still gets its .app from `pnpm dist:mac`, which needs the
      # code-signing tools Apple ships rather than anything Nix can provide.
      linuxSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      # Apple Silicon only: nixpkgs dropped x86_64-darwin, and a dev shell that
      # cannot evaluate is worse than one that is not offered.
      devSystems = linuxSystems ++ [ "aarch64-darwin" ];

      forSystems =
        systems: f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems linuxSystems (pkgs: rec {
        deep-pink = pkgs.callPackage ./nix/package.nix { };
        default = deep-pink;
      });

      # For `nixpkgs.overlays` in a system configuration, so `pkgs.deep-pink`
      # resolves everywhere else in it.
      overlays.default = final: _prev: {
        deep-pink = final.callPackage ./nix/package.nix { };
      };

      # `nix develop` — everything `pnpm dev`, `pnpm test` and `pnpm dist:linux`
      # need, and nothing global to install first.
      devShells = forSystems devSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.pnpm_11
            # `pnpm install` compiles the SQLite binding from source when no
            # prebuild matches the platform.
            pkgs.python3
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.electron
            # What encrypted key storage is built on here; macOS has the
            # Keychain and needs nothing installed.
            pkgs.libsecret
            # The suites that boot the real window need a display; on a
            # headless machine, `xvfb-run --auto-servernum pnpm test`.
            pkgs.xvfb-run
          ];

          # Use the Electron from nixpkgs rather than downloading one, and let
          # `pnpm dev` find it where electron-vite looks.
          shellHook = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            export ELECTRON_SKIP_BINARY_DOWNLOAD=1
            export ELECTRON_OVERRIDE_DIST_PATH="${pkgs.electron}/libexec/electron"
          '';
        };
      });

      checks = forSystems linuxSystems (pkgs: {
        deep-pink = self.packages.${pkgs.stdenv.hostPlatform.system}.deep-pink;
      });
    };
}
