{
  description = "prime-agent — PrimeIntellect fork of the pi coding agent, packaged for Nix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    primeAgentSrc = {
      url = "github:PrimeIntellect-ai/prime-agent?ref=main";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, primeAgentSrc }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageJson = builtins.fromJSON (builtins.readFile "${primeAgentSrc}/package.json");
      # Kept minimal on purpose: anything achievable via env var or user config
      # must not be a patch (patches rot on every primeAgentSrc bump).
      primeAgentPatches = [
        # Build must not hit the network: drop `npm run generate-models` from
        # the ai build so the committed models.generated.ts is used as-is.
        ./patches/avoid-network-model-regeneration.patch
      ];
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          lib = pkgs.lib;

          py = pkgs.python3Packages;
          # shtab completion tests fail in this nixpkgs rev
          tyro = py.tyro.overridePythonAttrs (_: { doCheck = false; });
          prime-agent-runtime = py.buildPythonPackage {
            pname = "prime-agent-runtime";
            version = "0.1.0";
            pyproject = true;
            src = primeAgentSrc + "/prime-agent-runtime";
            build-system = [ py.hatchling ];
            dependencies = [ py.ipykernel py.nest-asyncio tyro ];
          };
          # The built-in python skills must be importable inside the (read-only)
          # PRIME_AGENT_KERNEL_PYTHON env or prime-agent disables them — uv-install
          # cannot run there, so package them into the kernel-python env.
          skillDeps = {
            attach-image = [ py.pillow prime-agent-runtime ];
            linear = [ py.mcp py.httpx prime-agent-runtime ];
            notion = [ py.mcp py.httpx prime-agent-runtime ];
            websearch = [ py.httpx prime-agent-runtime ];
          };
          skillDir = primeAgentSrc + "/packages/coding-agent/skills";
          skillNames = builtins.attrNames (lib.filterAttrs (n: t:
            t == "directory" && builtins.pathExists (skillDir + "/${n}/pyproject.toml"))
            (builtins.readDir skillDir));
          resolveName = n: "prime-agent-skill-${n}";
          mkSkill = name: py.buildPythonPackage {
            pname = if builtins.elem name [ "attach-image" "linear" "notion" "websearch" ] then resolveName name else name;
            version = "0.1.0";
            pyproject = true;
            src = skillDir + "/${name}";
            build-system = [ py.hatchling ];
            dependencies = skillDeps.${name} or [ ];
          };
          pythonSkills = map mkSkill skillNames;

          # kernel env for the ipython tool; uv auto-bootstrap can't run on NixOS
          # (uv-managed CPython needs /lib64/ld-linux-x86-64.so.2).
          kernelPython = pkgs.python3.withPackages (ps: with ps; [
            ipykernel dill nest-asyncio
            requests httpx pyyaml tomli python-dotenv
            pandas numpy scipy beautifulsoup4 lxml pydantic
            tyro prime-agent-runtime
          ] ++ pythonSkills);
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "prime-agent";
            version = packageJson.version;
            src = primeAgentSrc;
            patches = primeAgentPatches;

            nodejs = pkgs.nodejs_22;

            # Fetch packuments too (needed for npm ci offline in the build).
            npmDepsFetcherVersion = 2;

            # Upstream's committed package-lock.json strips every `resolved` URL;
            # prefetch-npm-deps silently drops such packages, so they never enter
            # the npm cache and `npm ci --offline` fails with ENOTCACHED. postPatch
            # overwrites the lockfile with the vendored restored copy (identical
            # versions, `resolved` + `integrity` filled in from the registry).
            # Regenerate after primeAgentSrc bumps:
            #   python3 nix/fix-lockfile.py <rev>
            postPatch = ''
              cp ${./nix/package-lock.json} package-lock.json
            '';

            # Regenerate after dependency changes:
            #   nix build .# 2>&1 | grep 'got:' | awk '{print $2}'
            npmDepsHash = "sha256-bbO4t0FyCJPI9AvYILF5ZpN4k+evPPKu4Pwj4VFLO5I=";

            # zeromq's npm tarball ships prebuilt N-API addons for node 22
            # (.../build/linux/x64/node/glibc-127-Release/addon.node, ABI 127).
            # `npm rebuild zeromq` loads the prebuilt — no cmake, no vcpkg, no
            # network. Do NOT use nodejs_24: ABI 137 has no prebuilt and the
            # cmake fallback needs vcpkg network access.
            npmRebuildFlags = [ "zeromq" ];

            # The default installPhase packs only the ROOT package (no bin;
            # the prime-agent bin lives in the coding-agent workspace), so
            # override it: ship the whole built tree so the runtime layout
            # matches the repo.
            nativeBuildInputs = [ pkgs.makeWrapper ];

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib
              cp -a . $out/lib/prime-agent
              chmod +x $out/lib/prime-agent/prime-agent.sh
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/prime-agent                 --add-flags "$out/lib/prime-agent/packages/coding-agent/dist/bundle/cli.js"                 --prefix PATH : ${pkgs.nodejs_22}/bin                 --set-default PRIME_AGENT_KERNEL_PYTHON ${kernelPython}/bin/python                 --set PI_SKIP_VERSION_CHECK 1
              runHook postInstall
            '';

            meta = with lib; {
              description = packageJson.description or "PrimeIntellect fork of the pi coding agent";
              homepage = "https://github.com/PrimeIntellect-ai/prime-agent";
              license = licenses.mit;
              mainProgram = "prime-agent";
            };
          };

          kernel-python = kernelPython;
        });

      checks = forAllSystems (system: {
        build = self.packages.${system}.default;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/prime-agent";
        };
      });
    };
}
