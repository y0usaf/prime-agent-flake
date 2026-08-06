# prime-agent-flake

Nix flake packaging [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
(PrimeIntellect's fork of the pi coding agent) with a working IPython kernel
environment on NixOS.

The flake fetches upstream as a non-flake input (`primeAgentSrc`) — no code is
vendored here beyond nix glue:

- `patches/` — minimal patches applied to upstream (kept small: anything
  achievable via env var must not be a patch).
- `nix/package-lock.json` — upstream's committed lockfile with `resolved` +
  `integrity` restored (upstream strips them; prefetch-npm-deps drops such
  entries and `npm ci --offline` fails). Regenerate after `primeAgentSrc` bumps:
  `python3 nix/fix-lockfile.py <rev>`
- `nix/fix-lockfile.py` — regenerates the above from the npm registry.

## Usage

```sh
nix run github:y0usaf/prime-agent-flake
```

or add `inputs.prime-agent-flake.url = "github:y0usaf/prime-agent-flake";` and
install `pkgs.prime-agent-flake.packages.${system}.default`.

The wrapper sets `PRIME_AGENT_KERNEL_PYTHON` to a Nix-built Python with
ipykernel, `prime-agent-runtime`, and the built-in Python skills, since uv
auto-bootstrap cannot run on NixOS.

## Updating upstream

```sh
nix flake update primeAgentSrc
python3 nix/fix-lockfile.py main          # if package-lock.json changed
nix build .# 2>&1 | grep 'got:'           # refresh npmDepsHash if deps changed
nix flake check
```
