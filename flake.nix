{
  description = "Mastra server adapter for the Effect v4 HTTP layer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            # package.json sets engines.node >= 22.13. Node 24 is what the other
            # repos here run, so the toolchain stays consistent across them.
            pkgs.nodejs_24
            # pnpm is the package manager pnpm-lock.yaml is written for; npm or
            # yarn would resolve a different tree and can silently produce two
            # copies of @mastra/server, which breaks the conformance suites.
            pkgs.pnpm
          ];

          shellHook = ''
            echo "mastra-effect-adapter dev environment"
            echo "Node: $(node --version)"
            echo "pnpm: $(pnpm --version)"
          '';
        };
      }
    );
}
